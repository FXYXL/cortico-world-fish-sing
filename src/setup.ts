/**
 * 运行时安装与权重下载：面板按钮背后的全部逻辑。
 *
 * 为什么不用 `tools/bootstrap.mjs` 那套：那是给开发者在终端里跑的，输出是 ANSI 彩色行；
 * 面板要的是结构化的进度（百分比 + 一句话）。所以这里重新实现一遍，只共用清单文件。
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { MODELS_MANIFEST } from './paths.ts';
import type { WorkerPaths } from './paths.ts';

export interface ModelFile {
  name: string;
  size: number;
  sha256: string;
  target: string;
}

export interface Manifest {
  tag: string;
  base: string;
  totalBytes: number;
  files: ModelFile[];
}

export interface ModelState extends ModelFile {
  ready: boolean;
  actual: number;
}

export interface SetupStatus {
  runtimeRoot: string;
  rvc: { ready: boolean; root: string; files: number };
  python: { path: string; ok: boolean; note: string };
  models: ModelState[];
  doneBytes: number;
  totalBytes: number;
  systemPython: string;
  ffmpeg: { dir: string; ok: boolean };
}

export type Progress = (pct: number, msg: string) => void;

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MODELS_MANIFEST, 'utf8')) as Manifest;
}

function dirCount(p: string): number {
  if (!existsSync(p)) return 0;
  try {
    return readFileSync(join(p, 'infer', 'cli.py')) ? 1 : 0;
  } catch {
    return 0;
  }
}

/** 找一个可用的系统 python（只用于创建 venv）。 */
export function findSystemPython(): string {
  const cands = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  // 只做存在性检查：真正能不能用要跑一次才知道，交给装的时候验证
  return cands[0];
}

export function inspect(paths: WorkerPaths): SetupStatus {
  const manifest = loadManifest();
  const models: ModelState[] = manifest.files.map((f) => {
    const p = join(paths.rvcRoot, f.target);
    const there = existsSync(p);
    const actual = there ? statSync(p).size : 0;
    return { ...f, ready: actual === f.size, actual };
  });
  const doneBytes = models.reduce((n, m) => n + (m.ready ? m.size : 0), 0);
  return {
    runtimeRoot: paths.runtimeRoot,
    rvc: { ready: dirCount(paths.rvcRoot) > 0, root: paths.rvcRoot, files: dirCount(paths.rvcRoot) },
    python: {
      path: paths.pythonPath,
      ok: existsSync(paths.pythonPath),
      note: paths.selfHosted ? '自托管' : '外部 RVC',
    },
    models,
    doneBytes,
    totalBytes: models.reduce((n, m) => n + m.size, 0),
    systemPython: findSystemPython(),
    ffmpeg: {
      dir: paths.ffmpegDir,
      ok: existsSync(join(paths.ffmpegDir, 'ffmpeg.exe')) || existsSync(join(paths.ffmpegDir, 'ffmpeg')),
    },
  };
}

/** 从插件包复制 RVC 代码（不含权重）。 */
export function copyRvcCode(paths: WorkerPaths, vendorRoot: string): number {
  if (!existsSync(vendorRoot)) throw new Error(`插件包里没有 vendor/rvc：${vendorRoot}`);
  mkdirSync(paths.rvcRoot, { recursive: true });
  // 已有文件不覆盖：权重可能已经下好了，别让空目录把 .pth 冲掉
  cpSync(vendorRoot, paths.rvcRoot, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (p: string) => !p.includes('__pycache__'),
  });
  for (const f of loadManifest().files) mkdirSync(dirname(join(paths.rvcRoot, f.target)), { recursive: true });
  return 1;
}

