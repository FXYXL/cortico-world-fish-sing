/**
 * 训练数据准备的前端编排：扫描素材、起数据集任务、读 manifest。
 *
 * 所有音频处理都在 Python worker 里做（dataset.py），这里只负责把结果整理成
 * 面板能直接画的结构——统计、分档、直方图分桶。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { WorkerClient } from './worker.ts';

export interface TrainSource {
  path: string;
  name: string;
  duration?: number;
  sr?: number;
  channels?: number;
  codec?: string;
  dry?: boolean;
  error?: string;
}

export interface SliceRecord {
  file: string;
  source: string;
  sourceIndex: number;
  start: number;
  dur: number;
  f0_median: number;
  f0_p90: number;
  voiced: number;
  peak: number;
  band: string;
  kept: boolean;
  drop: string | null;
}

export interface DatasetStats {
  sources: number;
  slices: number;
  kept: number;
  dropped: number;
  seconds: number;
  droppedByReason: Record<string, number>;
  byBand: Record<string, number>;
  elapsedSec: number;
}

export interface Manifest {
  version: number;
  createdAt: number;
  sr: number;
  params: Record<string, unknown>;
  bands: Array<{ id: string; min: number; max: number }>;
  sources: Array<Record<string, unknown>>;
  slices: SliceRecord[];
  stats: DatasetStats;
}

/** 丢弃原因的中文说法（面板、提示词共用）。 */
export const DROP_LABEL: Record<string, string> = {
  too_short: '太短（不足 2 秒）',
  too_quiet: '几乎没声音',
  clipped: '削波',
  f0_outlier: '音高异常（可能不是人声）',
};

export const BAND_LABEL: Record<string, string> = {
  low: '低音 <280',
  mid: '中音 280–400',
  high: '偏高 400–520',
  top: '高音 >520',
  unknown: '未测出',
};

async function call(worker: WorkerClient, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${worker.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...worker.authHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.message || `worker 返回 HTTP ${res.status}`);
  }
  return json;
}

export async function scanSources(worker: WorkerClient, paths: string[]): Promise<TrainSource[]> {
  await worker.ensure();
  const j = (await call(worker, '/scan', { paths })) as { items?: TrainSource[] };
  return j.items ?? [];
}

/** 音域直方图分桶：按 50 Hz 一档，给面板画柱状图。 */
export function f0Histogram(slices: SliceRecord[], binHz = 50): Array<{ from: number; to: number; n: number }> {
  const kept = slices.filter((s) => s.kept && s.f0_median > 0);
  if (!kept.length) return [];
  const lo = Math.floor(Math.min(...kept.map((s) => s.f0_median)) / binHz) * binHz;
  const hi = Math.ceil(Math.max(...kept.map((s) => s.f0_median)) / binHz) * binHz;
  const bins: Array<{ from: number; to: number; n: number }> = [];
  for (let f = lo; f < hi + binHz; f += binHz) bins.push({ from: f, to: f + binHz, n: 0 });
  for (const s of kept) {
    const i = Math.min(bins.length - 1, Math.max(0, Math.floor((s.f0_median - lo) / binHz)));
    bins[i].n += 1;
  }
  return bins;
}

