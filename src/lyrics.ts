/**
 * 多级时间轴歌词模块：为每首歌提供「句号 + 起止秒 + 歌词 + 主/副歌标签」。
 *
 * 获取优先级（短超时，不阻塞主链路，且严格校验歌名与语言防张冠李戴）：
 *   1. 本地音频同目录同名 .lrc 文件
 *   2. 网易云音乐公开逐句 LRC（华语/粤语/日韩覆盖率高）
 *   3. 开源免鉴权 LRCLIB（欧美及国际曲库覆盖率高）
 *   4. B 站视频自带公开字幕轨（若该 BV 有 CC / 字幕）
 *   5. 零依赖保底：使用分离干声静音切分出的自然乐句时间轴
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export interface LyricLine {
  index: number;
  start: number;
  end: number;
  text: string;
  section?: 'verse' | 'chorus';
}

export interface LyricsSheet {
  source: 'local-lrc' | 'netease' | 'lrclib' | 'bili-subtitle' | 'phrases';
  sourceLabel: string;
  lines: LyricLine[];
}

export interface TimeSpan {
  start: number;
  end: number;
}

export interface PhraseSpan {
  index: number;
  start: number;
  end: number;
  section?: 'verse' | 'chorus';
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

/** 明显属于 B 站装饰标签而非歌名的括号内容 */
const NOISE_TAG_RE =
  /^(?:高音质|无损音质?|hi-?res|flac|4k|hd|60fps|mv|官方(?:版|mv)?|原唱|完整版|纯享版?|动态歌词|带歌词|歌词版?|live|现场版?|翻唱|女声翻唱|男声翻唱|cover|超清|高清|音质|双语字幕|中字|治愈|emo|神曲|必听|推荐|经典|老歌|宝藏|合集|洗脑|前奏杀|副歌|高能|循环|暗恋.*|小曲.*|bgm.*)$/i;

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function normCore(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\-_|｜/\\·•'"“”‘’《》【】\[\]()（）「」『』.,!?，。！？~～:：;；]+/g, '');
}

