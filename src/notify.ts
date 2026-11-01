/**
 * 长任务（训练、数据集）结束时的主动通知。
 *
 * 渠道：
 *  · 桌宠 —— host.pushEvent 把事件送进上下文，Coo 会自己接话（她的人设还能顺便营业）；
 *  · QQ   —— OneBot 文本消息，发到 notify.qqTarget 指定的群/私聊。
 *
 * 兜底规则（用户定的）：auto=配了 qqTarget 先走 QQ，失败退桌宠；没配 qqTarget 直接桌宠。
 * 显式 channel='qq' 时 QQ 失败同样退桌宠——通知这种事，宁可多嘴不能哑火。
 */
import { parseTarget, sendText, type OneBotOptions } from './deliver.ts';
import type { LoggerLike } from './worker.ts';

export interface NotifyConfig {
  enabled?: boolean;
  channel?: 'auto' | 'pet' | 'qq';
  /** QQ 通知发到哪：group:<群号> 或 private:<QQ号>；空 = 只用桌宠 */
  qqTarget?: string;
}

export interface NotifyDeps {
  cfg: NotifyConfig;
  /** WorldHost.pushEvent 的薄封装；事件进上下文，桌宠自己决定怎么说 */
  pushEvent: (e: Record<string, unknown>) => unknown;
  onebot: OneBotOptions;
  log: LoggerLike;
}

export interface NotifyOutcome {
  via: 'pet' | 'qq' | 'off' | 'none';
  note: string;
}

export async function notify(deps: NotifyDeps, title: string, body = ''): Promise<NotifyOutcome> {
  if (deps.cfg.enabled === false) return { via: 'off', note: '通知已关' };
  const text = body ? `${title}\n${body}` : title;

  const channel = deps.cfg.channel ?? 'auto';
  const target = parseTarget(String(deps.cfg.qqTarget ?? ''));
  const wantQQ = channel === 'qq' || (channel === 'auto' && Boolean(target) && Boolean(deps.onebot.httpUrl));
  if (wantQQ) {
    if (target && deps.onebot.httpUrl) {
      try {
        await sendText(deps.onebot, target, text);
        return { via: 'qq', note: `已发到${target.label}` };
      } catch (e) {
        deps.log.warn(`QQ 通知失败，退回桌宠：${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      deps.log.warn(`QQ 通知发不了（${!target ? '目标没配' : 'OneBot 地址没配'}），退回桌宠`);
    }
  }

  try {
    await deps.pushEvent({
      type: 'fishsing.notify',
      origin: 'internal',
      source: 'fish-sing',
      senderKey: 'fish-sing:notify',
      ts: new Date().toISOString(),
      text,
      meta: { title },
    });
    return { via: 'pet', note: '已告诉桌宠' };
  } catch (e) {
    return { via: 'none', note: `桌宠通知也失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
