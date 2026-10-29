/**
 * 训练数据准备的前端编排：扫描素材、起数据集任务、读 manifest。
 *
 * 所有音频处理都在 Python worker 里做（dataset.py），这里只负责把结果整理成
 * 面板能直接画的结构——统计、分档、直方图分桶。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
