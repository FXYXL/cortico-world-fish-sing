/**
 * 编排：从"她想唱一首歌"到"声音真的出来了"。
 *
 * 一条链路：
 *   解析来源（关键词 / BV号 / 本地文件）
 *     → 下载 B 站音频（需要时）
 *     → 截取（只唱副歌时）
 *     → worker：分离 → 55 秒切片换声 → 混音
 *     → 转 mp3 → 缓存 + 进作品库
 *     → 投递（本机 ffplay / QQ 语音条多条 / 两边都要）
 *
 * 设计取舍：
 *  · 中间产物全部落在 dataDir/tmp 下，跑完删掉（干声可能有几百 MB）；
 *  · 任何一步失败都返回 ok:false 并带上真实原因——她要能对用户说人话；
 *  · 进度通过 log 输出，工具调用本身是同步等待的（Coo 侧不需要知道细节）。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { audioUrlOf, download, extractBvid, isBvid, rankHits, searchBili, type SearchHit, type SearchOrder } from './bili.ts';
import { cut, duration, split, toMp3, type FfmpegDeps } from './audio.ts';
import {
  parseTarget,
  sendRecord,
  type LyricCueEvent,
  type LyricPushConfig,
  type OneBotOptions,
  type Player,
} from './deliver.ts';
import {
  addToLibrary,
  cacheGet,
  cacheKey,
  cachePut,
  loadSession,
  saveSession,
  sepCacheDir,
  sessionDir,
  type LibraryOptions,
  type SingParams,
  type SingSessionSnapshot,
  type VocalReport,
} from './library.ts';
import { fmtTime, locatePatchRange, resolveLyrics, type LyricsSheet } from './lyrics.ts';
import type { LoggerLike, WorkerClient } from './worker.ts';

export interface PlaybackEndInfo {
  id: string;
  title: string;
  reason: 'ended' | 'stopped' | 'error';
  elapsedSec: number;
  durationSec: number;
  report?: VocalReport;
}

export interface SingSegmentSpec {
  start: number;
  end: number;
  model?: string;
  indexRate?: number;
  protect?: number;
  pitch?: number;
  rmsMixRate?: number;
  f0Method?: 'rmvpe' | 'fcpe';
}

export interface SingDeps {
  log: LoggerLike;
  worker: WorkerClient;
  player: Player;
  ffmpeg: FfmpegDeps;
  data: LibraryOptions;
  onebot: OneBotOptions;
  /** 她主动唱时的默认投递目标（config.play.defaultTarget） */
  defaultTarget: 'local' | 'none';
  playEnabled: boolean;
  volume: number;
  playerPath: string;
  maxSegmentSec: number;
  gapMs: number;
  /** 点歌相关限制 */
  songEnabled: boolean;
  maxDurationSec: number;
  maxAudioMB: number;
  minScore: number;
  excludeWords: string;
  voice: SingParams;
  /** 唱中歌词提词配置 */
  lyricPush?: LyricPushConfig;
  /** 唱中提词触发回调 */
  onLyricCue?: (cue: LyricCueEvent) => void;
  /** 本机自然播完 / 被打断时的回调（用于 pushEvent 通知桌宠接话） */
  onPlaybackEnd?: (info: PlaybackEndInfo) => void;
}

/** 把 0~1 之间的参数夹住：非法/越界一律退回配置值，别把 NaN 传到 worker。 */
function clamp01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export interface SingRequest {
  song: string;
  to?: string;
  mode?: 'full' | 'vocals';
  /** 半音数；'auto' = 分离后按模型音域自动推荐（推荐，能挡住"男歌女唱忘移调"的翻车） */
  pitch?: number | 'auto';
  indexRate?: number;
  protect?: number;
  /** 音量跟随原唱的程度 0~1（0 = 完全跟随，轻唱不会被唱满） */
  rmsMixRate?: number;
  /** 和声堆叠：off / double / double+third / third / third+fifth */
  harmony?: 'off' | 'double' | 'double+third' | 'third' | 'third+fifth';
  /** 人声混响：off / light */
  reverb?: 'off' | 'light';
  /** 人声润色（默认开） */
  polish?: boolean;
  /** F0 音高提取算法 */
  f0Method?: 'rmvpe' | 'fcpe';
  /** 人声分离档位：htdemucs（快速） / roformer（UVR5 精唱） */
  separator?: 'htdemucs' | 'roformer';
  /** 分离后额外去混响 */
  dereverb?: boolean;
  /** 临时指定本次演唱使用的音色模型名（如 dfy7.pth），唱完自动恢复默认模型 */
  model?: string;
  /** 动态主副歌演绎：off / soft-verse-bright-chorus */
  dynamicStyle?: 'off' | 'soft-verse-bright-chorus';
  /** 显式分段换音色/换参数 */
  segments?: SingSegmentSpec[];
  start?: number;
  duration?: number;
  /** 跳过缓存（想重唱一遍时用） */
  refresh?: boolean;
  /** 只搜索不下载：把候选列表交回去，让她自己挑 */
  search?: boolean;
  /** 指定要下哪一条：序号（从 1 开始）或 BV 号 */
  pick?: string;
  /** B 站排序：default 综合 / click 播放多 / pubdate 最新 */
  order?: SearchOrder;
}

