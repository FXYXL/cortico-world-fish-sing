/**
 * 投递：本机出声（ffplay）与发 QQ 语音条（OneBot HTTP record 段）。
 *
 * 为什么本机用 ffplay 而不是复用桌宠的声卡通道：桌宠那条通道在 gpt-sovits 扩展内部
 * （audify/RtAudio），没有导出给别的插件；要复用就得自己引原生模块再写一遍。
 * ffplay 是现成的、什么格式都能放、能随时 kill。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { lineAtTime, type LyricLine, type LyricsSheet } from './lyrics.ts';

export interface PlayMeta {
  id?: string;
  title?: string;
  durationSec?: number;
  lyrics?: LyricsSheet;
}

export interface PlayOptions {
  dir: string;
  playerPath: string;
  volume: number;
  /** 曲目元信息（用于唱中实时追踪播到第几秒/第几句） */
  meta?: PlayMeta;
  /** 播放结束回调：ended=自然播完，stopped=被主动打断，error=异常退出 */
  onEnd?: (reason: 'ended' | 'stopped' | 'error', elapsedSec: number) => void;
  /** 出问题时用它留痕：ffplay 静默失败最坑，不报就永远查不到 */
  log?: (msg: string) => void;
}

export interface PlaybackState {
  playing: boolean;
  file: string;
  title: string;
  id: string;
  elapsedSec: number;
  durationSec: number;
  currentLine?: LyricLine;
  nextLine?: LyricLine;
}

export class Player {
  private proc: ChildProcess | null = null;
  private current = '';
  private startedAt = 0;
  private meta: PlayMeta = {};
  private stopFlag = false;
  private activeOnEnd: PlayOptions['onEnd'];

  get playing(): string {
    return this.current;
  }

  /** 查询当前实时播放进度与正唱到哪一句歌词（支持唱到一半插话定位「这句」）。 */
  playbackState(): PlaybackState {
    const active = Boolean(this.proc && this.current);
    const elapsedSec = active && this.startedAt > 0
      ? Math.max(0, Math.round(((Date.now() - this.startedAt) / 1000) * 10) / 10)
      : 0;
    const durationSec = Number(this.meta.durationSec ?? 0);
    const pos = active ? lineAtTime(this.meta.lyrics, elapsedSec) : {};
    return {
      playing: active,
      file: this.current,
      title: String(this.meta.title ?? ''),
      id: String(this.meta.id ?? ''),
      elapsedSec,
      durationSec,
      currentLine: pos.current,
      nextLine: pos.next,
    };
  }

  /** 放一首；新的一来就把旧的掐掉（同时放两首只会互相盖住）。 */
  play(file: string, opts: PlayOptions): void {
    this.stop();
    if (!existsSync(file)) throw new Error(`要播的文件不存在：${file}`);
    const exe = opts.playerPath && existsSync(opts.playerPath)
      ? opts.playerPath
      : join(opts.dir, 'ffplay.exe');
    if (!existsSync(exe)) throw new Error(`找不到 ffplay：${exe}（配置 → 运行时 → ffmpeg 目录）`);
    const vol = Math.max(0, Math.min(1, Number(opts.volume) || 1));
    const child = spawn(exe, ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(Math.round(vol * 100)), file], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    const started = Date.now();
    let settled = false;
    const finish = (reason: 'ended' | 'stopped' | 'error') => {
      if (settled) return;
      settled = true;
      const elapsed = Math.max(0, Math.round(((Date.now() - started) / 1000) * 10) / 10);
      if (this.proc === child) {
        this.proc = null;
        this.current = '';
        this.startedAt = 0;
        this.activeOnEnd = undefined;
      }
      opts.onEnd?.(reason, elapsed);
    };

    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf8');
      if (err.length > 2000) err = err.slice(-2000);
    });
    child.once('error', (e) => {
      opts.log?.(`ffplay 起不来：${e.message}`);
      finish('error');
    });
    child.once('exit', (code) => {
      const wasStopped = this.stopFlag && this.proc === child;
      if (!wasStopped && code !== 0 && code !== null) {
        opts.log?.(`ffplay 退出码 ${code}：${err.trim().split('\n').slice(-2).join(' ') || '无输出'}`);
      }
      finish(wasStopped ? 'stopped' : code === 0 ? 'ended' : 'error');
    });
    this.stopFlag = false;
    this.proc = child;
    this.current = file;
    this.startedAt = started;
    this.meta = opts.meta ?? {};
    this.activeOnEnd = opts.onEnd;
  }

  stop(): void {
    if (!this.proc) return;
    const child = this.proc;
    const started = this.startedAt;
    const onEnd = this.activeOnEnd;
    this.stopFlag = true;
    this.proc = null;
    this.current = '';
    this.startedAt = 0;
    this.activeOnEnd = undefined;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    const elapsed = started > 0 ? Math.max(0, Math.round(((Date.now() - started) / 1000) * 10) / 10) : 0;
    onEnd?.('stopped', elapsed);
  }
}

export interface OneBotOptions {
  httpUrl: string;
  token: string;
}

export interface OneBotTarget {
  action: string;
  params: Record<string, unknown>;
  label: string;
}

/** `group:123` / `private:456`；也接受 `群:123` / `私聊:456`（她有时候会这么写）。
 *  裸数字当成私聊 QQ 号——用户第一反应就是直接填号码，不能因为少个前缀就静默不发。 */
export function parseTarget(to: string): OneBotTarget | null {
  const text = String(to || '').trim();
  const bare = /^(\d{5,12})$/.exec(text);
  if (bare) {
    const id = Number(bare[1]);
    return { action: 'send_private_msg', params: { user_id: id }, label: `私聊 ${id}` };
  }
  const m = /^(group|群|private|私聊)\s*[:：]\s*(\d+)$/.exec(text);
  if (!m) return null;
  const isGroup = m[1] === 'group' || m[1] === '群';
  const id = Number(m[2]);
  return isGroup
    ? { action: 'send_group_msg', params: { group_id: id }, label: `群 ${id}` }
    : { action: 'send_private_msg', params: { user_id: id }, label: `私聊 ${id}` };
}

async function callOneBot(
  opts: OneBotOptions,
  action: string,
  params: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<void> {
  const res = await fetch(`${opts.httpUrl.replace(/\/+$/, '')}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`OneBot HTTP ${res.status}`);
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败 retcode=${body.retcode} ${String(body.wording ?? body.message ?? '')}`.trim());
  }
}

/** 把一段音频作为**真正的语音条**发出去（SnowLuma 收到 mp3 会自己转 SILK）。 */
export async function sendRecord(opts: OneBotOptions, target: OneBotTarget, file: string): Promise<void> {
  const bytes = await readFile(file);
  await callOneBot(opts, target.action, {
    ...target.params,
    message: [{ type: 'record', data: { file: `base64://${bytes.toString('base64')}` } }],
  });
}

export async function sendText(opts: OneBotOptions, target: OneBotTarget, text: string): Promise<void> {
  // 文本通知给短超时：SnowLuma 端口开着但不响应时，别让"训练完成"等两分钟才退桌宠。
  // 语音条（sendRecord）仍用 120 秒——大文件 + mp3→SILK 转换本来就慢。
  await callOneBot(
    opts,
    target.action,
    { ...target.params, message: [{ type: 'text', data: { text } }] },
    15_000,
  );
}
