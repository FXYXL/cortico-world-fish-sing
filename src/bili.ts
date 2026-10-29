/**
 * B 站：搜索 → 相关度打分 → 取音频流 → 下载。
 *
 * 这套接口是实测过的（2026-10-27）：搜索**不需要 wbi 签名**，带 `buvid3` cookie
 * + 普通 UA 就能 `code:0`；`x/player/playurl?...&fnval=16` 的 `dash.audio[*].baseUrl`
 * 直接能下载（内容一般是 audio/mp4）。
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

export interface SearchHit {
  bvid: string;
  title: string;
  author: string;
  durationSec: number;
  play: number;
  score?: number;
}

/** 标题里出现就重罚的词：教程、伴奏、合集、直播回放…… */
const BAD_TITLE =
  /教程|教学|谱|翻弹|指弹|钢琴|吉他|架子鼓|纯音乐|伴奏|消音|卡拉ok|ktv|合集|串烧|一小时|10小时|循环|直播|录播|reaction|解说|舞蹈|手书/;
const GOOD_TITLE = /官方|mv|原唱|高音质|无损|完整版|歌词|无损音质/;

export function isBvid(text: string): boolean {
  return /^BV[0-9A-Za-z]{10}$/.test(text.trim());
}

/** 从任意文本里抠 BV 号（支持整条链接）。 */
export function extractBvid(text: string): string | null {
  const m = /(BV[0-9A-Za-z]{10})/.exec(text || '');
  return m ? m[1] : null;
}

function durationToSec(text: string): number {
  const parts = String(text || '').split(':').map((x) => Number(x) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function stripTags(text: string): string {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

async function jsonGet<T>(url: string, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...extra },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function searchBili(keyword: string, limit = 20): Promise<SearchHit[]> {
  let buvid = '';
  try {
    const spi = await jsonGet<{ data?: { b_3?: string } }>('https://api.bilibili.com/x/frontend/finger/spi');
    buvid = spi?.data?.b_3 ?? '';
  } catch {
    /* 拿不到就裸搜，风控会更凶，但不是硬失败 */
  }
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=${encodeURIComponent(keyword)}`;
  const data = await jsonGet<{ code: number; message?: string; data?: { result?: unknown[] } }>(
    url,
    buvid ? { Cookie: `buvid3=${buvid}` } : {},
  );
  if (data.code !== 0) throw new Error(`B 站搜索返回 code=${data.code} ${data.message ?? ''}`.trim());
  const rows = (data.data?.result ?? []) as Record<string, unknown>[];
  return rows
    .filter((r) => typeof r.bvid === 'string')
    .slice(0, limit)
    .map((r) => ({
      bvid: String(r.bvid),
      title: stripTags(String(r.title ?? '')),
      author: String((r.author as string) ?? ''),
      durationSec: durationToSec(String(r.duration ?? '')),
      play: Number(r.play ?? 0) || 0,
    }));
}

/**
 * 相关性打分。为什么需要：只看第一条经常挑到教程、合集、伴奏、甚至不是那首歌的翻弹。
 * 规则：关键词逐个命中加分、缺一个重罚；坏词重罚、好词小加；播放量小幅加权（封顶 4，
 * 防止大 UP 的无关视频靠粉数压过准确度）；90~330 秒是常见流行歌长度，小幅加分。
 */
export function rankHits(hits: SearchHit[], keyword: string, excludeWords = ''): SearchHit[] {
  const tokens = keyword
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter((t) => t.length > 0);
  const extraBad = excludeWords
    .split(/[,，、]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0);
  return hits
    .map((hit) => {
      const low = hit.title.toLowerCase();
      let score = 0;
      let hitCount = 0;
      for (const t of tokens) {
        if (low.includes(t)) hitCount += 1;
      }
      score += hitCount * 6 - (tokens.length - hitCount) * 7;
      if (BAD_TITLE.test(low)) score -= 12;
      if (GOOD_TITLE.test(low)) score += 3;
      for (const w of extraBad) if (low.includes(w)) score -= 10;
      score += Math.min(4, (hit.play || 0) / 500_000);
      if (hit.durationSec >= 90 && hit.durationSec <= 330) score += 2;
      return { ...hit, score: Math.round(score * 10) / 10 };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** 视频信息 + 音频流地址（dash 里码率最低那轨：够听、省流量、下得快）。 */
export async function audioUrlOf(bvid: string): Promise<{ url: string; mime: string; title: string; author: string; durationSec: number }> {
  const view = await jsonGet<{
    code: number;
    data?: { cid?: number; title?: string; owner?: { name?: string }; duration?: number };
  }>(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (view.code !== 0 || !view.data?.cid) throw new Error(`取视频信息失败 code=${view.code}`);
  const cid = view.data.cid;
  const play = await jsonGet<{
    code: number;
    message?: string;
    data?: { dash?: { audio?: { baseUrl?: string; mimeType?: string; bandwidth?: number }[] } };
  }>(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fnver=0&fourk=1`);
  if (play.code !== 0) throw new Error(`取播放地址失败 code=${play.code} ${play.message ?? ''}`.trim());
  const list = play.data?.dash?.audio ?? [];
  if (!list.length) throw new Error('这个视频没有独立音频轨（可能是直播/番剧，需要登录）');
  const best = [...list].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0))[0];
  if (!best?.baseUrl) throw new Error('音频地址为空');
  return {
    url: best.baseUrl,
    mime: best.mimeType ?? 'audio/mp4',
    title: String(view.data.title ?? ''),
    author: String(view.data.owner?.name ?? ''),
    durationSec: Number(view.data.duration ?? 0) || 0,
  };
}

export async function download(url: string, dest: string, maxBytes: number): Promise<number> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`音频下载 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`音频 ${(buf.length / 1048576).toFixed(1)}MB 超过上限`);
  await writeFile(dest, buf);
  return buf.length;
}

/** ffmpeg 路径可用性：路径里混进控制字符（反斜杠被吃）时给出能看懂的错。 */
export function ffmpegProblem(configured: string): string | null {
  const want = String(configured || '').trim();
  if (!want) return null;
  if (existsSync(want)) return null;
  const suspicious = /[\u0000-\u001f]/.test(want);
  return suspicious
    ? `ffmpeg 路径含控制字符（典型是反斜杠被当转义吃掉）：${JSON.stringify(want)}`
    : `ffmpeg 路径不存在：${want}`;
}