/** 清理单个候选片段里的 B 站常见噪点词，保留核心歌名/歌手。 */
export function cleanSongQuery(rawTitle: string): string {
  const s = String(rawTitle || '').trim();
  const cleaned = s
    .replace(/[【\[（(]([^】\]）)]{1,36})[】\]）)]/g, (_all, inner: string) => {
      const t = inner.trim();
      if (!t || NOISE_TAG_RE.test(t) || /(?:高音质|无损|完整版|动态歌词|官方|翻唱|live|hi-?res|flac|4k|mv|小曲|bgm)/i.test(t)) {
        return ' ';
      }
      return ` ${t} `;
    })
    .replace(/[《》「」『』“”‘’"']+/g, ' ')
    .replace(/\b(?:official|music\s*video|mv|lyrics?|cover|live|hi-?res|flac|hd|4k|60fps|ver\.?)\b/gi, ' ')
    .replace(/(?:高音质|无损音质|无损|完整版|动态歌词|带歌词|纯享版|女声翻唱|男声翻唱|原唱|翻唱|官方版|超清|高清)/g, ' ')
    .replace(/[-_|｜/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

/**
 * 从原始搜索词与 B 站视频标题中提取 1~3 个高置信检索词（去重、按精准度排序）。
 * 解决 B 站常见「【心似烟火】|“【暗恋の小曲】”」把歌名放进方括号导致全被删光的问题。
 */
export function extractSongQueries(rawTitle: string, hintQuery = ''): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.replace(/\s+/g, ' ').trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  };

  // 1) 用户主动搜的歌名最精准（排除 BV 号、链接、文件路径）
  const hint = String(hintQuery || '').trim();
  if (hint && !/^BV[0-9A-Za-z]{10}$/i.test(hint) && !/^https?:\/\//i.test(hint) && !/[\\/]/.test(hint)) {
    const ch = cleanSongQuery(hint);
    if (ch) push(ch);
  }

  const s = String(rawTitle || '').trim();
  // 2) 书名号《歌名》
  for (const m of s.matchAll(/《([^》]{1,36})》/g)) {
    const t = cleanSongQuery(m[1]);
    if (t) push(t);
  }
  // 3) 非噪点【歌名】或竖线分隔第一段（如「【心似烟火】|“【暗恋の小曲】”」）
  for (const m of s.matchAll(/【([^】]{1,32})】/g)) {
    const inner = m[1].trim();
    if (inner && !NOISE_TAG_RE.test(inner) && !/(?:小曲|高音质|无损|完整版|动态歌词|翻唱|官方|mv|live)/i.test(inner)) {
      const t = cleanSongQuery(inner);
      if (t) push(t);
    }
  }
  const firstPipe = s.split(/[|｜]/)[0] || '';
  if (firstPipe && firstPipe !== s) {
    const t = cleanSongQuery(firstPipe);
    if (t) push(t);
  }
  // 4) 整体清洗后的标题
  const full = cleanSongQuery(s);
  if (full) push(full);
  return out.slice(0, 3);
}

/** 计算候选歌名与查询词的相关度（0~1），用于拦截毫无关系的错配结果。 */
function titleRelevance(query: string, trackName: string, artistName = ''): number {
  const q = normCore(query);
  const t = normCore(trackName);
  const ta = normCore(`${trackName} ${artistName}`);
  if (!q || !t) return 0;
  if (t === q || ta === q) return 1.0;
  if (t.includes(q) || q.includes(t)) {
    const ratio = Math.min(q.length, t.length) / Math.max(q.length, t.length);
    return 0.65 + 0.35 * ratio;
  }
  // 统计字符交集与 2-gram 重合，避免单字偶合
  const qChars = new Set(q.split(''));
  let hit = 0;
  for (const ch of t) if (qChars.has(ch)) hit += 1;
  const charScore = hit / Math.max(q.length, t.length);
  let biHit = 0;
  const biTotal = Math.max(1, q.length - 1);
  for (let i = 0; i < q.length - 1; i += 1) {
    if (ta.includes(q.slice(i, i + 2))) biHit += 1;
  }
  const biScore = biHit / biTotal;
  return Math.max(charScore * 0.8, biScore);
}

/** 校验歌词语言是否与中文查询一致：搜中文歌绝不接受纯英文歌词。 */
function lyricsLanguageMatches(query: string, lines: LyricLine[]): boolean {
  if (!hasCjk(query)) return true;
  const sample = lines.map((l) => l.text).join('');
  const cjkCount = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const letterCount = (sample.match(/[a-zA-Z]/g) || []).length;
  const total = cjkCount + letterCount;
  if (total === 0) return false;
  return cjkCount >= 8 && cjkCount / total >= 0.2;
}

/** 解析标准 LRC 文本（支持单行多时间戳 `[00:12.34][01:23.45]歌词`）。 */
export function parseLrc(text: string, durationSec = 0): LyricLine[] {
  const rows: Array<{ start: number; text: string }> = [];
  const timeRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const times: number[] = [];
    let m: RegExpExecArray | null;
    timeRe.lastIndex = 0;
    while ((m = timeRe.exec(rawLine)) !== null) {
      const mm = Number(m[1]) || 0;
      const ss = Number(m[2]) || 0;
      const fracRaw = m[3] || '0';
      const frac = Number(fracRaw) / (fracRaw.length === 3 ? 1000 : fracRaw.length === 2 ? 100 : 10);
      times.push(mm * 60 + ss + frac);
    }
    if (!times.length) continue;
    const lyric = rawLine.replace(timeRe, '').trim();
    if (!lyric) continue;
    // 跳过常见作词/作曲/编曲/制作人/版权声明等元信息头
    if (/^(?:中文填词|填词|作词|作曲|编曲|制作人|混音|和声|吉他|贝斯|鼓|录音|母带|监制|出品|统筹|文案|企划|发行|词|曲|op|sp|ti|ar|al|by)\s*(?:[（(][^）)]*[）)])?\s*[:：]/i.test(lyric)) continue;
    if (/^本作品经过.*授权/.test(lyric)) continue;
    for (const t of times) {
      rows.push({ start: t, text: lyric });
    }
  }
  rows.sort((a, b) => a.start - b.start);
  const out: LyricLine[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const cur = rows[i];
    const nextStart = i + 1 < rows.length ? rows[i + 1].start : Math.max(cur.start + 4.5, durationSec || cur.start + 5);
    const end = Math.max(cur.start + 0.8, Math.min(nextStart, cur.start + 12));
    out.push({
      index: i + 1,
      start: Math.round(cur.start * 100) / 100,
      end: Math.round(end * 100) / 100,
      text: cur.text,
    });
  }
  return out;
}

