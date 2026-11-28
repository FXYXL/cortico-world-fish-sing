/**
 * 脱离 Coopanion 宿主的本地调试壳（零外部依赖）。
 *
 * 直接加载当前工作区的 src/definition.ts 与 dist/webui.js：
 *  · 改 dist/webui.js：浏览器按 F5 立即生效，无需跑 bundle-webui.mjs 或复制 node_modules；
 *  · 改 src/*.ts：Ctrl+C 重跑本脚本，不到 1 秒生效，无需重启桌宠；
 *  · 内置「配置」页（按 ConfigGroup schema 自动渲染，支持热更新与可选落盘）；
 *  · 内置「模拟点歌 & 工具」页（B 站搜歌 → 选候选/填 BV → 调参试唱 → 实时进度 → 播放/停止）。
 *
 * 用法：
 *   node --experimental-strip-types tools/dev-host.mjs
 *   node --experimental-strip-types tools/dev-host.mjs --autostart
 *   node --experimental-strip-types tools/dev-host.mjs --sandbox
 *   node --experimental-strip-types tools/dev-host.mjs --port 17990 --worker-port 9890
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import definition from '../src/definition.ts';
import { rankHits, searchBili } from '../src/bili.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEBUI_JS = join(ROOT, 'dist', 'webui.js');

function argVal(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? String(process.argv[i + 1]) : fallback;
}

const useSandbox = process.argv.includes('--sandbox');
const allowAutoStart = process.argv.includes('--autostart');
const port = Number(argVal('--port', '17990')) || 17990;
const workerPortOverride = Number(argVal('--worker-port', '0')) || 0;
const cooDir = process.env.COOPANION_DIR || 'D:\\Coopanion';
const cooConfigPath = join(cooDir, 'data', 'home', 'companion', 'config.json');

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** 按点号路径读取 cfg 中的值（例如 worlds.fish-sing.voice.reverb → cfg.voice.reverb）。 */
function getCfgByKey(rootCfg, fullKey) {
  const prefix = `worlds.${definition.id}.`;
  const rel = fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
  let cur = rootCfg;
  for (const seg of rel.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 就地写入 cfg 活引用，确保 x-hot 配置改完立刻生效。 */
function setCfgByKey(rootCfg, fullKey, value) {
  const prefix = `worlds.${definition.id}.`;
  const rel = fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
  const parts = rel.split('.');
  let cur = rootCfg;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

const defaults = definition.defaults();
const cfg = structuredClone(defaults);
let dataRoot = '';
let modeLabel = '';
let saveConfigPath = '';

if (useSandbox) {
  dataRoot = join(ROOT, 'data', 'dev-sandbox');
  mkdirSync(dataRoot, { recursive: true });
  saveConfigPath = join(dataRoot, 'config.json');
  if (existsSync(saveConfigPath)) {
    try {
      const raw = JSON.parse(readFileSync(saveConfigPath, 'utf8'));
      const worldCfg = raw?.worlds?.[definition.id];
      if (worldCfg && typeof worldCfg === 'object') {
        Object.assign(cfg, deepMerge(cfg, worldCfg));
      }
    } catch {
      /* 忽略坏配置 */
    }
  }
  modeLabel = '沙箱模式（隔离数据）';
} else {
  dataRoot = join(cooDir, 'data', 'home', 'companion', 'data');
  saveConfigPath = cooConfigPath;
  if (existsSync(cooConfigPath)) {
    try {
      const raw = JSON.parse(readFileSync(cooConfigPath, 'utf8'));
      const worldCfg = raw?.worlds?.[definition.id];
      if (worldCfg && typeof worldCfg === 'object') {
        Object.assign(cfg, deepMerge(cfg, worldCfg));
      }
    } catch (e) {
      console.warn(`[dev-host] 读取桌宠配置失败，退回默认配置：${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.warn(`[dev-host] 未找到桌宠配置：${cooConfigPath}，使用默认配置`);
  }
  mkdirSync(dataRoot, { recursive: true });
  modeLabel = '复用桌宠数据';
}

cfg.enabled = true;
cfg.worker = {
  ...cfg.worker,
  autoStart: allowAutoStart,
  ...(workerPortOverride ? { port: workerPortOverride } : {}),
};

const events = [];
const logs = [];
function pushLog(level, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${ts}] [${level}] ${msg}`;
  logs.unshift(line);
  if (logs.length > 150) logs.length = 150;
  if (level === 'warn' || level === 'error') console.warn(line);
  else console.log(line);
}

const mockHost = {
  log: {
    info: (m) => pushLog('info', String(m)),
    warn: (m) => pushLog('warn', String(m)),
    error: (m) => pushLog('error', String(m)),
  },
  pushEvent: async (e) => {
    const item = { at: new Date().toISOString(), ...e };
    events.unshift(item);
    if (events.length > 50) events.length = 50;
    pushLog('event', `${e.type || 'event'}：${String(e.text || '').replace(/\n/g, ' / ')}`);
    return item;
  },
};

const world = definition.create({
  cfg,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dataDir: dataRoot,
  packageDir: ROOT,
  secret: (name) => process.env[name],
});

await world.start(mockHost);
const decl = world.webUi('zh');

function json(res, code, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const HTML = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>fish-sing 本地调试宿主</title>
<style>
  :root{
    color-scheme: dark;
    --content-width: 1120px;
    --bg: #15181d;
    --bg-sub: #1d222a;
    --fg: #e6ebf2;
    --border: rgba(127,127,127,.26);
  }
  :root[data-theme="light"]{
    color-scheme: light;
    --bg: #f6f7f9;
    --bg-sub: #ffffff;
    --fg: #1d222a;
    --border: rgba(127,127,127,.26);
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);
    font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  .top{position:sticky;top:0;z-index:10;background:var(--bg-sub);border-bottom:1px solid var(--border);
    padding:10px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .brand{font-weight:700;font-size:14px}
  .tabs{display:flex;gap:6px;flex-wrap:wrap}
  .tab{appearance:none;border:1px solid var(--border);background:transparent;color:inherit;
    border-radius:6px;padding:4px 11px;font-size:12.5px;cursor:pointer}
  .tab:hover{background:rgba(127,127,127,.1)}
  .tab.active{border-color:#378ADD;color:#378ADD;background:rgba(55,138,221,.12)}
  .tab.danger{border-color:rgba(220,80,80,.5);color:#d05555}
  .tab:disabled{opacity:.45;cursor:default}
  select.tab{appearance:auto;-webkit-appearance:menulist;padding:4px 8px;
    background-color:var(--bg-sub);color:var(--fg)}
  select.tab option,select.tab optgroup{background-color:var(--bg-sub);color:var(--fg)}
  select option,select optgroup{background-color:var(--bg-sub);color:var(--fg)}
  .grow{flex:1}
  .badge{font-size:11.5px;opacity:.7;padding:2px 8px;border:1px solid var(--border);border-radius:999px}
  /* 完整复刻 Coopanion 控制台的 .panelslot 布局规则，便于直接验证居中与宽度 */
  .stage{padding:16px 14px 48px;overflow-x:hidden}
  .panelslot{width:100%;min-width:0;overflow-x:hidden}
  .panelslot > :where(:not(.viewport-overlay)){
    width:100%;
    max-width:var(--content-width);
    margin:auto;
  }
  .dbg-stack{display:flex;flex-direction:column;gap:12px}
  .dbg-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media (max-width:860px){.dbg-grid{grid-template-columns:1fr}}
  .dbg-card{border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:var(--bg-sub)}
  .dbg-card h3{margin:0 0 8px;font-size:13.5px;display:flex;align-items:center;gap:8px}
  .dbg-pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Consolas,monospace;
    max-height:260px;overflow:auto;padding:8px;border-radius:6px;background:rgba(127,127,127,.08)}
  .dbg-ta{width:100%;min-height:92px;font:12px/1.5 ui-monospace,Consolas,monospace;padding:8px;
    border-radius:6px;border:1px solid var(--border);background:transparent;color:inherit;margin-bottom:8px}
  .dbg-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
  .dbg-in{padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;
    color:inherit;font-size:12.5px}
  .dbg-in.wide{flex:1;min-width:240px}
  .dbg-in.sm{width:86px}
  .dbg-field{display:flex;flex-direction:column;gap:2px;font-size:11.5px}
  .dbg-field>span{opacity:.65}
  .dbg-meta{font-size:12px;opacity:.7}
  .dbg-msg{min-height:18px;font-size:12.5px;margin:4px 0 8px}
  .dbg-msg.bad{color:#d05555}
  .dbg-msg.ok{color:#3fae62}
  .dbg-tbl{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
  .dbg-tbl th,.dbg-tbl td{padding:5px 8px;border-bottom:1px solid rgba(127,127,127,.16);text-align:left;vertical-align:middle}
  .dbg-tbl th{opacity:.7;font-weight:600;white-space:nowrap}
  .dbg-tbl tr:hover{background:rgba(127,127,127,.06)}
  .cfg-group{border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:var(--bg-sub)}
  .cfg-group h3{margin:0 0 10px;font-size:13.5px}
  .cfg-row{display:grid;grid-template-columns:220px 1fr;gap:12px;align-items:start;
    padding:8px 0;border-bottom:1px solid rgba(127,127,127,.14)}
  .cfg-row:last-child{border-bottom:none}
  @media (max-width:760px){.cfg-row{grid-template-columns:1fr}}
  .cfg-title{font-weight:600;font-size:12.5px}
  .cfg-desc{font-size:11.5px;opacity:.65;margin-top:2px}
  .cfg-tag{display:inline-block;font-size:10.5px;padding:0 5px;border-radius:4px;margin-left:6px;
    background:rgba(127,127,127,.16);opacity:.85}
  .cfg-tag.hot{color:#3fae62}
</style>
</head>
<body>
  <header class="top">
    <span class="brand">大肥鱼唱歌 · 本地调试</span>
    <nav class="tabs" id="tabs"></nav>
    <span class="grow"></span>
    <span class="badge" id="metaBadge">加载中…</span>
    <button class="tab" id="themeBtn">切亮色</button>
    <button class="tab" id="reloadBtn" title="仅重新挂载当前页签，重新拉取 dist/webui.js">热重载面板</button>
  </header>
  <main class="stage">
    <div id="slot" class="panelslot"></div>
  </main>
<script type="module">
  const tabsEl = document.getElementById('tabs');
  const slotEl = document.getElementById('slot');
  const badgeEl = document.getElementById('metaBadge');
  const themeBtn = document.getElementById('themeBtn');
  const reloadBtn = document.getElementById('reloadBtn');

  let currentId = localStorage.getItem('fs-dev-tab') || '__debug';
  let currentDispose = null;
  let meta = null;

  async function api(url, body) {
    const res = await fetch(url, body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || data.message || ('HTTP ' + res.status));
    }
    return data;
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function renderTabs() {
    tabsEl.replaceChildren();
    const list = [
      ...(meta.panels || []),
      { id: '__config', title: '配置' },
      { id: '__debug', title: '点歌模拟 & 工具' },
    ];
    for (const p of list) {
      const b = document.createElement('button');
      b.className = 'tab' + (p.id === currentId ? ' active' : '');
      b.textContent = p.title;
      b.onclick = () => void openTab(p.id);
      tabsEl.append(b);
    }
  }

  async function mountConfig(root) {
    const data = await api('/api/config');
    const wrap = document.createElement('div');
    wrap.className = 'dbg-stack';

    const bar = document.createElement('div');
    bar.className = 'dbg-bar';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'tab active';
    applyBtn.textContent = '应用到内存（热更新）';
    const saveDiskBtn = document.createElement('button');
    saveDiskBtn.className = 'tab';
    saveDiskBtn.textContent = data.useSandbox ? '保存到沙箱 config.json' : '同时写入桌宠 config.json';
    const tip = document.createElement('span');
    tip.className = 'dbg-meta';
    tip.textContent = '标注「热更新」的项应用后立即对下次点歌/通知生效；运行时路径类需重启本调试脚本';
    bar.append(applyBtn, saveDiskBtn, tip);

    const msg = document.createElement('div');
    msg.className = 'dbg-msg';
    wrap.append(bar, msg);

    const controls = [];

    for (const g of data.groups || []) {
      const card = document.createElement('div');
      card.className = 'cfg-group';
      const h3 = document.createElement('h3');
      h3.textContent = g.schema?.title || g.id;
      card.append(h3);

      const props = g.schema?.properties || {};
      for (const [key, prop] of Object.entries(props)) {
        const row = document.createElement('div');
        row.className = 'cfg-row';

        const left = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'cfg-title';
        title.textContent = prop.title || key;
        const tag = document.createElement('span');
        const isHot = prop['x-hot'] !== false;
        tag.className = 'cfg-tag' + (isHot ? ' hot' : '');
        tag.textContent = isHot ? '热更新' : '需重启';
        title.append(tag);
        const keyLine = document.createElement('div');
        keyLine.className = 'cfg-desc';
        keyLine.textContent = key.replace(/^worlds\\.fish-sing\\./, '');
        left.append(title, keyLine);

        const right = document.createElement('div');
        const val = data.values?.[key];
        let input;
        if (prop.type === 'boolean') {
          input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = Boolean(val);
        } else if (Array.isArray(prop.enum)) {
          input = document.createElement('select');
          input.className = 'tab';
          for (const opt of prop.enum) {
            const o = document.createElement('option');
            o.value = String(opt);
            o.textContent = String(opt);
            if (String(val) === String(opt)) o.selected = true;
            input.append(o);
          }
        } else if (prop.type === 'number') {
          input = document.createElement('input');
          input.type = 'number';
          input.className = 'dbg-in';
          input.step = 'any';
          if (prop.minimum !== undefined) input.min = String(prop.minimum);
          if (prop.maximum !== undefined) input.max = String(prop.maximum);
          input.value = val === undefined ? '' : String(val);
        } else {
          input = document.createElement('input');
          input.type = 'text';
          input.className = 'dbg-in wide';
          input.style.width = '100%';
          input.value = val === undefined ? '' : String(val);
        }
        right.append(input);
        if (prop.description) {
          const desc = document.createElement('div');
          desc.className = 'cfg-desc';
          desc.textContent = prop.description;
          right.append(desc);
        }

        controls.push({ key, prop, input });
        row.append(left, right);
        card.append(row);
      }
      wrap.append(card);
    }

    const collectPatch = () => {
      const patch = {};
      for (const { key, prop, input } of controls) {
        if (prop.type === 'boolean') {
          patch[key] = input.checked;
        } else if (prop.type === 'number') {
          const n = Number(input.value);
          if (Number.isFinite(n)) patch[key] = n;
        } else if (Array.isArray(prop.type) && prop.type.includes('number')) {
          const raw = input.value.trim();
          patch[key] = raw === '' || raw.toLowerCase() === 'auto' ? 'auto'
            : (Number.isFinite(Number(raw)) ? Number(raw) : raw);
        } else {
          patch[key] = input.value;
        }
      }
      return patch;
    };

    const submit = async (persist) => {
      applyBtn.disabled = true;
      saveDiskBtn.disabled = true;
      msg.className = 'dbg-msg';
      msg.textContent = '保存中…';
      try {
        const res = await api('/api/config', { patch: collectPatch(), persist });
        msg.className = 'dbg-msg ok';
        msg.textContent = res.message || '已更新';
      } catch (e) {
        msg.className = 'dbg-msg bad';
        msg.textContent = '失败：' + (e.message || e);
      } finally {
        applyBtn.disabled = false;
        saveDiskBtn.disabled = false;
      }
    };

    applyBtn.onclick = () => void submit(false);
    saveDiskBtn.onclick = () => void submit(true);

    root.append(wrap);
    return { dispose() {} };
  }

  async function mountDebug(root) {
    const data = await api('/api/meta');
    const wrap = document.createElement('div');
    wrap.className = 'dbg-stack';

    let pollTimer = null;

    // ---- 1. 可视化模拟点歌 / B 站搜歌 / BV 拉取 / 试唱播放 ----
    const simCard = document.createElement('div');
    simCard.className = 'dbg-card';
    simCard.innerHTML = '<h3>模拟点歌与播放（B 站搜歌 / 指定 BV / 本地文件 → 分离换声 → 本机播放）</h3>';

    const row1 = document.createElement('div');
    row1.className = 'dbg-bar';
    const songIn = document.createElement('input');
    songIn.className = 'dbg-in wide';
    songIn.placeholder = '输入歌名（搜 B 站）、BV 号（如 BV1xx...）、B 站链接或本机音频路径';
    const orderSel = document.createElement('select');
    orderSel.className = 'tab';
    for (const [v, t] of [['default', 'B 站综合'], ['click', '按播放量'], ['pubdate', '按最新']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      orderSel.append(o);
    }
    const searchBtn = document.createElement('button');
    searchBtn.className = 'tab';
    searchBtn.textContent = 'B 站搜歌';
    const singBtn = document.createElement('button');
    singBtn.className = 'tab active';
    singBtn.textContent = '拉取并唱播';
    const stopBtn = document.createElement('button');
    stopBtn.className = 'tab danger';
    stopBtn.textContent = '停止播放 / 取消';
    const unloadBtn = document.createElement('button');
    unloadBtn.className = 'tab';
    unloadBtn.textContent = '释放显存';
    unloadBtn.title = '立即卸载常驻 GPU 模型，释放约 1.5~2GB 显存（下次点歌自动拉回）';
    row1.append(songIn, orderSel, searchBtn, singBtn, stopBtn, unloadBtn);

    const row2 = document.createElement('div');
    row2.className = 'dbg-bar';
    const mkF = (label, node) => {
      const box = document.createElement('label');
      box.className = 'dbg-field';
      const s = document.createElement('span');
      s.textContent = label;
      box.append(s, node);
      return box;
    };
    const startIn = document.createElement('input');
    startIn.className = 'dbg-in sm';
    startIn.type = 'number';
    startIn.placeholder = '0';
    const durIn = document.createElement('input');
    durIn.className = 'dbg-in sm';
    durIn.type = 'number';
    durIn.placeholder = '整首';
    const pitchIn = document.createElement('input');
    pitchIn.className = 'dbg-in sm';
    pitchIn.value = 'auto';
    pitchIn.title = 'auto 或半音数（如 0、+3、-2）';
    const modeSel = document.createElement('select');
    modeSel.className = 'tab';
    for (const [v, t] of [['full', '带伴奏'], ['vocals', '清唱']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      modeSel.append(o);
    }
    const reverbSel = document.createElement('select');
    reverbSel.className = 'tab';
    for (const [v, t] of [['', '跟配置'], ['off', '关混响'], ['light', '轻度混响']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      reverbSel.append(o);
    }
    const harmSel = document.createElement('select');
    harmSel.className = 'tab';
    for (const [v, t] of [
      ['', '跟配置'],
      ['off', '无和声'],
      ['double', '双轨厚声(副歌)'],
      ['double+third', '双轨+轻三度(唱片感)'],
      ['third', '三度和声'],
      ['third+fifth', '三+五度'],
    ]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      harmSel.append(o);
    }
    const polishSel = document.createElement('select');
    polishSel.className = 'tab';
    for (const [v, t] of [['', '跟配置(开)'], ['on', '开润色'], ['off', '关润色']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      polishSel.append(o);
    }
    const sepSel = document.createElement('select');
    sepSel.className = 'tab';
    for (const [v, t] of [['', '跟配置'], ['htdemucs', '快速 htdemucs'], ['roformer', 'UVR5 RoFormer 精唱']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      sepSel.append(o);
    }
    const derevSel = document.createElement('select');
    derevSel.className = 'tab';
    for (const [v, t] of [['', '跟配置'], ['on', '开去混响'], ['off', '关去混响']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      derevSel.append(o);
    }
    const f0Sel = document.createElement('select');
    f0Sel.className = 'tab';
    for (const [v, t] of [['', '跟配置'], ['rmvpe', 'rmvpe'], ['fcpe', 'fcpe']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      f0Sel.append(o);
    }
    const dynSel = document.createElement('select');
    dynSel.className = 'tab';
    for (const [v, t] of [['', '跟配置'], ['off', '统一音色'], ['soft-verse-bright-chorus', '主歌柔/副歌亮']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      dynSel.append(o);
    }
    const asyncSel = document.createElement('select');
    asyncSel.className = 'tab';
    for (const [v, t] of [['', '跟配置(异步)'], ['sync', '同步等待'], ['async', '异步后台']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      asyncSel.append(o);
    }
    const toIn = document.createElement('input');
    toIn.className = 'dbg-in';
    toIn.style.width = '130px';
    toIn.value = 'local';
    toIn.title = 'local / group:群号 / private:QQ号';
    const refreshChk = document.createElement('input');
    refreshChk.type = 'checkbox';
    const refreshLbl = document.createElement('label');
    refreshLbl.className = 'dbg-meta';
    refreshLbl.style.display = 'inline-flex';
    refreshLbl.style.alignItems = 'center';
    refreshLbl.style.gap = '4px';
    refreshLbl.append(refreshChk, document.createTextNode('忽略成品缓存'));

    row2.append(
      mkF('起始(秒)', startIn),
      mkF('时长(秒)', durIn),
      mkF('移调', pitchIn),
      mkF('模式', modeSel),
      mkF('分离', sepSel),
      mkF('去混响', derevSel),
      mkF('F0', f0Sel),
      mkF('主副歌', dynSel),
      mkF('润色', polishSel),
      mkF('混响', reverbSel),
      mkF('和声', harmSel),
      mkF('执行', asyncSel),
      mkF('投递目标', toIn),
      refreshLbl,
    );

    const simMsg = document.createElement('div');
    simMsg.className = 'dbg-msg';
    const statusLine = document.createElement('div');
    statusLine.className = 'dbg-meta';
    const hitsBox = document.createElement('div');

    simCard.append(row1, row2, simMsg, statusLine, hitsBox);

    const refreshStatus = async () => {
      try {
        const r = await api('/api/tool', { name: 'fish_sing_status', args: {} });
        statusLine.textContent = '状态：' + (typeof r.result === 'string' ? r.result : JSON.stringify(r.result));
      } catch {
        /* 忽略 */
      }
    };

    const runSing = async (songOverride) => {
      const song = String(songOverride ?? songIn.value ?? '').trim();
      if (!song) {
        simMsg.className = 'dbg-msg bad';
        simMsg.textContent = '请先输入歌名、BV 号或本机路径';
        return;
      }
      if (songOverride) songIn.value = songOverride;
      const args = {
        song,
        mode: modeSel.value,
        to: toIn.value.trim() || 'local',
        order: orderSel.value,
        refresh: refreshChk.checked,
      };
      const st = Number(startIn.value);
      const du = Number(durIn.value);
      if (startIn.value !== '' && Number.isFinite(st) && st > 0) args.start = st;
      if (durIn.value !== '' && Number.isFinite(du) && du > 0) args.duration = du;
      const pRaw = pitchIn.value.trim();
      if (pRaw) args.pitch = pRaw.toLowerCase() === 'auto' ? 'auto' : Number(pRaw);
      if (reverbSel.value) args.reverb = reverbSel.value;
      if (harmSel.value) args.harmony = harmSel.value;
      if (polishSel.value === 'on') args.polish = true;
      if (polishSel.value === 'off') args.polish = false;
      if (sepSel.value) args.separator = sepSel.value;
      if (derevSel.value === 'on') args.dereverb = true;
      if (derevSel.value === 'off') args.dereverb = false;
      if (f0Sel.value) args.f0Method = f0Sel.value;
      if (dynSel.value) args.dynamicStyle = dynSel.value;
      if (asyncSel.value === 'sync') args.async = false;
      if (asyncSel.value === 'async') args.async = true;

      singBtn.disabled = true;
      simMsg.className = 'dbg-msg';
      simMsg.textContent = '处理中（下载 / 分离 / 换声 / 混音），请观察下方实时进度…';
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => void refreshStatus(), 1500);
      void refreshStatus();
      try {
        const r = await api('/api/tool', { name: 'fish_sing', args });
        simMsg.className = 'dbg-msg ok';
        simMsg.textContent = String(r.result || '完成');
      } catch (e) {
        simMsg.className = 'dbg-msg bad';
        simMsg.textContent = '失败：' + (e.message || e);
      } finally {
        singBtn.disabled = false;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        void refreshStatus();
      }
    };

    searchBtn.onclick = async () => {
      const kw = songIn.value.trim();
      if (!kw) {
        simMsg.className = 'dbg-msg bad';
        simMsg.textContent = '先输入要搜索的歌名或关键词';
        return;
      }
      searchBtn.disabled = true;
      simMsg.className = 'dbg-msg';
      simMsg.textContent = '正在 B 站搜索…';
      hitsBox.replaceChildren();
      try {
        const r = await api('/api/bili-search', { keyword: kw, order: orderSel.value });
        const hits = r.hits || [];
        if (!hits.length) {
          simMsg.className = 'dbg-msg bad';
          simMsg.textContent = 'B 站没搜到相关结果，换个关键词试试';
          return;
        }
        simMsg.className = 'dbg-msg ok';
        simMsg.textContent = '搜到 ' + hits.length + ' 条候选，点「选这条唱」即可按该 BV 拉取并试唱（想只试听一段可先填上面的起始秒/时长）';
        const tbl = document.createElement('table');
        tbl.className = 'dbg-tbl';
        tbl.innerHTML = '<thead><tr><th>#</th><th>标题</th><th>时长</th><th>UP 主</th><th>播放</th><th>BV 号</th><th>打分</th><th>操作</th></tr></thead>';
        const tb = document.createElement('tbody');
        hits.forEach((h, i) => {
          const tr = document.createElement('tr');
          const wan = h.play >= 10000 ? (h.play / 10000).toFixed(1) + '万' : String(h.play);
          const tdAct = document.createElement('td');
          const pickBtn = document.createElement('button');
          pickBtn.className = 'tab active';
          pickBtn.textContent = '选这条唱';
          pickBtn.onclick = () => void runSing(h.bvid);
          const fillBtn = document.createElement('button');
          fillBtn.className = 'tab';
          fillBtn.style.marginLeft = '4px';
          fillBtn.textContent = '填 BV';
          fillBtn.onclick = () => { songIn.value = h.bvid; songIn.focus(); };
          tdAct.append(pickBtn, fillBtn);
          tr.innerHTML = '<td>' + (i + 1) + '</td><td></td><td>' + fmtDur(h.durationSec) + '</td><td></td><td>'
            + wan + '</td><td style="font-family:ui-monospace,Consolas,monospace">' + h.bvid + '</td><td>' + (h.score ?? '') + '</td>';
          tr.children[1].textContent = h.title;
          tr.children[3].textContent = h.author;
          tr.append(tdAct);
          tb.append(tr);
        });
        tbl.append(tb);
        hitsBox.append(tbl);
      } catch (e) {
        simMsg.className = 'dbg-msg bad';
        simMsg.textContent = '搜索失败：' + (e.message || e);
      } finally {
        searchBtn.disabled = false;
      }
    };

    singBtn.onclick = () => void runSing();
    stopBtn.onclick = async () => {
      stopBtn.disabled = true;
      try {
        const r = await api('/api/tool', { name: 'fish_sing_stop', args: {} });
        simMsg.className = 'dbg-msg';
        simMsg.textContent = String(r.result || '已停止');
      } catch (e) {
        simMsg.className = 'dbg-msg bad';
        simMsg.textContent = '停止失败：' + (e.message || e);
      } finally {
        stopBtn.disabled = false;
        void refreshStatus();
      }
    };
    unloadBtn.onclick = async () => {
      unloadBtn.disabled = true;
      try {
        const r = await api('/api/unload', {});
        simMsg.className = 'dbg-msg ok';
        simMsg.textContent = String(r.message || '已释放显存');
      } catch (e) {
        simMsg.className = 'dbg-msg bad';
        simMsg.textContent = '释放失败：' + (e.message || e);
      } finally {
        unloadBtn.disabled = false;
        void refreshStatus();
      }
    };
    songIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void searchBtn.onclick();
    });

    // ---- 1b. 歌词时间轴、声学体检 & 局部返工补录 ----
    const patchCard = document.createElement('div');
    patchCard.className = 'dbg-card';
    patchCard.innerHTML = '<h3>歌词时间轴 / 声学体检 &amp; 局部返工（fish_sing_lyrics / fish_sing_patch）</h3>';
    const pRow1 = document.createElement('div');
    pRow1.className = 'dbg-bar';
    const lyrBtn = document.createElement('button');
    lyrBtn.className = 'tab';
    lyrBtn.textContent = '刷新歌词与体检';
    const pLinesIn = document.createElement('input');
    pLinesIn.className = 'dbg-in sm';
    pLinesIn.placeholder = '如 7-9';
    const pLyrIn = document.createElement('input');
    pLyrIn.className = 'dbg-in';
    pLyrIn.style.width = '120px';
    pLyrIn.placeholder = '歌词关键词';
    const pSecSel = document.createElement('select');
    pSecSel.className = 'tab';
    for (const [v, t] of [['', '按句号/秒'], ['chorus', '第1段副歌'], ['current', '当前正唱这句']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      pSecSel.append(o);
    }
    const pProtIn = document.createElement('input');
    pProtIn.className = 'dbg-in sm';
    pProtIn.type = 'number';
    pProtIn.step = '0.02';
    pProtIn.placeholder = 'protect';
    const pIdxIn = document.createElement('input');
    pIdxIn.className = 'dbg-in sm';
    pIdxIn.type = 'number';
    pIdxIn.step = '0.05';
    pIdxIn.placeholder = 'indexRate';
    const pModelIn = document.createElement('input');
    pModelIn.className = 'dbg-in';
    pModelIn.style.width = '110px';
    pModelIn.placeholder = '临时换模型(选填)';
    const pPrevChk = document.createElement('input');
    pPrevChk.type = 'checkbox';
    pPrevChk.checked = true;
    const pPrevLbl = document.createElement('label');
    pPrevLbl.className = 'dbg-meta';
    pPrevLbl.style.display = 'inline-flex';
    pPrevLbl.style.alignItems = 'center';
    pPrevLbl.style.gap = '4px';
    pPrevLbl.append(pPrevChk, document.createTextNode('仅试听这句'));
    const patchBtn = document.createElement('button');
    patchBtn.className = 'tab active';
    patchBtn.textContent = '局部返工补录';
    pRow1.append(
      lyrBtn,
      mkF('定位方式', pSecSel),
      mkF('句号', pLinesIn),
      mkF('关键词', pLyrIn),
      mkF('protect', pProtIn),
      mkF('indexRate', pIdxIn),
      mkF('换模型', pModelIn),
      pPrevLbl,
      patchBtn,
    );
    const patchMsg = document.createElement('div');
    patchMsg.className = 'dbg-msg';
    const lyrPre = document.createElement('pre');
    lyrPre.className = 'dbg-pre';
    lyrPre.textContent = '点「刷新歌词与体检」查看最近一首歌的时间轴歌词、副歌区间与声学体检明细';
    patchCard.append(pRow1, patchMsg, lyrPre);

    const loadLyrics = async () => {
      try {
        const r = await api('/api/tool', { name: 'fish_sing_lyrics', args: { fromLine: 1, limit: 60 } });
        lyrPre.textContent = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
      } catch (e) {
        lyrPre.textContent = '读取失败：' + (e.message || e);
      }
    };
    lyrBtn.onclick = () => void loadLyrics();
    patchBtn.onclick = async () => {
      const args = { previewOnly: pPrevChk.checked, to: 'local' };
      if (pSecSel.value === 'chorus') args.section = 'chorus';
      else if (pSecSel.value === 'current') args.atCurrent = true;
      else {
        if (pLinesIn.value.trim()) args.lines = pLinesIn.value.trim();
        if (pLyrIn.value.trim()) args.lyric = pLyrIn.value.trim();
      }
      if (pProtIn.value !== '') args.protect = Number(pProtIn.value);
      if (pIdxIn.value !== '') args.indexRate = Number(pIdxIn.value);
      if (pModelIn.value.trim()) args.model = pModelIn.value.trim();
      patchBtn.disabled = true;
      patchMsg.className = 'dbg-msg';
      patchMsg.textContent = '局部返工换声中（仅重跑目标句，约 3~6 秒）…';
      try {
        const r = await api('/api/tool', { name: 'fish_sing_patch', args });
        patchMsg.className = 'dbg-msg ok';
        patchMsg.textContent = String(r.result || '完成');
      } catch (e) {
        patchMsg.className = 'dbg-msg bad';
        patchMsg.textContent = '失败：' + (e.message || e);
      } finally {
        patchBtn.disabled = false;
        void refreshStatus();
      }
    };

    // ---- 2. 原始工具调用 + 状态/日志/事件 ----
    const grid = document.createElement('div');
    grid.className = 'dbg-grid';

    const toolCard = document.createElement('div');
    toolCard.className = 'dbg-card';
    toolCard.innerHTML = '<h3>原始工具调用（world.tools）</h3>';
    const sel = document.createElement('select');
    sel.className = 'tab';
    for (const t of data.tools) {
      const o = document.createElement('option');
      o.value = t.name;
      o.textContent = t.name;
      sel.append(o);
    }
    const presets = {
      fish_sing: { song: '晴天 女声翻唱', search: true, order: 'click' },
      fish_sing_patch: { lines: '7-8', protect: 0.42, previewOnly: true },
      fish_sing_lyrics: { fromLine: 1, limit: 45 },
      fish_sing_stop: {},
      fish_sing_library: { action: 'list', limit: 10 },
      fish_sing_status: {},
    };
    const ta = document.createElement('textarea');
    ta.className = 'dbg-ta';
    ta.value = JSON.stringify(presets[sel.value] || {}, null, 2);
    sel.onchange = () => {
      ta.value = JSON.stringify(presets[sel.value] || {}, null, 2);
    };
    const runBtn = document.createElement('button');
    runBtn.className = 'tab active';
    runBtn.textContent = '执行工具';
    const out = document.createElement('pre');
    out.className = 'dbg-pre';
    out.textContent = '结果将显示在这里';
    runBtn.onclick = async () => {
      runBtn.disabled = true;
      out.textContent = '执行中…';
      try {
        const args = JSON.parse(ta.value || '{}');
        const r = await api('/api/tool', { name: sel.value, args });
        out.textContent = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
      } catch (e) {
        out.textContent = '错误：' + (e.message || e);
      } finally {
        runBtn.disabled = false;
      }
    };
    const bar = document.createElement('div');
    bar.className = 'dbg-bar';
    bar.append(sel, runBtn);
    const quickBar = document.createElement('div');
    quickBar.className = 'dbg-bar';
    for (const [label, name, sample] of [
      ['模板: B站搜歌', 'fish_sing', { song: '我不难过 孙燕姿', search: true, order: 'default' }],
      ['模板: BV唱30秒', 'fish_sing', { song: 'BV1xx411c7mD', start: 60, duration: 30, to: 'local', pitch: 'auto' }],
      ['模板: 作品库', 'fish_sing_library', { action: 'list', limit: 10 }],
    ]) {
      const b = document.createElement('button');
      b.className = 'tab';
      b.textContent = label;
      b.onclick = () => {
        sel.value = name;
        ta.value = JSON.stringify(sample, null, 2);
      };
      quickBar.append(b);
    }
    toolCard.append(bar, quickBar, ta, out);

    const envCard = document.createElement('div');
    envCard.className = 'dbg-card';
    envCard.innerHTML = '<h3>环境提示词变量 &amp; 信息</h3>';
    const envPre = document.createElement('pre');
    envPre.className = 'dbg-pre';
    envPre.textContent = JSON.stringify({
      mode: data.mode,
      dataDir: data.dataDir,
      workerPort: data.workerPort,
      autoStart: data.autoStart,
      envPromptVars: data.envVars,
    }, null, 2);
    envCard.append(envPre);

    const logCard = document.createElement('div');
    logCard.className = 'dbg-card';
    const logHead = document.createElement('h3');
    logHead.textContent = '最近日志';
    const logRefresh = document.createElement('button');
    logRefresh.className = 'tab';
    logRefresh.textContent = '刷新日志';
    logHead.append(logRefresh);
    const logPre = document.createElement('pre');
    logPre.className = 'dbg-pre';
    logPre.textContent = (data.logs || []).join('\\n') || '（暂无日志）';
    logRefresh.onclick = async () => {
      const m = await api('/api/meta');
      logPre.textContent = (m.logs || []).join('\\n') || '（暂无日志）';
      evtPre.textContent = m.events && m.events.length
        ? JSON.stringify(m.events, null, 2)
        : '（暂无事件；可去「安装与运行时」点「测试通知」观察）';
    };
    logCard.append(logHead, logPre);

    const evtCard = document.createElement('div');
    evtCard.className = 'dbg-card';
    evtCard.innerHTML = '<h3>pushEvent 事件流</h3>';
    const evtPre = document.createElement('pre');
    evtPre.className = 'dbg-pre';
    evtPre.textContent = data.events && data.events.length
      ? JSON.stringify(data.events, null, 2)
      : '（暂无事件；可去「安装与运行时」点「测试通知」观察）';
    evtCard.append(evtPre);

    grid.append(toolCard, envCard, logCard, evtCard);
    wrap.append(simCard, patchCard, grid);
    root.append(wrap);
    void refreshStatus();

    return {
      dispose() {
        if (pollTimer) clearInterval(pollTimer);
      },
    };
  }

  async function openTab(id) {
    if (currentDispose) {
      try { currentDispose(); } catch {}
      currentDispose = null;
    }
    currentId = id;
    localStorage.setItem('fs-dev-tab', id);
    renderTabs();
    slotEl.className = 'panelslot';
    slotEl.replaceChildren();

    if (id === '__config') {
      const h = await mountConfig(slotEl);
      currentDispose = h?.dispose || null;
      return;
    }
    if (id === '__debug') {
      const h = await mountDebug(slotEl);
      currentDispose = h?.dispose || null;
      return;
    }

    // 每次加时间戳破除 ES module 缓存，改完 dist/webui.js 点热重载或 F5 即生效
    const mod = await import('/webui.js?t=' + Date.now());
    const panel = mod.default?.panels?.[id];
    if (!panel) {
      slotEl.textContent = 'dist/webui.js 中未找到面板：' + id;
      return;
    }
    const handle = panel.mount({
      root: slotEl,
      invoke: async (method, args = []) => {
        const res = await api('/api/invoke', { panel: id, method, args });
        return res.result;
      },
    });
    currentDispose = handle?.dispose || null;
  }

  themeBtn.onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    themeBtn.textContent = next === 'dark' ? '切亮色' : '切暗色';
  };
  reloadBtn.onclick = () => void openTab(currentId);

  meta = await api('/api/meta');
  badgeEl.textContent = meta.mode + ' · worker:' + meta.workerPort + (meta.autoStart ? ' (自动拉起)' : ' (不抢启)');
  const valid = new Set([...(meta.panels || []).map((p) => p.id), '__config', '__debug']);
  if (!valid.has(currentId)) currentId = '__debug';
  await openTab(currentId);
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/') {
      const body = Buffer.from(HTML, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/webui.js') {
      const code = readFileSync(WEBUI_JS);
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(code.length),
        'Cache-Control': 'no-store',
      });
      res.end(code);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/meta') {
      const curDecl = world.webUi('zh');
      json(res, 200, {
        ok: true,
        mode: modeLabel,
        dataDir: join(dataRoot, definition.id),
        workerPort: cfg.worker.port,
        autoStart: cfg.worker.autoStart,
        panels: (curDecl.panels || []).map((p) => ({ id: p.id, title: p.title })),
        tools: world.tools().map((t) => ({ name: t.name, description: t.description })),
        envVars: world.envPromptVars(),
        events,
        logs,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const groups = world.webUi('zh').config || [];
      const values = {};
      for (const g of groups) {
        for (const key of Object.keys(g.schema?.properties || {})) {
          values[key] = getCfgByKey(cfg, key);
        }
      }
      json(res, 200, { ok: true, groups, values, useSandbox, saveConfigPath });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const patch = body.patch || {};
      for (const [k, v] of Object.entries(patch)) {
        setCfgByKey(cfg, k, v);
      }
      if (body.persist && saveConfigPath) {
        const rootObj = existsSync(saveConfigPath)
          ? JSON.parse(readFileSync(saveConfigPath, 'utf8'))
          : {};
        rootObj.worlds = rootObj.worlds || {};
        rootObj.worlds[definition.id] = structuredClone(cfg);
        writeFileSync(saveConfigPath, `${JSON.stringify(rootObj, null, 2)}\n`, 'utf8');
        pushLog('info', `已将配置写入 ${saveConfigPath}`);
        json(res, 200, { ok: true, message: `已热更新并写入 ${saveConfigPath}` });
        return;
      }
      pushLog('info', '已更新内存配置（热更新生效，未改磁盘 config.json）');
      json(res, 200, { ok: true, message: '已应用到内存（所有热更新项立即生效，未改磁盘 config.json）' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/bili-search') {
      const body = await readBody(req);
      const keyword = String(body.keyword || '').trim();
      const order = body.order === 'click' || body.order === 'pubdate' ? body.order : 'default';
      if (!keyword) throw new Error('没给搜索关键词');
      const rawHits = await searchBili(keyword, 20, order);
      const maxDur = Number(cfg.song?.maxDurationSec ?? 480);
      const pool = rawHits.filter((h) => h.durationSec >= 20 && h.durationSec <= maxDur);
      const ranked = rankHits(pool.length ? pool : rawHits, keyword, String(cfg.song?.excludeWords ?? '')).slice(0, 12);
      json(res, 200, { ok: true, hits: ranked });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/invoke') {
      const body = await readBody(req);
      const panel = String(body.panel || '');
      const method = String(body.method || '');
      const args = Array.isArray(body.args) ? body.args : [];
      if (!decl.invoke) throw new Error('World 未声明面板 invoke');
      const result = await decl.invoke(panel, method, args);
      json(res, 200, { ok: true, result });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/tool') {
      const body = await readBody(req);
      const name = String(body.name || '');
      const tool = world.tools().find((t) => t.name === name);
      if (!tool) throw new Error(`未找到工具：${name}`);
      const result = await tool.handler(body.args || {});
      json(res, 200, { ok: true, result });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/unload') {
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.worker?.token) headers.Authorization = `Bearer ${cfg.worker.token}`;
      const r = await fetch(`http://127.0.0.1:${cfg.worker.port}/unload`, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
      json(res, r.status, data);
      return;
    }
    json(res, 404, { ok: false, error: '未知路径' });
  } catch (e) {
    json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log(`✓ fish-sing 本地调试宿主已启动：http://127.0.0.1:${port}`);
  console.log(`  模式：${modeLabel}`);
  console.log(`  数据目录：${join(dataRoot, definition.id)}`);
  console.log(`  Worker 端口：${cfg.worker.port}（autoStart=${cfg.worker.autoStart}）`);
  console.log('  改 dist/webui.js → 点页面「热重载面板」或 F5 立即生效');
  console.log('  改 src/*.ts      → Ctrl+C 重跑本脚本即可，无需重启 Coopanion');
  console.log('');
});

async function shutdown() {
  console.log('\n[dev-host] 正在关闭…');
  await world.stop().catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