/** 读某个数据集目录的 manifest（不存在返回 null）。 */
export function readManifest(dir: string): Manifest | null {
  const file = join(dir, 'manifest.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** 把统计整理成面板要显示的一段话。 */
export function summarize(m: Manifest): string {
  const s = m.stats;
  const mins = (s.seconds / 60).toFixed(1);
  const parts = [`${s.sources} 首 → ${s.kept} 片 / ${mins} 分钟`];
  if (s.dropped) {
    const why = Object.entries(s.droppedByReason)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${DROP_LABEL[k] ?? k} ${v}`)
      .join('、');
    parts.push(`丢弃 ${s.dropped} 片（${why}）`);
  }
  parts.push(`用时 ${s.elapsedSec.toFixed(0)} 秒`);
  return parts.join('；');
}

/** 数据集目录命名：按时间戳，和作品库风格一致。 */
export function datasetDirName(dataDir: string, prefix = 'ds'): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return join(dataDir, 'datasets', `${prefix}-${stamp}`);
}

export function dirLabel(dir: string): string {
  return basename(dir);
}

// ---------------------------------------------------------------- 音域权重

export type BandId = 'low' | 'mid' | 'high' | 'top';
export type BandMode = 'median' | 'p90' | 'mix';

export interface WeightConfig {
  mode: BandMode;
  bands: Record<BandId, number>;
}

export interface BandRow {
  id: BandId;
  label: string;
  n: number;
  seconds: number;
  /** 加权前的占比（按总时长） */
  share: number;
  /** 加权后的占比 */
  after: number;
  weight: number;
}

export const BAND_ORDER: BandId[] = ['low', 'mid', 'high', 'top'];

export const DEFAULT_WEIGHTS: WeightConfig = {
  mode: 'median',
  bands: { low: 1, mid: 1, high: 1, top: 1 },
};

/**
 * 预设。
 *
 * 每个都对应一个具体的听感问题——不是为了让人选花眼，而是这些是真实会遇到的四种毛病：
 * 男歌唱不了、高音发虚、整体糊、中音被挤掉。
 */
export const WEIGHT_PRESETS: Array<{ id: string; name: string; desc: string; cfg: WeightConfig }> = [
  {
    id: 'base',
    name: '均衡基线',
    desc: '全 1x，和现在的 dfy2 一样。做对比基准用。',
    cfg: { mode: 'median', bands: { low: 1, mid: 1, high: 1, top: 1 } },
  },
  {
    id: 'low',
    name: '补低音',
    desc: '治男歌。按主音域算，低音档 3x：占比 12% → 29%，低音样本相当于从 4 分钟变 12 分钟。',
    cfg: { mode: 'median', bands: { low: 3, mid: 1, high: 1, top: 1 } },
  },
  {
    id: 'high-soft',
    name: '微调高音',
    desc: '按最高音算，高音 1.5x：占比 32% → 41%。温和版，中音几乎不受影响。',
    cfg: { mode: 'p90', bands: { low: 1, mid: 1, high: 1, top: 1.5 } },
  },
  {
    id: 'high',
    name: '补高音',
    desc: '按最高音算，高音 3x + 偏高 1.5x：高音占比 32% → 54%，中音被压到 19%。效果强，代价也明显。',
    cfg: { mode: 'p90', bands: { low: 1, mid: 1, high: 1.5, top: 3 } },
  },
  {
    id: 'both',
    name: '两端都补',
    desc: '混合口径（低音看主音域、高音看最高音 540Hz+），两头各 2x。唯一能同时扩下限和上限的做法：低音 4→8 分钟、高音 5→10 分钟，中高音留住。',
    cfg: { mode: 'mix', bands: { low: 2, mid: 1, high: 1, top: 2 } },
  },
  {
    id: 'mid',
    name: '守住中音',
    desc: '混合口径，中音 1.5x + 低音 1.5x。怕加了极端档以后《我不难过》那种稳的感觉变差，用这个兜底。',
    cfg: { mode: 'mix', bands: { low: 1.5, mid: 1.5, high: 1, top: 1 } },
  },
  {
    id: 'sprint',
    name: '高音冲刺',
    desc: '按最高音，高音 4x + 偏高 2x + 中音 0.8x：高音 58%。只适合「就是要唱上去」的实验。',
    cfg: { mode: 'p90', bands: { low: 1, mid: 0.8, high: 2, top: 4 } },
  },
  {
    id: 'cool',
    name: '压住低音',
    desc: '反方向：低音只有 4 分钟，加权可能是在放大噪声。低音 0.5x、高音 1.5x（按主音域口径）。',
    cfg: { mode: 'median', bands: { low: 0.5, mid: 1, high: 1, top: 1.5 } },
  },
];

/** 按选定口径统计四档的片数、时长、占比。 */
export function bandStats(m: Manifest, mode: BandMode): Record<BandId, { n: number; seconds: number; share: number }> {
  const kept = m.slices.filter((s) => s.kept && s.f0_median > 0);
  const total = kept.reduce((n, s) => n + s.dur, 0) || 1;
  const out = {} as Record<BandId, { n: number; seconds: number; share: number }>;
  for (const id of BAND_ORDER) out[id] = { n: 0, seconds: 0, share: 0 };
  for (const s of kept) {
    const id = bandOfSlice(s, mode);
    if (id === 'unknown') continue;
    out[id].n += 1;
    out[id].seconds += s.dur;
  }
  for (const id of BAND_ORDER) out[id].share = out[id].seconds / total;
  return out;
}

function f0Band(f0: number): BandId | 'unknown' {
  if (f0 <= 0) return 'unknown';
  if (f0 < 280) return 'low';
  if (f0 < 400) return 'mid';
  if (f0 < 520) return 'high';
  return 'top';
}

/**
 * 按选定口径给一片分档。
 *
 * 为什么要 mix：低音和高音是两头的极端，一个片段很难同时"主音域低"和"最高音高"。
 * 单看中位，低音有量（4 分钟）高音没量（1.2 分钟）；单看 p90 反过来。
 * mix 的规则是「主音域落在低音区 → 算低音；否则只要唱到过 520 → 算高音；剩下按主音域」，
 * 这样两头的量都能用上，适合"想同时扩下限和上限"。
 */
function bandOfSlice(s: SliceRecord, mode: BandMode): BandId | 'unknown' {
  if (mode === 'p90') return f0Band(s.f0_p90);
  if (mode === 'median') return f0Band(s.f0_median);
  if (s.f0_median > 0 && s.f0_median < 280) return 'low';
  // 门槛比档位边界（520）高 20 Hz：混音口径里如果也用 520，会把大量"中高音"片段
  // 从「偏高」抢到「高音」，偏高只剩 11%，加权后直接被压平。540 时高音 5 分钟、
  // 偏高仍有 25 分钟，两头才真的能一起补。
  if (s.f0_p90 >= 540) return 'top';
  return f0Band(s.f0_median);
}

/** 加权后的四档占比（只算时长 × 权重的相对比例）。 */
export function weightedRows(m: Manifest, cfg: WeightConfig): BandRow[] {
  const st = bandStats(m, cfg.mode);
  const totalWeighted = BAND_ORDER.reduce((n, id) => n + st[id].seconds * (cfg.bands[id] ?? 1), 0) || 1;
  return BAND_ORDER.map((id) => ({
    id,
    label: BAND_LABEL[id] ?? id,
    n: st[id].n,
    seconds: Math.round(st[id].seconds),
    share: st[id].share,
    after: (st[id].seconds * (cfg.bands[id] ?? 1)) / totalWeighted,
    weight: cfg.bands[id] ?? 1,
  }));
}

const WEIGHTS_FILE = 'weights.json';

export function readWeights(dir: string): WeightConfig {
  const file = join(dir, WEIGHTS_FILE);
  if (!existsSync(file)) return { ...DEFAULT_WEIGHTS, bands: { ...DEFAULT_WEIGHTS.bands } };
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<WeightConfig>;
    return {
      mode: j.mode === 'p90' || j.mode === 'mix' ? j.mode : 'median',
      bands: {
        low: Number(j.bands?.low ?? 1),
        mid: Number(j.bands?.mid ?? 1),
        high: Number(j.bands?.high ?? 1),
        top: Number(j.bands?.top ?? 1),
      },
    };
  } catch {
    return { ...DEFAULT_WEIGHTS, bands: { ...DEFAULT_WEIGHTS.bands } };
  }
}

export function saveWeights(dir: string, cfg: WeightConfig): void {
  const clean: WeightConfig = {
    mode: cfg.mode === 'p90' || cfg.mode === 'mix' ? cfg.mode : 'median',
    bands: {
      low: clampWeight(cfg.bands.low),
      mid: clampWeight(cfg.bands.mid),
      high: clampWeight(cfg.bands.high),
      top: clampWeight(cfg.bands.top),
    },
  };
  writeFileSync(join(dir, WEIGHTS_FILE), `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
}

function clampWeight(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(0.2, Math.round(n * 10) / 10));
}

/** 供训练阶段用：每片的采样权重数组（顺序与 manifest.slices 中 kept 的一致）。 */
export function sliceWeights(m: Manifest, cfg: WeightConfig): Array<{ file: string; weight: number }> {
  return m.slices
    .filter((s) => s.kept)
    .map((s) => {
      const id = bandOfSlice(s, cfg.mode);
      return { file: s.file, weight: id === 'unknown' ? 1 : (cfg.bands[id] ?? 1) };
    });
}

// ---------------------------------------------------------------- 已有实验

export interface ExperimentInfo {
  exp: string;
  /** logs/<exp>/0_gt_wavs 里的切片数 */
  slices: number;
  gtDir: string;
  /** 这个实验有没有检索索引 */
  index: string | null;
  /** assets/weights 里属于这个实验的模型 */
  models: string[];
}

/**
 * 列出本机已有的训练实验（有切片的那种）。
 *
 * 为什么需要：想"在现有模型上补音域"，得先能看见它当初用了哪些切片。
 * RVC 把切片留在 logs/<exp>/0_gt_wavs，但训练完很多人会清掉——清掉了这里就看不到。
 */
export function listExperiments(rvcRoot: string, weights: string[] = []): ExperimentInfo[] {
  const logs = join(rvcRoot, 'logs');
  if (!existsSync(logs)) return [];
  const out: ExperimentInfo[] = [];
  for (const name of readdirSync(logs, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const exp = name.name;
    const gtDir = join(logs, exp, '0_gt_wavs');
    if (!existsSync(gtDir)) continue;
    const slices = readdirSync(gtDir).filter((f) => f.endsWith('.wav') && !f.includes('.spec.')).length;
    if (!slices) continue;
    out.push({
      exp,
      slices,
      gtDir,
      index: findIndexIn(logs, exp),
      models: weights.filter((m) => m.replace(/\.pth$/i, '').replace(/_e\d+(_s\d+)?$/, '') === exp),
    });
  }
  return out.sort((a, b) => b.slices - a.slices);
}

function findIndexIn(logs: string, exp: string): string | null {
  const dir = join(logs, exp);
  if (!existsSync(dir)) return null;
  const idx = readdirSync(dir).filter((f) => f.endsWith('.index'));
  return idx.length ? join('logs', exp, idx[0]) : null;
}

// ---------------------------------------------------------------- 数据集管理

export interface DatasetInfo {
  dir: string;
  name: string;
  slices: number;
  seconds: number;
  sources: number;
  /** 是从已有实验导入的，还是自己分离切出来的 */
  imported: boolean;
  /** 导入自哪个实验（imported 时才有） */
  fromExp: string;
  /** 关联的模型文件（说明这份数据已经训出模型了，删之前要想想） */
  models: string[];
  sizeMb: number;
  createdAt: number;
  current: boolean;
}

const DATASET_STATE = 'dataset.json';

export function readDatasetState(dataDir: string): string {
  const f = join(dataDir, DATASET_STATE);
  if (!existsSync(f)) return '';
  try {
    return String((JSON.parse(readFileSync(f, 'utf8')) as { dir?: string }).dir ?? '');
  } catch {
    return '';
  }
}

export function writeDatasetState(dataDir: string, dir: string): void {
  writeFileSync(join(dataDir, DATASET_STATE), `${JSON.stringify({ dir }, null, 2)}\n`, 'utf8');
}

function dirSizeMb(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          /* 被占用的文件跳过 */
        }
      }
    }
  };
  walk(dir);
  return Math.round((total / 1048576) * 10) / 10;
}

