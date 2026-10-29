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
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';

import { FISHSING_ID, fishsingConfigGroups, type FishSingConfigSection } from './config.ts';
import {
  BAND_LABEL,
  datasetDirName,
  f0Histogram,
  listDatasets,
  listExperiments,
  readDatasetState,
  readManifest,
  readTrainLog,
  readWeights,
  saveWeights,
  suggestTrainParams,
  scanSources,
  summarize,
  WEIGHT_PRESETS,
  writeDatasetState,
  weightedRows,
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
  downloadModels,
  findSystemPython,
  inspect,
  installRuntime,
  loadManifest,
  probeRuntime,
  type RuntimeMode,
  type SetupStatus,
} from './setup.ts';
import { duration, type FfmpegDeps } from './audio.ts';
import { Player } from './deliver.ts';
import { dropFromLibrary, listLibrary, loadLibrary, pruneCache, renameInLibrary, type LibraryOptions } from './library.ts';
import { singSong, type SingDeps } from './sing.ts';
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
  /**
   * 安装/下载任务。只保留最近一个，用它给面板轮询进度。
   * 不做队列：装运行时和唱一首歌抢同一张卡，同时来两个只会互相拖死。
   */
  private setupJob: {
    kind: 'models' | 'runtime';
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
    await this.worker.cancel().catch(() => undefined);
    this.worker.shutdown();
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
        pitch: Number(cfg.voice?.pitch ?? 0),
        mode: cfg.voice?.mode === 'vocals' ? 'vocals' : 'full',
      },
    };
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
    const last = this.lastSong
      ? `上一次唱的是《${this.lastSong.title}》（${Math.round(this.lastSong.duration)} 秒前）`
      : '还没唱过';
    // 装机状态：让她一眼知道现在能不能唱，而不是调了工具才发现缺权重
    const st = inspect(this.routes);
    const missModels = st.models.filter((m) => !m.ready).length;
    const ready = st.rvc.ready && st.python.ok && missModels === 0;
    // 值写成**人话**而不是枚举：模板只做占位符替换、没有条件语法，
    // 所以这句话本身就是"缺什么 + 去哪补"的行动指引。
    const state = ready
      ? '已就绪，可以直接唱。'
      : !st.rvc.ready
        ? '还缺插件代码，现在唱不了 —— 让她在控制台「大肥鱼唱歌 → 安装与运行时」页点「刷新」，或重装插件。'
        : !st.python.ok
          ? '还缺 Python 运行时，现在唱不了 —— 让她在「安装与运行时」页点「安装 GPU 运行时」。'
          : `还缺 ${missModels} 个模型权重，现在唱不了 —— 让她在「安装与运行时」页点「下载模型权重」。`;
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
          pitch: { type: 'number', description: '移调半音；男歌女唱常要 +2~+4，默认 0' },
          indexRate: { type: 'number', description: '音色检索强度 0~1；越大越像本人，0.9 以上咬字可能歪' },
          protect: { type: 'number', description: '气声保护 0~0.5；齿音发毛就调高到 0.4~0.45' },
          start: { type: 'number', description: '从第几秒开始唱（只想唱副歌时用）' },
          duration: { type: 'number', description: '唱多长（秒）；配合 start 可只发一段' },
          refresh: { type: 'boolean', description: '忽略缓存重唱一遍' },
          search: { type: 'boolean', description: '只搜索不下载，返回候选列表（标题/时长/UP主/播放/BV）让你自己挑' },
          pick: { type: 'string', description: '选定第几条：序号（从 1 开始）或 BV 号；配合 search 使用' },
          order: {
            type: 'string',
            enum: ['default', 'click', 'pubdate'],
            description: 'B 站排序：default 综合 / click 播放多 / pubdate 最新',
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
        this.busy = true;
        try {
          const r = await singSong({
            song: String(args.song ?? ''),
            to: args.to === undefined ? undefined : String(args.to),
            mode: args.mode === 'vocals' ? 'vocals' : args.mode === 'full' ? 'full' : undefined,
            pitch: args.pitch === undefined ? undefined : Number(args.pitch),
            indexRate: args.indexRate === undefined ? undefined : Number(args.indexRate),
            protect: args.protect === undefined ? undefined : Number(args.protect),
            start: args.start === undefined ? undefined : Number(args.start),
            duration: args.duration === undefined ? undefined : Number(args.duration),
            refresh: args.refresh === true,
            search: args.search === true,
            pick: args.pick === undefined ? undefined : String(args.pick),
            order: args.order === 'click' || args.order === 'pubdate' ? args.order : 'default',
          }, this.deps());
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
      description: '她唱过的歌都在这里：列出、回放、删除。用户问「你都唱过什么」「再放一遍刚才那首」时用。',
      tags: ['music'],
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'play', 'delete'], description: '默认 list' },
          query: { type: 'string', description: 'play/delete 时按标题模糊匹配' },
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
        const hit = rows.find((r) => r.title.toLowerCase().includes(q.toLowerCase()));
        if (!hit) return `作品库里没有「${q}」。`;
        if (!existsSync(hit.file)) return `《${hit.title}》的文件不见了（可能被清过缓存）。`;
        this.player.play(hit.file, {
          dir: this.ffmpeg().dir,
          playerPath: String(this.opts.cfg.play?.playerPath ?? ''),
          volume: Number(this.opts.cfg.play?.volume ?? 1),
          log: (m: string) => this.host?.log.warn(m),
        });
        return `放《${hit.title}》。`;
      },
    });

    list.push({
      name: 'fish_sing_status',
      description: '唱歌功能现在能不能用：模型、显存、队列、当前在算什么。用户问「你还能唱歌吗」「刚才那首到哪了」时用。',
      tags: ['music'],
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const h = await this.worker.health(2000);
        if (!h?.engine) return 'worker 没在跑（下次唱歌会自动拉起来）。';
        const cur = h.current ? `正在：${h.current.message}（${Math.round(h.current.progress * 100)}%）；` : '当前空闲；';
        return `模型 ${h.engine.model}${h.engine.index ? ` + 索引 ${h.engine.index}` : '（无索引）'}，采样率 ${h.engine.samplerate}；${cur}队列 ${h.queue ?? 0} 个。${this.player.playing ? '本机正在放歌。' : ''}`;
      },
    });

    return list;
  }

  // ------------------------------------------------------------ 控制台

  /**
   * 作品库面板的数据面。方法名与 `dist/webui.js` 里的调用一一对应。
   * 面板走的是「服务端渲染数据 + 前端只管展示」，所以这里只返回纯 JSON。
   */
  private async panelInvoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'setup') return this.setupInvoke(method, args);
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
          target: r.target,
          pitch: r.params?.pitch ?? 0,
          mode: r.params?.mode ?? 'full',
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
      return {
        job: j,
        dataset: manifest
          ? {
            dir: j?.dir ?? '',
            stats: manifest.stats,
            summary: summarize(manifest),
            bands: manifest.bands,
            bandLabels: BAND_LABEL,
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
      return {
        text: `已保存：${cfg.mode === 'p90' ? '按最高音' : '按主音域'}分档，${
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
      };
      const dir = this.datasetJob?.dir;
      const m = dir ? readManifest(dir) : null;
      if (!dir || !m) throw new Error('先在上面选一个数据集');
      if (this.trainJob?.state === 'running') throw new Error('已经在训练了');
      if (this.datasetJob?.state === 'running') throw new Error('数据准备还没跑完，等它结束');
      if (!existsSync(this.routes.pythonPath)) {
        throw new Error('运行时没装好：去「安装与运行时」页点「安装 GPU 运行时」');
      }

      const epochs = Math.max(10, Math.min(600, Number(cfg.epochs) || 200));
      const batch = Math.max(1, Math.min(16, Number(cfg.batch) || 4));
      const saveEvery = Math.max(1, Math.min(100, Number(cfg.saveEvery) || 10));
      const exp = String(cfg.exp ?? '').trim().replace(/[^\w.-]/g, '') || `fish${stamp()}`;

      // 同名实验的日志刚刚还在写 → 十有八九另一个训练在跑（包括重启 Coo 后留下的孤儿进程，
      // 那种情况 worker 已经不认识它了，光靠状态拦不住）。撞上去就是两个训练抢一张卡。
      const logFile = join(this.expDirFor(exp), 'train.log');
      if (existsSync(logFile)) {
        const ageSec = Math.round((Date.now() - statSync(logFile).mtimeMs) / 1000);
        if (ageSec < 180) {
          throw new Error(
            `「${exp}」的日志 ${ageSec} 秒前还在更新，可能有训练正在跑（重启 Coo 留下的孤儿进程也算）。`
            + '换个实验名，或者等它跑完再开始。',
          );
        }
      }

      // 逐片权重：按权重口径算好，键用文件 basename（实验目录里的切片同名）
      const weightCfg = readWeights(dir);
      const weightMap: Record<string, number> = {};
      for (const it of sliceWeights(m, weightCfg)) weightMap[basename(it.file)] = it.weight;
      const weighted = Object.values(weightMap).filter((v) => Math.abs(v - 1) > 1e-9).length;

      const job = {
        id: '', state: 'running' as const, pct: 0, msg: '排队中',
        exp, epochs, startedAt: Date.now(),
      };
      this.trainJob = job;
      try {
        const id = await this.worker.submit('train', {
          exp,
          dataset: dir,
          epochs,
          batch,
          saveEvery,
          resume: cfg.resume === true,
          rebuild: cfg.rebuild === true,
          weightMap,
        });
        job.id = id;
      } catch (e) {
        job.state = 'error';
        job.error = e instanceof Error ? e.message : String(e);
        throw e;
      }
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
        })
        .catch((e: unknown) => {
          job.state = 'error';
          job.error = e instanceof Error ? e.message : String(e);
          job.msg = job.error;
          this.host?.log.warn(`[fish-sing] 训练中断：${job.error}`);
        });
      return {
        text: `开始训练「${exp}」：${epochs} 轮 / batch ${batch} / ${m.stats.kept} 片${
          weighted ? ` / 其中 ${weighted} 片带音域加权` : '（均匀采样）'}`,
        exp,
      };
    }

    if (method === 'trainStatus') {
      const exp = String(args[0] ?? '') || this.trainJob?.exp || '';
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
        weights: exp && expDir ? readWeights(this.datasetJob?.dir ?? '') : null,
      };
    }

    if (method === 'trainStop') {
      await this.worker.cancel();
      if (this.trainJob?.state === 'running') {
        // 立刻落状态：子进程可能还在收尾，面板会一直显示"训练中"，用户以为没停
        this.trainJob.state = 'error';
        this.trainJob.error = '已手动停止';
        this.trainJob.msg = '已手动停止';
      }
      return { text: '已停止训练。最近的存档还在 logs 里，可以勾「从上次存档继续」接着练。' };
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
      return {
        ...st,
        runtime,
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
        const sysPy = findSystemPython();
        this.startSetupJob('runtime', async (signal, report) => {
          if (!existsSync(join(this.routes.rvcRoot, 'infer', 'cli.py'))) copyRvcCode(this.routes, VENDORED_RVC);
          await installRuntime(this.routes, mode, sysPy, report, signal);
        });
        return {
          text: mode === 'gpu'
            ? '开始安装 GPU 运行时（下载约 2.5 GB，装完约 6 GB 磁盘）'
            : '开始安装 CPU 运行时（下载约 200 MB，推理慢 6~8 倍）',
        };
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

    throw new Error(`未知方法：${method}`);
  }

  /**
   * 起一个后台安装任务。面板靠轮询 status 拿进度，所以这里不 await。
   * 只允许一个：装运行时和唱一首歌抢同一张卡，同时来两个会互相拖死。
   */
  private startSetupJob(kind: 'models' | 'runtime', task: (signal: AbortSignal, report: (pct: number, msg: string) => void) => Promise<unknown>): void {
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
