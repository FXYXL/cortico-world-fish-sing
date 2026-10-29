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

export interface PlayOptions {
  dir: string;
  playerPath: string;
  volume: number;
  /** 出问题时用它留痕：ffplay 静默失败最坑，不报就永远查不到 */
  log?: (msg: string) => void;
}

export class Player {
  private proc: ChildProcess | null = null;
  private current = '';

  get playing(): string {
    return this.current;
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
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf8');
      if (err.length > 2000) err = err.slice(-2000);
    });
    child.once('error', (e) => {
      opts.log?.(`ffplay 起不来：${e.message}`);
      if (this.proc === child) {
        this.proc = null;
        this.current = '';
      }
    });
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) {
        opts.log?.(`ffplay 退出码 ${code}：${err.trim().split('\n').slice(-2).join(' ') || '无输出'}`);
      }
      if (this.proc === child) {
        this.proc = null;
        this.current = '';
      }
    });
    this.proc = child;
    this.current = file;
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.current = '';
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

/** `group:123` / `private:456`；也接受 `群:123` / `私聊:456`（她有时候会这么写）。 */
export function parseTarget(to: string): OneBotTarget | null {
  const text = String(to || '').trim();
  const m = /^(group|群|private|私聊)\s*[:：]\s*(\d+)$/.exec(text);
  if (!m) return null;
  const isGroup = m[1] === 'group' || m[1] === '群';
  const id = Number(m[2]);
  return isGroup
    ? { action: 'send_group_msg', params: { group_id: id }, label: `群 ${id}` }
    : { action: 'send_private_msg', params: { user_id: id }, label: `私聊 ${id}` };
}

async function callOneBot(opts: OneBotOptions, action: string, params: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${opts.httpUrl.replace(/\/+$/, '')}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(120_000),
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
  await callOneBot(opts, target.action, {
    ...target.params,
    message: [{ type: 'text', data: { text } }],
  });
}
