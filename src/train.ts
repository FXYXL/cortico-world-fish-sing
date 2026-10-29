/**
 * 训练数据准备的前端编排：扫描素材、起数据集任务、读 manifest。
 *
 * 所有音频处理都在 Python worker 里做（dataset.py），这里只负责把结果整理成
 * 面板能直接画的结构——统计、分档、直方图分桶。
 */
import { existsSync, readFileSync } from 'node:fs';
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
