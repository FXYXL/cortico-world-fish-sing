/**
 * 音频小工具：全部走 ffmpeg / ffprobe 子进程。
 *
 * 为什么不用 JS 音频库：解码 mp3/m4a/flac、重采样、切段、混响这些 ffmpeg 一行搞定，
 * 而且这台机器上已经有完整 build（ffmpeg/ffprobe/ffplay 三件套）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface FfmpegDeps {
  dir: string;
}

export function ffmpegPath(deps: FfmpegDeps): string {
  const p = join(deps.dir, 'ffmpeg.exe');
  return existsSync(p) ? p : 'ffmpeg';
}

export function ffprobePath(deps: FfmpegDeps): string {
  const p = join(deps.dir, 'ffprobe.exe');
  return existsSync(p) ? p : 'ffprobe';
}

function run(cmd: string, args: string[], timeoutMs = 300_000): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (c) => {
      err += String(c);
      if (err.length > 6000) err = err.slice(-6000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, err });
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, err: e.message });
    });
  });
}

export async function duration(file: string, deps: FfmpegDeps): Promise<number> {
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(
      ffprobePath(deps),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { windowsHide: true },
    );
    let out = '';
    child.stdout?.on('data', (c) => {
      out += String(c);
    });
    child.once('exit', (code) => resolve({ code: code ?? -1, out }));
    child.once('error', () => resolve({ code: -1, out: '' }));
  });
  const v = Number(r.out.trim());
  return Number.isFinite(v) ? v : 0;
}

/** 任意音频 → mp3（统一 44.1k / 双声道 / 指定码率）。 */
export async function toMp3(src: string, dst: string, deps: FfmpegDeps, bitrate = '192k'): Promise<void> {
  const r = await run(ffmpegPath(deps), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', src, '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', bitrate, dst,
  ]);
  if (r.code !== 0) throw new Error(`转 mp3 失败：${r.err.split('\n').slice(-2).join(' ').trim()}`);
}

/** 截取一段（秒）。 */
export async function cut(src: string, dst: string, start: number, dur: number, deps: FfmpegDeps): Promise<void> {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', src);
  if (dur > 0) args.push('-t', String(dur));
  args.push('-ac', '2', '-c:a', 'pcm_s24le', dst);
  const r = await run(ffmpegPath(deps), args);
  if (r.code !== 0) throw new Error(`截取失败：${r.err.split('\n').slice(-2).join(' ').trim()}`);
}

/**
 * 按最长时长切段（QQ 语音条 ≤60 秒）。用 `-c copy` 只在关键帧切？
 * 不行——mp3 直接 copy 切会有几百毫秒误差和爆音，这里重编码，反正只有一次。
 */
export async function split(src: string, outDir: string, maxSec: number, deps: FfmpegDeps): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const total = await duration(src, deps);
  if (!total || total <= maxSec) return [src];
  const n = Math.ceil(total / maxSec);
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const dst = join(outDir, `seg_${String(i).padStart(2, '0')}.mp3`);
    const r = await run(ffmpegPath(deps), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(i * maxSec), '-t', String(maxSec),
      '-i', src, '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', dst,
    ]);
    if (r.code !== 0) throw new Error(`切段失败（第 ${i + 1} 段）：${r.err.split('\n').slice(-2).join(' ').trim()}`);
    out.push(dst);
  }
  return out;
}