/** 从 manifest 里的 importFrom 反推实验名：...\logs\dfy2\0_gt_wavs → dfy2 */
function expFromGtDir(p: string): string {
  const m = String(p ?? '').match(/logs[\\/]([^\\/]+)[\\/]0_gt_wavs/i);
  return m ? m[1] : '';
}

/**
 * 列出所有数据集（扫 datasets/*\/manifest.json）。
 *
 * 为什么要单独列：当前数据集只存在内存里，重启 Coo 就看不到了；
 * 而且切完片没训练的数据集会一直占着磁盘（几百 MB 一份），得能删。
 */
export function listDatasets(dataDir: string, weights: string[], currentDir: string): DatasetInfo[] {
  const root = join(dataDir, 'datasets');
  if (!existsSync(root)) return [];
  const out: DatasetInfo[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const m = readManifest(dir);
    if (!m) continue;
    const fromExp = expFromGtDir(String(m.params?.importFrom ?? ''));
    const models = fromExp
      ? weights.filter((w) => w.replace(/\.pth$/i, '').replace(/_e\d+(_s\d+)?$/, '') === fromExp)
      : [];
    out.push({
      dir,
      name: e.name,
      slices: m.stats.kept,
      seconds: m.stats.seconds,
      sources: m.stats.sources,
      imported: Boolean(m.params?.importFrom),
      fromExp,
      models,
      sizeMb: dirSizeMb(dir),
      createdAt: m.createdAt,
      current: dir === currentDir,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------- 训练进度

export interface LossPoint {
  epoch: number;
  mel: number;
  gen: number;
  disc: number;
  fm: number;
  kl: number;
}

export interface TrainLog {
  /** 已完成的轮次（从日志里的「====> 轮次：N」推算，N 从 0 开始） */
  done: number;
  /** 每轮平均耗时（秒），只有拿到两轮以上才有 */
  secPerEpoch: number | null;
  losses: LossPoint[];
  /** 最近一行 loss，面板显示当前值用 */
  latest: LossPoint | null;
  /** 日志里的最后一条错误（有就说明训练可能出事了） */
  error: string;
}

/**
 * 从 logs/<exp>/train.log 里读训练进度。
 *
 * 为什么读文件而不是读 stdout：RVC 的训练日志只走 FileHandler（`utils.get_logger`），
 * stdout 里根本没有轮次信息。所以进度只能 tail 这个文件。
 */
export function readTrainLog(expDir: string, maxLines = 400): TrainLog {
  const file = join(expDir, 'train.log');
  const empty: TrainLog = { done: 0, secPerEpoch: null, losses: [], latest: null, error: '' };
  if (!existsSync(file)) return empty;
  let text = '';
  try {
    const buf = readFileSync(file);
    // 只读尾部：3 小时的日志能到几 MB，全读进内存没必要
    text = buf.subarray(Math.max(0, buf.length - 262144)).toString('utf8');
  } catch {
    return empty;
  }
  const lines = text.split(/\r?\n/).slice(-maxLines);
  let done = 0;
  const secs: number[] = [];
  const losses: LossPoint[] = [];
  let error = '';
  let pending: Partial<LossPoint> = {};

  for (const line of lines) {
    const m = /====>\s*轮次：(\d+).*?\((\d+):(\d+):([\d.]+)\)/.exec(line);
    if (m) {
      done = Number(m[1]) + 1;
      secs.push(Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]));
      continue;
    }
    if (line.includes('loss_disc')) {
      const pick = (k: string) => {
        const r = new RegExp(`${k}=([0-9.]+)`).exec(line);
        return r ? Number(r[1]) : 0;
      };
      pending = {
        epoch: done,
        mel: pick('loss_mel'),
        gen: pick('loss_gen'),
        disc: pick('loss_disc'),
        fm: pick('loss_fm'),
        kl: pick('loss_kl'),
      };
      if (pending.mel) {
        losses.push(pending as LossPoint);
        pending = {};
      }
      continue;
    }
    if (line.includes('ERROR') || line.includes('Traceback') || line.includes('RuntimeError')) {
      error = line.replace(/^.*?(ERROR|Traceback|RuntimeError)\s*/, '$1 ').slice(0, 200);
    }
  }

  // 去掉第一轮（含模型加载，时间偏大），取中位数更稳
  const steady = secs.length > 2 ? secs.slice(1) : secs;
  const secPerEpoch = steady.length ? steady.sort((a, b) => a - b)[Math.floor(steady.length / 2)] : null;

  return {
    done,
    secPerEpoch,
    losses: losses.slice(-120),
    latest: losses.length ? losses[losses.length - 1] : null,
    error,
  };
}

/** 训练建议参数：批大小按显存给，轮次按数据量给。 */
export function suggestTrainParams(seconds: number): { epochs: number; batch: number; note: string } {
  const minutes = seconds / 60;
  if (minutes < 10) return { epochs: 300, batch: 4, note: '数据不到 10 分钟，轮次要更多才学得动' };
  if (minutes < 20) return { epochs: 250, batch: 4, note: '数据偏少，250 轮左右' };
  if (minutes < 45) return { epochs: 200, batch: 4, note: '33 分钟左右用 200 轮，之前 dfy2 就是这个配置' };
  return { epochs: 160, batch: 4, note: '数据超过 45 分钟，每轮变慢，160 轮通常够了' };
}

// ---------------------------------------------------------------- 中间档清理

export interface PrunePlan {
  /** 会保留的文件 */
  keep: string[];
  /** 会删掉的模型文件 */
  remove: string[];
  /**
   * 顺手清掉的临时文件（目前是 `logs/<exp>/total_fea.npy`：建索引时的汇总，
   * 索引建完就没用了，重建时会自动重新生成，占 200~300 MB）。
   */
  scratch: string[];
  /** 能释放多少 MB */
  freedMb: number;
  /** 被删文件总共占多少 MB */
  totalMb: number;
}

/**
 * 规划「每 N 轮留一个」要删哪些 checkpoint。
 *
 * 只碰 `assets/weights/<exp>_eN_sX.pth` 这类**导出的小模型**，不碰：
 * - `<exp>.pth`（最终模型，训练结束时写的）
 * - `logs/<exp>/G_2333333.pth`、`D_2333333.pth`（完整存档，续训要用）
 * - `.index`（唱歌时要加载）
 *
 * 默认保留：最终模型 + 最新的那个 + 每隔 keepEvery 轮的一个。
 * 这样既能把 20 个压到 4~5 个，又不至于想 A/B 时手里没档。
 */
export function planPruneCheckpoints(weightsDir: string, exp: string, keepEvery = 50): PrunePlan {
  const dir = weightsDir;
  const plan: PrunePlan = { keep: [], remove: [], scratch: [], freedMb: 0, totalMb: 0 };
  if (!existsSync(dir)) return plan;

  const re = new RegExp(`^${exp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_e(\\d+)_s\\d+\\.pth$`);
  const rows: Array<{ name: string; epoch: number; mb: number }> = [];
  for (const f of readdirSync(dir)) {
    const m = re.exec(f);
    if (!m) continue;
    let mb = 0;
    try {
      mb = Math.round((statSync(join(dir, f)).size / 1048576) * 10) / 10;
    } catch {
      /* 读不到就当 0 */
    }
    rows.push({ name: f, epoch: Number(m[1]), mb });
  }
  if (!rows.length) return plan;
  rows.sort((a, b) => a.epoch - b.epoch);

  const step = Math.max(1, Math.round(keepEvery));
  const newest = rows[rows.length - 1].epoch;
  for (const r of rows) {
    const keep = r.epoch % step === 0 || r.epoch === newest;
    if (keep) plan.keep.push(r.name);
    else {
      plan.remove.push(r.name);
      plan.freedMb += r.mb;
    }
    plan.totalMb += r.mb;
  }
  plan.freedMb = Math.round(plan.freedMb * 10) / 10;
  plan.totalMb = Math.round(plan.totalMb * 10) / 10;
  return plan;
}

/** 执行清理，返回实际删掉的文件名。 */
export function pruneCheckpoints(
  weightsDir: string,
  exp: string,
  keepEvery = 50,
  logsRoot?: string,
): PrunePlan {
  const plan = planPruneCheckpoints(weightsDir, exp, keepEvery);
  for (const name of plan.remove) {
    try {
      rmSync(join(weightsDir, name), { force: true });
    } catch {
      /* 被占用就跳过，下次再删 */
    }
  }
  if (logsRoot) {
    const scratch = join(logsRoot, exp, 'total_fea.npy');
    if (existsSync(scratch)) {
      try {
        const mb = Math.round((statSync(scratch).size / 1048576) * 10) / 10;
        rmSync(scratch, { force: true });
        plan.scratch.push('total_fea.npy');
        plan.freedMb = Math.round((plan.freedMb + mb) * 10) / 10;
      } catch {
        /* 跳过 */
      }
    }
  }
  return plan;
}

/** 某个实验目前有几个中间档、共占多大。 */
export function checkpointStats(weightsDir: string, exp: string): { n: number; totalMb: number } {
  // 不能复用 planPrune（大 step 会把「最新那个」以外的都算成待删），这里老实扫一遍
  let n = 0;
  let totalMb = 0;
  if (!existsSync(weightsDir)) return { n: 0, totalMb: 0 };
  const re = new RegExp(`^${exp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_e(\\d+)_s\\d+\\.pth$`);
  for (const f of readdirSync(weightsDir)) {
    if (!re.test(f)) continue;
    n += 1;
    try {
      totalMb += statSync(join(weightsDir, f)).size / 1048576;
    } catch {
      /* 读不到就当 0 */
    }
  }
  return { n, totalMb: Math.round(totalMb * 10) / 10 };
}

// ---------------------------------------------------------------- 训练状态持久化

export interface TrainState {
  exp: string;
  epochs: number;
  startedAt: number;
}

const TRAIN_STATE = 'train.json';

/**
 * 记住上次训练的实验名。
 *
 * 为什么需要：Coo 重启后 `trainJob` 是内存里的东西，没了。
 * 不记住的话面板打开是空的，明明训练还在跑（日志一直在写），却什么也看不到。
 */
export function readTrainState(dataDir: string): TrainState {
  const f = join(dataDir, TRAIN_STATE);
  if (!existsSync(f)) return { exp: '', epochs: 0, startedAt: 0 };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as Partial<TrainState>;
    return { exp: String(j.exp ?? ''), epochs: Number(j.epochs ?? 0), startedAt: Number(j.startedAt ?? 0) };
  } catch {
    return { exp: '', epochs: 0, startedAt: 0 };
  }
}

export function writeTrainState(dataDir: string, st: TrainState): void {
  writeFileSync(join(dataDir, TRAIN_STATE), `${JSON.stringify(st, null, 2)}\n`, 'utf8');
}

/** 训练日志最后一次更新距今多少秒；没有日志返回 null。 */
export function logAgeSec(expDir: string): number | null {
  const f = join(expDir, 'train.log');
  if (!existsSync(f)) return null;
  try {
    return Math.round((Date.now() - statSync(f).mtimeMs) / 1000);
  } catch {
    return null;
  }
}

/**
 * 找出「正在训练/最近训练过」的实验名。
 *
 * 为什么需要：面板原本靠 `train.json` 记的实验名。但那次训练是在加这个功能**之前**
 * 开始的，重启后既没有 train.json、新 worker 也不认识那个任务（孤儿进程），
 * 于是面板一片空白——训练明明还在跑。
 *
 * 做法：扫每个实验目录下的 train.log，优先挑 3 分钟内还在更新的那个；没有就挑最后改过的那个。
 */
export function findActiveExperiment(logsRoot: string, staleSec = 180): string {
  if (!existsSync(logsRoot)) return '';
  let fresh = { exp: '', mtime: 0 };
  let latest = { exp: '', mtime: 0 };
  for (const e of readdirSync(logsRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = join(logsRoot, e.name, 'train.log');
    try {
      const mt = statSync(f).mtimeMs;
      if (mt > latest.mtime) latest = { exp: e.name, mtime: mt };
      if (Date.now() - mt < staleSec * 1000 && mt > fresh.mtime) fresh = { exp: e.name, mtime: mt };
    } catch {
      /* 没有 train.log 的实验跳过 */
    }
  }
  return fresh.exp || latest.exp;
}
