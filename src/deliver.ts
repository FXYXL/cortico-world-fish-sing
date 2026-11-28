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

import { fmtTime, lineAtTime, type LyricLine, type LyricsSheet, type TimeSpan } from './lyrics.ts';

export interface PlayMeta {
  id?: string;
  title?: string;
  durationSec?: number;
  lyrics?: LyricsSheet;
  chorusRanges?: TimeSpan[];
}

export interface LyricPushConfig {
  mode: 'off' | 'smart' | 'interval';
  intervalSec: number;
  leadSec: number;
}

export interface LyricCueEvent {
  kind: 'chorus_ahead' | 'interval';
  title: string;
  elapsedSec: number;
  durationSec: number;
  text: string;
  nextLine?: LyricLine;
}

export interface PlayOptions {
  dir: string;
  playerPath: string;
  volume: number;
  /** 从第几秒开始起播（用于任意句/副歌跳播，默认 0） */
  seekSec?: number;
  /** 曲目元信息（用于唱中实时追踪播到第几秒/第几句与提词推送） */
  meta?: PlayMeta;
  /** 唱中歌词提词配置（smart / interval / off） */
  lyricPush?: LyricPushConfig;
  /** 唱中提词触发回调 */
  onLyricCue?: (cue: LyricCueEvent) => void;
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
  private seekOffsetSec = 0;
  private meta: PlayMeta = {};
  private stopFlag = false;
  private activeOnEnd: PlayOptions['onEnd'];
  private lyricTimer: ReturnType<typeof setInterval> | null = null;

  private clearLyricTimer(): void {
    if (this.lyricTimer) {
      clearInterval(this.lyricTimer);
      this.lyricTimer = null;
    }
  }

  /** 正在播放时热更新歌词时间轴（如手动微调 LRC 偏移后立即生效，无需重播）。 */
  updateMetaLyrics(lyrics: LyricsSheet, chorusRanges?: TimeSpan[]): void {
    if (!this.meta) return;
    this.meta = {
      ...this.meta,
      lyrics,
      chorusRanges: chorusRanges ?? this.meta.chorusRanges,
    };
  }

  /** 启动唱中提词调度器：仅在播放中生效，播完/切歌/停止立刻销毁。 */
  private startLyricPrompter(
    started: number,
    seekOffset: number,
    meta: PlayMeta,
    cfg: LyricPushConfig | undefined,
    onCue: PlayOptions['onLyricCue'],
  ): void {
    this.clearLyricTimer();
    if (!cfg || cfg.mode === 'off' || !onCue) return;
    const initLyrics = meta.lyrics;
    const initChorus = meta.chorusRanges ?? [];
    if (!initLyrics?.lines?.length && !initChorus.length) return;

    const title = String(meta.title || '当前歌曲');
    const durationSec = Number(meta.durationSec || 0);
    const leadSec = Math.max(0, Math.min(10, Number(cfg.leadSec ?? 3)));
    const intervalSec = Math.max(0, Math.min(120, Number(cfg.intervalSec ?? 25)));
    const firedChorus = new Set<number>();
    // 跳播到后半段时，把起播点之前的副歌直接标为已触发，避免误报过去段落
    initChorus.forEach((c, idx) => {
      if (c.start < seekOffset - 0.8) firedChorus.add(idx);
    });
    let lastPushAt = -999;
    let lastCueLineIdx = -1;

    this.lyricTimer = setInterval(() => {
      if (!this.proc) {
        this.clearLyricTimer();
        return;
      }
      const lyrics = this.meta.lyrics ?? initLyrics;
      const chorus = this.meta.chorusRanges ?? initChorus;
      const playedSec = Math.max(0, (Date.now() - started) / 1000);
      const elapsed = seekOffset + playedSec;
      if (durationSec > 6 && elapsed > durationSec - 2.5) return;

      // 1) 副歌提前预告（smart 和 interval 模式都优先触发，每段副歌只推一次）
      for (let idx = 0; idx < chorus.length; idx += 1) {
        if (firedChorus.has(idx)) continue;
        const c = chorus[idx];
        const remain = c.start - elapsed;
        if (remain <= leadSec + 0.6 && remain >= -0.8) {
          firedChorus.add(idx);
          const chLines = (lyrics?.lines ?? [])
            .filter((l) => l.start >= c.start - 1.2 && l.start <= c.end)
            .slice(0, 2);
          const preview = chLines.length
            ? `接下来：${chLines.map((l) => `第 ${l.index} 句「${l.text}」`).join(' → ')}`
            : `副歌区间 ${fmtTime(c.start)}–${fmtTime(c.end)}`;
          const timing = remain > 0.7 ? `约 ${Math.round(remain)} 秒后` : '马上';
          lastPushAt = elapsed;
          if (chLines[0]) lastCueLineIdx = chLines[0].index;
          onCue({
            kind: 'chorus_ahead',
            title,
            elapsedSec: Math.round(elapsed * 10) / 10,
            durationSec,
            nextLine: chLines[0],
            text: `[提词·即将进副歌] 《${title}》${timing}进副歌（${fmtTime(c.start)}–${fmtTime(c.end)}，该亮起来啦）！${preview}`,
          });
          return;
        }
      }

      // 2) 按秒定时节拍推送（interval 固定间隔；smart 在 intervalSec > 0 时作为长主歌兜底）
      const minStep = cfg.mode === 'interval' ? Math.max(5, intervalSec || 25) : (intervalSec > 0 ? Math.max(20, intervalSec) : 0);
      if (minStep <= 0) return;

      // smart 模式下如果即将进副歌（8 秒内），把机会留给更准的副歌预告，不连续推两次
      if (cfg.mode === 'smart') {
        const nearChorus = chorus.some((c, idx) => !firedChorus.has(idx) && c.start - elapsed > 0 && c.start - elapsed <= leadSec + 8);
        if (nearChorus) return;
      }

      const firstWait = cfg.mode === 'interval' ? Math.min(minStep, 10) : Math.min(minStep, 18);
      if (lastPushAt < 0 ? playedSec < firstWait : elapsed - lastPushAt < minStep) return;

      const curPos = lineAtTime(lyrics, elapsed);
      const aheadPos = lineAtTime(lyrics, elapsed + leadSec);
      const upcoming = aheadPos.current && aheadPos.current.index !== curPos.current?.index
        ? aheadPos.current
        : (curPos.next ?? aheadPos.next ?? aheadPos.current);
      if (!upcoming || upcoming.index === lastCueLineIdx) return;

      const nextCh = chorus.find((c, idx) => !firedChorus.has(idx) && c.start > elapsed && c.start - elapsed <= 20);
      const chHint = nextCh ? `（约 ${Math.round(nextCh.start - elapsed)} 秒后进副歌）` : '';
      const curNote = curPos.current ? `正唱第 ${curPos.current.index} 句「${curPos.current.text}」，` : '';
      lastPushAt = elapsed;
      lastCueLineIdx = upcoming.index;
      onCue({
        kind: 'interval',
        title,
        elapsedSec: Math.round(elapsed * 10) / 10,
        durationSec,
        nextLine: upcoming,
        text: `[提词 ${fmtTime(elapsed)}/${fmtTime(durationSec)}] 《${title}》${curNote}下一句（${fmtTime(upcoming.start)}）：第 ${upcoming.index} 句「${upcoming.text}」${chHint}`,
      });
    }, 1000);
    this.lyricTimer.unref?.();
  }