/** 截取片段偏移对齐：当只唱了 [cutStart, cutStart + cutDur] 时，把整首歌歌词映射到相对 0 秒坐标。 */
export function sliceLyricsForCut(lines: LyricLine[], cutStart = 0, cutDuration = 0): LyricLine[] {
  if (cutStart <= 0 && cutDuration <= 0) return lines;
  const lo = Math.max(0, cutStart);
  const hi = cutDuration > 0 ? lo + cutDuration : Number.POSITIVE_INFINITY;
  const kept: LyricLine[] = [];
  for (const ln of lines) {
    if (ln.end <= lo + 0.2 || ln.start >= hi - 0.2) continue;
    const s = Math.max(0, ln.start - lo);
    const e = Math.min(cutDuration > 0 ? cutDuration : ln.end - lo, ln.end - lo);
    if (e - s < 0.3) continue;
    kept.push({
      ...ln,
      index: kept.length + 1,
      start: Math.round(s * 100) / 100,
      end: Math.round(e * 100) / 100,
    });
  }
  return kept;
}

/** 1) 读取本地音频同目录同名 .lrc 文件。 */
function tryLocalLrc(audioPath: string, durationSec: number): LyricsSheet | null {
  if (!audioPath || !existsSync(audioPath)) return null;
  const stem = basename(audioPath, extname(audioPath));
  const lrcPath = join(dirname(audioPath), `${stem}.lrc`);
  if (!existsSync(lrcPath)) return null;
  try {
    const lines = parseLrc(readFileSync(lrcPath, 'utf8'), durationSec);
    if (lines.length >= 3) {
      return { source: 'local-lrc', sourceLabel: '本地 LRC 歌词', lines };
    }
  } catch {
    /* 读失败走下一级 */
  }
  return null;
}

/** 2) 网易云音乐公开逐句 LRC 检索（对华语/粤语/日韩最准，带严格歌名、时长与语言校验）。 */
async function tryNetEase(queries: string[], durationSec: number): Promise<LyricsSheet | null> {
  for (const query of queries) {
    try {
      const url = `https://music.163.com/api/search/get/web?type=1&limit=8&s=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        result?: {
          songs?: Array<{
            id?: number;
            name?: string;
            duration?: number;
            artists?: Array<{ name?: string }>;
          }>;
        };
      };
      const songs = data.result?.songs ?? [];
      if (!songs.length) continue;

      const scored = songs
        .map((s) => {
          const name = String(s.name ?? '');
          const artist = String(s.artists?.[0]?.name ?? '');
          const rel = titleRelevance(query, name, artist);
          const durSec = (Number(s.duration ?? 0) || 0) / 1000;
          const durDiff = durationSec > 20 && durSec > 20 ? Math.abs(durSec - durationSec) : 0;
          const score = rel * 100 - Math.min(40, durDiff * 0.6);
          return { s, name, artist, rel, durDiff, score };
        })
        .filter((x) => x.rel >= 0.45 && (durationSec <= 20 || x.durDiff <= 45))
        .sort((a, b) => b.score - a.score);

      for (const cand of scored.slice(0, 3)) {
        if (!cand.s.id) continue;
        const lrRes = await fetch(`https://music.163.com/api/song/lyric?id=${cand.s.id}&lv=1`, {
          headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
          signal: AbortSignal.timeout(4000),
        });
        if (!lrRes.ok) continue;
        const lrJson = (await lrRes.json()) as { lrc?: { lyric?: string } };
        const rawLrc = String(lrJson.lrc?.lyric ?? '');
        if (!rawLrc) continue;
        const lines = parseLrc(rawLrc, durationSec);
        if (lines.length >= 4 && lyricsLanguageMatches(query, lines)) {
          const label = cand.artist
            ? `网易云歌词（${cand.name} - ${cand.artist}）`
            : `网易云歌词（${cand.name}）`;
          return { source: 'netease', sourceLabel: label, lines };
        }
      }
    } catch {
      /* 单个查询超时或失败继续下一个 */
    }
  }
  return null;
}

