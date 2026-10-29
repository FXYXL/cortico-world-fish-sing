/**
 * 缓存与作品库。
 *
 * 缓存解决"同一首歌点两次要等 90 秒"的问题：key 里带上所有影响音色的参数
 * （model / index / index-rate / protect / pitch / mode），参数一变就不命中——
 * 宁可重算，也不要拿旧参数的结果糊弄。
 *
 * 作品库是她的"歌单"：每一首都留一份 mp3 + 元数据，能回放、能列出来。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SingParams {
  model: string;
  index: string;
  indexRate: number;
  protect: number;
  pitch: number;
  mode: string;
}

export interface LibraryEntry {
  id: string;
  title: string;
  source: string;
  bvid: string;
  file: string;
  durationSec: number;
  at: number;
  params: SingParams;
  target: string;
}

export interface LibraryOptions {
  dataDir: string;
}

function files(opts: LibraryOptions) {
  const cacheDir = join(opts.dataDir, 'cache');
  const libDir = join(opts.dataDir, 'library');
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  return { cacheDir, libDir, indexFile: join(libDir, 'index.json') };
}

/** 缓存键：源标识 + 全部音色参数。 */
export function cacheKey(sourceId: string, p: SingParams): string {
  const raw = [
    sourceId,
    p.model,
    p.index,
    p.indexRate.toFixed(3),
    p.protect.toFixed(3),
    String(p.pitch),
    p.mode,
  ].join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 20);
}

export function cacheGet(opts: LibraryOptions, key: string): string | null {
  const { cacheDir } = files(opts);
  const f = join(cacheDir, `${key}.mp3`);
  return existsSync(f) ? f : null;
}

export function cachePut(opts: LibraryOptions, key: string, mp3: string): string {
  const { cacheDir } = files(opts);
  const dst = join(cacheDir, `${key}.mp3`);
  copyFileSync(mp3, dst);
  return dst;
}

export function loadLibrary(opts: LibraryOptions): LibraryEntry[] {
  const { indexFile } = files(opts);
  try {
    const rows = JSON.parse(readFileSync(indexFile, 'utf8')) as LibraryEntry[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function saveLibrary(opts: LibraryOptions, rows: LibraryEntry[]): void {
  const { indexFile } = files(opts);
  writeFileSync(indexFile, JSON.stringify(rows.slice(0, 500), null, 2), 'utf8');
}

/** 收进作品库（同一首歌重复唱会覆盖旧条目，不留一堆同名的）。 */
export function addToLibrary(opts: LibraryOptions, entry: LibraryEntry, mp3: string): LibraryEntry {
  const { libDir } = files(opts);
  const dst = join(libDir, `${entry.id}.mp3`);
  copyFileSync(mp3, dst);
  const rows = loadLibrary(opts).filter((r) => r.id !== entry.id);
  rows.unshift({ ...entry, file: dst });
  saveLibrary(opts, rows);
  return { ...entry, file: dst };
}

export function listLibrary(opts: LibraryOptions, limit = 10): LibraryEntry[] {
  return loadLibrary(opts).slice(0, Math.max(1, limit));
}

/** 按标题模糊找（她可能只说"那首星落的歌"）。 */
export function findInLibrary(opts: LibraryOptions, query: string): LibraryEntry | null {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const rows = loadLibrary(opts);
  return rows.find((r) => r.title.toLowerCase().includes(q) || r.id === q) ?? null;
}

export function dropFromLibrary(opts: LibraryOptions, query: string): LibraryEntry | null {
  const hit = findInLibrary(opts, query);
  if (!hit) return null;
  const rows = loadLibrary(opts).filter((r) => r.id !== hit.id);
  saveLibrary(opts, rows);
  try {
    if (existsSync(hit.file)) unlinkSync(hit.file);
  } catch {
    /* 文件被占用就留着，至少索引里没了 */
  }
  return hit;
}

/** 缓存清理：超过 maxAgeDays 的缓存文件删掉（作品库不动）。 */
export function pruneCache(opts: LibraryOptions, maxAgeDays = 14): number {
  const { cacheDir } = files(opts);
  const cut = Date.now() - maxAgeDays * 86400_000;
  let n = 0;
  try {
    for (const name of readdirSync(cacheDir)) {
      const f = join(cacheDir, name);
      try {
        if (statSync(f).mtimeMs < cut) {
          unlinkSync(f);
          n += 1;
        }
      } catch {
        /* 单个文件失败不影响其它 */
      }
    }
  } catch {
    /* 目录都没有就算了 */
  }
  return n;
}
