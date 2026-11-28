/**
 * 个人曲库记忆与拿手歌本（Repertoire）。
 *
 * 与作品库（library）的职责分工：
 *  · library 是按「单次录音文件」存的磁带架，同一首歌可能有好几版试唱；
 *  · repertoire 是按「歌曲」存的乐谱笔记本，记录星标拿手曲、情绪标签、唱法心得、
 *    最顺耳的参数配方（模型 / 移调 / 音高算法 / 主副歌演绎 / LRC 偏移）与定稿录音 ID。
 *
 * 数据存放在 <dataDir>/repertoire.json，平时不注入常驻提示词，仅在点歌或按需查歌本时读取。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LibraryEntry, SingParams } from './library.ts';

export interface RepertoireRecipe {
  model?: string;
  pitch?: number | 'auto';
  indexRate?: number;
  protect?: number;
  rmsMixRate?: number;
  harmony?: 'off' | 'double' | 'double+third' | 'third' | 'third+fifth';
  reverb?: 'off' | 'light';
  polish?: boolean;
  f0Method?: 'rmvpe' | 'fcpe';
  separator?: 'htdemucs' | 'roformer';
  dereverb?: boolean;
  dynamicStyle?: 'off' | 'soft-verse-bright-chorus';
  mode?: 'full' | 'vocals';
  lrcOffsetSec?: number;
}

export interface RepertoireItem {
  key: string;
  title: string;
  source: string;
  bvid: string;
  favorite: boolean;
  tags: string[];
  note: string;
  bestLibraryId: string;
  bestParams: RepertoireRecipe;
  singCount: number;
  lastSungAt: number;
  updatedAt: number;
}

function filePath(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, 'repertoire.json');
}

/** 归一化歌名用于匹配同一首歌，忽略括号装饰与标点空白。 */
export function normSongKey(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[《》【】\[\]()（）「」『』“”‘’"'·•\-_|｜/\\.,!?，。！？~～:：;；\s]+/g, '');
}

/** 根据 BV 号或歌名生成稳定的歌本主键。 */
export function repertoireKeyOf(info: { bvid?: string; title?: string; source?: string }): string {
  const bv = String(info.bvid || '').trim();
  if (/^BV[0-9A-Za-z]{10}$/i.test(bv)) return `bili:${bv}`;
  const core = normSongKey(info.title || info.source || '');
  return core ? `song:${core}` : `song:${Date.now()}`;
}

export function loadRepertoire(dataDir: string): RepertoireItem[] {
  const f = filePath(dataDir);
  if (!existsSync(f)) return [];
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw as RepertoireItem[];
  } catch {
    return [];
  }
}

export function saveRepertoire(dataDir: string, items: RepertoireItem[]): void {
  const sorted = items.slice().sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  writeFileSync(filePath(dataDir), JSON.stringify(sorted, null, 2), 'utf8');
}

/** 把标签参数统一规范成去重数组（支持数组或逗号/顿号/空格分隔字符串）。 */
export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 8);
  }
  const s = String(raw || '').trim();
  if (!s) return [];
  return Array.from(new Set(s.split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean))).slice(0, 8);
}

/** 从一次演唱参数里提炼适合沉淀进歌本的配方对象。 */
export function extractRecipe(params: Partial<SingParams> | undefined, lrcOffsetSec?: number): RepertoireRecipe {
  const p = params ?? {};
  const recipe: RepertoireRecipe = {};
  if (p.model) recipe.model = String(p.model);
  if (p.pitch !== undefined) recipe.pitch = p.pitch;
  if (p.indexRate !== undefined) recipe.indexRate = Number(p.indexRate);
  if (p.protect !== undefined) recipe.protect = Number(p.protect);
  if (p.rmsMixRate !== undefined) recipe.rmsMixRate = Number(p.rmsMixRate);
  if (p.harmony) recipe.harmony = p.harmony;
  if (p.reverb) recipe.reverb = p.reverb;
  if (p.polish !== undefined) recipe.polish = Boolean(p.polish);
  if (p.f0Method) recipe.f0Method = p.f0Method;
  if (p.separator) recipe.separator = p.separator;
  if (p.dereverb !== undefined) recipe.dereverb = Boolean(p.dereverb);
  if (p.dynamicStyle) recipe.dynamicStyle = p.dynamicStyle;
  if (p.mode === 'vocals' || p.mode === 'full') recipe.mode = p.mode;
  if (typeof lrcOffsetSec === 'number' && Number.isFinite(lrcOffsetSec) && Math.abs(lrcOffsetSec) >= 0.05) {
    recipe.lrcOffsetSec = Math.round(lrcOffsetSec * 100) / 100;
  }
  return recipe;
}