/** 3) 开源免鉴权 LRCLIB 精准逐句歌词检索（严格校验歌名相关性与语言，杜绝错配英文歌）。 */
async function tryLrcLib(queries: string[], durationSec: number): Promise<LyricsSheet | null> {
  for (const query of queries) {
    try {
      const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'cortico-world-fish-sing/1.0' },
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) continue;
      const list = (await res.json()) as Array<{
        trackName?: string;
        artistName?: string;
        duration?: number;
        syncedLyrics?: string;
      }>;
      if (!Array.isArray(list) || !list.length) continue;

      const scored = list
        .filter((it) => typeof it.syncedLyrics === 'string' && it.syncedLyrics.trim().length > 20)
        .map((it) => {
          const name = String(it.trackName ?? '');
          const artist = String(it.artistName ?? '');
          const rel = titleRelevance(query, name, artist);
          const durDiff = durationSec > 20 && it.duration ? Math.abs(it.duration - durationSec) : 0;
          const score = rel * 100 - Math.min(40, durDiff * 0.6);
          return { it, name, artist, rel, durDiff, score };
        })
        .filter((x) => x.rel >= 0.45 && (durationSec <= 20 || x.durDiff <= 35))
        .sort((a, b) => b.score - a.score);

      for (const cand of scored.slice(0, 3)) {
        const lines = parseLrc(cand.it.syncedLyrics || '', durationSec);
        if (lines.length >= 4 && lyricsLanguageMatches(query, lines)) {
          const label = cand.artist
            ? `LRCLIB 歌词（${cand.name} - ${cand.artist}）`
            : `LRCLIB 歌词（${cand.name}）`;
          return { source: 'lrclib', sourceLabel: label, lines };
        }
      }
    } catch {
      /* 网络不可达或超时静默跳过 */
    }
  }
  return null;
}

/** 4) B 站视频公开字幕轨（无需登录，若无公开字幕静默跳过）。 */
async function tryBiliSubtitle(bvid: string): Promise<LyricsSheet | null> {
  if (!bvid) return null;
  try {
    const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(4000),
    });
    if (!viewRes.ok) return null;
    const view = (await viewRes.json()) as { code?: number; data?: { cid?: number; aid?: number } };
    const cid = view.data?.cid;
    if (!cid) return null;
    const playerRes = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(4000),
    });
    if (!playerRes.ok) return null;
    const player = (await playerRes.json()) as {
      data?: { subtitle?: { subtitles?: Array<{ lan?: string; subtitle_url?: string }> } };
    };
    const subs = (player.data?.subtitle?.subtitles ?? []).filter((s) => Boolean(s.subtitle_url));
    if (!subs.length) return null;
    const picked = subs.find((s) => /^zh/i.test(String(s.lan ?? ''))) ?? subs[0];
    let subUrl = String(picked.subtitle_url ?? '');
    if (subUrl.startsWith('//')) subUrl = `https:${subUrl}`;
    const subRes = await fetch(subUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(4000),
    });
    if (!subRes.ok) return null;
    const subData = (await subRes.json()) as {
      body?: Array<{ from?: number; to?: number; content?: string }>;
    };
    const body = subData.body ?? [];
    const lines: LyricLine[] = [];
    for (const item of body) {
      const txt = String(item.content ?? '').trim();
      if (!txt) continue;
      lines.push({
        index: lines.length + 1,
        start: Math.round(Number(item.from ?? 0) * 100) / 100,
        end: Math.round(Number(item.to ?? 0) * 100) / 100,
        text: txt,
      });
    }
    if (lines.length >= 4) {
      return { source: 'bili-subtitle', sourceLabel: 'B 站视频字幕', lines };
    }
  } catch {
    /* 静默兜底 */
  }
  return null;
}

