/**
 * 配置段：默认值 + WebUI 配置组。
 *
 * 键名沿用 Coo 约定：配置组里写 `worlds.fish-sing.<点号路径>`，值落在
 * `data/home/companion/config.json` 的 `worlds["fish-sing"]` 下。
 * `x-hot: true` 的项改完即时生效（World 里读的是 `ctx.cfg` 活引用）。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export const FISHSING_ID = 'fish-sing';

export interface FishSingConfigSection {
  enabled: boolean;
  song: {
    enabled: boolean;
    maxDurationSec: number;
    maxAudioMB: number;
    /** 相关性阈值：低于它不发，改回候补让人挑。 */
    minScore: number;
    /** 额外想避开的词（逗号分隔），例如「翻唱,ai」 */
    excludeWords: string;
  };
  voice: {
    /** 模型文件名，相对 <rvcRoot>/assets/weights */
    model: string;
    /** 检索索引，相对 <rvcRoot>；空 = 不用索引（音色最弱） */
    index: string;
    indexRate: number;
    protect: number;
    pitch: number;
    /** full = 带伴奏；vocals = 只要人声 */
    mode: 'full' | 'vocals';
  };
  play: {
    enabled: boolean;
    /** ffplay 路径；空则用 <worker.ffmpegDir>/ffplay.exe */
    playerPath: string;
    volume: number;
    /** 她主动唱歌时默认发到哪：local / none（问她） */
    defaultTarget: 'local' | 'none';
  };
  send: {
    /** SnowLuma OneBot HTTP，例如 http://127.0.0.1:3002 */
    httpUrl: string;
    token: string;
    /** 密钥库里的名字，优先于明文 token */
    tokenSecret: string;
    /** 单条语音上限（秒）；QQ 语音条一般 ≤60 */
    maxSegmentSec: number;
    /** 多条之间的间隔（毫秒），防风控 */
    gapMs: number;
  };
  worker: {
    /** 自托管根目录；留空 = <数据目录>/runtime（推荐） */
    runtimeRoot: string;
    /** 外部 RVC 项目根；留空 = 用自托管（<runtimeRoot>/rvc） */
    rvcRoot: string;
    /** 外部 python；留空 = <runtimeRoot>/venv/Scripts/python.exe */
    pythonPath: string;
    /** 跑 demucs 的 python；留空 = 与 pythonPath 相同 */
    separatePython: string;
    /** 分离脚本；留空 = 插件自带的 worker/separate.py */
    separateScript: string;
    /** ffmpeg 目录（ffmpeg.exe / ffprobe.exe / ffplay.exe） */
    ffmpegDir: string;
    port: number;
    /** worker 端口令牌；空 = 不校验（只监听回环） */
    token: string;
    /** 启动时自动拉起 worker；关掉就得自己起 */
    autoStart: boolean;
    /** 首次调用允许等多久（毫秒），要覆盖模型加载 */
    startTimeoutMs: number;
  };
}

export const FISHSING_DEFAULTS: FishSingConfigSection = {
  enabled: false,
  song: {
    enabled: true,
    maxDurationSec: 480,
    maxAudioMB: 30,
    minScore: 8,
    excludeWords: '',
  },
  voice: {
    model: 'dfy2.pth',
    index: 'logs/dfy2/added_IVF2529_Flat_nprobe_1_dfy2_v2.index',
    indexRate: 0.75,
    protect: 0.33,
    pitch: 0,
    mode: 'full',
  },
  play: {
    enabled: true,
    playerPath: '',
    volume: 1,
    defaultTarget: 'local',
  },
  send: {
    httpUrl: '',
    token: '',
    tokenSecret: '',
    maxSegmentSec: 55,
    gapMs: 1500,
  },
  worker: {
    runtimeRoot: '',
    rvcRoot: '',
    pythonPath: '',
    separatePython: '',
    separateScript: '',
    ffmpegDir: 'D:\\ffmpeg\\bin',
    port: 9890,
    token: '',
    autoStart: true,
    startTimeoutMs: 240000,
  },
};

