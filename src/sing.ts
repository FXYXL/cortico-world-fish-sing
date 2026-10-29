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
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import { audioUrlOf, download, extractBvid, isBvid, rankHits, searchBili } from './bili.ts';
import { cut, duration, split, toMp3, type FfmpegDeps } from './audio.ts';
import { parseTarget, sendRecord, type OneBotOptions, type Player } from './deliver.ts';
import {
  addToLibrary, cacheGet, cacheKey, cachePut, type LibraryOptions, type SingParams,
} from './library.ts';
import type { LoggerLike, WorkerClient } from './worker.ts';

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
}

export interface SingRequest {
  song: string;
  to?: string;
  mode?: 'full' | 'vocals';
  pitch?: number;
  indexRate?: number;
  protect?: number;
  start?: number;
  duration?: number;
  /** 跳过缓存（想重唱一遍时用） */
  refresh?: boolean;
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
  const hits = await searchBili(raw);
  if (!hits.length) throw new Error(`B 站没搜到「${raw}」，换个写法或者直接给 BV 号`);
  const pool = hits.filter((h) => h.durationSec >= 20 && h.durationSec <= deps.maxDurationSec);
  if (!pool.length) {
    throw new Error(`搜到 ${hits.length} 条，但没有一条时长在 20~${Math.round(deps.maxDurationSec)} 秒内（可能都是合集/直播）`);
  }
  const ranked = rankHits(pool, raw, deps.excludeWords);
  const best = ranked[0];
  if ((best.score ?? 0) < deps.minScore) {
    const top = ranked.slice(0, 3).map((h) => `《${h.title}》（${human(h.durationSec)}，${h.bvid}，${h.score} 分）`);
    throw new Error(`没把握是这首（最高 ${best.score} 分，阈值 ${deps.minScore}）。候补：${top.join('；')}。要么换个写法（歌名+歌手），要么直接给 BV 号`);
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

export async function singSong(req: SingRequest, deps: SingDeps): Promise<SingResult> {
  const t0 = Date.now();
  const songText = String(req.song || '').trim();
  if (!songText) return { ok: false, message: '没给歌名或文件' };

  const params: SingParams = {
    model: deps.voice.model,
    index: deps.voice.index,
    indexRate: Number(req.indexRate ?? deps.voice.indexRate),
    protect: Number(req.protect ?? deps.voice.protect),
    pitch: Number(req.pitch ?? deps.voice.pitch),
    mode: req.mode ?? deps.voice.mode,
  };

  const root = join(deps.data.dataDir, 'tmp', `${stamp()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(root, { recursive: true });

  try {
    // ---- 1. 来源
    const src = await resolveSource(req, deps, root);
    deps.log.info(`唱歌：${src.title}（${src.note}，${human(src.durationSec)}）`);

    // ---- 2. 缓存
    const wantCut = (req.start ?? 0) > 0 || (req.duration ?? 0) > 0;
    const key = cacheKey(`${src.sourceId}|cut:${req.start ?? 0}/${req.duration ?? 0}`, params);
    let mp3 = req.refresh ? null : cacheGet(deps.data, key);
    let cached = Boolean(mp3);
    let info: Record<string, unknown> = {};

    if (mp3) {
      deps.log.info(`命中缓存（${key}）`);
    } else {
      // ---- 3. 截取（省算力：分离前就切）
      let feed = src.input;
      if (wantCut) {
        const cutFile = join(root, 'cut.wav');
        await cut(src.input, cutFile, Number(req.start ?? 0), Number(req.duration ?? 0), deps.ffmpeg);
        feed = cutFile;
        deps.log.info(`截取 ${Math.round(req.start ?? 0)}s 起 ${Math.round(req.duration ?? 0) || '到结尾'}s`);
      }

      // ---- 4. 换声
      const jobId = await deps.worker.submit('song', {
        input: feed,
        work: join(root, 'work'),
        separate: !src.alreadyVocal,
        mode: params.mode,
        pitch: params.pitch,
        index_rate: params.indexRate,
        protect: params.protect,
      });
      let lastLog = 0;
      const job = await deps.worker.wait(jobId, (p, msg) => {
        if (Date.now() - lastLog > 4000) {
          lastLog = Date.now();
          deps.log.info(`唱歌进度 ${Math.round(p * 100)}%：${msg}`);
        }
      });
      info = job.result ?? {};
      const raw = String(info.output ?? '');
      if (!raw) throw new Error('worker 没给出输出文件');

      // ---- 5. 转 mp3（44.1k 双声道 192k，QQ 和本机都认）
      mp3 = join(root, 'result.mp3');
      await toMp3(raw, mp3, deps.ffmpeg, '192k');
      cachePut(deps.data, key, mp3);
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

    const doLocal = lower === 'local' || isBoth || (!toRaw && deps.defaultTarget === 'local');
    if (doLocal) {
      if (!deps.playEnabled) {
        problems.push('本机播放被关掉了（配置 → 播放与发送）');
      } else {
        deps.player.play(libEntry.file, {
          dir: deps.ffmpeg.dir, playerPath: deps.playerPath, volume: deps.volume,
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
    const head = `唱完了《${src.title}》，${human(totalSec)}${cached ? '（走缓存）' : `，用了 ${elapsed} 秒`}`;
    const tail = delivered.length ? `；${delivered.join('，')}` : '；没投递（文件进了作品库，可以用 fish_sing_library 回放）';
    const warn = problems.length ? `；但${problems.join('；')}` : '';
    return {
      ok: true,
      message: `${head}${tail}${warn}`,
      detail: {
        title: src.title, bvid: src.bvid, duration: totalSec, segments: Math.ceil(totalSec / deps.maxSegmentSec),
        cached, elapsed, file: mp3, params, delivered, problems,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.log.warn(`唱歌失败：${msg}`);
    return { ok: false, message: `没唱成：${msg}` };
  } finally {
    // 中间产物清掉；成品在 cache/library 里各有一份
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 被占用就留着，下次启动可以清 */
    }
  }
}