/** 5) 保底方案：把 worker 静音切分出的乐句转成时间轴表。 */
export function buildPhraseLyrics(phrases: PhraseSpan[]): LyricsSheet {
  const lines: LyricLine[] = (phrases || []).map((p, idx) => ({
    index: idx + 1,
    start: p.start,
    end: p.end,
    section: p.section,
    text: p.section === 'chorus' ? `（副歌第 ${idx + 1} 乐句）` : `（主歌第 ${idx + 1} 乐句）`,
  }));
  return { source: 'phrases', sourceLabel: '干声乐句切分（无歌词文本兜底）', lines };
}

/** 把副歌时间轴标到每句歌词上，方便按「副歌」快速定位返工或演绎。 */
export function tagLyricsSections(sheet: LyricsSheet, chorusRanges: TimeSpan[]): LyricsSheet {
  if (!chorusRanges?.length) return sheet;
  const lines = sheet.lines.map((ln) => {
    const mid = (ln.start + ln.end) / 2;
    const inCh = chorusRanges.some((c) => mid >= c.start - 0.5 && mid <= c.end + 0.5);
    return { ...ln, section: inCh ? ('chorus' as const) : ('verse' as const) };
  });
  return { ...sheet, lines };
}

/** 统一入口：多级获取歌词表，永远返回一个可用结果。 */
export async function resolveLyrics(opts: {
  title: string;
  hintQuery?: string;
  localPath?: string;
  bvid?: string;
  fullDurationSec: number;
  cutStart?: number;
  cutDuration?: number;
  phrases?: PhraseSpan[];
  chorusRanges?: TimeSpan[];
}): Promise<LyricsSheet> {
  const local = opts.localPath ? tryLocalLrc(opts.localPath, opts.fullDurationSec) : null;
  const queries = extractSongQueries(opts.title, opts.hintQuery);
  let sheet: LyricsSheet | null = local;
  if (!sheet && queries.length) {
    sheet = await tryNetEase(queries, opts.fullDurationSec);
  }
  if (!sheet && queries.length) {
    sheet = await tryLrcLib(queries, opts.fullDurationSec);
  }
  if (!sheet && opts.bvid) {
    sheet = await tryBiliSubtitle(opts.bvid);
  }
  if (sheet) {
    const sliced = sliceLyricsForCut(sheet.lines, opts.cutStart ?? 0, opts.cutDuration ?? 0);
    if (sliced.length >= 2) {
      return tagLyricsSections({ ...sheet, lines: sliced }, opts.chorusRanges ?? []);
    }
  }
  return buildPhraseLyrics(opts.phrases ?? []);
}

/** 根据播放秒数找当前正在唱的那一句及下一句。 */
export function lineAtTime(sheet: LyricsSheet | undefined, sec: number): { current?: LyricLine; next?: LyricLine } {
  if (!sheet?.lines?.length) return {};
  const t = Math.max(0, sec);
  let current: LyricLine | undefined;
  let next: LyricLine | undefined;
  for (let i = 0; i < sheet.lines.length; i += 1) {
    const ln = sheet.lines[i];
    if (t >= ln.start - 0.3 && t <= ln.end + 0.5) {
      current = ln;
      next = sheet.lines[i + 1];
      return { current, next };
    }
    if (ln.start > t) {
      next = ln;
      current = i > 0 ? sheet.lines[i - 1] : undefined;
      return { current, next };
    }
  }
  return { current: sheet.lines[sheet.lines.length - 1] };
}