const at = (path: string): string => `worlds.${FISHSING_ID}.${path}`;

export function fishsingConfigGroups(): ConfigGroup[] {
  return [
    {
      id: `world:${FISHSING_ID}.voice`,
      owner: `world:${FISHSING_ID}`,
      schema: {
        type: 'object',
        title: '换声（唱成谁的声音）',
        properties: {
          [at('enabled')]: {
            type: 'boolean',
            title: '启用唱歌',
            description: '关掉后 fish_sing 系列工具都不会出现在她的工具表里。',
            'x-hot': true,
          },
          [at('voice.model')]: {
            type: 'string',
            title: '模型文件',
            description: '放在 <RVC 根>/assets/weights 下。默认 dfy2.pth（33 分钟全量那版）。',
            'x-hot': true,
          },
          [at('voice.index')]: {
            type: 'string',
            title: '检索索引',
            description: '相对 RVC 根目录。索引决定"像不像本人"，留空 = 纯模型生成（最不像）。',
            'x-hot': true,
          },
          [at('voice.indexRate')]: {
            type: 'number',
            title: '检索强度 index-rate',
            description: '0=纯模型最自然但最不像；0.75 是平衡点；0.9 以上咬字可能歪。',
            minimum: 0,
            maximum: 1,
            'x-hot': true,
          },
          [at('voice.protect')]: {
            type: 'number',
            title: '气声保护 protect',
            description: '齿音发毛就调高（0.4~0.45）；整体发闷就调回 0.3。',
            minimum: 0,
            maximum: 0.5,
            'x-hot': true,
          },
          [at('voice.pitch')]: {
            type: 'number',
            title: '默认移调（半音）',
            description: '男歌女唱常要 +2 ~ +4。会连带改变音色（升调后更薄）。',
            minimum: -12,
            maximum: 12,
            'x-hot': true,
          },
          [at('voice.mode')]: {
            type: 'string',
            title: '默认输出',
            description: 'full=带伴奏；vocals=清唱（更容易听出音色）。',
            enum: ['full', 'vocals'],
            'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${FISHSING_ID}.song`,
      owner: `world:${FISHSING_ID}`,
      schema: {
        type: 'object',
        title: '点歌（B 站搜索）',
        properties: {
          [at('song.enabled')]: {
            type: 'boolean',
            title: '允许从 B 站找歌',
            description: '关掉后只能用本地文件或 BV 号。',
            'x-hot': true,
          },
          [at('song.maxDurationSec')]: {
            type: 'number',
            title: '可接受的最长视频（秒）',
            description: '超长的跳过，避免点到合集/直播回放。默认 480。',
            minimum: 30,
            maximum: 3600,
            'x-hot': true,
          },
          [at('song.maxAudioMB')]: {
            type: 'number',
            title: '音频大小上限（MB）',
            description: '超过就放弃，防止拖慢。默认 30。',
            minimum: 1,
            maximum: 120,
            'x-hot': true,
          },
          [at('song.minScore')]: {
            type: 'number',
            title: '相关性阈值',
            description: '打分低于它就不唱，改成把候补报出来让她挑。默认 8。',
            minimum: 0,
            maximum: 40,
            'x-hot': true,
          },
          [at('song.excludeWords')]: {
            type: 'string',
            title: '额外避开这些词',
            description: '逗号分隔，标题里出现就重罚。例如「翻唱,ai,伴奏」。',
            'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${FISHSING_ID}.play`,
      owner: `world:${FISHSING_ID}`,
      schema: {
        type: 'object',
        title: '播放与发送',
        properties: {
          [at('play.enabled')]: {
            type: 'boolean',
            title: '允许本机播放',
            description: '用 ffplay 直接出声；关掉就只能发 QQ。',
            'x-hot': true,
          },
          [at('play.defaultTarget')]: {
            type: 'string',
            title: '她主动唱时发到哪',
            description: 'local=只在本机放；none=不自动发，等她判断要不要发群/私聊。',
            enum: ['local', 'none'],
            'x-hot': true,
          },
          [at('play.volume')]: {
            type: 'number',
            title: '本机音量',
            description: '0~1（ffplay 的 -volume，百分比）。',
            minimum: 0,
            maximum: 1,
            'x-hot': true,
          },
          [at('play.playerPath')]: {
            type: 'string',
            title: '播放器路径',
            description: '留空则用 ffmpeg 目录下的 ffplay.exe。',
            'x-hot': true,
          },
          [at('send.httpUrl')]: {
            type: 'string',
            title: 'OneBot HTTP 地址',
            description: '例如 http://127.0.0.1:3002。发 QQ 语音条用，空着就只能本机播放。',
            'x-hot': true,
          },
          [at('send.token')]: {
            type: 'string',
            title: 'OneBot 令牌（明文）',
            description: '优先用密钥库；这里只在没配密钥时兜底。',
            'x-hot': true,
          },
          [at('send.tokenSecret')]: {
            type: 'string',
            title: 'OneBot 令牌（密钥名）',
            description: '填密钥库里的名字，比明文安全。',
            'x-hot': true,
          },
          [at('send.maxSegmentSec')]: {
            type: 'number',
            title: '单条语音上限（秒）',
            description: 'QQ 语音条一般 ≤60；长歌会切成多条发。默认 55。',
            minimum: 10,
            maximum: 300,
            'x-hot': true,
          },
          [at('send.gapMs')]: {
            type: 'number',
            title: '多条之间的间隔（毫秒）',
            description: '防风控。默认 1500。',
            minimum: 0,
            maximum: 10000,
            'x-hot': true,
          },
        },
      },
    },
    {
      id: `world:${FISHSING_ID}.worker`,
      owner: `world:${FISHSING_ID}`,
      schema: {
        type: 'object',
        title: '运行时（改这些要重启）',
        properties: {
          [at('worker.runtimeRoot')]: {
            type: 'string',
            title: '自托管根目录',
            description: '留空 = <数据目录>/runtime。代码、venv、权重都装在这里。',
            'x-hot': false,
          },
          [at('worker.rvcRoot')]: {
            type: 'string',
            title: '外部 RVC 目录（高级）',
            description: '已经有一份 RVC 项目时才填，填了就不用自托管。留空 = 用插件自带的代码。',
            'x-hot': false,
          },
          [at('worker.pythonPath')]: {
            type: 'string',
            title: '外部 python（高级）',
            description: '留空 = 自托管 venv。填了就用你的。',
            'x-hot': false,
          },
          [at('worker.separatePython')]: {
            type: 'string',
            title: '分离用的 python（高级）',
            description: '留空 = 与上面同一个 venv（demucs 装在同一个里）。',
            'x-hot': false,
          },
          [at('worker.separateScript')]: {
            type: 'string',
            title: '分离脚本（高级）',
            description: '留空 = 插件自带的 worker/separate.py。',
            'x-hot': false,
          },
          [at('worker.ffmpegDir')]: {
            type: 'string',
            title: 'ffmpeg 目录',
            description: '要同时有 ffmpeg.exe、ffprobe.exe、ffplay.exe。',
            'x-hot': false,
          },
          [at('worker.port')]: {
            type: 'number',
            title: 'worker 端口',
            description: '只监听 127.0.0.1。默认 9890。',
            minimum: 1024,
            maximum: 65535,
            'x-hot': false,
          },
          [at('worker.autoStart')]: {
            type: 'boolean',
            title: '自动拉起 worker',
            description: '启动 Coo 时顺手把常驻 worker 起起来（省掉第一次的 8 秒模型加载）。',
            'x-hot': false,
          },
          [at('worker.startTimeoutMs')]: {
            type: 'number',
            title: '首次调用超时（毫秒）',
            description: '要盖住模型加载时间，默认 240000（4 分钟）。',
            minimum: 30000,
            maximum: 900000,
            'x-hot': false,
          },
        },
      },
    },
  ];
}