/** 按作品 ID / BV 号 / 源路径 / 歌名精准或模糊查找歌本条目。 */
export function findRepertoire(
  dataDir: string,
  query: { libraryId?: string; bvid?: string; source?: string; title?: string; text?: string },
): RepertoireItem | null {
  const list = loadRepertoire(dataDir);
  if (!list.length) return null;

  if (query.libraryId) {
    const byLib = list.find((it) => it.bestLibraryId === query.libraryId);
    if (byLib) return byLib;
  }
  const bv = String(query.bvid || '').trim().toLowerCase();
  if (bv) {
    const byBv = list.find((it) => it.bvid && it.bvid.toLowerCase() === bv);
    if (byBv) return byBv;
  }
  const src = String(query.source || '').trim();
  if (src) {
    const bySrc = list.find((it) => it.source && it.source === src);
    if (bySrc) return bySrc;
  }
  const titleCore = normSongKey(query.title || query.text || '');
  if (titleCore) {
    const exact = list.find((it) => normSongKey(it.title) === titleCore);
    if (exact) return exact;
    const fuzzy = list.find((it) => {
      const c = normSongKey(it.title);
      return c && (c.includes(titleCore) || titleCore.includes(c));
    });
    if (fuzzy) return fuzzy;
  }
  return null;
}

/** 新增或更新一条歌本记录（自动按 key 去重合并）。 */
export function upsertRepertoire(
  dataDir: string,
  input: {
    title: string;
    source?: string;
    bvid?: string;
    favorite?: boolean;
    tags?: string[];
    note?: string;
    bestLibraryId?: string;
    bestParams?: RepertoireRecipe;
  },
): RepertoireItem {
  const list = loadRepertoire(dataDir);
  const key = repertoireKeyOf(input);
  const now = Date.now();
  const idx = list.findIndex((it) => it.key === key
    || (input.bvid && it.bvid && it.bvid.toLowerCase() === input.bvid.toLowerCase())
    || (normSongKey(it.title) && normSongKey(it.title) === normSongKey(input.title)));
  const prev = idx >= 0 ? list[idx] : null;
  const item: RepertoireItem = {
    key: prev?.key ?? key,
    title: String(input.title || prev?.title || '').trim(),
    source: String(input.source || prev?.source || ''),
    bvid: String(input.bvid || prev?.bvid || ''),
    favorite: input.favorite !== undefined ? input.favorite : (prev?.favorite ?? true),
    tags: input.tags && input.tags.length ? input.tags : (prev?.tags ?? []),
    note: input.note !== undefined ? String(input.note).trim() : (prev?.note ?? ''),
    bestLibraryId: String(input.bestLibraryId || prev?.bestLibraryId || ''),
    bestParams: input.bestParams ? { ...(prev?.bestParams ?? {}), ...input.bestParams } : (prev?.bestParams ?? {}),
    singCount: Math.max(1, prev?.singCount ?? 1),
    lastSungAt: prev?.lastSungAt ?? now,
    updatedAt: now,
  };
  if (idx >= 0) list[idx] = item;
  else list.unshift(item);
  saveRepertoire(dataDir, list);
  return item;
}

/** 作品库一键星标/取消星标：已星标且指向本条则取消，否则将本条录音与参数设为该曲拿手定稿。 */
export function toggleFavoriteFromLibrary(
  dataDir: string,
  entry: LibraryEntry,
  lrcOffsetSec?: number,
): { item: RepertoireItem; favored: boolean } {
  const list = loadRepertoire(dataDir);
  const key = repertoireKeyOf({ bvid: entry.bvid, title: entry.title, source: entry.source });
  const idx = list.findIndex((it) => it.bestLibraryId === entry.id
    || it.key === key
    || (entry.bvid && it.bvid && it.bvid.toLowerCase() === entry.bvid.toLowerCase()));
  const prev = idx >= 0 ? list[idx] : null;
  if (prev && prev.favorite && prev.bestLibraryId === entry.id) {
    const next: RepertoireItem = { ...prev, favorite: false, updatedAt: Date.now() };
    list[idx] = next;
    saveRepertoire(dataDir, list);
    return { item: next, favored: false };
  }
  const item = upsertRepertoire(dataDir, {
    title: entry.title,
    source: entry.source,
    bvid: entry.bvid,
    favorite: true,
    bestLibraryId: entry.id,
    bestParams: extractRecipe(entry.params, lrcOffsetSec),
  });
  return { item, favored: true };
}

