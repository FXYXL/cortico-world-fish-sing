/**
 * Node 侧冒烟测试：入口能加载、通知渠道兜底逻辑正确。
 * 跑法：node --experimental-strip-types tests/smoke.mjs
 */
import { notify } from '../src/notify.ts';

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  if (!ok) failed += 1;
}

const log = { info: () => {}, warn: () => {}, error: () => {} };

// ---- 1. 桌宠渠道：pushEvent 被调用 ----
let pushed = [];
const r1 = await notify(
  { cfg: { enabled: true, channel: 'pet' }, pushEvent: (e) => pushed.push(e), onebot: { httpUrl: '' }, log },
  '训练完成：dfy3', '200 轮全部完成。',
);
check('桌宠渠道走 pushEvent', r1.via === 'pet' && pushed.length === 1 && pushed[0].type === 'fishsing.notify');
check('事件带正文', typeof pushed[0]?.text === 'string' && pushed[0].text.includes('dfy3'));

// ---- 2. auto + 没配 QQ 目标 → 退桌宠 ----
pushed = [];
const r2 = await notify(
  { cfg: { enabled: true, channel: 'auto' }, pushEvent: (e) => pushed.push(e), onebot: { httpUrl: '' }, log },
  '测试2',
);
check('auto 无 QQ 目标 → 桌宠', r2.via === 'pet' && pushed.length === 1);

// ---- 3. QQ 不通 → 退桌宠（用户定的兜底规则） ----
pushed = [];
const r3 = await notify(
  { cfg: { enabled: true, channel: 'auto', qqTarget: 'group:123' }, pushEvent: (e) => pushed.push(e), onebot: { httpUrl: 'http://127.0.0.1:59999' }, log },
  '测试3',
);
check('QQ 不通退桌宠', r3.via === 'pet' && pushed.length === 1);

// ---- 4. 关闭 → 不发 ----
pushed = [];
const r4 = await notify(
  { cfg: { enabled: false, channel: 'pet' }, pushEvent: (e) => pushed.push(e), onebot: { httpUrl: '' }, log },
  '测试4',
);
check('enabled=false 不发', r4.via === 'off' && pushed.length === 0);


// ---- 5. 裸号码当私聊（0.4.10 的坑：填了号码没前缀就静默不发） ----
const { parseTarget } = await import('../src/deliver.ts');
const t1 = parseTarget('2587509374');
check('裸号码 → 私聊', Boolean(t1) && t1.action === 'send_private_msg' && t1.params.user_id === 2587509374);
check('乱码 → null', parseTarget('2587509374abc') === null);

// ---- 6. 音量跟随：默认 0（跟随原唱），且配置里有这一项 ----
const { FISHSING_DEFAULTS, fishsingConfigGroups } = await import('../src/config.ts');
check('默认 rmsMixRate = 0', FISHSING_DEFAULTS.voice.rmsMixRate === 0);
const voiceGroup = fishsingConfigGroups().find((g) => g.id.endsWith('.voice'));
const key = Object.keys(voiceGroup.schema.properties).find((k) => k.endsWith('voice.rmsMixRate'));
check('配置项 voice.rmsMixRate 存在', Boolean(key));
check('配置项有说明文案', String(voiceGroup.schema.properties[key].description || '').length > 20);

// ---- 7. 和声堆叠：默认关，配置项齐全 ----
check('默认和声 = off', FISHSING_DEFAULTS.voice.harmony === 'off');
check('默认和声音量 0.22', FISHSING_DEFAULTS.voice.harmonyGain === 0.22);
const hKeys = ['voice.harmony', 'voice.harmonyGain', 'voice.harmonyScope']
  .map((k) => Object.keys(voiceGroup.schema.properties).find((x) => x.endsWith(k)));
check('三个和声配置项都在', hKeys.every(Boolean));
check('和声配置项都有说明', hKeys.every((k) => String(voiceGroup.schema.properties[k].description || '').length > 20));

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n冒烟测试全部通过');
