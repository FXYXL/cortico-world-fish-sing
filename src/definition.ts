/**
 * World 定义：Coo 的装配层按这个挂载，Core 按这个构造实例。
 */
import { join } from 'node:path';
import type { WorldContext, WorldDefinition } from 'cortico/world.ts';
import { FISHSING_DEFAULTS, FISHSING_ID, type FishSingConfigSection } from './config.ts';
import { FishSingWorld } from './world.ts';

export const FISHSING: WorldDefinition<FishSingConfigSection> = {
  id: FISHSING_ID,
  label: '大肥鱼唱歌',
  defaults: () => structuredClone(FISHSING_DEFAULTS),
  preflight: (ctx: WorldContext<FishSingConfigSection>) => {
    if (ctx.cfg?.enabled === false) return;
    const url = String(ctx.cfg?.send?.httpUrl ?? '').trim();
    if (url && !/^https?:\/\//.test(url)) {
      throw new Error(
        `worlds.${FISHSING_ID}.send.httpUrl 必须是 http(s):// 开头的地址，现在是「${url}」。不想发 QQ 就留空。`,
      );
    }
  },
  create: (ctx: WorldContext<FishSingConfigSection>) =>
    new FishSingWorld({
      cfg: ctx.cfg,
      // 每个插件一个子目录：ctx.dataDir 是整个部署的 data/，别把 cache/library 摊在它根上
      dataDir: join(ctx.dataDir, FISHSING_ID),
      secret: (name: string) => ctx.secret(name),
    }),
  describe: {
    tools: [
      {
        name: 'fish_sing',
        description: '把一首歌换成她的声音唱出来，本机放或发 QQ 语音条。',
        tags: ['music', 'voice'],
        summary: '唱一首歌（歌名 / BV 号 / 本地文件）',
        parameters: {
          type: 'object',
          properties: {
            song: { type: 'string', description: '歌名、BV 号、链接或本机文件路径' },
            to: { type: 'string', description: 'local / group:<群号> / private:<QQ号> / both' },
            mode: { type: 'string', enum: ['full', 'vocals'], description: '带伴奏 / 清唱' },
            pitch: { type: 'number', description: '移调半音' },
            indexRate: { type: 'number', description: '音色检索强度 0~1' },
            protect: { type: 'number', description: '气声保护 0~0.5' },
            start: { type: 'number', description: '从第几秒开始' },
            duration: { type: 'number', description: '唱多长（秒）' },
            refresh: { type: 'boolean', description: '忽略缓存' },
          },
          required: ['song'],
        },
      },
      {
        name: 'fish_sing_stop',
        description: '停掉播放并取消正在处理的歌。',
        tags: ['music'],
        summary: '别唱了',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'fish_sing_library',
        description: '列出 / 回放 / 删除她唱过的歌。',
        tags: ['music'],
        summary: '作品库',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'play', 'delete'] },
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: [],
        },
      },
      {
        name: 'fish_sing_status',
        description: '唱歌功能是否可用、当前在算什么。',
        tags: ['music'],
        summary: '唱歌状态',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
    events: [],
  },
};

export { fishsingConfigGroups } from './config.ts';
export default FISHSING;