export interface PatchRequest {
  /** 要返工的会话 ID；不填默认最近一次唱过的歌 */
  sessionId?: string;
  /** 按秒数指定起止 */
  start?: number;
  end?: number;
  /** 按句号指定，如 "7" 或 "7-9" */
  lines?: string | number;
  /** 按歌词关键词匹配定位 */
  lyric?: string;
  /** 按段落定位（如 "chorus"） */
  section?: 'chorus';
  /** 第几段副歌（从 1 开始，配合 section="chorus"） */
  chorusIndex?: number;
  /** 按当前正在播放的位置自动取「这一句」 */
  atCurrent?: boolean;
  /** 是否自动吸附换气静音谷底（默认 true） */
  snap?: boolean;
  /** 返工新参数（不填则沿用原曲参数） */
  pitch?: number;
  indexRate?: number;
  protect?: number;
  rmsMixRate?: number;
  f0Method?: 'rmvpe' | 'fcpe';
  /** 临时更换该句所用模型名（如 dfy2.pth） */
  model?: string;
  /** true = 仅生成前后各带 2 秒上下文的短预览轨试听，不改整首；false = 贴回整首并更新作品库 */
  previewOnly?: boolean;
  to?: string;
}

export interface SingResult {
  ok: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

function human(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 调用端超时断开后，worker 里的任务可能还在往工作目录写——立刻删会报
 * 「vocals.wav 打不开」并把任务搞死。改成：等任务落到终态（最多 10 分钟）再删。
 */
function scheduleTmpCleanup(worker: WorkerClient, jobId: string | null, root: string): void {
  void (async () => {
    for (let i = 0; i < 120; i += 1) {
      const j = jobId ? await worker.jobState(jobId).catch(() => null) : null;
      if (!j || !['queued', 'running'].includes(j.state)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 被占用就算了，24 小时的兜底清扫会收走 */
    }
  })();
}

/** 兜底清扫：删掉超过 24 小时的临时目录（覆盖「清理也失败」的漏网之鱼）。 */
function sweepStaleTmp(base: string): void {
  try {
    if (!existsSync(base)) return;
    const cutoff = Date.now() - 24 * 3600_000;
    for (const name of readdirSync(base)) {
      const p = join(base, name);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
      } catch {
        /* 单个删不掉就留给下次 */
      }
    }
  } catch {
    /* 清扫是尽力而为 */
  }
}

/** 来源解析结果。sourceId 用来算缓存键：BV 用 bvid，本地文件用路径+mtime+size。 */
interface Source {
  kind: 'bili' | 'file';
  input: string;
  sourceId: string;
  title: string;
  bvid: string;
  durationSec: number;
  /** 输入本身是不是已经只有人声（本地给干声时可跳过分离） */
  alreadyVocal: boolean;
  note: string;
}

async function resolveSource(req: SingRequest, deps: SingDeps, tmp: string): Promise<Source> {
  const raw = String(req.song || '').trim();
  if (!raw) throw new Error('没给歌名');

  // 1) 本地文件：存在就当
  if (existsSync(raw)) {
    const bvid = '';
    const dur = await duration(raw, deps.ffmpeg);
    return {
      kind: 'file', input: raw, sourceId: `file:${basename(raw)}:${dur.toFixed(1)}`,
      title: basename(raw, extname(raw)), bvid, durationSec: dur,
      alreadyVocal: /干声|清唱|vocal|acapella/i.test(basename(raw)),
      note: '本地文件',
    };
  }

  // 2) BV 号 / 链接
  const bvid = extractBvid(raw) ?? (isBvid(raw) ? raw : '');
  if (bvid) {
    const info = await audioUrlOf(bvid);
    if (info.durationSec > deps.maxDurationSec) {
      throw new Error(`这个视频 ${human(info.durationSec)}，超过上限 ${human(deps.maxDurationSec)}`);
    }
    const m4a = join(tmp, 'src.m4a');
    await download(info.url, m4a, deps.maxAudioMB * 1048576);
    return {
      kind: 'bili', input: m4a, sourceId: `bili:${bvid}`, title: info.title, bvid,
      durationSec: info.durationSec || (await duration(m4a, deps.ffmpeg)), alreadyVocal: false,
      note: `BV 号 ${bvid}`,
    };
  }

  // 3) 关键词搜索
  if (!deps.songEnabled) throw new Error('从 B 站找歌被关掉了（配置 → 点歌），只能给 BV 号或本地文件');
  const hits = await searchBili(raw, 20, req.order ?? 'default');
  if (!hits.length) throw new Error(`B 站没搜到「${raw}」，换个写法或者直接给 BV 号`);
  const pool = hits.filter((h) => h.durationSec >= 20 && h.durationSec <= deps.maxDurationSec);
  if (!pool.length) {
    throw new Error(`搜到 ${hits.length} 条，但没有一条时长在 20~${Math.round(deps.maxDurationSec)} 秒内（可能都是合集/直播）`);
  }
  const ranked = rankHits(pool, raw, deps.excludeWords);
  let best = ranked[0];
  const pickRaw = String(req.pick ?? '').trim();
  if (pickRaw) {
    // 她看过候选列表后点名要某一条：序号或 BV
    const bv = extractBvid(pickRaw);
    if (bv) {
      best = ranked.find((h) => h.bvid === bv) ?? { ...best, bvid: bv, title: bv, score: 100 };
    } else {
      const idx = Number(pickRaw);
      if (!Number.isInteger(idx) || idx < 1 || idx > ranked.length) {
        throw new Error(`pick「${pickRaw}」不对：要给 1~${ranked.length} 的序号，或者 BV 号`);
      }
      best = ranked[idx - 1];
    }
    deps.log.info(`按 pick 选了第 ${pickRaw} 条：${best.title}（${best.bvid}）`);
  } else if ((best.score ?? 0) < deps.minScore) {
    const top = ranked.slice(0, 3).map((h) => `《${h.title}》（${human(h.durationSec)}，${h.bvid}，${h.score} 分）`);
    throw new Error(`没把握是这首（最高 ${best.score} 分，阈值 ${deps.minScore}）。候补：${top.join('；')}。要么换个写法（歌名+歌手），要么直接给 BV 号，要么先 search=true 看候选`);
  }
  const info = await audioUrlOf(best.bvid);
  const m4a = join(tmp, 'src.m4a');
  await download(info.url, m4a, deps.maxAudioMB * 1048576);
  return {
    kind: 'bili', input: m4a, sourceId: `bili:${best.bvid}`,
    title: info.title || best.title, bvid: best.bvid,
    durationSec: info.durationSec || best.durationSec, alreadyVocal: false,
    note: `搜到《${best.title}》${best.score} 分`,
  };
}

/**
 * 只搜索、不下歌：把候选列表交回去让她自己挑。
 *
 * 为什么要这一步：rankHits 是正则打分，不懂语义——「女声翻唱」「电音版」「合唱」
 * 这几种标题它分不出来。模型读标题一眼就懂，所以把选择权交出去，换一次往返。
 */
async function previewSearch(req: SingRequest, deps: SingDeps): Promise<SingResult> {
  const raw = String(req.song || '').trim();
  if (!raw) return { ok: false, message: '没给歌名' };
  if (!deps.songEnabled) return { ok: false, message: '从 B 站找歌被关掉了（配置 → 点歌）' };

  let hits: SearchHit[];
  try {
    hits = await searchBili(raw, 20, req.order ?? 'default');
  } catch (e) {
    return { ok: false, message: `搜索失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!hits.length) return { ok: false, message: `B 站没搜到「${raw}」，换个写法（歌名 + 歌手）试试` };

  const pool = hits.filter((h) => h.durationSec >= 20 && h.durationSec <= deps.maxDurationSec);
  const ranked = rankHits(pool.length ? pool : hits, raw, deps.excludeWords).slice(0, 8);
  const orderLabel = req.order === 'click' ? '按播放量' : req.order === 'pubdate' ? '按最新' : '综合排序';
  const lines = ranked.map((h, i) => {
    const wan = h.play >= 10000 ? `${(h.play / 10000).toFixed(1)}万` : String(h.play);
    return `${i + 1}. 《${h.title}》｜${human(h.durationSec)}｜${h.author}｜${wan}播放｜${h.bvid}｜${h.score}分`;
  });
  return {
    ok: true,
    message: [
      `「${raw}」搜到 ${ranked.length} 条（${orderLabel}）。看完标题挑一条，用 pick 给序号或 BV：`,
      ...lines,
    ].join('\n'),
    detail: {
      keyword: raw,
      order: req.order ?? 'default',
      candidates: ranked.map((h, i) => ({
        index: i + 1, title: h.title, bvid: h.bvid, author: h.author,
        durationSec: h.durationSec, play: h.play, score: h.score,
      })),
    },
  };
}

export async function singSong(req: SingRequest, deps: SingDeps): Promise<SingResult> {
  const t0 = Date.now();
  const songText = String(req.song || '').trim();
  if (!songText) return { ok: false, message: '没给歌名或文件' };

  const reqModel = req.model ? String(req.model).trim() : '';
  const params: SingParams = {
    model: reqModel || deps.voice.model,
    index: reqModel && reqModel !== deps.voice.model ? '' : deps.voice.index,
    indexRate: Number(req.indexRate ?? deps.voice.indexRate),
    protect: Number(req.protect ?? deps.voice.protect),
    // 0 = 完全跟随原唱音量；1 = 完全用模型自己的（轻唱被唱满）。越界/NaN 一律退回配置值。
    rmsMixRate: clamp01(req.rmsMixRate ?? deps.voice.rmsMixRate),
    harmony: (req.harmony ?? deps.voice.harmony) === 'third+fifth' ? 'third+fifth'
      : (req.harmony ?? deps.voice.harmony) === 'double+third' ? 'double+third'
        : (req.harmony ?? deps.voice.harmony) === 'third' ? 'third'
          : (req.harmony ?? deps.voice.harmony) === 'double' ? 'double' : 'off',
    harmonyGain: Math.min(0.6, Math.max(0, Number(deps.voice.harmonyGain ?? 0.22))),
    harmonyScope: deps.voice.harmonyScope === 'all' ? 'all' : 'chorus',
    reverb: (req.reverb ?? deps.voice.reverb) === 'light' ? 'light' : 'off',
    polish: (req.polish ?? deps.voice.polish) !== false,
    f0Method: (req.f0Method ?? deps.voice.f0Method) === 'fcpe' ? 'fcpe' : 'rmvpe',
    separator: (req.separator ?? deps.voice.separator) === 'roformer' ? 'roformer' : 'htdemucs',
    dereverb: Boolean(req.dereverb ?? deps.voice.dereverb),
    dynamicStyle: (req.dynamicStyle ?? deps.voice.dynamicStyle) === 'soft-verse-bright-chorus'
      ? 'soft-verse-bright-chorus' : 'off',
    segmentsKey: Array.isArray(req.segments) && req.segments.length ? JSON.stringify(req.segments) : '',
    // 不传 pitch = 按配置默认（配置默认 'auto' = 按音域自动推荐）
    pitch: req.pitch === undefined || req.pitch === 'auto'
      ? (deps.voice.pitch ?? 'auto')
      : Number(req.pitch),
    mode: req.mode ?? deps.voice.mode,
  };

  if (req.search) return previewSearch(req, deps);

  const root = join(deps.data.dataDir, 'tmp', `${stamp()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(root, { recursive: true });
  sweepStaleTmp(join(deps.data.dataDir, 'tmp'));
  let jobId: string | null = null;
  let done = false;

  try {
    // ---- 1. 来源
    const src = await resolveSource(req, deps, root);
    deps.log.info(`唱歌：${src.title}（${src.note}，${human(src.durationSec)}）`);

    // ---- 2. 缓存
    const cutStart = Math.max(0, Number(req.start ?? 0) || 0);
    const cutDuration = Math.max(0, Number(req.duration ?? 0) || 0);
    const wantCut = cutStart > 0 || cutDuration > 0;
    const fullSourceKey = `${src.sourceId}|cut:0/0`;
    const sourceCutKey = `${src.sourceId}|cut:${cutStart}/${cutDuration}`;
    const key = cacheKey(sourceCutKey, params);
    let mp3 = req.refresh ? null : cacheGet(deps.data, key);
    let cached = Boolean(mp3);
    let info: Record<string, unknown> = {};
    let report: VocalReport | undefined;
    let lyrics: LyricsSheet | undefined;
    const requestedAutoPitch = params.pitch === 'auto';
    const sessDir = sessionDir(deps.data, key);

    if (mp3) {
      deps.log.info(`命中缓存（${key}）`);
      const prevSnap = loadSession(deps.data, key);
      if (prevSnap) {
        report = prevSnap.report;
        lyrics = prevSnap.lyrics as LyricsSheet | undefined;
      }
      if (!lyrics) {
        lyrics = await resolveLyrics({
          title: src.title,
          hintQuery: songText,
          localPath: src.kind === 'file' ? src.input : undefined,
          bvid: src.bvid || undefined,
          fullDurationSec: src.durationSec,
          cutStart,
          cutDuration,
          phrases: report?.phrases,
          chorusRanges: report?.chorusRanges,
        }).catch(() => undefined);
      }
    } else {
      // ---- 3. 截取（若整首已有分离缓存，则交给 worker 在干声上做换气静音边界吸附再切，既免重复分离又不劈字）
      const fullSepDir = sepCacheDir(deps.data, fullSourceKey, {
        separator: params.separator,
        dereverb: params.dereverb,
      });
      const hasFullSep = !src.alreadyVocal && existsSync(join(fullSepDir, 'vocals.wav'));
      let feed = src.input;
      let useSnapCut = false;
      if (wantCut) {
        if (hasFullSep) {
          useSnapCut = true;
          deps.log.info(`复用整首分离缓存并按静音边界吸附截取：${Math.round(cutStart)}s 起 ${Math.round(cutDuration) || '到结尾'}s`);
        } else {
          const cutFile = join(root, 'cut.wav');
          await cut(src.input, cutFile, cutStart, cutDuration, deps.ffmpeg);
          feed = cutFile;
          deps.log.info(`截取 ${Math.round(cutStart)}s 起 ${Math.round(cutDuration) || '到结尾'}s`);
        }
      }

      // ---- 4. 换声
      jobId = await deps.worker.submit('song', {
        input: feed,
        work: join(root, 'work'),
        separate: !src.alreadyVocal,
        sep_cache: src.alreadyVocal ? '' : (useSnapCut ? fullSepDir : sepCacheDir(deps.data, sourceCutKey, {
          separator: params.separator,
          dereverb: params.dereverb,
        })),
        snap_cut: useSnapCut ? { start: cutStart, duration: cutDuration } : null,
        session_dir: sessDir,
        mode: params.mode,
        pitch: params.pitch,
        index_rate: params.indexRate,
        protect: params.protect,
        rms_mix_rate: params.rmsMixRate,
        f0_method: params.f0Method,
        separator: params.separator,
        dereverb: params.dereverb,
        model: reqModel,
        dynamic_style: params.dynamicStyle ?? 'off',
        segments: Array.isArray(req.segments) && req.segments.length ? req.segments : null,
        reverb: params.reverb,
        polish: params.polish !== false,
        harmony: params.harmony === 'off' ? null : {
          mode: params.harmony === 'double' ? 'double'
            : params.harmony === 'double+third' ? 'double+third' : 'pitch',
          semis: params.harmony === 'third+fifth' ? [3, 7]
            : (params.harmony === 'third' || params.harmony === 'double+third') ? [3] : [],
          gain: params.harmonyGain,
          scope: params.harmonyScope,
        },
      });
      let lastLog = 0;
      const job = await deps.worker.wait(jobId, (p, msg) => {
        if (Date.now() - lastLog > 4000) {
          lastLog = Date.now();
          deps.log.info(`唱歌进度 ${Math.round(p * 100)}%：${msg}`);
        }
      });
      info = job.result ?? {};
      report = info.report as VocalReport | undefined;
      const suggest = info.pitchSuggest as { pitch: number; reason: string } | undefined;
      if (suggest?.reason) deps.log.info(`变调推荐：${suggest.reason}`);
      // 库里记实际用的半音数（'auto' 已在 worker 里落成具体值）
      if (suggest && params.pitch === 'auto') params.pitch = suggest.pitch;
      const raw = String(info.output ?? '');
      if (!raw) throw new Error('worker 没给出输出文件');

      // ---- 5. 转 mp3（44.1k 双声道 192k，QQ 和本机都认）
      mp3 = join(root, 'result.mp3');
      await toMp3(raw, mp3, deps.ffmpeg, '192k');
      cachePut(deps.data, key, mp3);

      // ---- 5b. 多级时间轴歌词（LRC / B站字幕 / 静音切分乐句兜底）
      const snapRange = info.snappedRange as { start?: number; end?: number } | undefined;
      const effStart = snapRange?.start ?? cutStart;
      const effDur = snapRange?.end !== undefined && snapRange?.start !== undefined
        ? Math.max(0, snapRange.end - snapRange.start)
        : cutDuration;
      lyrics = await resolveLyrics({
        title: src.title,
        hintQuery: songText,
        localPath: src.kind === 'file' ? src.input : undefined,
        bvid: src.bvid || undefined,
        fullDurationSec: src.durationSec,
        cutStart: effStart,
        cutDuration: effDur,
        phrases: report?.phrases,
        chorusRanges: report?.chorusRanges,
      }).catch(() => undefined);
    }

    const totalSec = await duration(mp3, deps.ffmpeg);
    const id = key;

    // ---- 6. 投递
    // to 的语义：local=只本机放；group:/private:=发 QQ（不本机放，免得群里点歌自己这儿也响）；
    // both=本机放 + 必须再给一个具体会话（单独写 both 只能本机放，因为不知道发给谁）
    const toRaw = String(req.to ?? '').trim();
    const lower = toRaw.toLowerCase();
    const isBoth = lower === 'both';
    const obTarget = parseTarget(toRaw);
    const delivered: string[] = [];
    const problems: string[] = [];

    // 先放进作品库：本地播放要播**库里的持久副本**，不能播临时文件——
    // 临时目录在函数返回前就被删了，ffplay 还没打开文件就没了，表现是"一声不响"。
    const libEntry = addToLibrary(deps.data, {
      id,
      title: src.title,
      source: src.bvid || src.input,
      bvid: src.bvid,
      file: mp3,
      durationSec: totalSec,
      at: Date.now(),
      params,
      target: '',
    }, mp3);

    // 持久化本次会话快照（干声路径 + 体检 + 时间轴歌词），供局部返工与唱中查句使用
    const prevSnap = loadSession(deps.data, id);
    const snapshot: SingSessionSnapshot = {
      id,
      title: src.title,
      bvid: src.bvid,
      source: src.bvid || src.input,
      mp3: libEntry.file,
      vocalSrc: String(info.vocalSrc || prevSnap?.vocalSrc || ''),
      convVocal: String(info.convVocal || prevSnap?.convVocal || ''),
      inst: String(info.inst || prevSnap?.inst || ''),
      durationSec: totalSec,
      pitchApplied: Number(info.pitchApplied ?? (typeof params.pitch === 'number' ? params.pitch : prevSnap?.pitchApplied ?? 0)),
      cutStart,
      cutDuration,
      params,
      report,
      lyrics,
      at: Date.now(),
    };
    try {
      saveSession(deps.data, snapshot);
    } catch {
      /* 快照保存失败不影响出声 */
    }

    const doLocal = lower === 'local' || isBoth || (!toRaw && deps.defaultTarget === 'local');
    if (doLocal) {
      if (!deps.playEnabled) {
        problems.push('本机播放被关掉了（配置 → 播放与发送）');
      } else {
        deps.player.play(libEntry.file, {
          dir: deps.ffmpeg.dir,
          playerPath: deps.playerPath,
          volume: deps.volume,
          meta: {
            id,
            title: src.title,
            durationSec: totalSec,
            lyrics,
            chorusRanges: report?.chorusRanges,
          },
          lyricPush: deps.lyricPush,
          onLyricCue: deps.onLyricCue,
          onEnd: (reason, elapsedSec) => {
            deps.onPlaybackEnd?.({ id, title: src.title, reason, elapsedSec, durationSec: totalSec, report });
          },
          log: (m: string) => deps.log.warn(m),
        });
        delivered.push('本机在放');
      }
    }

    if (obTarget) {
      if (!deps.onebot.httpUrl) {
        problems.push('没配 OneBot HTTP 地址，发不了 QQ');
      } else {
        const segs = await split(mp3, join(root, 'segs'), deps.maxSegmentSec, deps.ffmpeg);
        for (let i = 0; i < segs.length; i += 1) {
          if (i > 0 && deps.gapMs > 0) await new Promise((r) => setTimeout(r, deps.gapMs));
          await sendRecord(deps.onebot, obTarget, segs[i]);
        }
        delivered.push(`发到${obTarget.label}${segs.length > 1 ? `（${segs.length} 条）` : ''}`);
      }
    } else if (isBoth) {
      problems.push('「both」只做了本机播放——要发 QQ 请写 group:<群号> 或 private:<QQ号>');
    } else if (toRaw && lower !== 'local') {
      problems.push(`不认识的会话地址「${toRaw}」，要 group:<群号> 或 private:<QQ号>`);
    }

    // ---- 7. 作品库条目补充"投递到哪"
    if (delivered.length) {
      addToLibrary(deps.data, { ...libEntry, target: delivered.join(' + ') }, libEntry.file);
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);
    done = true;  // 走到这里任务已落终态，finally 里可以安全清理
    const suggest = info.pitchSuggest as { pitch: number; reason: string } | undefined;
    const autoNote = requestedAutoPitch && suggest
      ? `；变调 ${suggest.pitch >= 0 ? '+' : ''}${suggest.pitch}（${suggest.reason}）`
      : '';
    const reportNote = report?.summary ? `；体检：${report.summary}` : '';
    const lyricsNote = lyrics?.lines?.length ? `；已备时间轴（${lyrics.sourceLabel}，${lyrics.lines.length} 句）` : '';
    const head = `唱完了《${src.title}》，${human(totalSec)}${cached ? '（走缓存）' : `，用了 ${elapsed} 秒`}${autoNote}`;
    const tail = delivered.length ? `；${delivered.join('，')}` : '；没投递（文件进了作品库，可以用 fish_sing_library 回放）';
    const warn = problems.length ? `；但${problems.join('；')}` : '';
    return {
      ok: true,
      message: `${head}${tail}${reportNote}${lyricsNote}${warn}`,
      detail: {
        id,
        title: src.title,
        bvid: src.bvid,
        duration: totalSec,
        segments: Math.ceil(totalSec / deps.maxSegmentSec),
        cached,
        elapsed,
        file: libEntry.file,
        params,
        delivered,
        problems,
        pitchSuggest: info.pitchSuggest,
        report,
        lyricsSource: lyrics?.sourceLabel ?? '',
        lyricsCount: lyrics?.lines?.length ?? 0,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.log.warn(`唱歌失败：${msg}`);
    return { ok: false, message: `没唱成：${msg}` };
  } finally {
    if (done) {
      // 正常结束：中间产物清掉；成品在 cache/library 里各有一份
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* 被占用就留给 24h 清扫 */
      }
    } else {
      // 失败/超时：worker 里的任务可能还在写这个目录，等它落终态再删
      scheduleTmpCleanup(deps.worker, jobId, root);
    }
  }
}

/** 局部返工重唱 / 补录：复用分离干声与上一版换声干声，只重跑目标句并无缝贴回原位。 */
export async function patchSong(req: PatchRequest, deps: SingDeps): Promise<SingResult> {
  const t0 = Date.now();
  const snap = loadSession(deps.data, req.sessionId);
  if (!snap) return { ok: false, message: '还没有可返工的最近演唱记录，先唱一首歌吧。' };
  if (!snap.vocalSrc || !existsSync(snap.vocalSrc) || !snap.convVocal || !existsSync(snap.convVocal)) {
    return {
      ok: false,
      message: `《${snap.title}》的干声快照已不存在（可能被清理过或之前走旧缓存），请先带 refresh=true 重唱一次再局部返工。`,
    };
  }

  let startSec: number | undefined = req.start !== undefined ? Number(req.start) : undefined;
  let endSec: number | undefined = req.end !== undefined ? Number(req.end) : undefined;
  let locLabel = '';

  if (startSec === undefined || endSec === undefined) {
    if (req.atCurrent) {
      const pb = deps.player.playbackState();
      if (pb.playing && pb.currentLine) {
        startSec = pb.currentLine.start;
        endSec = pb.currentLine.end;
        locLabel = `当前第 ${pb.currentLine.index} 句「${pb.currentLine.text.slice(0, 18)}」`;
      } else if (pb.playing) {
        startSec = Math.max(0, pb.elapsedSec - 3);
        endSec = Math.min(snap.durationSec, pb.elapsedSec + 3);
        locLabel = `当前位置 ${fmtTime(startSec)}–${fmtTime(endSec)}`;
      }
    }
    if (startSec === undefined || endSec === undefined) {
      const hit = locatePatchRange(
        snap.lyrics as LyricsSheet | undefined,
        snap.report?.chorusRanges,
        {
          lines: req.lines,
          lyric: req.lyric,
          section: req.section,
          chorusIndex: req.chorusIndex,
        },
      );
      if (hit) {
        startSec = hit.start;
        endSec = hit.end;
        locLabel = hit.label;
      }
    }
  }

  if (startSec === undefined || endSec === undefined || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return {
      ok: false,
      message: '没定位到要返工的段落：请给句号（lines，如 "7" 或 "7-9"）、歌词关键词（lyric）、section="chorus" 或起止秒数（start/end）。',
    };
  }
  if (!locLabel) locLabel = `${fmtTime(startSec)}–${fmtTime(endSec)}`;

  const root = join(deps.data.dataDir, 'tmp', `patch-${stamp()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(root, { recursive: true });
  let jobId: string | null = null;
  let done = false;

  try {
    const p = snap.params;
    const previewOnly = req.previewOnly === true;
    const sessDir = sessionDir(deps.data, snap.id);
    const harmony = p.harmony && p.harmony !== 'off' ? {
      mode: p.harmony === 'double' ? 'double' : p.harmony === 'double+third' ? 'double+third' : 'pitch',
      semis: p.harmony === 'third+fifth' ? [3, 7] : (p.harmony === 'third' || p.harmony === 'double+third') ? [3] : [],
      gain: p.harmonyGain ?? 0.22,
      scope: p.harmonyScope ?? 'chorus',
    } : null;

    jobId = await deps.worker.submit('patch', {
      vocal_src: snap.vocalSrc,
      base_conv: snap.convVocal,
      inst: snap.inst || '',
      work: join(root, 'work'),
      session_dir: sessDir,
      start: startSec,
      end: endSec,
      snap: req.snap !== false,
      base_pitch: snap.pitchApplied,
      pitch: req.pitch !== undefined ? Number(req.pitch) : undefined,
      index_rate: req.indexRate !== undefined ? Number(req.indexRate) : p.indexRate,
      protect: req.protect !== undefined ? Number(req.protect) : p.protect,
      rms_mix_rate: req.rmsMixRate !== undefined ? clamp01(req.rmsMixRate) : (p.rmsMixRate ?? 0),
      f0_method: req.f0Method ?? p.f0Method ?? 'rmvpe',
      model: req.model ? String(req.model).trim() : '',
      harmony,
      reverb: p.reverb ?? 'off',
      polish: p.polish !== false,
      mode: p.mode,
      preview_only: previewOnly,
    });
    const job = await deps.worker.wait(jobId);
    const info = job.result ?? {};
    const raw = String(info.output ?? '');
    if (!raw) throw new Error('worker 没给出返工输出文件');

    const mp3 = join(root, 'patched.mp3');
    await toMp3(raw, mp3, deps.ffmpeg, '192k');
    const sec = await duration(mp3, deps.ffmpeg);

    let playFile = mp3;
    if (!previewOnly) {
      cachePut(deps.data, snap.id, mp3);
      const updated = addToLibrary(deps.data, {
        id: snap.id,
        title: snap.title,
        source: snap.source,
        bvid: snap.bvid,
        file: mp3,
        durationSec: sec,
        at: Date.now(),
        params: snap.params,
        target: '本机在放（已返工）',
      }, mp3);
      playFile = updated.file;
      saveSession(deps.data, {
        ...snap,
        mp3: updated.file,
        convVocal: String(info.convVocal || snap.convVocal),
        durationSec: sec,
        at: Date.now(),
      });
    } else {
      // 预览文件落到 session 目录持久一份，防止 tmp 删除导致 ffplay 读不到
      const previewDst = join(sessDir, 'last_preview.mp3');
      mkdirSync(sessDir, { recursive: true });
      await toMp3(raw, previewDst, deps.ffmpeg, '192k');
      playFile = previewDst;
    }

    const toRaw = String(req.to ?? '').trim();
    const lower = toRaw.toLowerCase();
    const obTarget = parseTarget(toRaw);
    const delivered: string[] = [];
    const doLocal = lower === 'local' || lower === 'both' || (!toRaw && deps.defaultTarget === 'local');
    if (doLocal && deps.playEnabled) {
      deps.player.play(playFile, {
        dir: deps.ffmpeg.dir,
        playerPath: deps.playerPath,
        volume: deps.volume,
        meta: {
          id: snap.id,
          title: previewOnly ? `${snap.title}（返工预览）` : snap.title,
          durationSec: sec,
          lyrics: previewOnly ? undefined : (snap.lyrics as LyricsSheet | undefined),
          chorusRanges: previewOnly ? undefined : snap.report?.chorusRanges,
        },
        lyricPush: previewOnly ? undefined : deps.lyricPush,
        onLyricCue: previewOnly ? undefined : deps.onLyricCue,
        onEnd: previewOnly ? undefined : (reason, elapsedSec) => {
          deps.onPlaybackEnd?.({ id: snap.id, title: snap.title, reason, elapsedSec, durationSec: sec, report: snap.report });
        },
        log: (m: string) => deps.log.warn(m),
      });
      delivered.push(previewOnly ? '本机试听返工句' : '本机播放新版全曲');
    }
    if (obTarget && deps.onebot.httpUrl) {
      const segs = await split(playFile, join(root, 'segs'), deps.maxSegmentSec, deps.ffmpeg);
      for (let i = 0; i < segs.length; i += 1) {
        if (i > 0 && deps.gapMs > 0) await new Promise((r) => setTimeout(r, deps.gapMs));
        await sendRecord(deps.onebot, obTarget, segs[i]);
      }
      delivered.push(`发到${obTarget.label}`);
    }

    done = true;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const sOut = Number(info.start ?? startSec);
    const eOut = Number(info.end ?? endSec);
    return {
      ok: true,
      message: `已返工《${snap.title}》${locLabel}（吸附区间 ${fmtTime(sOut)}–${fmtTime(eOut)}，用时 ${elapsed} 秒）${delivered.length ? `；${delivered.join('，')}` : ''}。`,
      detail: {
        id: snap.id,
        title: snap.title,
        start: sOut,
        end: eOut,
        previewOnly,
        elapsed,
        file: playFile,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.log.warn(`局部返工失败：${msg}`);
    return { ok: false, message: `局部返工失败：${msg}` };
  } finally {
    if (done) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    } else {
      scheduleTmpCleanup(deps.worker, jobId, root);
    }
  }
}