/** 从歌本删除匹配条目。 */
export function removeRepertoire(dataDir: string, query: string): RepertoireItem | null {
  const q = String(query || '').trim();
  if (!q) return null;
  const list = loadRepertoire(dataDir);
  const core = normSongKey(q);
  const idx = list.findIndex((it) => it.key === q
    || it.bestLibraryId === q
    || (it.bvid && it.bvid.toLowerCase() === q.toLowerCase())
    || (core && (normSongKey(it.title) === core || normSongKey(it.title).includes(core))));
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  saveRepertoire(dataDir, list);
  return removed;
}

/** 唱完一首后若已在歌本里，悄悄累计唱次与最近时间（不主动把未收藏的歌塞进歌本）。 */
export function recordSingCount(
  dataDir: string,
  info: { bvid?: string; source?: string; title?: string; lrcOffsetSec?: number },
): void {
  const list = loadRepertoire(dataDir);
  const hit = findRepertoire(dataDir, info);
  if (!hit) return;
  const idx = list.findIndex((it) => it.key === hit.key);
  if (idx < 0) return;
  const nextParams = { ...list[idx].bestParams };
  if (typeof info.lrcOffsetSec === 'number' && Number.isFinite(info.lrcOffsetSec) && nextParams.lrcOffsetSec === undefined) {
    nextParams.lrcOffsetSec = Math.round(info.lrcOffsetSec * 100) / 100;
  }
  list[idx] = {
    ...list[idx],
    singCount: (list[idx].singCount || 0) + 1,
    lastSungAt: Date.now(),
    bestParams: nextParams,
  };
  saveRepertoire(dataDir, list);
}

/** 按标签/星标从歌本里挑一首（优先避开刚刚唱过的那一首）。 */
export function pickRepertoire(
  dataDir: string,
  opts?: { tag?: string; favoriteOnly?: boolean; excludeKey?: string },
): RepertoireItem | null {
  let pool = loadRepertoire(dataDir);
  if (!pool.length) return null;
  if (opts?.favoriteOnly !== false) {
    const favs = pool.filter((it) => it.favorite);
    if (favs.length) pool = favs;
  }
  const tag = String(opts?.tag || '').trim().toLowerCase();
  if (tag) {
    const tagged = pool.filter((it) => it.tags.some((t) => t.toLowerCase().includes(tag))
      || it.note.toLowerCase().includes(tag)
      || it.title.toLowerCase().includes(tag));
    if (!tagged.length) return null;
    pool = tagged;
  }
  if (opts?.excludeKey && pool.length > 1) {
    const filtered = pool.filter((it) => it.key !== opts.excludeKey);
    if (filtered.length) pool = filtered;
  }
  // 优先从较久没唱的前半段里随机挑一首，避免老重复同一首
  pool.sort((a, b) => (a.lastSungAt || 0) - (b.lastSungAt || 0));
  const top = pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)));
  return top[Math.floor(Math.random() * top.length)] ?? pool[0];
}

/** 紧凑格式化一条最佳配方给日志与桌宠阅读。 */
export function formatRecipeBrief(recipe: RepertoireRecipe | undefined): string {
  if (!recipe) return '';
  const parts: string[] = [];
  if (recipe.model) parts.push(recipe.model);
  if (recipe.pitch !== undefined && recipe.pitch !== 'auto') {
    parts.push(`移调 ${recipe.pitch > 0 ? '+' : ''}${recipe.pitch}`);
  }
  if (recipe.mode === 'vocals') parts.push('清唱');
  if (recipe.f0Method && recipe.f0Method !== 'rmvpe') parts.push(recipe.f0Method);
  if (recipe.separator === 'roformer') parts.push(recipe.dereverb ? 'RoFormer+去混响' : 'RoFormer');
  if (recipe.dynamicStyle === 'soft-verse-bright-chorus') parts.push('主歌柔/副歌亮');
  if (recipe.harmony && recipe.harmony !== 'off') parts.push(`和声:${recipe.harmony}`);
  if (typeof recipe.lrcOffsetSec === 'number' && Math.abs(recipe.lrcOffsetSec) >= 0.05) {
    parts.push(`词偏 ${recipe.lrcOffsetSec > 0 ? '+' : ''}${recipe.lrcOffsetSec.toFixed(1)}s`);
  }
  return parts.join(' · ');
}