/**
 * 灵活定位返工区间：支持
 *  - `lines`: "7" 或 "7-9"（1 基句号）
 *  - `lyric`: 歌词关键词模糊匹配
 *  - `section`: "chorus"（可选 chorusIndex 指定第几段副歌，默认第 1 段）
 */
export function locatePatchRange(
  sheet: LyricsSheet | undefined,
  chorusRanges: TimeSpan[] | undefined,
  query: { lines?: string | number; lyric?: string; section?: string; chorusIndex?: number },
): { start: number; end: number; label: string } | null {
  const lines = sheet?.lines ?? [];
  if (query.lines !== undefined && String(query.lines).trim() !== '') {
    const raw = String(query.lines).trim();
    const m = /^(\d+)(?:\s*[-~到至]\s*(\d+))?$/.exec(raw);
    if (m && lines.length) {
      const a = Math.max(1, Math.min(lines.length, Number(m[1])));
      const b = Math.max(a, Math.min(lines.length, Number(m[2] ?? m[1])));
      const first = lines[a - 1];
      const last = lines[b - 1];
      return {
        start: first.start,
        end: last.end,
        label: a === b ? `第 ${a} 句「${first.text.slice(0, 18)}」` : `第 ${a}–${b} 句`,
      };
    }
  }

  if (query.lyric && lines.length) {
    const kw = String(query.lyric).trim().toLowerCase();
    const hit = lines.find((ln) => ln.text.toLowerCase().includes(kw));
    if (hit) {
      return {
        start: hit.start,
        end: hit.end,
        label: `第 ${hit.index} 句「${hit.text.slice(0, 20)}」`,
      };
    }
  }

  if (query.section === 'chorus') {
    const list = chorusRanges ?? [];
    if (list.length) {
      const idx = Math.max(0, Math.min(list.length - 1, Number(query.chorusIndex ?? 1) - 1));
      const c = list[idx];
      return {
        start: c.start,
        end: c.end,
        label: `第 ${idx + 1} 段副歌（${fmtTime(c.start)}–${fmtTime(c.end)}）`,
      };
    }
    const chLines = lines.filter((l) => l.section === 'chorus');
    if (chLines.length) {
      return {
        start: chLines[0].start,
        end: chLines[chLines.length - 1].end,
        label: `副歌（第 ${chLines[0].index}–${chLines[chLines.length - 1].index} 句）`,
      };
    }
  }

  return null;
}

/** 紧凑格式化歌词表给桌宠阅读。 */
export function formatLyricsTable(sheet: LyricsSheet, opts?: { fromLine?: number; limit?: number }): string {
  if (!sheet.lines.length) return '（暂无时间轴歌词）';
  const from = Math.max(1, Number(opts?.fromLine ?? 1));
  const limit = Math.max(1, Math.min(120, Number(opts?.limit ?? 60)));
  const slice = sheet.lines.slice(from - 1, from - 1 + limit);
  const rows = slice.map((ln) => {
    const tag = ln.section === 'chorus' ? '[副歌]' : '';
    return `${ln.index}. [${fmtTime(ln.start)}–${fmtTime(ln.end)}]${tag} ${ln.text}`;
  });
  const tail = from - 1 + slice.length < sheet.lines.length
    ? `\n…共 ${sheet.lines.length} 句（可传 fromLine=${from + slice.length} 继续看）`
    : '';
  return `来源：${sheet.sourceLabel}（共 ${sheet.lines.length} 句）\n${rows.join('\n')}${tail}`;
}