  get playing(): string {
    return this.current;
  }

  /** 查询当前实时播放进度与正唱到哪一句歌词（支持唱到一半插话定位「这句」）。 */
  playbackState(): PlaybackState {
    const active = Boolean(this.proc && this.current);
    const durationSec = Number(this.meta.durationSec ?? 0);
    const rawElapsed = active && this.startedAt > 0
      ? this.seekOffsetSec + Math.max(0, (Date.now() - this.startedAt) / 1000)
      : 0;
    const clamped = durationSec > 0 ? Math.min(durationSec, rawElapsed) : rawElapsed;
    const elapsedSec = Math.max(0, Math.round(clamped * 10) / 10);
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

  /** 放一首；新的一来就把旧的掐掉（同时放两首只会互相盖住）。支持 seekSec 从任意位置起播。 */
  play(file: string, opts: PlayOptions): void {
    this.stop();
    if (!existsSync(file)) throw new Error(`要播的文件不存在：${file}`);
    const exe = opts.playerPath && existsSync(opts.playerPath)
      ? opts.playerPath
      : join(opts.dir, 'ffplay.exe');
    if (!existsSync(exe)) throw new Error(`找不到 ffplay：${exe}（配置 → 运行时 → ffmpeg 目录）`);
    const vol = Math.max(0, Math.min(1, Number(opts.volume) || 1));
    const seek = Math.max(0, Number(opts.seekSec ?? 0) || 0);
    const ffArgs = ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(Math.round(vol * 100))];
    if (seek > 0.1) ffArgs.push('-ss', seek.toFixed(2));
    ffArgs.push(file);
    const child = spawn(exe, ffArgs, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    const started = Date.now();
    let settled = false;
    const finish = (reason: 'ended' | 'stopped' | 'error') => {
      if (settled) return;
      settled = true;
      const elapsed = Math.max(0, Math.round((seek + (Date.now() - started) / 1000) * 10) / 10);
      if (this.proc === child) {
        this.clearLyricTimer();
        this.proc = null;
        this.current = '';
        this.startedAt = 0;
        this.seekOffsetSec = 0;
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
    this.seekOffsetSec = seek;
    this.meta = opts.meta ?? {};
    this.activeOnEnd = opts.onEnd;
    this.startLyricPrompter(started, seek, this.meta, opts.lyricPush, opts.onLyricCue);
  }

  stop(): void {
    this.clearLyricTimer();
    if (!this.proc) return;
    const child = this.proc;
    const started = this.startedAt;
    const seek = this.seekOffsetSec;
    const onEnd = this.activeOnEnd;
    this.stopFlag = true;
    this.proc = null;
    this.current = '';
    this.startedAt = 0;
    this.seekOffsetSec = 0;
    this.activeOnEnd = undefined;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    const elapsed = started > 0 ? Math.max(0, Math.round((seek + (Date.now() - started) / 1000) * 10) / 10) : 0;
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
