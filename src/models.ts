/**
 * 模型（.pth）管理：列出、切换、删除、导入。
 *
 * 「当前用哪个」不写 Coo 的 config.json —— 那是用户配置，写进去要重启 Coo 才生效，
 * 也容易被 Coo 退出时的内存快照覆盖。这里单独存 <数据目录>/model.json，
 * 切换后立刻作用于 worker（重启它即可），配置里的 voice.model 只当出厂默认值。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { WorkerPaths } from './paths.ts';

export interface ModelEntry {
  name: string;
  sizeMb: number;
  mtime: number;
  /** 从文件名解析：dfy2_e130_s8190.pth → 130 */
  epoch: number | null;
  step: number | null;
  /** 实验名：dfy2_e130_s8190.pth → dfy2 */
  exp: string;
  /** 这个实验对应的检索索引（相对 rvcRoot），没有就是 null */
  index: string | null;
  current: boolean;
}

export interface CurrentModel {
  model: string;
  index: string;
}

const CURRENT_FILE = 'model.json';

function currentPath(dataDir: string): string {
  return join(dataDir, CURRENT_FILE);
}

/** 读出「当前用哪个模型」；没存过就用配置里的默认值。 */
export function readCurrent(dataDir: string, fallback: CurrentModel): CurrentModel {
  try {
    const j = JSON.parse(readFileSync(currentPath(dataDir), 'utf8')) as Partial<CurrentModel>;
    if (j.model) return { model: String(j.model), index: String(j.index ?? '') };
  } catch {
    /* 没存过或者坏了，用默认值 */
  }
  return { ...fallback };
}

export function writeCurrent(dataDir: string, cur: CurrentModel): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(currentPath(dataDir), `${JSON.stringify(cur, null, 2)}\n`, 'utf8');
}

/** 从文件名拆出实验名与轮次：`dfy2_e130_s8190.pth` → { exp:'dfy2', epoch:130, step:8190 }。 */
export function parseModelName(name: string): { exp: string; epoch: number | null; step: number | null } {
  const base = name.replace(/\.pth$/i, '');
  const m = base.match(/^(.*?)_e(\d+)(?:_s(\d+))?$/);
  if (m) return { exp: m[1], epoch: Number(m[2]), step: m[3] ? Number(m[3]) : null };
  return { exp: base, epoch: null, step: null };
}

/** 某个实验目录下最新的索引（相对路径）。 */
export function findIndex(paths: WorkerPaths, exp: string): string | null {
  const dir = join(paths.rvcRoot, 'logs', exp);
  if (!existsSync(dir)) return null;
  const idx = readdirSync(dir)
    .filter((f) => f.endsWith('.index'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return idx.length ? `logs/${exp}/${idx[0].f}` : null;
}

export function listModels(paths: WorkerPaths, currentName: string): ModelEntry[] {
  const dir = join(paths.rvcRoot, 'assets', 'weights');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.pth'))
    .map((f) => {
      const full = join(dir, f);
      const st = statSync(full);
      const { exp, epoch, step } = parseModelName(f);
      return {
        name: f,
        sizeMb: Math.round((st.size / 1048576) * 10) / 10,
        mtime: st.mtimeMs,
        epoch,
        step,
        exp,
        index: findIndex(paths, exp),
        current: f === currentName,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** 切到某个模型：写状态 + 返回新的 model/index，由调用方重启 worker。 */
export function useModel(paths: WorkerPaths, dataDir: string, name: string): CurrentModel {
  const file = join(paths.rvcRoot, 'assets', 'weights', name);
  if (!existsSync(file)) throw new Error(`没有这个模型：${name}`);
  const { exp } = parseModelName(name);
  const index = findIndex(paths, exp) ?? '';
  const cur = { model: name, index };
  writeCurrent(dataDir, cur);
  return cur;
}

export function deleteModel(paths: WorkerPaths, dataDir: string, name: string): void {
  const cur = readCurrent(dataDir, { model: '', index: '' });
  if (cur.model === name) throw new Error('这是正在用的模型，先切到别的再删');
  const file = join(paths.rvcRoot, 'assets', 'weights', name);
  if (!existsSync(file)) throw new Error(`没有这个模型：${name}`);
  rmSync(file, { force: true });
}

/** 从外部路径导入一个 .pth（比如别的 RVC 项目里训练好的）。 */
export function importModel(paths: WorkerPaths, src: string): { name: string; index: string | null } {
  if (!existsSync(src)) throw new Error(`找不到文件：${src}`);
  if (!src.toLowerCase().endsWith('.pth')) throw new Error('只支持 .pth');
  const name = basename(src);
  const dir = join(paths.rvcRoot, 'assets', 'weights');
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, name);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) {
    return { name, index: findIndex(paths, parseModelName(name).exp) };
  }
  copyFileSync(src, dst);
  return { name, index: findIndex(paths, parseModelName(name).exp) };
}