/** 下载一个文件，带进度；中途可用 signal 取消。 */
async function downloadOne(
  url: string,
  dst: string,
  size: number,
  onTick: (got: number) => void,
  signal: AbortSignal,
): Promise<void> {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}.part`;
  const res = await fetch(url, {
    redirect: 'follow',
    signal,
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  if (!res.body) throw new Error('下载响应没有 body');
  const out = createWriteStream(tmp);
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      onTick(got);
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once('drain', () => r()));
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  if (size && got !== size) {
    rmSync(tmp, { force: true });
    throw new Error(`大小不符：收到 ${got} 字节，应为 ${size}`);
  }
  rmSync(dst, { force: true });
  renameSync(tmp, dst);
}

async function sha256File(file: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const h = createHash('sha256');
  await new Promise<void>((res, rej) => {
    const s = createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => res());
    s.on('error', rej);
  });
  return h.digest('hex');
}

/** 下载全部缺失权重；已就位（大小一致）的会跳过。 */
export async function downloadModels(
  paths: WorkerPaths,
  report: Progress,
  signal: AbortSignal,
): Promise<{ downloaded: number; skipped: number }> {
  const manifest = loadManifest();
  const base = manifest.base.endsWith('/') ? manifest.base : `${manifest.base}/`;
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  let doneBefore = 0;
  let downloaded = 0;
  let skipped = 0;

  for (let i = 0; i < manifest.files.length; i += 1) {
    const f = manifest.files[i];
    const dst = join(paths.rvcRoot, f.target);
    if (existsSync(dst) && statSync(dst).size === f.size) {
      doneBefore += f.size;
      skipped += 1;
      continue;
    }
    report(Math.round((doneBefore / total) * 100), `下载 ${f.name}（${(f.size / 1048576).toFixed(1)} MB）`);
    await downloadOne(
      base + encodeURIComponent(f.name),
      dst,
      f.size,
      (got) => {
        const pct = Math.round(((doneBefore + got) / total) * 100);
        const mbs = got / 1048576;
        report(pct > 99 ? 99 : pct, `下载 ${f.name} ${mbs.toFixed(1)}/${(f.size / 1048576).toFixed(1)} MB`);
      },
      signal,
    );
    // 完整性校验：Release 传坏了、或者中间被截断，都在这里拦下
    report(Math.round(((doneBefore + f.size) / total) * 100), `校验 ${f.name}`);
    const h = await sha256File(dst);
    if (h !== f.sha256) {
      rmSync(dst, { force: true });
      throw new Error(`${f.name} 校验失败（sha256 不符），已删除，请重试`);
    }
    doneBefore += f.size;
    downloaded += 1;
  }
  report(100, downloaded ? `下载完成（${downloaded} 个）` : '权重已齐全，无需下载');
  return { downloaded, skipped };
}

/** 跑一个子进程，边跑边喂输出行。 */
function run(
  exe: string,
  args: string[],
  onLine: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    const feed = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/[\r\n]+/)) {
        const t = line.trim();
        if (t) onLine(t);
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
    };
    signal.addEventListener('abort', kill, { once: true });
    child.once('error', (e) => {
      signal.removeEventListener('abort', kill);
      reject(e);
    });
    child.once('exit', (code) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) reject(new Error('已取消'));
      else if (code === 0) resolve();
      else reject(new Error(`进程退出码 ${code}`));
    });
  });
}

/** 现有 venv 里的 torch 情况；没有 torch 返回 null。 */
function detectTorch(py: string): { version: string; cuda: boolean } | null {
  if (!existsSync(py)) return null;
  try {
    const out = execFileSync(py, ['-c', 'import torch;print(torch.__version__);print(torch.cuda.is_available())'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    const [version, cuda] = out.trim().split(/\r?\n/);
    return { version: version ?? '', cuda: cuda === 'True' };
  } catch {
    return null;
  }
}

export type RuntimeMode = 'gpu' | 'cpu';

/**
 * 从零安装 Python 运行时。
 *
 * gpu：torch 2.7.1+cu118，下载约 2.5 GB（走 nju 镜像），装完约 6 GB。
 * cpu：torch CPU 版，下载约 200 MB，推理慢 6~8 倍（55 秒音频约 1 分钟）。
 */
export async function installRuntime(
  paths: WorkerPaths,
  mode: RuntimeMode,
  systemPython: string,
  report: Progress,
  signal: AbortSignal,
): Promise<void> {
  const venvDir = join(paths.runtimeRoot, 'venv');
  const py = join(venvDir, 'Scripts', 'python.exe');

  if (!existsSync(py)) {
    report(1, `创建 venv（${systemPython}）`);
    if (existsSync(venvDir)) rmSync(venvDir, { recursive: true, force: true });
    await run(systemPython, ['-m', 'venv', venvDir], () => {}, signal);
    if (!existsSync(py)) throw new Error('venv 建好了但找不到 python.exe，检查系统 python 是否可用');
  }

  const pipIndex = 'https://mirrors.pku.edu.cn/pypi/simple';
  report(4, '升级 pip');
  await run(py, ['-m', 'pip', 'install', '--upgrade', 'pip', '-i', pipIndex], () => {}, signal);

  // 已经装好的 torch 不要动：`pip install torch`（CPU 源）会**替换** cu118 版，
  // 一个误点就把能用的 GPU 环境变成 CPU 版（慢 6~8 倍，还得重下 2.5 GB 才能恢复）。
  const has = detectTorch(py);
  const wantGpu = mode === 'gpu';
  if (has && (has.cuda || !wantGpu)) {
    const keep = has.cuda ? 'GPU 版（cu118）' : 'CPU 版';
    report(70, `已有 torch ${has.version}，保留现有${keep}，跳过 torch 安装`);
  } else {

  const torchArgs = mode === 'gpu'
    ? [
        'install',
        'torch==2.7.1+cu118',
        'torchaudio==2.7.1+cu118',
        '--index-url',
        'https://mirrors.nju.edu.cn/pytorch/whl/cu118',
        '--extra-index-url',
        pipIndex,
      ]
    : ['install', 'torch', 'torchaudio', '--index-url', 'https://mirrors.nju.edu.cn/pytorch/whl/cpu'];

    const sizeHint = mode === 'gpu' ? '约 2.5 GB' : '约 200 MB';
    // pip 的百分比是每个包各自的，这里只在阶段边界跳，阶段内用最后一行日志体现"还在动"
    let spin = 0;
    report(6, `安装 torch（${sizeHint}，这是最慢的一步）`);
    await run(
      py,
      ['-m', 'pip', ...torchArgs],
      (line) => {
        spin = Math.min(64, spin + 0.4);
        report(Math.round(6 + spin), line.slice(0, 120));
      },
      signal,
    );
  }

  const req = join(paths.rvcRoot, 'requirments_cu118_py312.txt');
  if (existsSync(req)) {
    report(78, '安装项目依赖（faiss / librosa / onnxruntime 等）');
    await run(py, ['-m', 'pip', 'install', '-r', req], (line) => report(84, line.slice(0, 120)), signal);
  }

  report(90, '安装 demucs（分离人声）');
  await run(py, ['-m', 'pip', 'install', 'demucs>=4.0.1', '-i', pipIndex], (line) => report(94, line.slice(0, 120)), signal);

  report(97, '检查依赖');
  await run(
    py,
    ['-c', 'import torch, torchaudio, faiss, soundfile, librosa, demucs; print("ok")'],
    (line) => report(98, line.slice(0, 120)),
    signal,
  );
  report(100, '运行时装好了');
}

/** 用运行时的 python 跑一段检测，返回可读的结论。 */
export async function probeRuntime(pythonPath: string): Promise<string> {
  if (!existsSync(pythonPath)) return '还没有 python';
  const code = `
import sys
print('python', sys.version.split()[0])
mods = ['torch','torchaudio','faiss','soundfile','librosa','demucs']
miss = []
for m in mods:
    try:
        __import__(m)
    except Exception:
        miss.append(m)
if miss:
    print('缺:', ','.join(miss))
else:
    import torch
    print('cuda', 'yes' if torch.cuda.is_available() else 'no')
    if torch.cuda.is_available():
        print('gpu', torch.cuda.get_device_name(0))
    print('ok')
`;
  return new Promise((resolve) => {
    const child = spawn(pythonPath, ['-c', code], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.once('error', () => resolve('python 跑不起来'));
    child.once('exit', () => resolve(out.trim().split('\n').slice(0, 4).join(' · ')));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      resolve(out.trim() || '检测超时');
    }, 20000);
  });
}
