/**
 * 与 Python worker 的通信：自动拉起、健康检查、投任务、轮询进度、取消。
 *
 * 为什么 worker 是独立进程而不是"每次起一个 python 命令"：
 *  · RVC 每次启动都要重载 hubert(181M) + rmvpe(173M) + 生成器 + faiss 索引，实测 8 秒；
 *  · CUDA context 反复创建销毁在这台机器上偶发几十秒卡顿；
 *  · 它崩了不该拖垮 Coo（契约：worker 挂了只影响唱歌，不影响聊天）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PY = join(HERE, '..', 'worker', 'server.py');

export interface WorkerOptions {
  rvcRoot: string;
  pythonPath: string;
  separatePython: string;
  separateScript: string;
  ffmpegDir: string;
  port: number;
  token: string;
  autoStart: boolean;
  startTimeoutMs: number;
  workDir: string;
  model: string;
  index: string;
}

export interface WorkerHealth {
  ok: boolean;
  engine?: { ready: boolean; model: string; index: string; samplerate: number; loadMs: number };
  queue?: number;
  current?: { id: string; message: string; progress: number } | null;
}

export interface JobState {
  id: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'canceled';
  progress: number;
  message: string;
  result?: Record<string, unknown> | null;
  error?: string;
}

export interface LoggerLike {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
}

export class WorkerClient {
  private opts: WorkerOptions;
  private readonly log: LoggerLike;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  /** 上次拉起的时间戳，防止「起不来 → 每次调用都重试 → 疯狂 spawn」。 */
  private lastSpawnAt = 0;

  constructor(opts: WorkerOptions, log: LoggerLike) {
    this.opts = opts;
    this.log = log;
  }

  /** 供外部（train.ts 等）直接调接口用。 */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  /** 鉴权头；外部直接请求 worker 时也用这个，免得两处写法不一致。 */
  authHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`;
    return h;
  }

  async health(timeoutMs = 2500): Promise<WorkerHealth | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return (await res.json()) as WorkerHealth;
    } catch {
      return null;
    }
  }

  /** 确保 worker 在跑。已在跑就直接返回；否则按配置拉起并等就绪。 */
  /**
   * 换掉运行时参数（装好 venv 之后用）。
   *
   * 必须重新赋值：pythonPath 从「不存在的 runtime/venv」变成「刚装好的那个」，
   * 不更新的话下一次唱歌仍然报"找不到 python"。
   */
  retune(patch: Partial<WorkerOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  async ensure(): Promise<void> {
    if (await this.health()) return;
    if (!this.opts.autoStart) {
      throw new Error(`worker 没在跑（${this.baseUrl}），而「自动拉起」是关的。先手动起：${this.opts.pythonPath} worker\\server.py`);
    }
    if (this.starting) return this.starting;
    if (Date.now() - this.lastSpawnAt < 8000) {
      throw new Error('worker 刚启动还没就绪，稍等一两秒再试');
    }
    this.lastSpawnAt = Date.now();
    this.starting = this.spawnAndWait().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnAndWait(): Promise<void> {
    if (!existsSync(SERVER_PY)) {
      return Promise.reject(new Error(`找不到 worker 脚本：${SERVER_PY}`));
    }
    if (!existsSync(this.opts.pythonPath)) {
      return Promise.reject(new Error(`找不到 python：${this.opts.pythonPath}（配置 → 运行时）`));
    }
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      FISHSING_PORT: String(this.opts.port),
      FISHSING_TOKEN: this.opts.token || '',
      FISHSING_RVC_ROOT: this.opts.rvcRoot,
      // 自托管时 venv 与 rvc 代码平级，doctor 自检需要知道真正的 python 在哪
      FISHSING_RVC_PY: this.opts.pythonPath,
      FISHSING_MODEL: this.opts.model,
      FISHSING_INDEX: this.opts.index.startsWith('logs') || this.opts.index.startsWith('assets')
        ? join(this.opts.rvcRoot, this.opts.index)
        : this.opts.index,
      FISHSING_FFMPEG: join(this.opts.ffmpegDir, 'ffmpeg.exe'),
      FISHSING_SEP_PY: this.opts.separatePython,
      FISHSING_SEP_SCRIPT: this.opts.separateScript,
      FISHSING_WORK: this.opts.workDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    };
    this.log.info(`拉起唱歌 worker（端口 ${this.opts.port}）`);
    const child = spawn(this.opts.pythonPath, [SERVER_PY], {
      cwd: join(HERE, '..', 'worker'),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (c: Buffer) => {
      const s = c.toString('utf8').trim();
      if (s) this.log.info(`[worker] ${s.slice(0, 400)}`);
    });
    child.stderr?.on('data', (c: Buffer) => {
      const s = c.toString('utf8').trim();
      if (s) this.log.warn(`[worker:err] ${s.slice(0, 400)}`);
    });
    child.once('exit', (code) => {
      this.log.warn(`worker 退出（code=${code}）`);
      if (this.child === child) this.child = null;
    });
    this.child = child;

    const deadline = Date.now() + this.opts.startTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      const tick = async (): Promise<void> => {
        if (this.child === null) {
          reject(new Error('worker 启动后立刻退出了，看日志里的 [worker:err]'));
          return;
        }
        const h = await this.health(1500);
        // 只要服务在监听就算就绪：engine 可能是关预热（FISHSING_NO_WARMUP=1）的，
        // 那种情况下模型由 run_job 在真正要唱歌时再加载。
        if (h?.ok) {
          const e = h.engine;
          this.log.info(e?.ready
            ? `worker 就绪：${e.model}（加载 ${e.loadMs} ms）`
            : 'worker 就绪（模型未预热，第一次唱歌会多等几秒）');
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`worker 在 ${Math.round(this.opts.startTimeoutMs / 1000)} 秒内没就绪`));
          return;
        }
        setTimeout(() => void tick(), 800);
      };
      setTimeout(() => void tick(), 1200);
    });
  }

  async submit(kind: string, params: Record<string, unknown>): Promise<string> {
    await this.ensure();
    const res = await fetch(`${this.baseUrl}/job`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ kind, ...params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; message?: string };
    if (!res.ok || !body.id) throw new Error(`投任务失败：${body.message ?? `HTTP ${res.status}`}`);
    return body.id;
  }

  /**
   * 轮询直到 done/error/canceled。
   *
   * 两个超时是分开的，别混：
   * - `stallMs`：**多久没有新进度**才算卡住（默认 15 分钟）。唱歌、分离都会不停更新消息，
   *   所以这个值是有效的。
   * - `timeoutMs`：绝对上限，默认**不限**。
   *
   * 早先只有一个 15 分钟的绝对上限，结果训练跑到 15 分钟就被判「任务卡住」——
   * 界面报错、任务却还在跑（dfy3 实测 53 秒/轮 × 200 轮 ≈ 3 小时）。
   */
  async wait(
    id: string,
    onProgress?: (p: number, msg: string) => void,
    opts: number | { stallMs?: number; timeoutMs?: number } = {},
  ): Promise<JobState> {
    // 兼容旧写法：第三个参数直接给数字 = 绝对超时
    const o = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    const stallMs = o.stallMs ?? 15 * 60_000;
    const timeoutMs = o.timeoutMs ?? Number.POSITIVE_INFINITY;
    const started = Date.now();
    let lastChange = Date.now();
    let lastMsg = '';
    let lastPct = -1;

    for (;;) {
      const res = await fetch(`${this.baseUrl}/job/${id}`, { signal: AbortSignal.timeout(10_000) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; job?: JobState };
      const job = body.job;
      if (!job) throw new Error(`查不到任务 ${id}`);

      const pct = job.progress ?? 0;
      if ((job.message && job.message !== lastMsg) || Math.abs(pct - lastPct) > 1e-6) {
        lastMsg = job.message ?? lastMsg;
        lastPct = pct;
        lastChange = Date.now();
        onProgress?.(pct, job.message ?? '');
      }

      if (job.state === 'done') return job;
      if (job.state === 'error') throw new Error(job.message || '未知错误');
      if (job.state === 'canceled') throw new Error('已取消');

      const now = Date.now();
      if (now - lastChange > stallMs) {
        throw new Error(`已经 ${Math.max(1, Math.round(stallMs / 60_000))} 分钟没有任何进展，任务可能真的卡住了`);
      }
      if (now - started > timeoutMs) {
        throw new Error(`超过 ${Math.round(timeoutMs / 60_000)} 分钟上限`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  async cancel(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/stop`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* 没在跑就算了 */
    }
  }

  /** Coo 退出时把常驻进程收掉，不留孤儿占显存。 */
  shutdown(): void {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}
