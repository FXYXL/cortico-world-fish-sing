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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';

import { FISHSING_ID, fishsingConfigGroups, type FishSingConfigSection } from './config.ts';
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

export class FishSingWorld implements World {
  readonly id = FISHSING_ID;
  private host: WorldHost | null = null;
  private readonly opts: FishSingWorldOptions;
  private readonly player = new Player();
  private readonly worker: WorkerClient;
  private lastSong: { title: string; at: number; duration: number } | null = null;
  /** 同一时刻只允许一首在跑（GPU 只有一张卡）。 */
  private busy = false;

  constructor(opts: FishSingWorldOptions) {
    // 不用「参数属性」写法：Node 的类型剥离跑不了它
    this.opts = opts;
    const cfg = opts.cfg || ({} as FishSingConfigSection);
    this.worker = new WorkerClient(
      {
        rvcRoot: cfg.worker?.rvcRoot ?? 'D:\\AI\\rvc',
        pythonPath: cfg.worker?.pythonPath ?? 'D:\\AI\\rvc\\venv\\Scripts\\python.exe',
        separatePython: cfg.worker?.separatePython ?? 'D:\\AI\\seed-vc\\venv\\Scripts\\python.exe',
        separateScript: cfg.worker?.separateScript ?? 'D:\\AI\\seed-vc-src\\separate.py',
        ffmpegDir: cfg.worker?.ffmpegDir ?? 'D:\\ffmpeg\\bin',
        port: Number(cfg.worker?.port ?? 9890),
        token: String(cfg.worker?.token ?? ''),
        autoStart: cfg.worker?.autoStart !== false,
        startTimeoutMs: Number(cfg.worker?.startTimeoutMs ?? 240000),
        workDir: join(opts.dataDir, 'work'),
        model: String(cfg.voice?.model ?? 'dfy2.pth'),
        index: String(cfg.voice?.index ?? ''),
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
    return { dir: this.opts.cfg.worker?.ffmpegDir ?? 'D:\\ffmpeg\\bin' };
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
        model: String(cfg.voice?.model ?? 'dfy2.pth'),
        index: String(cfg.voice?.index ?? ''),
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
    const model = String(cfg.voice?.model ?? '');
    const where = cfg.play?.defaultTarget === 'none' ? '不自动发，由你自己判断要不要发' : '默认只在本机放（不打扰群里）';
    const last = this.lastSong
      ? `上一次唱的是《${this.lastSong.title}》（${Math.round(this.lastSong.duration)} 秒前）`
      : '还没唱过';
    return {
      singModel: model || '未配置',
      singTarget: where,
      singLast: last,
      singOnebot: String(cfg.send?.httpUrl ?? '') ? '已配置（能发 QQ 语音条）' : '未配置（只能本机播放）',
      singBody: text,
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
          id: 'library',
          title: '作品库',
          description: '她唱过的每一首：试听、改名、删除、打开所在文件夹。',
          getMethods: ['list'],
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
