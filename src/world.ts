/**
 * 大肥鱼唱歌（World）：把一首歌换成她的声音，本机出声或发 QQ 语音条。
 *
 * 边界：
 *  · 只管"唱歌"这一件事——不做 TTS（那是 gpt-sovits 扩展的活）；
 *  · 不依赖 qq-final：语音条自己走 SnowLuma 的 OneBot HTTP record 段；
 *  · 不依赖 fishtools：B 站搜索在这里重新实现了一份（见 bili.ts）；
 *  · 重活全在 Python worker 里（模型常驻、55 秒切片），TS 侧只做编排和投递。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';

import { FISHSING_ID, fishsingConfigGroups, type FishSingConfigSection } from './config.ts';
import {
  BAND_LABEL,
  DROP_LABEL,
  datasetDirName,
  findActiveExperiment,
  f0Histogram,
  listDatasets,
  listExperiments,
  readDatasetState,
  readEvaluationPaths,
  readManifest,
  checkpointStats,
  planPruneCheckpoints,
  pruneCheckpoints,
  readTrainLog,
  logAgeSec,
  readTrainState,
  readWeights,
  saveEvaluationPaths,
  saveWeights,
  sourceQualityReport,
  suggestTrainParams,
  scanSources,
  summarize,
  WEIGHT_PRESETS,
  writeTrainState,
  writeDatasetState,
  weightedRows,
  validateEvaluation,
  readSamplingReport,
  sliceWeights,
  type TrainSource,
  type WeightConfig,
} from './train.ts';
import {
  deleteModel,
  importModel,
  listModels,
  readCurrent,
  useModel,
  type CurrentModel,
} from './models.ts';
import { BUNDLED_SEPARATE, LEGACY_RVC_ROOTS, MODELS_MANIFEST, PKG_ROOT, resolvePaths, VENDORED_RVC, type WorkerPaths } from './paths.ts';
import {
  copyRvcCode,
  detectOptionalDeps,
  downloadModels,
  resolveSystemPython,
  inspect,
  installRuntime,
  installUvrDeps,
  loadManifest,
  probeRuntime,
  type RuntimeMode,
  type SetupStatus,
  missingRequiredCount,
} from './setup.ts';
import { duration, split, toMp3, type FfmpegDeps } from './audio.ts';
import { rankHits, searchBili, type SearchOrder } from './bili.ts';
import { parseTarget, Player, sendRecord, type LyricCueEvent, type LyricPushConfig } from './deliver.ts';
import {
  addToLibrary,
  dropFromLibrary,
  listLibrary,
  loadLibrary,
  loadSession,
  pruneCache,
  renameInLibrary,
  saveSession,
  type LibraryOptions,
} from './library.ts';
import { fmtTime, formatLyricsTable, resolveLyrics, type LyricsSheet } from './lyrics.ts';
import { patchSong, singSong, type PlaybackEndInfo, type SingDeps, type SingSegmentSpec } from './sing.ts';
import { notify } from './notify.ts';
import { WorkerClient } from './worker.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

export interface FishSingWorldOptions {
  cfg: FishSingConfigSection;
  dataDir: string;
  secret: (name: string) => string | undefined;
}

/** 实验名默认后缀：fish261029（年月日）。RVC 的实验名会直接变成 logs/<exp> 目录。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export class FishSingWorld implements World {
  readonly id = FISHSING_ID;
  private host: WorldHost | null = null;
  private readonly opts: FishSingWorldOptions;
  private readonly player = new Player();
  private readonly worker: WorkerClient;
  /** 解析后的实际路径（自托管 or 外部 RVC），构造函数里算一次。 */
  private routes: WorkerPaths;
  private lastSong: { title: string; at: number; duration: number } | null = null;
  /** 同一时刻只允许一首在跑（GPU 只有一张卡）。 */
  private busy = false;
  /** 本实例提交过的任务类型。stop() 用它判断要不要顺手取消。 */
  private ownedJob: 'song' | 'dataset' | 'train' | null = null;
  /**
   * 安装/下载任务。只保留最近一个，用它给面板轮询进度。
   * 不做队列：装运行时和唱一首歌抢同一张卡，同时来两个只会互相拖死。
   */
  private setupJob: {
    kind: 'models' | 'runtime' | 'uvr';
    state: 'running' | 'done' | 'error';
    pct: number;
    msg: string;
    error?: string;
    startedAt: number;
  } | null = null;
  /** 取消用的开关。 */
  private setupAbort: AbortController | null = null;
  /** 当前在用的模型（存在 <dataDir>/model.json，配置里的 voice.model 只是出厂默认）。 */
  private current: CurrentModel = { model: '', index: '' };
  /**
   * 训练任务。和 datasetJob 分开：训练要跑几小时，中途还可能去看数据集/模型页，
   * 混在一个字段里会被互相覆盖。
   */
  /** 上次训练的实验名（存在 <dataDir>/train.json，重启后用来找回进度）。 */
  private lastExp = '';
  private trainJob: {
    id: string;
    state: 'running' | 'done' | 'error';
    pct: number;
    msg: string;
    exp: string;
    epochs: number;
    startedAt: number;
    error?: string;
  } | null = null;
  /** 数据准备任务（扫描 → 分离 → 切片）。面板靠轮询它拿进度。 */
  private datasetJob: {
    id: string;
    state: 'running' | 'done' | 'error';
    pct: number;
    msg: string;
    dir: string;
    error?: string;
  } | null = null;

  constructor(opts: FishSingWorldOptions) {
    // 不用「参数属性」写法：Node 的类型剥离跑不了它
    this.opts = opts;
    const cfg = opts.cfg || ({} as FishSingConfigSection);
    this.current = readCurrent(opts.dataDir, {
      model: String(cfg.voice?.model ?? 'dfy2.pth'),
      index: String(cfg.voice?.index ?? ''),
    });
    this.routes = resolvePaths(this.effCfg(), opts.dataDir);
    // 恢复上次选中的数据集：只存在内存里的话，重启 Coo 就看不到自己切好的数据了
    const saved = readDatasetState(opts.dataDir);
    if (saved && existsSync(join(saved, 'manifest.json'))) {
      this.datasetJob = { id: '', state: 'done', pct: 100, msg: '上次选中的数据集', dir: saved };
    }
    // 恢复上次训练的实验名；日志还在写就说明它还在跑（进程可能是重启前留下的）
    const ts = readTrainState(opts.dataDir);
    this.lastExp = ts.exp;
    if (ts.exp) {
      const dir = this.expDirFor(ts.exp);
      const age = logAgeSec(dir);
      if (age !== null && age < 180) {
        const done = readTrainLog(dir).done;
        this.trainJob = {
          id: '',
          state: 'running',
          pct: ts.epochs ? Math.min(99, Math.round((done / ts.epochs) * 100)) : 50,
          msg: '训练中（本次启动之前开始的，进程不由面板接管）',
          exp: ts.exp,
          epochs: ts.epochs,
          startedAt: ts.startedAt || Date.now(),
        };
      }
    }
    this.worker = new WorkerClient(
      {
        rvcRoot: this.routes.rvcRoot,
        pythonPath: this.routes.pythonPath,
        separatePython: this.routes.separatePython,
        separateScript: this.routes.separateScript,
        ffmpegDir: this.routes.ffmpegDir,
        port: Number(cfg.worker?.port ?? 9890),
        token: String(cfg.worker?.token ?? ''),
        autoStart: cfg.worker?.autoStart !== false,
        startTimeoutMs: Number(cfg.worker?.startTimeoutMs ?? 240000),
        workDir: join(opts.dataDir, 'work'),
        model: this.current.model,
        index: this.current.index,
        idleUnloadSec: Math.max(0, Math.round(Number(cfg.worker?.idleUnloadMin ?? 10) * 60)),
        uvrModelDir: join(this.routes.runtimeRoot, 'uvr_models'),
      },
      {
        info: (m: string) => this.host?.log.info(m),
        warn: (m: string) => this.host?.log.warn(m),
      },
    );
  }

  // ------------------------------------------------------------ 生命周期

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    host.log.info(`fish-sing 就绪：模型 ${this.opts.cfg.voice?.model ?? '?'}，本机播放${this.opts.cfg.play?.enabled === false ? '关' : '开'}`);
    if (this.opts.cfg.enabled === false) return;
    // 如果上一个 worker 还活着并且正在训练，直接把那个任务认回来——
    // 这样停止按钮能用、进度来自任务本身，比只读日志可靠。
    if (this.ownedJob !== 'train') {
      const cur = await this.worker.currentJob().catch(() => null);
      if (cur && cur.kind === 'train' && cur.state !== 'done' && cur.state !== 'error'
          && cur.state !== 'canceled') {
        const saved = readTrainState(this.opts.dataDir);
        const exp = cur.exp || this.lastExp;
        const epochs = cur.epochs || (saved.exp === exp ? saved.epochs : 0);
        const job = {
          id: cur.id,
          state: 'running' as const,
          pct: Math.round((cur.progress ?? 0) * 100),
          msg: cur.message || '训练中',
          exp,
          epochs,
          startedAt: saved.exp === exp && saved.startedAt ? saved.startedAt : Date.now(),
        };
        this.trainJob = job;
        this.ownedJob = 'train';
        host.log.info(`[fish-sing] 接管正在进行的训练：${job.exp}（${job.pct}%）`);
        // 重新挂上等待监听，确保重启后训练完成仍能正常落状态、发通知与执行收尾
        this.attachTrainWait(job, {
          pruneAfter: saved.exp === exp ? saved.pruneAfter === true : false,
          abTest: saved.exp === exp ? saved.abTest === true : false,
          keepEvery: saved.exp === exp ? saved.keepEvery : undefined,
          evaluationPaths: saved.exp === exp ? saved.evaluationPaths : undefined,
        });
      }
    }

    // 自托管时每次启动刷新一遍 RVC 代码（约 3 MB）。
    // 不这么做的话，插件升级后 runtime/ 里还是旧代码——改了训练逻辑也传不下去。
    // 权重和 logs 不受影响（copyRvcCode 只覆盖代码文件）。
    if (this.routes.selfHosted && existsSync(this.routes.rvcRoot)) {
      try {
        copyRvcCode(this.routes, VENDORED_RVC);
      } catch (e) {
        host.log.warn(`刷新 RVC 代码失败（不影响唱歌，但训练可能用旧代码）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 顺手把 worker 拉起来：省掉第一次请求的模型加载（约 6 秒）
    if (this.opts.cfg.worker?.autoStart !== false) {
      void this.worker.ensure().catch((e: unknown) => {
        host.log.warn(`唱歌 worker 没起来：${e instanceof Error ? e.message : String(e)}`);
      });
    }
    // 缓存清一清（作品库不动）
    try {
      const n = pruneCache(this.data(), 14);
      if (n > 0) host.log.info(`清掉 ${n} 个过期缓存`);
    } catch {
      /* 无所谓 */
    }
  }

  async stop(): Promise<void> {
    this.player.stop();
    /**
     * 退出时**不要**发 /stop 取消任务。
     *
     * /stop 会杀掉 worker 里正在跑的那一个 job。Coo 退出时被调一次，于是：
     * 重启一次 Coo = 掐掉一次训练（dfy3 就是这么断了两次，一次在第 28 轮、一次又在第 28 轮）。
     * 唱歌任务被掐问题不大，训练是几小时的活，不能跟着一起没。
     *
     * 只有显式点「停止训练」才会走 trainStop → cancel()。
     * 另外：本实例没有提交过任务时也不该取消，否则别人（另一个面板、别的 world）的活会被误伤。
     */
    if (this.ownedJob === 'song') {
      await this.worker.cancel().catch(() => undefined);
    }
    // 训练还在跑就**连 worker 一起留着**。
    // 关掉 worker 的话训练就成了孤儿：面板再打开时只能靠猜日志判断它死没死，
    // 停止按钮也按不动。留着它，下次启动 /current 就能把任务认回来。
    if (this.trainJob?.state === 'running') {
      this.host?.log.info(`[fish-sing] 训练进行中，worker 保持运行：${this.trainJob.exp}`);
    } else {
      this.worker.shutdown();
    }
    this.host = null;
  }

  // ------------------------------------------------------------ 内部

  private data(): LibraryOptions {
    return { dataDir: this.opts.dataDir };
  }

  private ffmpeg(): FfmpegDeps {
    return { dir: this.routes.ffmpegDir };
  }

  private onebotToken(): string {
    const secretName = String(this.opts.cfg.send?.tokenSecret ?? '').trim();
    if (secretName) {
      const v = this.opts.secret(secretName);
      if (v && v.trim()) return v.trim();
    }
    return String(this.opts.cfg.send?.token ?? '').trim();
  }

  /** 长任务结果主动说一声：QQ 配了走 QQ（失败退桌宠），没配就桌宠。详见 notify.ts。 */
  private notifyEvent(title: string, body = ''): Promise<unknown> {
    return notify(
      {
        cfg: this.opts.cfg.notify ?? {},
        pushEvent: (e) => this.host?.pushEvent(e as never),
        onebot: { httpUrl: String(this.opts.cfg.send?.httpUrl ?? ''), token: this.onebotToken() },
        log: this.host?.log ?? { info: () => undefined, warn: () => undefined },
      },
      title,
      body,
    ).then((r) => {
      if (r.via !== 'off') this.host?.log.info(`[fish-sing] 通知（${r.via}）：${r.note}`);
      return r;
    });
  }

  /**
   * 训练完成后自动生成选模对比试听：同一句训练切片（目标音色清唱），用
   * final + 最后两个中间档各换声一遍。输入完全一致，听出来的差异全是存档本身
   * 的差别——比拿着不同版本整首唱一遍再凭记忆比要靠谱。
   * 片段进作品库；配了 notify.qqTarget 就同时发 QQ。
   */
  private async runAbTest(exp: string, enabled?: boolean, evaluationPaths?: string[]): Promise<string> {
    if (enabled === false || this.opts.cfg.train?.abTest === false) return '';
    const weights = join(this.routes.rvcRoot, 'assets', 'weights');
    const logDir = join(this.routes.rvcRoot, 'logs', exp);
    const indexOf = (dir: string): string => {
      try {
        const idx = readdirSync(dir).find((f) => f.endsWith('.index'));
        return idx ? join(dir, idx) : '';
      } catch {
        return '';
      }
    };
    const variants: { ckpt: string; label: string; index: string }[] = [];
    const finalPth = join(weights, `${exp}.pth`);
    const hasFinal = existsSync(finalPth);
    if (hasFinal) variants.push({ ckpt: finalPth, label: 'final', index: indexOf(logDir) });
    try {
      // 中间档从新到旧取 2 个。
      // 注意：save_every_weights=1 时 RVC 把每个存档点导出成 weights/<exp>_e<N>_s<X>.pth，
      // logs 里只剩滚动的 G_2333333（跟 final 重复）——所以必须优先看 weights 目录。
      // （0.4.8 之前只查 logs 里的 G_<步数>.pth，结果永远"只有一个存档"，选模对比被静默跳过。）
      const esc = exp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${esc}_e(\\d+)_s\\d+\\.pth$`);
      const exported = readdirSync(weights)
        .map((f) => re.exec(f))
        .filter((m): m is RegExpExecArray => Boolean(m))
        .map((m) => ({ epoch: Number(m[1]), file: m[0] }))
        .sort((a, b) => b.epoch - a.epoch);
      // 最新一个导出的存档通常就等于 final，跳过它（否则同一份权重会比两次）
      const pool = hasFinal ? exported.slice(1) : exported;
      for (const it of pool.slice(0, 2)) {
        variants.push({
          ckpt: join(weights, it.file),
          label: `e${it.epoch}`,
          index: indexOf(logDir),
        });
      }
      if (variants.length < 2) {
        // 老实验没有导出文件时退回 logs 里的 G_<步数>.pth
        const gs = readdirSync(logDir)
          .map((f) => /^G_(\d+)\.pth$/.exec(f))
          .filter((m): m is RegExpExecArray => Boolean(m) && m[1] !== '2333333')
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .slice(0, 2);
        for (const m of gs) variants.push({ ckpt: join(logDir, m[0]), label: `e${m[1]}`, index: indexOf(logDir) });
      }
    } catch {
      /* 没有中间档就只用 final */
    }
    if (variants.length < 2) {
      this.host?.log.info(`[fish-sing] ${exp} 只有一个可用存档（中间档可能被清理了），跳过选模对比`);
      return '';
    }
    const gtDir = join(logDir, '0_gt_wavs');
    const saved = join(logDir, 'evaluation.json');
    const tests = validateEvaluation(evaluationPaths ?? (existsSync(saved)
      ? JSON.parse(readFileSync(saved, 'utf8')) : []),
      existsSync(gtDir) ? readdirSync(gtDir).filter(f => f.endsWith('.wav')).map(f => join(gtDir, f)) : []);
    const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const outDir = join(this.data().dataDir, 'ab', `${exp}-${ts}`);
    const jobId = await this.worker.submit('ab', {
      tests, out: outDir, variants, pitch: 0, index_rate: 0, protect: 0.33,
    });
    const job = await this.worker.wait(
      jobId,
      (p, msg) => this.host?.log.info(`[fish-sing] 选模对比 ${Math.round(p * 100)}%：${msg}`),
      { stallMs: 10 * 60_000 },
    );
    const outputs = ((job.result?.outputs ?? []) as { label: string; file: string }[])
      .filter((o) => existsSync(o.file));
    const compares = ((job.result?.compares ?? []) as { band: string; labels: string[]; file: string }[])
      .filter((c) => existsSync(c.file));
    if (!outputs.length) throw new Error('选模任务未生成试听文件');
    const labels: string[] = [];
    const obTarget = parseTarget(String(this.opts.cfg.notify?.qqTarget ?? ''));
    const onebot = { httpUrl: String(this.opts.cfg.send?.httpUrl ?? ''), token: this.onebotToken() };
    const canSendQQ = Boolean(obTarget && onebot.httpUrl);
    if (!canSendQQ) {
      // 缺配置只提示一次，避免循环里连刷多条告警
      this.host?.log.warn(
        `[fish-sing] 选模片段没发 QQ：${!obTarget ? 'qqTarget 没配或格式不对（要 group:/private: 前缀）' : 'OneBot HTTP 地址没配'}`,
      );
    }
    const bandZh: Record<string, string> = { low: '低音', mid: '中音', high: '高音' };
    for (const o of outputs) {
      const mp3 = join(outDir, `${o.label}.mp3`);
      await toMp3(o.file, mp3, this.ffmpeg(), '192k');
      labels.push(o.label);
      addToLibrary(this.data(), {
        id: `ab-${exp}-${o.label}`,
        title: `${exp} 选模对比 · ${o.label}`,
        source: 'ab-test', bvid: '',
        file: mp3,
        durationSec: await duration(mp3, this.ffmpeg()).catch(() => 0),
        at: Date.now(),
        params: { model: o.label, index: '', indexRate: 0, protect: 0.33, pitch: 0, mode: 'vocals' },
        target: '',
      }, mp3);
      // 没有串联轨时才逐条发单段，避免 QQ 一次刷 9 条语音
      if (canSendQQ && obTarget && !compares.length) {
        try {
          await sendRecord(onebot, obTarget, mp3);
        } catch (e) {
          this.host?.log.warn(`[fish-sing] 选模片段发 QQ 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    for (const c of compares) {
      const mp3 = join(outDir, `compare_${c.band}.mp3`);
      await toMp3(c.file, mp3, this.ffmpeg(), '192k');
      const seq = c.labels.join(' → ');
      addToLibrary(this.data(), {
        id: `ab-${exp}-cmp-${c.band}`,
        title: `${exp} 选模串联·${bandZh[c.band] ?? c.band}（${seq}）`,
        source: 'ab-test-compare', bvid: '',
        file: mp3,
        durationSec: await duration(mp3, this.ffmpeg()).catch(() => 0),
        at: Date.now(),
        params: { model: seq, index: '', indexRate: 0, protect: 0.33, pitch: 0, mode: 'vocals' },
        target: '',
      }, mp3);
      if (canSendQQ && obTarget) {
        try {
          await sendRecord(onebot, obTarget, mp3);
        } catch (e) {
          this.host?.log.warn(`[fish-sing] 选模串联轨发 QQ 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    this.host?.log.info(`[fish-sing] 选模对比已生成：${labels.join(' / ')}（${outDir}）`);
    void this.notifyEvent(
      `选模试听已生成：${exp}`,
      `独立低、中、高音干声（关闭检索），用 ${labels.join('、')} 对比${compares.length ? `，并已合成 ${compares.length} 条串联对比轨` : ''}。在作品库里试听（fish_sing_library）${canSendQQ ? '，QQ 那边也已发送' : ''}。`,
    );
    return labels.join(' / ');
  }

  private lyricPushConfig(): LyricPushConfig {
    const p = this.opts.cfg.play;
    const rawMode = String(p?.lyricPushMode ?? 'smart');
    const mode: 'off' | 'smart' | 'interval' = rawMode === 'off' ? 'off' : rawMode === 'interval' ? 'interval' : 'smart';
    return {
      mode,
      intervalSec: Math.max(0, Math.min(120, Number(p?.lyricPushIntervalSec ?? 25))),
      leadSec: Math.max(0, Math.min(10, Number(p?.lyricLeadSec ?? 3))),
    };
  }

  private emitLyricCue(cue: LyricCueEvent): void {
    void this.pushSingEvent('fishsing.lyric', cue.text, {
      kind: cue.kind,
      title: cue.title,
      elapsedSec: cue.elapsedSec,
      durationSec: cue.durationSec,
      nextLine: cue.nextLine,
    });
  }

  /** 汇总本机可用的音色模型列表（优先展示各实验主模型，供工具按需返回，不占用常驻环境提示词）。 */
  private formatAvailableModels(): string {
    const all = listModels(this.routes, this.current.model);
    if (!all.length) return '无';
    // 优先展示无 _eXXX 后缀的主模型；如果某实验只有中间档，也保留最新一档
    const byExp = new Map<string, typeof all>();
    for (const m of all) {
      const arr = byExp.get(m.exp) ?? [];
      arr.push(m);
      byExp.set(m.exp, arr);
    }
    const picked: typeof all = [];
    for (const arr of byExp.values()) {
      const finals = arr.filter((x) => x.epoch === null);
      if (finals.length) picked.push(...finals);
      else picked.push(arr[0]);
    }
    // 当前正在用的模型（即使是中间档）一定要露脸
    if (!picked.some((x) => x.current)) {
      const cur = all.find((x) => x.current);
      if (cur) picked.unshift(cur);
    }
    return picked
      .map((m) => {
        const rg = m.range ? ` ${m.range.p5}–${m.range.p95}Hz` : '';
        return `${m.name}${m.current ? '（当前）' : ''}${rg ? `(${rg.trim()})` : ''}`;
      })
      .join('、');
  }

  private deps(): SingDeps {
    const cfg = this.opts.cfg;
    return {
      log: {
        info: (m: string) => this.host?.log.info(m),
        warn: (m: string) => this.host?.log.warn(m),
      },
      worker: this.worker,
      player: this.player,
      ffmpeg: this.ffmpeg(),
      data: this.data(),
      onebot: { httpUrl: String(cfg.send?.httpUrl ?? ''), token: this.onebotToken() },
      defaultTarget: (cfg.play?.defaultTarget ?? 'local') === 'none' ? 'none' : 'local',
      playEnabled: cfg.play?.enabled !== false,
      volume: Number(cfg.play?.volume ?? 1),
      playerPath: String(cfg.play?.playerPath ?? ''),
      maxSegmentSec: Math.max(10, Number(cfg.send?.maxSegmentSec ?? 55)),
      gapMs: Math.max(0, Number(cfg.send?.gapMs ?? 1500)),
      songEnabled: cfg.song?.enabled !== false,
      maxDurationSec: Number(cfg.song?.maxDurationSec ?? 480),
      maxAudioMB: Number(cfg.song?.maxAudioMB ?? 30),
      minScore: Number(cfg.song?.minScore ?? 8),
      excludeWords: String(cfg.song?.excludeWords ?? ''),
      voice: {
        model: this.current.model,
        index: this.current.index,
        indexRate: Number(cfg.voice?.indexRate ?? 0.75),
        protect: Number(cfg.voice?.protect ?? 0.33),
        pitch: (cfg.voice?.pitch as number | 'auto' | undefined) ?? 'auto',
        rmsMixRate: cfg.voice?.rmsMixRate === undefined ? 0 : Number(cfg.voice.rmsMixRate),
        harmony: (cfg.voice?.harmony === 'double' || cfg.voice?.harmony === 'double+third'
          || cfg.voice?.harmony === 'third' || cfg.voice?.harmony === 'third+fifth'
          ? cfg.voice.harmony : 'off') as 'off' | 'double' | 'double+third' | 'third' | 'third+fifth',
        harmonyGain: cfg.voice?.harmonyGain === undefined ? 0.22 : Number(cfg.voice.harmonyGain),
        harmonyScope: cfg.voice?.harmonyScope === 'all' ? 'all' : 'chorus',
        reverb: cfg.voice?.reverb === 'light' ? 'light' : 'off',
        polish: cfg.voice?.polish !== false,
        f0Method: cfg.voice?.f0Method === 'fcpe' ? 'fcpe' : 'rmvpe',
        separator: cfg.voice?.separator === 'roformer' ? 'roformer' : 'htdemucs',
        dereverb: cfg.voice?.dereverb === true,
        dynamicStyle: cfg.voice?.dynamicStyle === 'soft-verse-bright-chorus' ? 'soft-verse-bright-chorus' : 'off',
        mode: cfg.voice?.mode === 'vocals' ? 'vocals' : 'full',
      },
      lyricPush: this.lyricPushConfig(),
      onLyricCue: (cue: LyricCueEvent) => this.emitLyricCue(cue),
      onPlaybackEnd: (ev: PlaybackEndInfo) => {
        if (ev.reason !== 'ended') return;
        const issueHint = ev.report?.issues?.length
          ? `（声学体检留意：${ev.report.issues[0].note}，如想重唱某句可调 fish_sing_patch）`
          : '';
        void this.pushSingEvent(
          'fishsing.ended',
          `《${ev.title}》刚刚自然唱完了（${fmtTime(ev.durationSec)}）${issueHint}。可以顺着气氛自然接话，问问要不要再来一首或重唱哪一句。`,
          { id: ev.id, title: ev.title, durationSec: ev.durationSec, report: ev.report },
        );
      },
    };
  }

  private async pushSingEvent(type: string, text: string, meta?: Record<string, unknown>): Promise<void> {
    if (!this.host?.pushEvent) return;
    try {
      await this.host.pushEvent({
        type,
        origin: 'internal',
        source: FISHSING_ID,
        senderKey: `${FISHSING_ID}:${type}`,
        ts: new Date().toISOString(),
        text,
        meta,
      });
    } catch (e) {
      this.host?.log.warn(`[fish-sing] 推送事件 ${type} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------ 环境提示词

  envPromptVars(): Record<string, string> | null {
    const cfg = this.opts.cfg;
    if (cfg.enabled === false) return null;
    let text = '';
    try {
      text = readFileSync(ENV_PROMPT_FILE, 'utf8');
    } catch {
      return null;
    }
    const model = this.current.model || String(cfg.voice?.model ?? '');
    const where = cfg.play?.defaultTarget === 'none'
      ? '不自动发，由你自己判断要不要发'
      : cfg.play?.defaultTarget === 'both'
        ? '本机 + QQ 都发'
        : '本机（不打扰群里）';
    const elapsedSec = this.lastSong
      ? Math.max(0, Math.round((Date.now() - this.lastSong.at) / 1000))
      : 0;
    const ago = elapsedSec >= 60 ? `${Math.round(elapsedSec / 60)} 分钟前` : `${elapsedSec} 秒前`;
    const last = this.lastSong
      ? `上一次唱的是《${this.lastSong.title}》（${ago}）`
      : '还没唱过';
    // 装机状态：让她一眼知道现在能不能唱，而不是调了工具才发现缺权重
    const st = inspect(this.routes);
    // 只算「必需」组件（hubert / rmvpe / 两个底模）。出厂默认模型 dfy2 是可选的示例：
    // 用户换过模型后删掉它很正常。以前这里把所有文件都算上，结果她被告知"还缺 2 个权重、
    // 现在唱不了"——明明能用 dfy7 唱，却按这句话拒绝唱歌。（面板 0.4.22 修过，这里是第三处）
    const missModels = missingRequiredCount(st.models);
    const ready = st.rvc.ready && st.python.ok && missModels === 0;
    // 值写成**人话**而不是枚举：模板只做占位符替换、没有条件语法，
    // 所以这句话本身就是"缺什么 + 去哪补"的行动指引。
    const state = ready
      ? '已就绪，可以直接唱。'
      : !st.rvc.ready
        ? '还缺插件代码，现在唱不了 —— 让她在控制台「大肥鱼唱歌 → 安装与运行时」页点「刷新」，或重装插件。'
        : !st.python.ok
          ? '还缺 Python 运行时，现在唱不了 —— 让她在「安装与运行时」页点「安装 GPU 运行时」。'
          : `还缺 ${missModels} 个必需组件，现在唱不了 —— 让她在「安装与运行时」页点「下载必需组件」。`;
    return {
      singModel: model || '未配置',
      singTarget: where,
      singLast: last,
      singOnebot: String(cfg.send?.httpUrl ?? '') ? '可用' : '没配（只能本机播放）',
      singState: state,
      singLangs: String(cfg.voice?.f0Method ?? 'rmvpe'),
    };
  }

  // ------------------------------------------------------------ 工具

  tools(): ToolDef[] {
    const cfg = this.opts.cfg;
    if (cfg.enabled === false) return [];
    const list: ToolDef[] = [];

    list.push({
      name: 'fish_sing',
      description: [
        '唱一首歌：把这首歌换成她自己的声音唱出来，可以只在电脑上放，也可以发成 QQ 语音条。',
        '来源三选一：歌名（去 B 站搜）、BV 号或 B 站链接、本机文件绝对路径。',
        '不确定哪条视频对时，先 search=true 只搜索不下载，看一眼标题再决定——正则打分分不出「女声翻唱」和「电音版」的区别，你自己读标题能分清。',
        '看完候选用 pick 指定：给序号（从 1 开始）或 BV 号。pick 会跳过相关性阈值，所以只挑你确认过的。',
        'order 可以换 B 站排序：default 综合、click 按播放、pubdate 按最新。找冷门翻唱时 click 常比综合靠谱。',
        '什么时候用：用户说「唱一首 X」「用你的声音唱 X」「来首 X 呗」，或者她自己想唱。',
        'to 决定声音去哪：local=只在本机放（默认、不打扰群）；group:<群号> 或 private:<QQ号> 发语音条（长歌会自动切成多条，每条 ≤60 秒）；both=两边都要。会话号从消息事件里原样取，不要自己编。',
        '耗时 60~120 秒，期间别的唱歌请求会被拒。返回 ok=false 时，把 message 里的真实原因如实告诉用户，不要假装唱了。',
      ].join(' '),
      tags: ['music', 'voice'],
      parameters: {
        type: 'object',
        properties: {
          song: { type: 'string', description: '歌名（可带歌手）、BV 号、B 站链接，或本机音频文件绝对路径' },
          to: { type: 'string', description: 'local / group:<群号> / private:<QQ号> / both；不填按配置默认' },
          mode: { type: 'string', enum: ['full', 'vocals'], description: 'full=带伴奏；vocals=清唱（更容易听出音色）' },
          pitch: { type: ['number', 'string'], description: "移调半音；不填或 'auto' = 按模型音域自动推荐（默认）；男歌女唱常要 +2~+4" },
          indexRate: { type: 'number', description: '音色检索强度 0~1；越大越像本人，0.9 以上咬字可能歪' },
          protect: { type: 'number', description: '气声保护 0~0.5；齿音发毛就调高到 0.4~0.45' },
          start: { type: 'number', description: '从第几秒开始唱（只想唱副歌时用）' },
          duration: { type: 'number', description: '唱多长（秒）；配合 start 可只发一段' },
          refresh: { type: 'boolean', description: '忽略缓存重唱一遍' },
          search: { type: 'boolean', description: '只搜索不下载，返回候选列表（标题/时长/UP主/播放/BV）让你自己挑' },
          rmsMixRate: {
            type: 'number',
            description: '音量跟随原唱的程度 0~1：0 = 完全跟随（轻唱/渐弱能还原，默认）；'
              + '0.25 = 保留一点模型自己的动态；1 = 不跟随（轻唱会被唱满）。不确定就别传。',
          },
          pick: { type: 'string', description: '选定第几条：序号（从 1 开始）或 BV 号；配合 search 使用' },
          order: {
            type: 'string',
            enum: ['default', 'click', 'pubdate'],
            description: 'B 站排序：default 综合 / click 播放多 / pubdate 最新',
          },
          f0Method: {
            type: 'string',
            enum: ['rmvpe', 'fcpe'],
            description: '音高提取算法：rmvpe（默认）或 fcpe（高音气声偶发更稳）',
          },
          separator: {
            type: 'string',
            enum: ['htdemucs', 'roformer'],
            description: '人声分离档位：htdemucs（快速）或 roformer（UVR5 精唱，更干净）',
          },
          dereverb: {
            type: 'boolean',
            description: '分离后是否额外去混响（减少原唱混响导致的电音）',
          },
          model: {
            type: 'string',
            description: '临时指定本次演唱使用的音色模型（如 dfy7.pth），唱完自动恢复默认模型；可先调 fish_sing_status 查看本机全部可用音色模型',
          },
          dynamicStyle: {
            type: 'string',
            enum: ['off', 'soft-verse-bright-chorus'],
            description: '主副歌动态演绎：soft-verse-bright-chorus = 自动主歌轻柔、副歌明亮',
          },
          segments: {
            type: 'array',
            description: '显式分段换音色/换参数：每项 {start, end, model?, indexRate?, protect?, pitch?}',
            items: {
              type: 'object',
              properties: {
                start: { type: 'number' },
                end: { type: 'number' },
                model: { type: 'string' },
                indexRate: { type: 'number' },
                protect: { type: 'number' },
                pitch: { type: 'number' },
              },
              required: ['start', 'end'],
            },
          },
          async: {
            type: 'boolean',
            description: '是否异步后台准备并自动开唱（默认按配置开启；开唱和自然播完时会通过事件通知你）',
          },
        },
        required: ['song'],
      },
      handler: async (args) => {
        if (cfg.enabled === false) return '唱歌功能被关掉了。';
        if (this.trainJob?.state === 'running') {
          return '正在训练模型（显存被占着），这会儿唱不了。训练完再唱，或者在控制台「训练」页停掉训练。';
        }
        if (this.busy) return '上一首还在处理中（同一时刻只能处理一首，显卡就一张）。等她唱完再说，或者先 fish_sing_stop 停掉。';

        const req = {
          song: String(args.song ?? ''),
          to: args.to === undefined ? undefined : String(args.to),
          mode: args.mode === 'vocals' ? ('vocals' as const) : args.mode === 'full' ? ('full' as const) : undefined,
          pitch: args.pitch === undefined ? undefined
            : String(args.pitch).toLowerCase() === 'auto' ? ('auto' as const) : Number(args.pitch),
          indexRate: args.indexRate === undefined ? undefined : Number(args.indexRate),
          protect: args.protect === undefined ? undefined : Number(args.protect),
          rmsMixRate: args.rmsMixRate === undefined ? undefined : Number(args.rmsMixRate),
          harmony: args.harmony === 'double' || args.harmony === 'double+third'
            || args.harmony === 'third' || args.harmony === 'third+fifth' || args.harmony === 'off'
            ? (args.harmony as 'off' | 'double' | 'double+third' | 'third' | 'third+fifth') : undefined,
          reverb: args.reverb === 'light' || args.reverb === 'off' ? (args.reverb as 'off' | 'light') : undefined,
          polish: typeof args.polish === 'boolean' ? args.polish : undefined,
          f0Method: args.f0Method === 'fcpe' || args.f0Method === 'rmvpe' ? (args.f0Method as 'rmvpe' | 'fcpe') : undefined,
          separator: args.separator === 'roformer' || args.separator === 'htdemucs' ? (args.separator as 'htdemucs' | 'roformer') : undefined,
          dereverb: typeof args.dereverb === 'boolean' ? args.dereverb : undefined,
          model: args.model === undefined ? undefined : String(args.model),
          dynamicStyle: args.dynamicStyle === 'soft-verse-bright-chorus' || args.dynamicStyle === 'off'
            ? (args.dynamicStyle as 'off' | 'soft-verse-bright-chorus') : undefined,
          segments: Array.isArray(args.segments) ? (args.segments as SingSegmentSpec[]) : undefined,
          start: args.start === undefined ? undefined : Number(args.start),
          duration: args.duration === undefined ? undefined : Number(args.duration),
          refresh: args.refresh === true,
          search: args.search === true,
          pick: args.pick === undefined ? undefined : String(args.pick),
          order: args.order === 'click' || args.order === 'pubdate' ? (args.order as 'click' | 'pubdate') : ('default' as const),
        };

        const wantAsync = req.search !== true && (
          typeof args.async === 'boolean' ? args.async : cfg.play?.asyncSing !== false
        );

        this.busy = true;
        this.ownedJob = 'song';

        if (wantAsync) {
          void (async () => {
            try {
              const r = await singSong(req, this.deps());
              if (r.ok && r.detail) {
                this.lastSong = {
                  title: String(r.detail.title ?? ''),
                  at: Date.now(),
                  duration: Number(r.detail.duration ?? 0),
                };
                await this.pushSingEvent('fishsing.started', r.message, r.detail);
              } else {
                await this.pushSingEvent('fishsing.error', r.message);
              }
            } catch (e) {
              await this.pushSingEvent('fishsing.error', `没唱成：${e instanceof Error ? e.message : String(e)}`);
            } finally {
              this.busy = false;
            }
          })();
          return `已开始后台准备「${req.song}」，分离换声完成后会自动开唱并通知你（期间可以正常聊天，想停随时调用 fish_sing_stop）。`;
        }

        try {
          const r = await singSong(req, this.deps());
          if (r.ok && r.detail) {
            this.lastSong = {
              title: String(r.detail.title ?? ''),
              at: Date.now(),
              duration: Number(r.detail.duration ?? 0),
            };
          }
          return r.message;
        } finally {
          this.busy = false;
        }
      },
    });

    list.push({
      name: 'fish_sing_patch',
      description: [
        '局部返工重唱 / 补录：不重跑整首，复用刚唱过那首歌的分离干声与换声干声，只针对某一句、某段副歌或某几秒换参数或换模型重唱一遍，并自动吸附静音边界无缝贴回原位。',
        '支持按句号（lines="7" 或 "7-9"）、歌词关键词（lyric）、section="chorus"、当前正在唱的那一句（atCurrent=true）或起止秒（start/end）定位。',
      ].join(' '),
      tags: ['music', 'voice'],
      parameters: {
        type: 'object',
        properties: {
          lines: { type: 'string', description: '按歌词句号定位，如 "7" 或 "7-9"（先用 fish_sing_lyrics 看句号）' },
          lyric: { type: 'string', description: '按歌词关键词模糊匹配定位对应句子' },
          section: { type: 'string', enum: ['chorus'], description: '直接返工副歌段' },
          chorusIndex: { type: 'number', description: '第几段副歌（从 1 开始，配合 section="chorus"）' },
          atCurrent: { type: 'boolean', description: 'true = 自动取本机当前正唱到的那一句' },
          start: { type: 'number', description: '起始秒（秒数直定位）' },
          end: { type: 'number', description: '结束秒（秒数直定位）' },
          pitch: { type: 'number', description: '该句新移调半音数（不填沿用原曲）' },
          indexRate: { type: 'number', description: '该句新检索强度 0~1' },
          protect: { type: 'number', description: '该句新气声保护 0~0.5' },
          rmsMixRate: { type: 'number', description: '该句新音量跟随 0~1' },
          f0Method: { type: 'string', enum: ['rmvpe', 'fcpe'], description: '该句临时切换 F0 算法' },
          model: { type: 'string', description: '临时换另一个音色模型来唱这一句（如 dfy7.pth），可先调 fish_sing_status 查看本机全部可用音色模型' },
          previewOnly: { type: 'boolean', description: 'true = 只试听返工句（前后带 2 秒上下文），不改整首；false = 贴回整首并重放' },
          to: { type: 'string', description: '投递目标，默认 local' },
        },
        required: [],
      },
      handler: async (args) => {
        if (cfg.enabled === false) return '唱歌功能被关掉了。';
        if (this.trainJob?.state === 'running') return '正在训练模型（显存被占着），先等训练结束。';
        if (this.busy) return '上一首或上一次返工还在处理中，稍等几秒。';
        this.busy = true;
        this.ownedJob = 'song';
        try {
          const r = await patchSong({
            lines: args.lines === undefined ? undefined : String(args.lines),
            lyric: args.lyric === undefined ? undefined : String(args.lyric),
            section: args.section === 'chorus' ? 'chorus' : undefined,
            chorusIndex: args.chorusIndex === undefined ? undefined : Number(args.chorusIndex),
            atCurrent: args.atCurrent === true,
            start: args.start === undefined ? undefined : Number(args.start),
            end: args.end === undefined ? undefined : Number(args.end),
            pitch: args.pitch === undefined ? undefined : Number(args.pitch),
            indexRate: args.indexRate === undefined ? undefined : Number(args.indexRate),
            protect: args.protect === undefined ? undefined : Number(args.protect),
            rmsMixRate: args.rmsMixRate === undefined ? undefined : Number(args.rmsMixRate),
            f0Method: args.f0Method === 'fcpe' || args.f0Method === 'rmvpe' ? args.f0Method : undefined,
            model: args.model === undefined ? undefined : String(args.model),
            previewOnly: args.previewOnly === true,
            to: args.to === undefined ? undefined : String(args.to),
          }, this.deps());
          return r.message;
        } finally {
          this.busy = false;
        }
      },
    });

    list.push({
      name: 'fish_sing_lyrics',
      description: '查看当前或最近一首歌的时间轴歌词表（句号、起止秒、主/副歌标签）、当前播到第几句，以及声学体检明细。唱中插话、按句返工或顺着歌词情绪接话时调用。',
      tags: ['music'],
      parameters: {
        type: 'object',
        properties: {
          fromLine: { type: 'number', description: '从第几句开始显示，默认 1' },
          limit: { type: 'number', description: '最多返回几句，默认 45' },
          refresh: { type: 'boolean', description: '强制重新联网匹配歌词并更新会话缓存' },
        },
        required: [],
      },
      handler: async (args) => {
        const snap = loadSession(this.data());
        if (!snap) return '还没有最近唱过歌的记录。';
        const needRetryLang = Boolean(
          /[\u4e00-\u9fff]/.test(snap.title)
          && snap.lyrics?.lines?.length
          && snap.lyrics.source !== 'phrases'
          && !/[\u4e00-\u9fff]/.test(snap.lyrics.lines.map((l) => l.text).join('')),
        );
        if (args.refresh === true || needRetryLang) {
          const fresh = await resolveLyrics({
            title: snap.title,
            bvid: snap.bvid || undefined,
            fullDurationSec: snap.durationSec,
            cutStart: snap.cutStart,
            cutDuration: snap.cutDuration,
            phrases: snap.report?.phrases,
            chorusRanges: snap.report?.chorusRanges,
          }).catch(() => undefined);
          if (fresh) {
            snap.lyrics = fresh;
            try {
              saveSession(this.data(), snap);
            } catch {
              /* 忽略 */
            }
          }
        }
        const pb = this.player.playbackState();
        const head: string[] = [`《${snap.title}》（${fmtTime(snap.durationSec)}）`];
        if (pb.playing) {
          const curTxt = pb.currentLine
            ? `，正唱到第 ${pb.currentLine.index} 句「${pb.currentLine.text}」`
            : '';
          head.push(`当前播放进度：${fmtTime(pb.elapsedSec)} / ${fmtTime(pb.durationSec || snap.durationSec)}${curTxt}`);
        }
        if (snap.report?.summary) {
          head.push(`声学体检：${snap.report.summary}`);
          if (snap.report.issues?.length) {
            head.push('风险时间段：\n' + snap.report.issues.map((it) => `  - ${it.note}`).join('\n'));
          }
        }
        if (snap.lyrics?.lines?.length) {
          head.push(formatLyricsTable(snap.lyrics as LyricsSheet, {
            fromLine: args.fromLine === undefined ? 1 : Number(args.fromLine),
            limit: args.limit === undefined ? 45 : Number(args.limit),
          }));
        } else {
          head.push('（暂无歌词时间轴）');
        }
        return head.join('\n');
      },
    });

    list.push({
      name: 'fish_sing_stop',
      description: '让她别唱了：停掉本机正在放的那首，并取消正在处理的歌。用户说「别唱了」「停」「安静」时用。',
      tags: ['music'],
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const was = this.player.playing;
        this.player.stop();
        await this.worker.cancel().catch(() => undefined);
        return was ? '停了。' : '本来就没在唱（正在处理的那首也取消了）。';
      },
    });

    list.push({
      name: 'fish_sing_library',
      description: '她唱过的歌都在这里：列出、回放、发到 QQ、删除。用户问「你都唱过什么」「再放一遍刚才那首」「把那首发到群里」时用。',
      tags: ['music'],
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'play', 'send', 'delete'], description: '默认 list' },
          query: { type: 'string', description: 'play/send/delete 时按标题模糊匹配' },
          to: { type: 'string', description: '发到 QQ 的目标：group:<群号> 或 private:<QQ号>（配合 send 或 play 使用）' },
          limit: { type: 'number', description: 'list 时最多列几条，默认 10' },
        },
        required: [],
      },
      handler: async (args) => {
        const action = String(args.action ?? 'list');
        if (action === 'list') {
          const rows = listLibrary(this.data(), Number(args.limit ?? 10));
          if (!rows.length) return '还一首都没唱过。';
          return rows
            .map((r, i) => `${i + 1}. 《${r.title}》${Math.floor(r.durationSec / 60)}:${String(Math.round(r.durationSec % 60)).padStart(2, '0')}（${new Date(r.at).toLocaleString('zh-CN')}）`)
            .join('\n');
        }
        const q = String(args.query ?? '').trim();
        if (!q) return '要给个歌名（模糊匹配就行）。';
        if (action === 'delete') {
          const hit = dropFromLibrary(this.data(), q);
          return hit ? `删掉了《${hit.title}》。` : `作品库里没有「${q}」。`;
        }
        const rows = listLibrary(this.data(), 500);
        const hit = rows.find((r) => r.id === q || r.title.toLowerCase().includes(q.toLowerCase()));
        if (!hit) return `作品库里没有「${q}」。`;
        if (!existsSync(hit.file)) return `《${hit.title}》的文件不见了（可能被清过缓存）。`;
        const toRaw = String(args.to ?? '').trim();
        if (action === 'send' || toRaw) {
          const target = toRaw || String(this.opts.cfg.notify?.qqTarget ?? '').trim();
          const sent = await this.sendFileToQQ(hit.file, hit.title, target);
          if (action === 'send') return sent;
          this.player.play(hit.file, {
            dir: this.ffmpeg().dir,
            playerPath: String(this.opts.cfg.play?.playerPath ?? ''),
            volume: Number(this.opts.cfg.play?.volume ?? 1),
            log: (m: string) => this.host?.log.warn(m),
          });
          return `放《${hit.title}》，并${sent}`;
        }
        const snap = loadSession(this.data(), hit.id);
        this.player.play(hit.file, {
          dir: this.ffmpeg().dir,
          playerPath: String(this.opts.cfg.play?.playerPath ?? ''),
          volume: Number(this.opts.cfg.play?.volume ?? 1),
          meta: {
            id: hit.id,
            title: hit.title,
            durationSec: hit.durationSec,
            lyrics: snap?.lyrics as LyricsSheet | undefined,
            chorusRanges: snap?.report?.chorusRanges,
          },
          lyricPush: this.lyricPushConfig(),
          onLyricCue: (cue) => this.emitLyricCue(cue),
          onEnd: (reason, elapsedSec) => {
            if (reason !== 'ended') return;
            void this.pushSingEvent(
              'fishsing.ended',
              `《${hit.title}》刚刚自然唱完了（${fmtTime(hit.durationSec)}）。可以自然接话问问要不要再来一首。`,
              { id: hit.id, title: hit.title, durationSec: hit.durationSec, elapsedSec },
            );
          },
          log: (m: string) => this.host?.log.warn(m),
        });
        return `放《${hit.title}》。`;
      },
    });

    list.push({
      name: 'fish_sing_status',
      description: '查看唱歌状态、当前播到第几句，以及本机所有可用的音色模型列表（想换音色重唱或局部返工前先调这个查看有哪些模型）。',
      tags: ['music'],
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const modelsTxt = this.formatAvailableModels();
        const h = await this.worker.health(2000);
        if (!h?.engine) return `worker 没在跑（下次唱歌会自动拉起来）。可用音色模型：${modelsTxt}。`;
        const cur = h.current ? `正在：${h.current.message}（${Math.round(h.current.progress * 100)}%）；` : '当前空闲；';
        const gpuState = h.engine.ready ? '已预热在显存' : '已休眠省显存（下次点歌自动加载）';
        const extras: string[] = [];
        if (h.engine.uvrAvailable) extras.push('UVR5精唱可用');
        if (h.engine.fcpeAvailable) extras.push('FCPE可用');
        const pb = this.player.playbackState();
        const playNote = pb.playing
          ? `本机正在放《${pb.title || '歌曲'}》（${fmtTime(pb.elapsedSec)}/${fmtTime(pb.durationSec)}${pb.currentLine ? `，第 ${pb.currentLine.index} 句「${pb.currentLine.text}」` : ''}）。`
          : '';
        return `模型 ${h.engine.model}${h.engine.index ? ` + 索引 ${h.engine.index}` : '（无索引）'}（${gpuState}），采样率 ${h.engine.samplerate}${extras.length ? `，${extras.join('/')}` : ''}；${cur}队列 ${h.queue ?? 0} 个。可用音色模型：${modelsTxt}。${playNote}`;
      },
    });

    return list;
  }

  // ------------------------------------------------------------ 控制台

  /** 把已有音频切条发送到 QQ 群或私聊（工具与作品库面板共用）。 */
  private async sendFileToQQ(file: string, title: string, rawTarget: string): Promise<string> {
    const httpUrl = String(this.opts.cfg.send?.httpUrl ?? '').trim();
    if (!httpUrl) throw new Error('没配 OneBot HTTP 地址（配置 → 播放与发送）');
    const target = parseTarget(rawTarget);
    if (!target) throw new Error('QQ 目标格式不对：请写 group:<群号> 或 private:<QQ号>（或裸 QQ 号）');
    const tmpSegDir = join(this.opts.dataDir, 'tmp', `qqsend-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    try {
      const maxSeg = Math.max(10, Number(this.opts.cfg.send?.maxSegmentSec ?? 55));
      const gapMs = Math.max(0, Number(this.opts.cfg.send?.gapMs ?? 1500));
      const segs = await split(file, tmpSegDir, maxSeg, this.ffmpeg());
      const onebot = { httpUrl, token: this.onebotToken() };
      for (let i = 0; i < segs.length; i += 1) {
        if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        await sendRecord(onebot, target, segs[i]);
      }
      return `已将《${title}》发到${target.label}${segs.length > 1 ? `（${segs.length} 条）` : ''}`;
    } finally {
      try {
        rmSync(tmpSegDir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 作品库面板的数据面。方法名与 `dist/webui.js` 里的调用一一对应。
   * 面板走的是「服务端渲染数据 + 前端只管展示」，所以这里只返回纯 JSON。
   */
  private async panelInvoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'setup') return this.setupInvoke(method, args);
    if (panel === 'sing') return this.singInvoke(method, args);
    if (panel === 'models') return this.modelInvoke(method, args);
    if (panel === 'train') return this.trainInvoke(method, args);
    if (panel !== 'library') throw new Error(`未知面板：${panel}`);
    const a0 = String(args[0] ?? '');
    const a1 = String(args[1] ?? '');

    if (method === 'list') {
      const dir = join(this.opts.dataDir, 'library');
      const rows = loadLibrary(this.data()).map((r) => {
        let sizeMb = 0;
        try {
          sizeMb = Math.round((statSync(r.file).size / 1048576) * 10) / 10;
        } catch {
          /* 文件没了就显示 0 */
        }
        return {
          id: r.id,
          title: r.title,
          durationSec: Math.round(r.durationSec * 10) / 10,
          at: r.at,
          sizeMb,
          bvid: r.bvid,
          source: r.source,
          target: r.target,
          pitch: r.params?.pitch ?? 0,
          mode: r.params?.mode ?? 'full',
          model: String(r.params?.model ?? ''),
          indexRate: r.params?.indexRate ?? 0,
          missing: sizeMb === 0,
        };
      });
      return {
        items: rows,
        playing: this.player.playing ? this.player.playing.split(/[\\/]/).pop() : '',
        dir,
        totalMb: Math.round(rows.reduce((n, r) => n + r.sizeMb, 0) * 10) / 10,
        playingEnabled: this.opts.cfg.play?.enabled !== false,
        qqEnabled: Boolean(String(this.opts.cfg.send?.httpUrl ?? '').trim()),
        defaultQqTarget: String(this.opts.cfg.notify?.qqTarget ?? '').trim(),
        currentModel: this.current.model,
      };
    }

    if (method === 'play') {
      const rows = loadLibrary(this.data());
      const hit = rows.find((r) => r.id === a0) ?? rows.find((r) => r.title.includes(a0));
      if (!hit) throw new Error('作品库里没有这一首');
      if (!existsSync(hit.file)) throw new Error('文件不见了（可能被清理过）');
      if (this.opts.cfg.play?.enabled === false) throw new Error('本机播放被关掉了（配置 → 播放与发送）');
      this.player.play(hit.file, {
        dir: this.ffmpeg().dir,
        playerPath: String(this.opts.cfg.play?.playerPath ?? ''),
        volume: Number(this.opts.cfg.play?.volume ?? 1),
        log: (m: string) => this.host?.log.warn(m),
      });
      return { text: `正在放《${hit.title}》` };
    }

    if (method === 'stop') {
      this.player.stop();
      return { text: '停了' };
    }

    if (method === 'delete') {
      const hit = dropFromLibrary(this.data(), a0);
      return { text: hit ? `删掉了《${hit.title}》` : '没找到这一首' };
    }

    if (method === 'rename') {
      const hit = renameInLibrary(this.data(), a0, a1);
      return { text: hit ? `改成了《${hit.title}》` : '没找到这一首（或者标题是空的）' };
    }

    if (method === 'reveal') {
      const dir = join(this.opts.dataDir, 'library');
      spawn('explorer', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { text: `已在资源管理器打开：${dir}` };
    }

    if (method === 'send') {
      const rows = loadLibrary(this.data());
      const hit = rows.find((r) => r.id === a0) ?? rows.find((r) => r.title.includes(a0));
      if (!hit) throw new Error('作品库里没有这一首');
      if (!existsSync(hit.file)) throw new Error('文件不见了（可能被清理过）');
      const target = a1.trim() || String(this.opts.cfg.notify?.qqTarget ?? '').trim();
      const text = await this.sendFileToQQ(hit.file, hit.title, target);
      return { text };
    }

    if (method === 'resing') {
      if (this.trainJob?.state === 'running') throw new Error('正在训练模型，等训练完再重唱');
      if (this.busy) throw new Error('上一首还在处理中，稍等一下');
      const rows = loadLibrary(this.data());
      const hit = rows.find((r) => r.id === a0);
      if (!hit) throw new Error('作品库里没有这一首');
      const src = hit.bvid || (hit.source && existsSync(hit.source) ? hit.source : '');
      if (!src) throw new Error('这条作品没有记录 BV 号或可用的本机源文件，无法直接重唱');
      this.busy = true;
      this.ownedJob = 'song';
      try {
        const r = await singSong({
          song: src,
          mode: hit.params?.mode === 'vocals' ? 'vocals' : 'full',
          pitch: hit.params?.pitch ?? 'auto',
          to: 'local',
          refresh: true,
        }, this.deps());
        if (!r.ok) throw new Error(r.message);
        if (r.detail) {
          this.lastSong = {
            title: String(r.detail.title ?? hit.title),
            at: Date.now(),
            duration: Number(r.detail.duration ?? 0),
          };
        }
        return { text: `已用当前模型 ${this.current.model} 重唱：${r.message}` };
      } finally {
        this.busy = false;
      }
    }

    throw new Error(`未知方法：${method}`);
  }

  /** 正式「试唱 / 点歌」面板数据面：搜歌、调参试唱、进度轮询、歌词体检与局部返工。 */
  private async singInvoke(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'status') {
      const h = await this.worker.health(2000);
      const pb = this.player.playbackState();
      const snap = loadSession(this.data());
      const v = this.opts.cfg.voice;
      return {
        busy: this.busy,
        training: this.trainJob?.state === 'running',
        model: this.current.model,
        index: this.current.index ? basename(this.current.index) : '',
        worker: h,
        playback: pb,
        defaults: {
          mode: v?.mode === 'vocals' ? 'vocals' : 'full',
          pitch: v?.pitch ?? 'auto',
          indexRate: Number(v?.indexRate ?? 0.75),
          protect: Number(v?.protect ?? 0.33),
          rmsMixRate: Number(v?.rmsMixRate ?? 0),
          harmony: v?.harmony ?? 'off',
          reverb: v?.reverb ?? 'off',
          polish: v?.polish !== false,
          f0Method: v?.f0Method ?? 'rmvpe',
          separator: v?.separator ?? 'htdemucs',
          dereverb: v?.dereverb === true,
          dynamicStyle: v?.dynamicStyle ?? 'off',
          qqEnabled: Boolean(String(this.opts.cfg.send?.httpUrl ?? '').trim()),
          defaultQqTarget: String(this.opts.cfg.notify?.qqTarget ?? '').trim(),
        },
        lastSession: snap ? {
          id: snap.id,
          title: snap.title,
          durationSec: snap.durationSec,
          summary: snap.report?.summary ?? '',
          issues: snap.report?.issues ?? [],
          lyricsSource: snap.lyrics?.sourceLabel ?? '',
          lyricsCount: snap.lyrics?.lines?.length ?? 0,
        } : null,
      };
    }

    if (method === 'search') {
      const kw = String(args[0] ?? '').trim();
      const order = (args[1] === 'click' || args[1] === 'pubdate' ? args[1] : 'default') as SearchOrder;
      if (!kw) throw new Error('先输入要搜索的歌名或关键词');
      if (this.opts.cfg.song?.enabled === false) throw new Error('配置里关掉了从 B 站搜歌');
      const rawHits = await searchBili(kw, 20, order);
      const maxDur = Number(this.opts.cfg.song?.maxDurationSec ?? 480);
      const pool = rawHits.filter((h) => h.durationSec >= 20 && h.durationSec <= maxDur);
      const hits = rankHits(pool.length ? pool : rawHits, kw, String(this.opts.cfg.song?.excludeWords ?? '')).slice(0, 12);
      return { hits };
    }

    if (method === 'sing') {
      if (this.trainJob?.state === 'running') throw new Error('正在训练模型，等训练完再试唱');
      if (this.busy) throw new Error('上一首还在处理中，稍等一下或先点停止');
      const raw = (args[0] as Record<string, unknown>) ?? {};
      const song = String(raw.song ?? '').trim();
      if (!song) throw new Error('先填歌名、BV 号或本机文件路径');
      this.busy = true;
      this.ownedJob = 'song';
      try {
        const r = await singSong({
          song,
          to: raw.to ? String(raw.to) : 'local',
          mode: raw.mode === 'vocals' ? 'vocals' : 'full',
          pitch: raw.pitch === undefined || raw.pitch === '' || String(raw.pitch).toLowerCase() === 'auto'
            ? 'auto' : Number(raw.pitch),
          indexRate: raw.indexRate === undefined || raw.indexRate === '' ? undefined : Number(raw.indexRate),
          protect: raw.protect === undefined || raw.protect === '' ? undefined : Number(raw.protect),
          rmsMixRate: raw.rmsMixRate === undefined || raw.rmsMixRate === '' ? undefined : Number(raw.rmsMixRate),
          harmony: raw.harmony === 'double' || raw.harmony === 'double+third'
            || raw.harmony === 'third' || raw.harmony === 'third+fifth' || raw.harmony === 'off'
            ? raw.harmony : undefined,
          reverb: raw.reverb === 'light' || raw.reverb === 'off' ? raw.reverb : undefined,
          polish: typeof raw.polish === 'boolean' ? raw.polish : undefined,
          f0Method: raw.f0Method === 'fcpe' || raw.f0Method === 'rmvpe' ? raw.f0Method : undefined,
          separator: raw.separator === 'roformer' || raw.separator === 'htdemucs' ? raw.separator : undefined,
          dereverb: typeof raw.dereverb === 'boolean' ? raw.dereverb : undefined,
          dynamicStyle: raw.dynamicStyle === 'soft-verse-bright-chorus' || raw.dynamicStyle === 'off'
            ? raw.dynamicStyle : undefined,
          start: raw.start === undefined || raw.start === '' ? undefined : Number(raw.start),
          duration: raw.duration === undefined || raw.duration === '' ? undefined : Number(raw.duration),
          refresh: raw.refresh === true,
          order: raw.order === 'click' || raw.order === 'pubdate' ? raw.order : 'default',
        }, this.deps());
        if (!r.ok) throw new Error(r.message);
        if (r.detail) {
          this.lastSong = {
            title: String(r.detail.title ?? ''),
            at: Date.now(),
            duration: Number(r.detail.duration ?? 0),
          };
        }
        return { text: r.message, detail: r.detail };
      } finally {
        this.busy = false;
      }
    }

    if (method === 'stop') {
      this.player.stop();
      await this.worker.cancel().catch(() => undefined);
      return { text: '已停止播放并取消当前任务' };
    }

    if (method === 'unload') {
      const r = await this.worker.unload();
      if (!r.ok) throw new Error(r.message);
      return { text: r.message };
    }

    if (method === 'lyrics') {
      const forceRefresh = args[0] === true;
      const snap = loadSession(this.data());
      if (!snap) return { text: '还没有最近唱过歌的记录', body: '' };
      if (forceRefresh) {
        const fresh = await resolveLyrics({
          title: snap.title,
          bvid: snap.bvid || undefined,
          fullDurationSec: snap.durationSec,
          cutStart: snap.cutStart,
          cutDuration: snap.cutDuration,
          phrases: snap.report?.phrases,
          chorusRanges: snap.report?.chorusRanges,
        }).catch(() => undefined);
        if (fresh) {
          snap.lyrics = fresh;
          try {
            saveSession(this.data(), snap);
          } catch {
            /* 忽略 */
          }
        }
      }
      const pb = this.player.playbackState();
      const head: string[] = [`《${snap.title}》（${fmtTime(snap.durationSec)}）`];
      if (pb.playing) {
        head.push(`当前播放：${fmtTime(pb.elapsedSec)}/${fmtTime(pb.durationSec || snap.durationSec)}${pb.currentLine ? ` · 第 ${pb.currentLine.index} 句「${pb.currentLine.text}」` : ''}`);
      }
      if (snap.report?.summary) head.push(`声学体检：${snap.report.summary}`);
      if (snap.report?.issues?.length) {
        head.push('风险时间段：\n' + snap.report.issues.map((it) => `  - ${it.note}`).join('\n'));
      }
      if (snap.lyrics?.lines?.length) {
        head.push(formatLyricsTable(snap.lyrics as LyricsSheet, { fromLine: 1, limit: 120 }));
      }
      return { body: head.join('\n') };
    }

    if (method === 'patch') {
      if (this.trainJob?.state === 'running') throw new Error('正在训练模型，稍后再返工');
      if (this.busy) throw new Error('当前有任务在进行，稍等几秒');
      const raw = (args[0] as Record<string, unknown>) ?? {};
      this.busy = true;
      this.ownedJob = 'song';
      try {
        const r = await patchSong({
          lines: raw.lines === undefined || raw.lines === '' ? undefined : String(raw.lines),
          lyric: raw.lyric === undefined || raw.lyric === '' ? undefined : String(raw.lyric),
          section: raw.section === 'chorus' ? 'chorus' : undefined,
          chorusIndex: raw.chorusIndex === undefined ? undefined : Number(raw.chorusIndex),
          atCurrent: raw.atCurrent === true,
          start: raw.start === undefined || raw.start === '' ? undefined : Number(raw.start),
          end: raw.end === undefined || raw.end === '' ? undefined : Number(raw.end),
          pitch: raw.pitch === undefined || raw.pitch === '' ? undefined : Number(raw.pitch),
          indexRate: raw.indexRate === undefined || raw.indexRate === '' ? undefined : Number(raw.indexRate),
          protect: raw.protect === undefined || raw.protect === '' ? undefined : Number(raw.protect),
          rmsMixRate: raw.rmsMixRate === undefined || raw.rmsMixRate === '' ? undefined : Number(raw.rmsMixRate),
          f0Method: raw.f0Method === 'fcpe' || raw.f0Method === 'rmvpe' ? raw.f0Method : undefined,
          model: raw.model ? String(raw.model) : undefined,
          previewOnly: raw.previewOnly === true,
          to: raw.to ? String(raw.to) : 'local',
        }, this.deps());
        if (!r.ok) throw new Error(r.message);
        return { text: r.message, detail: r.detail };
      } finally {
        this.busy = false;
      }
    }

    throw new Error(`未知方法：${method}`);
  }

  /**
   * 把「当前模型」盖到配置上再解析路径。
   *
   * 为什么不能直接改 opts.cfg：那是 Coo 传进来的配置对象，改了会和它的热重载打架；
   * 而且 inspect() 判断「权重齐不齐」用的是这个 model 名，不盖就会按出厂默认去报缺失。
   */
  private effCfg(): FishSingConfigSection {
    const cfg = this.opts.cfg || ({} as FishSingConfigSection);
    return {
      ...cfg,
      voice: {
        ...cfg.voice,
        model: this.current.model || cfg.voice?.model,
        index: this.current.index || cfg.voice?.index,
      },
    };
  }

  /** 路径可能因为装上运行时/下好权重而变，面板操作后重算一次。 */
  private refreshRoutes(): void {
    this.routes = resolvePaths(this.effCfg(), this.opts.dataDir);
  }

  /**
   * 本机能看到的训练实验（含历史目录）。
   *
   * 自托管后 rvcRoot 指向 runtime/rvc，里面只有权重和索引；训练切片（0_gt_wavs）
   * 是中间产物，只在老项目里。所以两边都扫，用实验名去重。
   */
  private allExperiments(): Array<{
    exp: string; slices: number; gtDir: string; index: string | null; models: string[]; root: string;
  }> {
    const weights = listModels(this.routes, this.current.model).map((m) => m.name);
    const roots = [this.routes.rvcRoot, ...LEGACY_RVC_ROOTS.filter((p) => existsSync(p))];
    const seen = new Set<string>();
    const items = [];
    for (const root of roots) {
      for (const it of listExperiments(root, weights)) {
        if (seen.has(it.exp)) continue;
        seen.add(it.exp);
        items.push({ ...it, root });
      }
    }
    return items.sort((a, b) => b.slices - a.slices);
  }

  /**
   * 实验目录（logs/<exp>）。
   *
   * 自托管后 rvcRoot 是 runtime/rvc，里面只有最近训练过的实验；历史实验（dfy2 等）
   * 的日志和存档都在老项目里。所以两个根都找，先看自托管。
   */
  private expDirFor(exp: string): string {
    if (!exp) return '';
    const roots = [this.routes.rvcRoot, ...LEGACY_RVC_ROOTS.filter((p) => existsSync(p))];
    // 优先挑**有 train.log** 的那个：runtime 里也可能存在 logs/dfy2（只放了下载来的索引），
    // 那个目录是空的，拿它当实验目录会显示 0 轮。
    let fallback = '';
    for (const root of roots) {
      const dir = join(root, 'logs', exp);
      if (!existsSync(dir)) continue;
      if (existsSync(join(dir, 'train.log'))) return dir;
      if (!fallback) fallback = dir;
    }
    return fallback || join(this.routes.rvcRoot, 'logs', exp);
  }

  /** 训练面板（数据准备阶段）：扫描、开始、进度、结果。 */
  private async trainInvoke(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'scan') {
      const paths = (args[0] as string[]) ?? [];
      if (!paths.length) throw new Error('先填一个文件夹或文件路径');
      const items = await scanSources(this.worker, paths);
      return { items, root: String(paths[0] ?? '') };
    }

    if (method === 'start') {
      if (this.datasetJob?.state === 'running') throw new Error('已经有一个数据准备任务在跑，等它结束');
      const sources = (args[0] as TrainSource[]) ?? [];
      const params = (args[1] as Record<string, unknown>) ?? {};
      const opts = (args[2] as { dir?: string; append?: boolean } | undefined) ?? {};
      if (!sources.length) throw new Error('先勾选至少一首素材');

      // 追加到当前数据集（在同一模型的基础上补音域），否则新建
      const dir = opts.dir || datasetDirName(this.opts.dataDir);
      if (opts.append) params.append = true;
      writeDatasetState(this.opts.dataDir, dir);
      const job = { id: '', state: 'running' as const, pct: 0, msg: '排队中', dir };
      this.datasetJob = job;
      try {
        const id = await this.worker.submit('dataset', { ...params, sources, out: dir });
        this.ownedJob = 'dataset';
        job.id = id;
      } catch (e) {
        job.state = 'error';
        throw e;
      }
      void this.worker
        .wait(
          job.id,
          (p, m) => {
            job.pct = Math.round(p * 100);
            job.msg = m;
          },
          // 分离一首歌 20~40 秒，几十首可能十几分钟；只要还在报进度就不算超时
          { stallMs: 10 * 60_000, timeoutMs: 4 * 3600_000 },
        )
        .then(() => {
          job.state = 'done';
          job.pct = 100;
          job.msg = '完成';
          this.host?.log.info(`[fish-sing] 数据集完成：${dir}`);
        })
        .catch((e: unknown) => {
          job.state = 'error';
          job.msg = e instanceof Error ? e.message : String(e);
          this.host?.log.warn(`[fish-sing] 数据集中断：${job.msg}`);
        });
      return { text: `开始处理 ${sources.length} 首，产物在 ${dir}` };
    }

    if (method === 'status') {
      const j = this.datasetJob;
      const manifest = j?.dir ? readManifest(j.dir) : null;
      const qual = manifest ? sourceQualityReport(manifest) : null;
      return {
        job: j,
        dataset: manifest
          ? {
            dir: j?.dir ?? '',
            stats: manifest.stats,
            summary: summarize(manifest),
            bands: manifest.bands,
            bandLabels: BAND_LABEL,
            dropLabels: DROP_LABEL,
            sourceQuality: qual?.rows ?? [],
            f0Failed: qual?.f0Failed ?? [],
            histogram: f0Histogram(manifest.slices),
            weights: readWeights(j?.dir ?? ''),
            presets: WEIGHT_PRESETS,
            rows: weightedRows(manifest, readWeights(j?.dir ?? '')),
            preview: manifest.slices
              .filter((x) => x.kept)
              .slice(0, 8)
              .map((x) => ({
                file: x.file,
                dur: x.dur,
                f0: x.f0_median,
                p90: x.f0_p90,
                band: x.band,
                source: x.source,
              })),
          }
          : null,
      };
    }

    if (method === 'datasets') {
      const weights = listModels(this.routes, this.current.model).map((m) => m.name);
      return {
        items: listDatasets(this.opts.dataDir, weights, this.datasetJob?.dir ?? ''),
        current: this.datasetJob?.dir ?? '',
      };
    }

    if (method === 'select') {
      const dir = String(args[0] ?? '').trim();
      if (!dir) throw new Error('没指定数据集');
      if (!readManifest(dir)) throw new Error('这个目录里没有 manifest.json，不是数据集');
      this.datasetJob = { id: '', state: 'done', pct: 100, msg: '已载入', dir };
      writeDatasetState(this.opts.dataDir, dir);
      return { text: `已载入 ${basename(dir)}` };
    }

    if (method === 'deleteDataset') {
      const dir = String(args[0] ?? '').trim();
      if (!dir) throw new Error('没指定数据集');
      // 只允许删 datasets/ 下面的目录，防止参数被传成别的地方造成误删
      const root = join(this.opts.dataDir, 'datasets');
      const parent = dirname(dir);
      if (parent !== root) throw new Error(`只允许删除 ${root} 下面的数据集`);
      if (!existsSync(dir)) throw new Error('目录已经不在了');
      if (this.datasetJob?.state === 'running') throw new Error('有任务在跑，等它结束');
      rmSync(dir, { recursive: true, force: true });
      if (this.datasetJob?.dir === dir) {
        this.datasetJob = null;
        writeDatasetState(this.opts.dataDir, '');
      }
      return { text: `删掉了 ${basename(dir)}` };
    }

    if (method === 'experiments') {
      return {
        items: this.allExperiments(),
        current: this.current.model,
        rvcRoot: this.routes.rvcRoot,
      };
    }

    if (method === 'import') {
      if (this.datasetJob?.state === 'running') throw new Error('已经有一个任务在跑');
      const exp = String(args[0] ?? '').trim();
      const appendTo = String(args[1] ?? '').trim();
      const info = this.allExperiments().find((e) => e.exp === exp);
      if (!info) {
        throw new Error(`找不到实验「${exp}」的切片。训练完清理过 logs 的话就只能从原始音频重建。`);
      }
      const dir = appendTo || datasetDirName(this.opts.dataDir);
      writeDatasetState(this.opts.dataDir, dir);
      const job = { id: '', state: 'running' as const, pct: 0, msg: '排队中', dir };
      this.datasetJob = job;
      try {
        const id = await this.worker.submit('dataset', {
          // 导入已有实验的切片，用来在旧模型基础上补音域
          mode: 'import',
          gtDir: info.gtDir,
          out: dir,
          label: `导入：${exp}`,
          append: Boolean(appendTo),
        });
        job.id = id;
      } catch (e) {
        job.state = 'error';
        throw e;
      }
      void this.worker
        .wait(job.id, (p, m) => {
          job.pct = Math.round(p * 100);
          job.msg = m;
        })
        .then(() => {
          job.state = 'done';
          job.pct = 100;
          job.msg = '完成';
        })
        .catch((e: unknown) => {
          job.state = 'error';
          job.msg = e instanceof Error ? e.message : String(e);
        });
      return { text: `开始导入 ${exp} 的 ${info.slices} 片切片，产物在 ${dir}` };
    }

    if (method === 'weights') {
      const dir = this.datasetJob?.dir;
      const m = dir ? readManifest(dir) : null;
      if (!m) throw new Error('还没有数据集，先在上面扫一遍素材');
      const cfg = (args[0] as WeightConfig | undefined) ?? readWeights(dir ?? '');
      return { cfg, rows: weightedRows(m, cfg), presets: WEIGHT_PRESETS };
    }

    if (method === 'saveWeights') {
      const dir = this.datasetJob?.dir;
      const m = dir ? readManifest(dir) : null;
      if (!m) throw new Error('还没有数据集');
      const cfg = args[0] as WeightConfig;
      saveWeights(dir, cfg);
      const rows = weightedRows(m, cfg);
      const worst = rows.reduce((a, b) => (b.after > a.after ? b : a), rows[0]);
      const modeLabel = cfg.mode === 'p90' ? '按最高音' : cfg.mode === 'mix' ? '两端兼顾' : '按主音域';
      return {
        text: `已保存：${modeLabel}分档，${
          rows.map((r) => `${r.label.split(' ')[0]} ${r.weight}x`).join(' / ')}（占比最大的是${worst.label.split(' ')[0]} ${(worst.after * 100).toFixed(0)}%）`,
        rows,
      };
    }

    if (method === 'trainStart') {
      const cfg = (args[0] ?? {}) as {
        exp?: string;
        epochs?: number;
        batch?: number;
        saveEvery?: number;
        resume?: boolean;
        rebuild?: boolean;
        /** 训练完自动清理中间档（默认不勾：删了只能重训才拿得回来） */
        pruneAfter?: boolean;
        /** 训练完生成选模对比试听（默认开） */
        abTest?: boolean;
        /** 低音增强：合成 -2/-4 半音低音数据（默认开） */
        augment?: boolean;
        keepEvery?: number;
        evaluationPaths?: string[];
      };
      const dir = this.datasetJob?.dir;
      const m = dir ? readManifest(dir) : null;
      if (!dir || !m) throw new Error('先在上面选一个数据集');
      if (this.trainJob?.state === 'running') throw new Error('已经在训练了');
      if (this.datasetJob?.state === 'running') throw new Error('数据准备还没跑完，等它结束');
      if (!existsSync(this.routes.pythonPath)) {
        throw new Error('运行时没装好：去「安装与运行时」页点「安装 GPU 运行时」');
      }

      const epochs = Math.max(10, Math.min(600, Number(cfg.epochs) || suggestTrainParams(m.stats.seconds).epochs));
      const batch = Math.max(1, Math.min(16, Number(cfg.batch) || 4));
      const saveEvery = Math.max(1, Math.min(100, Number(cfg.saveEvery) || 10));
      const exp = String(cfg.exp ?? '').trim().replace(/[^\w.-]/g, '') || `fish${stamp()}`;
      if (cfg.resume !== true && existsSync(this.expDirFor(exp)) && readdirSync(this.expDirFor(exp)).length) {
        throw new Error('同名实验已存在：从头训练请换新实验名，断点续训请勾选续训');
      }
      const evaluationPaths = cfg.abTest === true ? validateEvaluation(cfg.evaluationPaths ?? [], [
        ...m.slices.filter(s => s.kept).map(s => join(dir, s.file)),
        ...m.sources.flatMap(s => [String(s.path ?? ''), String(s.vocalFile ?? '')]),
      ]) : undefined;
      if (evaluationPaths) {
        saveEvaluationPaths(this.opts.dataDir, evaluationPaths);
      }

      // 同名实验的日志刚刚还在写 → 可能有训练在跑（包括重启 Coo 后留下的孤儿进程，
      // 那种情况 worker 已经不认识它了，光靠状态拦不住）。撞上去就是两个训练抢一张卡。
      // 但"日志新"不等于"在跑"：刚点停止的训练日志也会热 3 分钟（0.4.15：停止后立刻
      // 重训被误拦）。所以看两件事：日志 3 秒内还长不长、worker 里有没有训练任务。
      const logFile = join(this.expDirFor(exp), 'train.log');
      if (existsSync(logFile)) {
        const ageSec = Math.round((Date.now() - statSync(logFile).mtimeMs) / 1000);
        if (ageSec < 180) {
          const s1 = statSync(logFile).size;
          const cur = await this.worker.currentJob().catch(() => null);
          const workerBusy = Boolean(cur && cur.kind === 'train');
          await new Promise((r) => setTimeout(r, 3000));
          const s2 = existsSync(logFile) ? statSync(logFile).size : 0;
          if (workerBusy) {
            throw new Error(
              `worker 里还有「${cur?.exp || exp}」的训练任务在跑，先停止它或等它结束再开始。`,
            );
          }
          if (s2 > s1) {
            throw new Error(
              `「${exp}」的训练日志 3 秒内还在增长（${s1} → ${s2} 字节），可能有训练正在跑`
                + `（重启 Coo 留下的孤儿进程也算）。换个实验名，或者等它跑完再开始。`,
            );
          }
        }
      }

      // 逐片权重：按权重口径算好，键用文件 basename（实验目录里的切片同名）
      const weightCfg = readWeights(dir);
      const weightMap: Record<string, number> = {};
      const bandMap: Record<string, string> = {};
      for (const it of sliceWeights(m, weightCfg)) {
        weightMap[basename(it.file)] = it.weight;
        bandMap[basename(it.file)] = it.band;
      }
      const weighted = Object.values(weightMap).filter((v) => Math.abs(v - 1) > 1e-9).length;

      const job = {
        id: '', state: 'running' as const, pct: 0, msg: '排队中',
        exp, epochs, startedAt: Date.now(),
      };
      this.trainJob = job;
      try {
        const id = await this.worker.submit('train', {
          /* 训练是几小时的活，别让 Coo 退出把它的取消按钮也按下去 */
          exp,
          dataset: dir,
          epochs,
          batch,
          saveEvery,
          resume: cfg.resume === true,
          evaluationPaths,
          rebuild: cfg.rebuild === true,
          // 低音增强：-2/-4 半音各合成一份低音数据，副本权重按份数摊薄（见 trainer.prepare）
          augmentShifts: cfg.augment === true ? [-2, -4] : [],
          weightMap,
          bandMap,
        });
        job.id = id;
        this.ownedJob = 'train';
        this.lastExp = exp;
        writeTrainState(this.opts.dataDir, {
          exp,
          epochs,
          startedAt: job.startedAt,
          pruneAfter: cfg.pruneAfter === true,
          abTest: cfg.abTest === true,
          keepEvery: cfg.keepEvery,
          evaluationPaths,
        });
      } catch (e) {
        job.state = 'error';
        job.error = e instanceof Error ? e.message : String(e);
        throw e;
      }
      this.attachTrainWait(job, {
        pruneAfter: cfg.pruneAfter === true,
        abTest: cfg.abTest === true,
        keepEvery: cfg.keepEvery,
        evaluationPaths,
      });
      return {
        text: `开始训练「${exp}」：${epochs} 轮 / batch ${batch} / ${m.stats.kept} 片${
          weighted ? ` / 其中 ${weighted} 片带音域加权` : '（均匀采样）'}`,
        exp,
      };
    }

    if (method === 'trainStatus') {
      const exp = String(args[0] ?? '')
        || this.trainJob?.exp
        || this.lastExp
        // 最后兜底：直接去看哪个实验的日志最近还在写。
        // 孤儿进程（worker 换过、或 train.json 还没来得及写）就靠这条被发现。
        || findActiveExperiment(join(this.routes.rvcRoot, 'logs'));
      if (exp && !this.lastExp) {
        this.lastExp = exp;
        writeTrainState(this.opts.dataDir, { exp, epochs: 0, startedAt: 0 });
      }
      const expDir = this.expDirFor(exp);
      const lg = expDir ? readTrainLog(expDir) : null;
      const models = exp
        ? listModels(this.routes, this.current.model).filter((x) => x.exp === exp)
        : [];
      const total = this.trainJob?.exp === exp ? this.trainJob.epochs : 0;
      const etaSec = lg && lg.secPerEpoch && total
        ? Math.max(0, Math.round(lg.secPerEpoch * Math.max(0, total - lg.done)))
        : null;
      return {
        job: this.trainJob,
        exp,
        expDir,
        total,
        log: lg,
        etaSec,
        models: models.map((x) => ({ name: x.name, epoch: x.epoch, sizeMb: x.sizeMb, current: x.current })),
        datasetBusy: this.datasetJob?.state === 'running',
        /**
         * 面板能不能管这个训练。
         * 认回任务（有 id）当然能；认不回但日志还在写，也能——`/stop` 取消的是 worker 当前的
         * 那一个任务，跟谁提交的无关，旧版 worker 同样支持。
         */
        owned: Boolean(this.trainJob?.id) || (logAgeSec(expDir) ?? 9999) < 180,
        /** 日志多久没更新了，秒。用来判断「日志还在写 = 还在跑」 */
        logAgeSec: logAgeSec(expDir),
        ckpt: exp ? checkpointStats(join(this.routes.rvcRoot, 'assets', 'weights'), exp) : { n: 0, totalMb: 0 },
        weights: exp && expDir ? readWeights(this.datasetJob?.dir ?? '') : null,
        sampling: expDir ? readSamplingReport(expDir) : null,
        evaluationPaths: readEvaluationPaths(this.opts.dataDir),
      };
    }

    if (method === 'saveEvalPaths') {
      const paths = Array.isArray(args[0]) ? args[0].map((x) => String(x ?? '')) : [];
      const saved = saveEvaluationPaths(this.opts.dataDir, paths);
      return { paths: saved };
    }

    if (method === 'prune') {
      const exp = String(args[0] ?? '');
      if (!exp) throw new Error('没指定实验名');
      const dir = join(this.routes.rvcRoot, 'assets', 'weights');
      const plan = planPruneCheckpoints(dir, exp, Number(args[1]) || 50);
      if (!plan.remove.length) {
        return { text: `没有可清理的中间档（现在 ${plan.keep.length} 个 / ${plan.totalMb} MB）`, removed: 0 };
      }
      const done = pruneCheckpoints(dir, exp, Number(args[1]) || 50, join(this.routes.rvcRoot, 'logs'));
      // 正在用的模型被删了就得换一个，否则下一次唱歌指向一个不存在的文件
      const gone = done.remove.includes(basename(this.current.model));
      return {
        text: `清掉 ${done.remove.length} 个中间档${done.scratch.length ? ` + ${done.scratch.join('/')}` : ''}，`
          + `释放 ${done.freedMb} MB（保留 ${done.keep.length} 个）`
          + (gone ? '；注意：正在用的那一个被删了，去「模型」页换一档' : ''),
        removed: done.remove.length,
        freedMb: done.freedMb,
      };
    }

    if (method === 'trainAbTest') {
      const exp = String(args[0]?.exp ?? '').trim() || this.trainJob?.exp || '';
      if (!exp) throw new Error('没有实验名：先在「训练」页填实验名，或跑一次训练');
      const evalPaths = Array.isArray(args[0]?.evaluationPaths) ? args[0].evaluationPaths.map(String) : undefined;
      if (evalPaths && evalPaths.some((p: string) => p.trim())) {
        saveEvaluationPaths(this.opts.dataDir, evalPaths);
      }
      const text = await this.runAbTest(exp, true, evalPaths);
      return { text: text || `没生成：${exp} 只找到一个可用存档（中间档可能已被清理）` };
    }

    if (method === 'trainNotifyTest') {
      // 「QQ 通不通」不用等下一次训练结束才知道：手动发一条，看落在哪个渠道。
      const out = (await this.notifyEvent(
        '测试通知（唱歌插件）',
        '这是一条测试消息：收到就说明通知渠道通了。',
      )) as { via?: string; note?: string };
      return { via: out?.via ?? '', note: out?.note ?? '' };
    }

    if (method === 'trainStop') {
      const cres = await this.worker.cancel();
      // 送达 ≠ 停住：取消请求成功，也可能因为训练是"重启前留下的孤儿"而落空
      // （worker 当前任务为 null，它只会回"当前没有任务"）。所以实测 worker 还在不在跑。
      let left: { kind?: string } | null = null;
      for (let i = 0; i < 5; i += 1) {
        await new Promise((r) => setTimeout(r, 2500));
        left = await this.worker.currentJob().catch(() => null);
        if (!left) break;
      }
      if (left) {
        this.host?.log.warn(
          `[fish-sing] 停止训练：取消请求已发（${cres.message}），但 worker 还有任务在跑（${left.kind ?? '?'}）`,
        );
        return {
          text: `取消请求发出去了（${cres.message}），但 worker 那边还有任务在跑——这个训练可能是重启前启动的、worker 管不到它。重启 Coo 后再试。`,
        };
      }
      if (this.trainJob?.state === 'running') {
        // 立刻落状态：子进程可能还在收尾，面板会一直显示"训练中"，用户以为没停
        this.trainJob.state = 'error';
        this.trainJob.error = '已手动停止';
        this.trainJob.msg = '已手动停止';
      }
      return { text: `已停止训练（${cres.message}）。最近的存档还在 logs 里，可以勾「从上次存档继续」接着练。` };
    }

    if (method === 'cancel') {
      await this.worker.cancel();
      if (this.datasetJob?.state === 'running') {
        this.datasetJob.state = 'error';
        this.datasetJob.msg = '已取消';
      }
      if (this.trainJob?.state === 'running') {
        this.trainJob.state = 'error';
        this.trainJob.error = '已取消';
        this.trainJob.msg = '已取消';
      }
      return { text: '已取消' };
    }

    if (method === 'reveal') {
      const dir = String(args[0] ?? '') || this.datasetJob?.dir;
      if (!dir) throw new Error('还没有数据集目录');
      spawn('explorer', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { text: `已打开：${dir}` };
    }

    throw new Error(`未知方法：${method}`);
  }

  /** 模型面板：列表、切换、删除、从别处导入。 */
  private async modelInvoke(method: string, args: unknown[]): Promise<unknown> {
    const dir = join(this.routes.rvcRoot, 'assets', 'weights');
    const a0 = String(args[0] ?? '').trim();

    if (method === 'list') {
      return {
        items: listModels(this.routes, this.current.model),
        current: this.current,
        dir,
        busy: this.busy,
      };
    }

    if (method === 'use') {
      if (this.busy) throw new Error('正在唱，等这首唱完再切模型');
      const cur = useModel(this.routes, this.opts.dataDir, a0);
      this.current = cur;
      this.worker.retune({ model: cur.model, index: cur.index });
      // 常驻 worker 里模型已经加载了，必须重启才会换成新的；隔一下等端口释放
      this.worker.shutdown();
      setTimeout(() => {
        void this.worker.ensure().catch((e: unknown) => {
          this.host?.log.warn(`换模型后 worker 没起来：${e instanceof Error ? e.message : String(e)}`);
        });
      }, 1200);
      this.refreshRoutes();
      return {
        text: cur.index
          ? `已切到 ${cur.model}，索引 ${basename(cur.index)}`
          : `已切到 ${cur.model}，但这个实验没有检索索引——音色会比平时淡，建议确认 logs 里有没有 .index`,
      };
    }

    if (method === 'delete') {
      deleteModel(this.routes, this.opts.dataDir, a0);
      return { text: `删掉了 ${a0}` };
    }

    if (method === 'prune') {
      const exp = a0;
      if (!exp) throw new Error('先在筛选框选择一个具体实验');
      const step = Math.max(1, Number(args[1]) || 50);
      const plan = planPruneCheckpoints(dir, exp, step);
      if (!plan.remove.length) {
        return { text: `「${exp}」没有可清理的中间档（现有 ${plan.keep.length} 个 / ${plan.totalMb} MB）`, removed: 0 };
      }
      const done = pruneCheckpoints(dir, exp, step, join(this.routes.rvcRoot, 'logs'));
      const gone = done.remove.includes(basename(this.current.model));
      return {
        text: `已清理「${exp}」${done.remove.length} 个中间档${done.scratch.length ? ` + ${done.scratch.join('/')}` : ''}，`
          + `释放 ${done.freedMb} MB（保留 ${done.keep.length} 个）`
          + (gone ? '；注意：正在用的中间档被删了，请切到其他模型' : ''),
        removed: done.remove.length,
        freedMb: done.freedMb,
      };
    }

    if (method === 'import') {
      const r = importModel(this.routes, a0);
      return {
        text: r.index
          ? `导入了 ${r.name}，顺便找到了索引 ${basename(r.index)}`
          : `导入了 ${r.name}（没找到同名实验的索引，切过去后音色会淡一些）`,
      };
    }

    if (method === 'reveal') {
      spawn('explorer', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { text: `已在资源管理器打开：${dir}` };
    }

    throw new Error(`未知方法：${method}`);
  }

  /** 设置面板：状态、开始下载/安装、取消。 */
  private async setupInvoke(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'status') {
      this.refreshRoutes();
      const st: SetupStatus = inspect(this.routes);
      const runtime = existsSync(this.routes.pythonPath) ? await probeRuntime(this.routes.pythonPath) : '';
      const optionalDeps = existsSync(this.routes.pythonPath)
        ? detectOptionalDeps(this.routes.pythonPath)
        : { uvr: false, fcpe: false };
      return {
        ...st,
        runtime,
        optionalDeps,
        job: this.setupJob,
        tag: loadManifest().tag,
        separateScript: existsSync(this.routes.separateScript),
      };
    }

    if (method === 'start') {
      const what = String(args[0] ?? '');
      if (this.setupJob?.state === 'running') throw new Error('已经有一个任务在跑，先等它结束或点停止');

      if (what === 'models') {
        this.startSetupJob('models', async (signal, report) => {
          if (!existsSync(join(this.routes.rvcRoot, 'infer', 'cli.py'))) {
            report(0, '先复制 RVC 代码');
            copyRvcCode(this.routes, VENDORED_RVC);
          }
          await downloadModels(this.routes, report, signal);
        });
        return { text: '开始下载权重（909 MB，可随时停止）' };
      }

      if (what === 'runtime-gpu' || what === 'runtime-cpu') {
        const mode: RuntimeMode = what === 'runtime-gpu' ? 'gpu' : 'cpu';
        this.startSetupJob('runtime', async (signal, report) => {
          const sysPy = resolveSystemPython(report);
          if (!existsSync(join(this.routes.rvcRoot, 'infer', 'cli.py'))) copyRvcCode(this.routes, VENDORED_RVC);
          await installRuntime(this.routes, mode, sysPy, report, signal);
        });
        return {
          text: mode === 'gpu'
            ? '开始安装 GPU 运行时（下载约 2.5 GB，装完约 6 GB 磁盘）'
            : '开始安装 CPU 运行时（下载约 200 MB，推理慢 6~8 倍）',
        };
      }

      if (what === 'uvr') {
        this.startSetupJob('uvr', async (signal, report) => {
          await installUvrDeps(this.routes, report, signal);
        });
        return { text: '开始安全安装 UVR5 精唱/去混响内核（约 25 MB，锁定版本不覆盖 torch / numpy）' };
      }

      if (what === 'code') {
        copyRvcCode(this.routes, VENDORED_RVC);
        return { text: `代码已复制到 ${this.routes.rvcRoot}` };
      }

      throw new Error(`不认识的安装项：${what}`);
    }

    if (method === 'cancel') {
      this.setupAbort?.abort();
      // 立刻把状态落下来：等子进程退出可能要几秒，面板会一直显示"还在跑"，
      // 用户以为没停掉就会再点一次。
      if (this.setupJob && this.setupJob.state === 'running') {
        this.setupJob.state = 'error';
        this.setupJob.error = '已取消';
        this.setupJob.msg = '已取消';
      }
      return { text: '已停止' };
    }

    if (method === 'trainNotifyTest') {
      const out = (await this.notifyEvent(
        '测试通知（唱歌插件）',
        '这是一条测试消息：收到就说明通知渠道通了。',
      )) as { via?: string; note?: string };
      return { via: out?.via ?? '', note: out?.note ?? '' };
    }

    throw new Error(`未知方法：${method}`);
  }

  /**
   * 监听训练任务直至终态并执行收尾（通知、选模对比、可选中间档清理）。
   * 抽出来供新开训练与重启接管训练共用。
   */
  private attachTrainWait(
    job: {
      id: string;
      state: 'running' | 'done' | 'error';
      pct: number;
      msg: string;
      exp: string;
      epochs: number;
      startedAt: number;
      error?: string;
    },
    opts: {
      pruneAfter?: boolean;
      abTest?: boolean;
      keepEvery?: number;
      evaluationPaths?: string[];
    },
  ): void {
    const exp = job.exp;
    const epochs = job.epochs;
    void this.worker
      .wait(
        job.id,
        (p, msg) => {
          job.pct = Math.round(p * 100);
          job.msg = msg;
        },
        // 训练要几小时，不能设绝对上限；30 分钟没有任何进展（连轮次都没动）才算真卡住
        { stallMs: 30 * 60_000, timeoutMs: 10 * 3600_000 },
      )
      .then(() => {
        job.state = 'done';
        job.pct = 100;
        job.msg = '完成';
        this.host?.log.info(`[fish-sing] 训练完成：${exp}`);
        // 勾了「训练完自动清理」才动文件：中间档删了只能重训才拿得回来，
        // 默认不自动删，宁可让用户自己点那一下。
        if (opts.pruneAfter === true && opts.abTest !== true) {
          const step = Math.max(1, Number(opts.keepEvery) || 50);
          const done = pruneCheckpoints(
            join(this.routes.rvcRoot, 'assets', 'weights'),
            exp, step, join(this.routes.rvcRoot, 'logs'),
          );
          if (done.remove.length) {
            job.msg = `完成（自动清理 ${done.remove.length} 个中间档，释放 ${done.freedMb} MB）`;
            this.host?.log.info(`[fish-sing] 已清理中间档：${done.remove.length} 个 / ${done.freedMb} MB`);
          }
        }
        const roundText = epochs ? `${epochs} 轮全部完成。` : '训练全部完成。';
        void this.notifyEvent(`训练完成：${exp}`, `${roundText}${job.msg}`);
        void this.runAbTest(exp, opts.abTest === true, opts.evaluationPaths).then(() => {
          if (opts.pruneAfter === true && opts.abTest === true) {
            pruneCheckpoints(join(this.routes.rvcRoot, 'assets', 'weights'), exp,
              Math.max(1, Number(opts.keepEvery) || 50), join(this.routes.rvcRoot, 'logs'));
          }
        }).catch((e: unknown) => {
          this.host?.log.warn(`[fish-sing] 选模对比失败：${e instanceof Error ? e.message : String(e)}`);
        });
      })
      .catch((e: unknown) => {
        job.state = 'error';
        job.error = e instanceof Error ? e.message : String(e);
        job.msg = job.error;
        if (job.error === '已取消' || job.error === '已手动停止') {
          // 用户自己点的停止不算"中断"，也用不着通知（0.4.14 之前点停止也会收到
          // 一条"训练中断"推送，纯属噪音）
          this.host?.log.info(`[fish-sing] 训练已停止（${job.error}）`);
          return;
        }
        this.host?.log.warn(`[fish-sing] 训练中断：${job.error}`);
        void this.notifyEvent(`训练中断：${exp}`, job.error);
      });
  }

  /**
   * 起一个后台安装任务。面板靠轮询 status 拿进度，所以这里不 await。
   * 只允许一个：装运行时和唱一首歌抢同一张卡，同时来两个会互相拖死。
   */
  private startSetupJob(kind: 'models' | 'runtime' | 'uvr', task: (signal: AbortSignal, report: (pct: number, msg: string) => void) => Promise<unknown>): void {
    const abort = new AbortController();
    const job = { kind, state: 'running' as const, pct: 0, msg: '准备中…', startedAt: Date.now() };
    this.setupJob = job;
    this.setupAbort = abort;

    const report = (pct: number, msg: string) => {
      job.pct = Math.max(0, Math.min(100, Math.round(pct)));
      job.msg = msg;
    };

    void task(abort.signal, report)
      .then(() => {
        Object.assign(job, { state: 'done', pct: 100, msg: '完成' });
        this.host?.log.info(`[fish-sing] ${kind} 完成`);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        Object.assign(job, { state: 'error', error: msg, msg: abort.signal.aborted ? '已取消' : msg });
        this.host?.log.warn(`[fish-sing] ${kind} 失败：${msg}`);
      })
      .finally(() => {
        this.setupAbort = null;
        // 装完运行时：路径变了，worker 那份参数也得跟着换，否则下次唱歌还找旧 python
        this.refreshRoutes();
        this.worker.retune({
          rvcRoot: this.routes.rvcRoot,
          pythonPath: this.routes.pythonPath,
          separatePython: this.routes.separatePython,
          separateScript: this.routes.separateScript,
        });
      });
  }

  webUi(_language: Language = 'zh'): WorldWebUiDecl {
    const cfg = this.opts.cfg;
    return {
      label: '大肥鱼唱歌',
      lamps: [
        {
          label: '唱歌',
          state: cfg.enabled === false ? 'offline' : 'online',
          hint: cfg.enabled === false ? '未启用' : `模型 ${cfg.voice?.model ?? '?'}`,
        },
        {
          label: '发 QQ',
          state: String(cfg.send?.httpUrl ?? '') ? 'online' : 'error',
          hint: String(cfg.send?.httpUrl ?? '') ? '已配 OneBot HTTP' : '没配 OneBot 地址，只能本机播放',
        },
        {
          label: '本机播放',
          state: cfg.play?.enabled === false ? 'offline' : 'online',
          hint: cfg.play?.enabled === false ? '已关' : 'ffplay',
        },
      ],
      // 注意：框架是从 `webUi()` 的**返回值**里取 invoke（bot.ts: decl?.invoke），
      // 不是从 World 实例上取。挂错地方的现象就是面板画出来了、但所有请求都报「没有面板数据面」。
      invoke: (panel: string, method: string, args: unknown[]) => this.panelInvoke(panel, method, args),
      panels: [
        {
          id: 'setup',
          title: '安装与运行时',
          description: '装 Python 运行时、下载模型权重、看当前状态。装完就能唱歌，不用敲命令。',
          getMethods: ['status'],
        },
        {
          id: 'sing',
          title: '试唱 / 点歌',
          description: '搜 B 站、填 BV 号或本地文件，调参试唱、查看歌词体检与局部返工补录。',
          getMethods: ['status'],
        },
        {
          id: 'train',
          title: '训练数据',
          description: '选素材 → 分离人声 → 自适应切片 → 音域分布。这一步跑完才知道数据值不值得练。',
          getMethods: ['status'],
        },
        {
          id: 'models',
          title: '模型',
          description: 'assets/weights 下的所有音色模型：轮次、大小、对应的检索索引，一键切换或删除。',
          getMethods: ['list'],
        },
        {
          id: 'library',
          title: '作品库',
          description: '她唱过的每一首：试听、改名、删除、打开所在文件夹。',
          getMethods: ['list'],
        },
      ],
      // 环境提示词：声明后控制台会出现可编辑的一栏，模板在 ENV_PROMPT.md。
      // 用户改的内容写到 <部署>/worlds/fish-sing/ENV_PROMPT.md，升级插件不会冲掉。
      promptDocs: [
        {
          key: `worlds.${FISHSING_ID}.envPrompt`,
          title: '大肥鱼唱歌 · 环境提示词',
          description: '她怎么用唱歌工具：装机状态、点歌流程、参数、出错怎么回话。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'singState', description: '装机状态：已就绪，或缺什么、去哪补。' },
            { name: 'singModel', description: '当前音色模型文件名。' },
            { name: 'singTarget', description: '默认投递方式。' },
            { name: 'singOnebot', description: 'QQ 语音条是否可用。' },
            { name: 'singLast', description: '上一次唱的歌（可能为空）。' },
            { name: 'singLangs', description: 'F0 提取方法，排障时用。' },
          ],
        },
      ],
      config: fishsingConfigGroups(),
      storage: [
        {
          key: 'cache',
          label: '换声缓存',
          kind: 'disk',
          stat: () => {
            const rows = listLibrary(this.data(), 500);
            return `作品库 ${rows.length} 首（在「作品库」页管理）；缓存按参数各存一份，点清理只删缓存不动作品库`;
          },
          clear: async () => {
            const n = pruneCache(this.data(), 0);
            return `清掉 ${n} 个缓存文件（作品库没动）`;
          },
        },
      ],
    };
  }
}
