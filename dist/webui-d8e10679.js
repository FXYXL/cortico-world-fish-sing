/**
 * 作品库面板（前端）。
 *
 * 为什么是手写的普通 JS 而不是 TS + 打包：这个面板只有一张表 + 五个动作，
 * 引入一套构建链（vite/tsc + 产物校验）比面板本身还复杂。Coo 只要求
 * `export default { panels: { <id>: { mount(ctx) } } }`，纯 ESM 就能满足。
 *
 * 数据全部来自服务端 `invoke('library', 'list' | 'play' | ...)`，
 * 前端不碰文件系统，也不知道文件在哪。
 */

const STYLE_ID = 'fish-sing-style';
const CSS = `
.fs-wrap{display:flex;flex-direction:column;gap:10px;width:100%;min-width:0;box-sizing:border-box;flex:1 1 auto;align-self:stretch;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
/* 宽度交给宿主：.panelslot > :where(...) 已经给了 width:100% + max-width:var(--content-width)=1120px。
   自己再写 max-width（比如 980px）会把宿主规则覆盖掉，看起来"没占满"；写 none 又会被 overflow 裁掉。
   这里只补 box-sizing——根元素带 padding 时不加它会把盒子撑出容器，内容往左溢出（dev-guide 里点名的坑）。 */
.fs-wrap *{box-sizing:border-box}
.fs-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fs-bar .fs-grow{flex:1}
.fs-btn{appearance:none;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;
  border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.fs-btn:hover{background:rgba(127,127,127,.12)}
.fs-btn:disabled{opacity:.4;cursor:default}
select.fs-btn{appearance:auto;-webkit-appearance:menulist;padding:4px 8px;max-width:560px;background-color:var(--bg-sub,Canvas);color:var(--fg,CanvasText)}
.fs-wrap select option,.fs-wrap select optgroup{background-color:var(--bg-sub,Canvas);color:var(--fg,CanvasText)}
.fs-btn.danger{border-color:rgba(220,80,80,.5);color:#d05555}
.fs-input{flex:0 0 200px;padding:4px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.35);
  background:transparent;color:inherit;font-size:12px}
.fs-meta{opacity:.65;font-size:12px}
.fs-msg{min-height:18px;font-size:12px;opacity:.8}
.fs-msg.bad{color:#d05555;opacity:1}
.fs-table{width:100%;border-collapse:collapse;font-size:12.5px}
.fs-table th,.fs-table td{padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.18);text-align:left;vertical-align:middle}
.fs-table th{font-weight:600;opacity:.75;cursor:pointer;user-select:none;white-space:nowrap}
.fs-table th:hover{opacity:1}
.fs-table tbody tr:hover{background:rgba(127,127,127,.07)}
.fs-table tr.playing{background:rgba(80,160,255,.12)}
.fs-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.fs-title{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-acts{display:flex;gap:6px;white-space:nowrap}
.fs-empty{padding:24px;text-align:center;opacity:.6}
.fs-tag{display:inline-block;padding:0 6px;border-radius:4px;background:rgba(127,127,127,.16);
  font-size:11px;margin-left:6px;opacity:.9}
.fs-edit{width:100%;padding:2px 6px;border-radius:4px;border:1px solid rgba(127,127,127,.4);
  background:transparent;color:inherit;font-size:12.5px}
.fs-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.fs-card{border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:8px 10px}
.fs-card .k{font-size:11px;opacity:.6}
.fs-card .v{font-size:13.5px;margin-top:2px;font-weight:600}
.fs-card.ok .v{color:#3fae62}
.fs-card.bad .v{color:#d05555}
.fs-prog{height:8px;border-radius:5px;background:rgba(127,127,127,.2);overflow:hidden}
.fs-prog>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#4a90e2,#5ac8a8);transition:width .3s}
.fs-list{display:flex;flex-direction:column;gap:2px}
.fs-row{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:4px 0;
  border-bottom:1px solid rgba(127,127,127,.12)}
.fs-row .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-row .r{white-space:nowrap;font-variant-numeric:tabular-nums}
.fs-ok{color:#3fae62}
.fs-bad{color:#d05555}
.fs-warn{color:#c9962f}
.fs-hint{font-size:12px;opacity:.65;line-height:1.7;white-space:pre-line}
.fs-mhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fs-impbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;
  border:1px solid rgba(127,127,127,.22);border-radius:8px;background:rgba(127,127,127,.04)}
.fs-mtable{width:100%;border-collapse:collapse;font-size:12.5px}
.fs-mtable th,.fs-mtable td{padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.18);
  text-align:left;vertical-align:middle}
.fs-mtable th{font-weight:600;opacity:.75;white-space:nowrap}
.fs-mtable tbody tr:hover{background:rgba(127,127,127,.07)}
.fs-mtable tr.on{background:rgba(80,160,255,.12)}
.fs-dot{color:#3fae62;font-weight:700}
.fs-mname{font-family:ui-monospace,Consolas,monospace;font-size:12px;max-width:180px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle}
.fs-tagx{display:inline-block;padding:0 5px;border-radius:4px;background:rgba(127,127,127,.16);
  font-size:11px;margin-left:6px}
/* 分步折叠：新用户只看得到当前该做什么，老手展开就有全部东西。
   注意：这三块是 .panelslot 的直接子元素，宿主靠 margin-right/left:auto 把它们居中；
   这里只能写 margin-block，写 margin:10px 0 会把左右 auto 覆盖成 0，整块就贴左了
   （0.4.19 之前的真实症状：进度条居中、三块贴左）。 */
.fs-sec{margin-block:6px;border:1px solid rgba(127,127,127,.22);border-radius:10px;
  background:rgba(127,127,127,.035);overflow:hidden}
.fs-sec>summary{cursor:pointer;padding:9px 12px;font-size:13px;font-weight:600;
  display:flex;align-items:center;gap:8px;list-style:none;user-select:none}
.fs-sec>summary::-webkit-details-marker{display:none}
.fs-sec>summary::before{content:"▸";opacity:.55;font-size:11px;transition:transform .12s}
.fs-sec[open]>summary::before{transform:rotate(90deg)}
.fs-sec>summary:hover{background:rgba(127,127,127,.07)}
.fs-sec-hint{font-weight:400;font-size:11.5px;opacity:.55}
.fs-sec-body{display:flex;flex-direction:column;gap:8px;padding:6px 12px 12px}
.fs-tpath{flex:1;min-width:260px;padding:5px 8px;border-radius:6px;
  border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:12.5px}
.fs-tsum{font-size:12.5px;line-height:1.7}
.fs-hist{display:flex;align-items:flex-end;gap:2px;height:96px;padding:4px 0;
  border-bottom:1px solid rgba(127,127,127,.25)}
.fs-hist .bar{flex:1;min-width:3px;background:#5b8dd6;border-radius:2px 2px 0 0;position:relative}
.fs-hist .bar.peak{background:#1D9E75}
.fs-haxis{display:flex;justify-content:space-between;font-size:11px;opacity:.6;margin-top:3px}
.fs-bandrow{display:flex;gap:6px;flex-wrap:wrap;font-size:12px}
.fs-band{padding:3px 8px;border-radius:5px;background:rgba(127,127,127,.14)}
.fs-file{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-ck{width:14px;height:14px;cursor:pointer;vertical-align:middle;margin-right:4px}
.fs-card2{border:1px solid rgba(127,127,127,.22);border-radius:8px;padding:8px 10px;font-size:12px}
.fs-wtitle{font-size:13px;font-weight:600;opacity:.85}
.fs-wmodes{display:flex;gap:4px}
.fs-btn.on{border-color:#378ADD;color:#378ADD;background:rgba(55,138,221,.10)}
.fs-wpresets{display:flex;gap:6px;flex-wrap:wrap}
.fs-wrow{display:grid;grid-template-columns:110px 96px 108px 1fr 44px;align-items:center;gap:10px;
  font-size:12.5px;padding:5px 0;border-bottom:1px solid rgba(127,127,127,.12)}
.fs-wname{opacity:.85}
.fs-wmeta{opacity:.55;font-size:11.5px}
.fs-wshift{font-variant-numeric:tabular-nums;font-size:12px}
.fs-wshift.up{color:#1D9E75}
.fs-wshift.down{color:#c9962f}
.fs-wshift.same{opacity:.55}
.fs-wrange{width:100%;accent-color:#378ADD}
.fs-wtimes{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.fs-tform{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.fs-field{display:flex;flex-direction:column;gap:3px}
.fs-flabel{font-size:11px;opacity:.6}
.fs-tin{padding:4px 7px;border-radius:6px;border:1px solid rgba(127,127,127,.35);
  background:transparent;color:inherit;font-size:12.5px;width:110px}
.fs-eval{display:flex;flex-direction:column;gap:6px;padding:8px 10px;
  border:1px solid rgba(127,127,127,.2);border-radius:8px;background:rgba(127,127,127,.03)}
.fs-eval-row{display:grid;grid-template-columns:44px 1fr;align-items:center;gap:8px}
.fs-eval-in{width:100%;min-width:0;padding:4px 8px;border-radius:6px;
  border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:12px}
.fs-augbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:8px;
  border-bottom:1px solid rgba(127,127,127,.16)}
.fs-loss{display:flex;align-items:flex-end;gap:1px;height:60px;padding-top:6px}
.fs-lbar{flex:1;min-width:2px;background:#5b8dd6;border-radius:1px 1px 0 0;opacity:.85}
.fs-card2 .k{opacity:.6;font-size:11px}
.fs-card2 .v{font-size:15px;font-weight:600;margin-top:1px}
.fs-pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Consolas,monospace;
  max-height:260px;overflow:auto;padding:8px;border-radius:6px;background:rgba(127,127,127,.08)}
.fs-sgrid{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.fs-sin-sm{width:76px;padding:4px 7px;border-radius:6px;border:1px solid rgba(127,127,127,.35);
  background:transparent;color:inherit;font-size:12px}
.fs-qual-low{color:#d05555;font-weight:600}
.fs-lyr-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px}
.fs-lyr-list{max-height:280px;overflow:auto;border-radius:6px;background:rgba(127,127,127,.06);padding:4px 6px;display:flex;flex-direction:column;gap:2px}
.fs-lyr-item{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:5px;cursor:pointer;font-size:12.5px}
.fs-lyr-item:hover{background:rgba(127,127,127,.14)}
.fs-lyr-item.now{background:rgba(80,160,255,.18);font-weight:600}
.fs-lyr-idx{width:24px;text-align:right;opacity:.55;font-variant-numeric:tabular-nums;flex:0 0 auto}
.fs-lyr-tm{width:78px;opacity:.65;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;flex:0 0 auto}
.fs-lyr-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-lyr-ch{padding:0 5px;border-radius:4px;background:rgba(55,138,221,.18);color:#378ADD;font-size:11px;flex:0 0 auto}
.fs-tscroll{width:100%;overflow-x:auto;border:1px solid rgba(127,127,127,.16);border-radius:8px}
.fs-tscroll .fs-table{min-width:860px}
.fs-table th.fs-sticky,.fs-table td.fs-sticky{position:sticky;right:0;z-index:2;
  background:var(--bg,Canvas);border-left:1px solid rgba(127,127,127,.18);box-shadow:-6px 0 10px rgba(0,0,0,.08)}
.fs-table tr.playing td.fs-sticky{background:color-mix(in srgb,var(--bg,Canvas) 86%,#50a0ff 14%)}
.fs-table tbody tr:hover td.fs-sticky{background:color-mix(in srgb,var(--bg,Canvas) 92%,currentColor 8%)}
.fs-pager{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:8px;font-size:12px}
.fs-pager-g{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
`;

function ensureStyle() {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtTime(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function mount(ctx) {
  ensureStyle();

  const root = ctx.root;
  root.classList.add('fs-wrap');

  // ---- 工具栏
  const bar = el('div', 'fs-bar');
  const refresh = el('button', 'fs-btn', '刷新');
  const stop = el('button', 'fs-btn', '停止播放');
  const reveal = el('button', 'fs-btn', '打开目录');
  const favOnlyBtn = el('button', 'fs-btn', '⭐ 拿手曲');
  const search = el('input', 'fs-input');
  search.placeholder = '按标题、模型或标签过滤…';
  const meta = el('span', 'fs-meta');
  bar.append(refresh, stop, reveal, favOnlyBtn, el('span', 'fs-grow'), search, meta);

  const msg = el('div', 'fs-msg');
  const qqBar = el('div', 'fs-impbar');
  qqBar.style.display = 'none';
  const qqTitle = el('span', 'fs-meta', '');
  const qqIn = el('input', 'fs-eval-in');
  qqIn.style.maxWidth = '240px';
  qqIn.placeholder = 'group:群号 或 private:QQ号';
  const qqSendOk = el('button', 'fs-btn', '确认发送');
  const qqSendCancel = el('button', 'fs-btn', '取消');
  qqBar.append(qqTitle, qqIn, qqSendOk, qqSendCancel);
  const box = el('div', '');

  root.append(bar, qqBar, msg, box);

  let items = [];
  let sortKey = 'at';
  let sortAsc = false;
  let filter = '';
  let favOnly = false;
  let page = 1;
  let pageSize = 10;
  let playingId = '';
  let qqEnabled = false;
  let defaultQqTarget = '';
  let currentModel = '';
  let pendingQqItem = null;
  let timer = null;

  const say = (text, bad) => {
    msg.textContent = text || '';
    msg.classList.toggle('bad', Boolean(bad));
  };

  const call = async (method, args) => {
    try {
      const res = await ctx.invoke(method, args || []);
      if (res && typeof res === 'object' && typeof res.text === 'string') say(res.text);
      return res;
    } catch (err) {
      say(err && err.message ? err.message : String(err), true);
      throw err;
    }
  };

  const load = async () => {
    try {
      const data = await ctx.invoke('list', []);
      items = Array.isArray(data && data.items) ? data.items : [];
      playingId = (data && data.playing) || '';
      qqEnabled = Boolean(data && data.qqEnabled);
      defaultQqTarget = String((data && data.defaultQqTarget) || '');
      currentModel = String((data && data.currentModel) || '');
      stop.disabled = !playingId;
      const n = items.length;
      const fn = Number((data && data.favCount) || 0);
      favOnlyBtn.textContent = fn ? `⭐ 拿手曲 (${fn})` : '⭐ 拿手曲';
      favOnlyBtn.classList.toggle('on', favOnly);
      meta.textContent = n
        ? `共 ${n} 首 · ${data.totalMb || 0} MB · ${data.playingEnabled === false ? '本机播放已关' : ''}`
        : '还一首都没唱过';
      render();
      schedulePoll();
    } catch {
      /* say() 已经提示过了 */
    }
  };

  /** 有在播的就每 2 秒对一次状态，播完自动取消高亮；没在播就不轮询。 */
  const schedulePoll = () => {
    if (timer) clearTimeout(timer);
    timer = playingId ? setTimeout(() => void load(), 2000) : null;
  };

  const sorted = () => {
    let rows = favOnly ? items.filter((r) => r.isFav) : items.slice();
    if (filter) {
      rows = rows.filter((r) => String(r.title).toLowerCase().includes(filter)
        || String(r.model || '').toLowerCase().includes(filter)
        || String(r.duetModel || '').toLowerCase().includes(filter)
        || (Array.isArray(r.favTags) && r.favTags.some((t) => String(t).toLowerCase().includes(filter))));
    }
    rows.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'zh-CN');
      return sortAsc ? cmp : -cmp;
    });
    return rows;
  };

  const header = (table) => {
    const tr = el('tr');
    const cols = [
      ['title', '标题'],
      ['durationSec', '时长'],
      ['pitch', '音高'],
      ['mode', '模式'],
      ['model', '模型'],
      ['sizeMb', '大小'],
      ['at', '时间'],
      ['', '操作'],
    ];
    for (const [key, label] of cols) {
      const th = el('th', key ? '' : 'fs-sticky', label);
      if (key) {
        th.title = '点一下按这列排序';
        th.addEventListener('click', () => {
          if (sortKey === key) sortAsc = !sortAsc;
          else {
            sortKey = key;
            sortAsc = key !== 'at';
          }
          page = 1;
          render();
        });
      }
      tr.append(th);
    }
    const thead = el('thead');
    thead.append(tr);
    table.append(thead);
  };

  const rowOf = (r) => {
    const tr = el('tr');
    if (playingId && `${r.id}.mp3` === playingId) tr.classList.add('playing');

    const tdTitle = el('td', 'fs-title');
    const titleSpan = el('span', '', r.title || '(无标题)');
    titleSpan.title = `${r.title}\n${r.bvid || ''}${r.favNote ? `\n心得：${r.favNote}` : ''}`;
    tdTitle.append(titleSpan);
    if (r.isFav) {
      const favTag = el('span', 'fs-tag', r.favTags && r.favTags.length ? `⭐ ${r.favTags.join('/')}` : '⭐ 拿手');
      favTag.style.color = '#c9962f';
      tdTitle.append(favTag);
    }
    if (r.missing) tdTitle.append(el('span', 'fs-tag', '文件缺失'));
    if (r.target) tdTitle.append(el('span', 'fs-tag', r.target));

    const modelTd = el('td', '');
    const modelText = r.duetModel ? `${r.model || '—'} + ${r.duetModel}` : (r.model || '—');
    const modelSpan = el('span', 'fs-mname', modelText);
    modelSpan.style.maxWidth = '220px';
    modelSpan.title = r.duetModel
      ? `双音色合唱：${r.model || '默认'} + ${r.duetModel}（${r.duetMode === 'unison' ? '全程双声部合唱' : '主歌对唱+副歌合唱'}）${r.karaoke ? ' · 已去伴唱' : ''}`
      : `${r.model || '—'}${r.karaoke ? ' · 已去伴唱' : ''}`;
    modelTd.append(modelSpan);
    if (r.duetModel) {
      const dt = el('span', 'fs-tag', r.duetMode === 'unison' ? '合唱' : '对唱');
      dt.style.color = '#378ADD';
      modelTd.append(dt);
    }

    tr.append(
      tdTitle,
      el('td', 'fs-num', fmtDur(r.durationSec)),
      el('td', 'fs-num', r.pitch ? `${r.pitch > 0 ? '+' : ''}${r.pitch}` : '0'),
      el('td', '', r.mode === 'vocals' ? '清唱' : '带伴奏'),
      modelTd,
      el('td', 'fs-num', `${r.sizeMb} MB`),
      el('td', '', fmtTime(r.at)),
    );

    const acts = el('div', 'fs-acts');
    const play = el('button', 'fs-btn', '播放');
    play.addEventListener('click', async () => {
      play.disabled = true;
      try {
        await call('play', [r.id]);
        // 立刻把「正在播」落到本地状态：不然「停止播放」要等下一次轮询才可用
        playingId = `${r.id}.mp3`;
        stop.disabled = false;
        render();
        schedulePoll();
      } finally {
        play.disabled = false;
      }
    });
    const rename = el('button', 'fs-btn', '改名');
    rename.addEventListener('click', () => {
      // 就地编辑，不用 prompt（Electron 里 prompt 某些版本被禁用）
      const input = el('input', 'fs-edit');
      input.value = r.title;
      tdTitle.replaceChildren(input);
      input.focus();
      input.select();
      const finish = async (commit) => {
        if (commit) {
          const next = input.value.trim();
          if (next && next !== r.title) await call('rename', [r.id, next]);
          else say('标题没变');
        }
        await load();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void finish(true);
        if (e.key === 'Escape') void finish(false);
      });
      input.addEventListener('blur', () => void finish(false));
    });

    const del = el('button', 'fs-btn danger', '删除');
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = '确认删除？';
        setTimeout(() => {
          armed = false;
          del.textContent = '删除';
        }, 3000);
        return;
      }
      await call('delete', [r.id]);
      await load();
    });

    const sendQq = el('button', 'fs-btn', '发 QQ');
    sendQq.disabled = !qqEnabled || r.missing;
    sendQq.title = qqEnabled ? '将这条成品切条发送到 QQ 群或私聊' : '未配置 OneBot HTTP 地址';
    sendQq.addEventListener('click', () => {
      pendingQqItem = r;
      qqTitle.textContent = `发《${r.title}》到 QQ：`;
      if (!qqIn.value && defaultQqTarget) qqIn.value = defaultQqTarget;
      qqBar.style.display = 'flex';
      qqIn.focus();
    });

    const resing = el('button', 'fs-btn', '重唱');
    resing.disabled = !r.bvid && !r.source;
    resing.title = currentModel
      ? `用当前模型（${currentModel}）和当前配置重唱这首歌`
      : '用当前模型重唱这首歌';
    resing.addEventListener('click', async () => {
      resing.disabled = true;
      say(`正在用当前模型 ${currentModel || ''} 重唱《${r.title}》…`);
      try {
        await call('resing', [r.id]);
        await load();
      } finally {
        resing.disabled = false;
      }
    });

    const favBtn = el('button', `fs-btn${r.isFav ? ' on' : ''}`, r.isFav ? '★ 拿手' : '☆ 拿手');
    favBtn.title = r.isFav ? '已是拿手曲（点击取消星标）' : '设为拿手曲并记住这版的模型和参数配方';
    favBtn.addEventListener('click', async () => {
      favBtn.disabled = true;
      try {
        await call('favorite', [r.id]);
        await load();
      } finally {
        favBtn.disabled = false;
      }
    });

    acts.append(play, favBtn, sendQq, resing, rename, del);
    const tdActs = el('td', 'fs-sticky');
    tdActs.append(acts);
    tr.append(tdActs);
    return tr;
  };

  function render() {
    box.replaceChildren();
    const rows = sorted();
    if (!rows.length) {
      box.append(el('div', 'fs-empty', items.length ? '没有匹配的歌' : '还没有唱过歌'));
      return;
    }
    const total = rows.length;
    const effSize = pageSize > 0 ? pageSize : total;
    const totalPages = Math.max(1, Math.ceil(total / effSize));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    const startIdx = (page - 1) * effSize;
    const pageRows = rows.slice(startIdx, startIdx + effSize);

    const scroller = el('div', 'fs-tscroll');
    const table = el('table', 'fs-table');
    header(table);
    const tbody = el('tbody');
    for (const r of pageRows) tbody.append(rowOf(r));
    table.append(tbody);
    scroller.append(table);
    box.append(scroller);

    // 分页条
    const pager = el('div', 'fs-pager');
    const left = el('div', 'fs-pager-g');
    const fromN = startIdx + 1;
    const toN = Math.min(total, startIdx + pageRows.length);
    left.append(el('span', 'fs-meta', `显示第 ${fromN}–${toN} 条，共 ${total} 条（第 ${page} / ${totalPages} 页）`));

    const sizeSel = el('select', 'fs-btn');
    for (const [val, lbl] of [[10, '10 条/页'], [20, '20 条/页'], [50, '50 条/页'], [0, '全部']]) {
      const o = el('option', '', lbl);
      o.value = String(val);
      if (pageSize === val) o.selected = true;
      sizeSel.append(o);
    }
    sizeSel.addEventListener('change', () => {
      pageSize = Number(sizeSel.value) || 0;
      page = 1;
      render();
    });
    left.append(sizeSel);

    const right = el('div', 'fs-pager-g');
    const mkNav = (lbl, targetPage, disabled) => {
      const b = el('button', 'fs-btn', lbl);
      b.disabled = disabled;
      b.addEventListener('click', () => {
        page = targetPage;
        render();
      });
      return b;
    };
    right.append(
      mkNav('首页', 1, page <= 1),
      mkNav('上一页', page - 1, page <= 1),
      mkNav('下一页', page + 1, page >= totalPages),
      mkNav('末页', totalPages, page >= totalPages),
    );
    pager.append(left, right);
    box.append(pager);
  }

  const submitSendQq = async () => {
    if (!pendingQqItem) return;
    const target = String(qqIn.value || '').trim();
    if (!target) {
      say('请先填写 QQ 目标（group:群号 或 private:QQ号）', true);
      qqIn.focus();
      return;
    }
    qqSendOk.disabled = true;
    say(`正在将《${pendingQqItem.title}》发到 ${target}…`);
    try {
      await call('send', [pendingQqItem.id, target]);
      qqBar.style.display = 'none';
      pendingQqItem = null;
    } finally {
      qqSendOk.disabled = false;
    }
  };
  qqSendOk.addEventListener('click', () => void submitSendQq());
  qqSendCancel.addEventListener('click', () => {
    qqBar.style.display = 'none';
    pendingQqItem = null;
  });
  qqIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submitSendQq();
    if (e.key === 'Escape') {
      qqBar.style.display = 'none';
      pendingQqItem = null;
    }
  });

  favOnlyBtn.addEventListener('click', () => {
    favOnly = !favOnly;
    favOnlyBtn.classList.toggle('on', favOnly);
    page = 1;
    render();
  });

  refresh.addEventListener('click', () => {
    say('');
    void load();
  });
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try {
      await call('stop', []);
    } finally {
      playingId = '';
      await load();
    }
  });
  reveal.addEventListener('click', () => void call('reveal', []));
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    page = 1;
    render();
  });

  void load();

  return {
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}


/* ------------------------------------------------------------------ 安装与运行时 */

function mb(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
  return `${(v / 1048576).toFixed(1)} MB`;
}

function mountSetup(ctx) {
  ensureStyle();

  const root = ctx.root;
  root.classList.add('fs-wrap');

  const cards = el('div', 'fs-cards');
  const bar = el('div', 'fs-bar');
  const dl = el('button', 'fs-btn', '下载模型权重');
  const gpu = el('button', 'fs-btn', '安装 GPU 运行时');
  const cpu = el('button', 'fs-btn', '安装 CPU 运行时');
  const uvr = el('button', 'fs-btn', '安装 UVR5 精唱内核');
  uvr.title = '安全安装锁定版 audio-separator（--no-deps，不覆盖 torch 与 numpy），用于精唱分离和训练素材去混响';
  const stopBtn = el('button', 'fs-btn danger', '停止');
  const refresh = el('button', 'fs-btn', '刷新');
  bar.append(dl, gpu, cpu, uvr, stopBtn, el('span', 'fs-grow'), refresh);

  const prog = el('div', 'fs-prog');
  const fill = el('i');
  prog.append(fill);

  const msg = el('div', 'fs-msg');
  const list = el('div', 'fs-list');
  const hint = el('div', 'fs-hint');
  hint.textContent =
    '必需组件约 557 MB：ContentVec + RMVPE + 两个训练底模——这几个缺了才真的用不了，下载后自动校验 sha256。\n'
    + '出厂默认模型（dfy2 + 检索索引，约 349 MB）是可选的示例；换过模型之后删掉它完全没问题，'
    + '自检只会显示「默认模型未装」，点按钮可补。\n'
    + '运行时是 Python 环境：GPU 版下载约 2.5 GB、装完约 6 GB（55 秒的歌约 8 秒换完）；'
    + 'CPU 版只要约 200 MB，但慢 6~8 倍。已经装好 torch 的不会被覆盖。\n'
    + 'UVR5 精唱内核（audio-separator，可选，约 25 MB）：支持 BS-RoFormer 精唱分离与 De-Reverb 去混响；'
    + '点击按钮会用锁定版本 + --no-deps 安全安装，绝不覆盖 GPU 版 torch 与 numpy；未安装时自动回落 htdemucs。';

  // ---- 通知渠道测试（配置页的「完成通知」里填目标，这里一键验证）
  const nbar = el('div', 'fs-bar');
  const nbtn = el('button', 'fs-btn', '测试通知');
  nbtn.title = '立刻发一条测试通知：QQ 通就发 QQ，不通就退桌宠';
  nbtn.addEventListener('click', async () => {
    nbtn.disabled = true;
    try {
      const r = await ctx.invoke('trainNotifyTest', []);
      say(`通知：${(r && r.note) || '已发'}${r && r.via ? `（${r.via}）` : ''}`);
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
    nbtn.disabled = false;
  });
  nbar.append(nbtn, el('span', 'fs-meta',
    'QQ 目标在 Coo 设置 → 插件配置 → 完成通知 里填（group:群号 / private:QQ号，直接填号码也行）'));
  root.append(cards, bar, prog, msg, list, nbar, hint);

  let timer = null;
  let lastJob = '';

  const say = (t, bad) => {
    msg.textContent = t || '';
    msg.classList.toggle('bad', Boolean(bad));
  };

  const call = async (method, args) => {
    try {
      const res = await ctx.invoke(method, args || []);
      if (res && typeof res.text === 'string') say(res.text);
      return res;
    } catch (e) {
      say((e && e.message) || String(e), true);
      throw e;
    }
  };

  const card = (k, v, state) => {
    const c = el('div', `fs-card${state ? ` ${state}` : ''}`);
    c.append(el('div', 'k', k), el('div', 'v', v));
    return c;
  };

  const paint = (st) => {
    const m = st.models || [];
    const ready = m.filter((x) => x.ready).length;
    // 必需（hubert/rmvpe/底模）才算"能不能用"；出厂默认模型 dfy2 是可选的示例，
    // 换过模型后删掉它很常见，不能因此把整块显示成"4/6 未就绪"（用户会以为装坏了）。
    // world 侧重启后会给 required 字段；没给时按文件名兜底认出厂默认模型（dfy2 的 .pth 和它的索引），
    // 这样不重启也能立刻显示正确结果。
    const isOptional = (x) => (x.required === false)
      || (x.required === undefined
        && (/assets[\\/]weights[\\/]dfy2\.pth$/.test(x.target || '') || /logs[\\/]dfy2[\\/]/.test(x.target || '')));
    const need = m.filter((x) => !isOptional(x));
    const needReady = need.filter((x) => x.ready).length;
    const weightsOk = needReady === need.length;
    const optList = m.filter((x) => isOptional(x) && !x.ready);
    const optMissing = Number(st.optionalMissing ?? optList.length);
    // 大小也要有兜底：world 重启前不带 optionalMissingBytes，之前会显示「补下默认模型（0.0 MB）」
    const optMissingBytes = Number(st.optionalMissingBytes ?? optList.reduce((n, x) => n + (Number(x.size) || 0), 0));
    const weightsText = weightsOk
      ? (optMissing ? '就绪 · 默认模型未装' : `就绪 · ${needReady}/${need.length}`)
      : `缺 ${need.length - needReady} 项 · ${needReady}/${need.length}`;
    const optDeps = st.optionalDeps || {};
    cards.replaceChildren(
      card('RVC 代码', st.rvc && st.rvc.ready ? '已就绪' : '缺失', st.rvc && st.rvc.ready ? 'ok' : 'bad'),
      card('模型权重', weightsText, weightsOk ? 'ok' : needReady ? 'warn' : 'bad'),
      card('Python 运行时', st.python && st.python.ok ? '已就绪' : '未安装', st.python && st.python.ok ? 'ok' : 'bad'),
      card('UVR5 精唱内核', optDeps.uvr ? '已安装' : '未安装（可选）', optDeps.uvr ? 'ok' : ''),
      card('ffmpeg', st.ffmpeg && st.ffmpeg.ok ? '已就绪' : '没找到', st.ffmpeg && st.ffmpeg.ok ? 'ok' : 'bad'),
    );

    if (st.runtime) {
      list.replaceChildren();
      const parts = String(st.runtime).split(' · ');
      for (const p of parts) {
        const row = el('div', 'fs-row');
        row.append(el('span', 'n', p));
        list.append(row);
      }
    }

    const job = st.job;
    const running = job && job.state === 'running';
    dl.disabled = running;
    gpu.disabled = running;
    cpu.disabled = running;
    uvr.disabled = running || !(st.python && st.python.ok);
    stopBtn.disabled = !running;
    fill.style.width = `${running ? job.pct : job && job.state === 'done' ? 100 : 0}%`;

    if (job) {
      const kindLbl = job.kind === 'models' ? '权重下载' : job.kind === 'uvr' ? 'UVR5 精唱内核安装' : '运行时安装';
      const head = job.state === 'running' ? `${job.pct}% · ${job.msg}`
        : job.state === 'done' ? `✓ 完成：${kindLbl}`
          : `✗ ${job.error || job.msg}`;
      say(head, job.state === 'error');
      lastJob = `${job.state}${job.pct}${job.msg}`;
    }

    // 按钮文案跟着状态走，避免"已经装好了还写着安装"
    dl.textContent = weightsOk
      ? (optMissing ? `补下默认模型（${mb(optMissingBytes)}）` : '校验权重')
      : `下载必需组件（${mb(st.totalBytes - st.doneBytes)}）`;
    uvr.textContent = optDeps.uvr ? '重装 UVR5 精唱内核' : '安装 UVR5 精唱内核（推荐）';
    if (st.python && st.python.ok) {
      gpu.textContent = '重装 GPU 运行时';
      cpu.textContent = '重装 CPU 运行时';
    } else {
      gpu.textContent = '安装 GPU 运行时（推荐）';
      cpu.textContent = '安装 CPU 运行时（小）';
    }

    return running;
  };

  const load = async () => {
    let st;
    try {
      st = await ctx.invoke('status', []);
    } catch (e) {
      say((e && e.message) || String(e), true);
      return;
    }
    const running = paint(st);
    if (timer) clearInterval(timer);
    // 装的时候 800ms 刷一次，装完就停——不要一直空转打服务端
    timer = running ? setInterval(() => void load(), 800) : null;
  };

  const startJob = async (what, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    await call('start', [what]);
    setTimeout(() => void load(), 300);
  };

  dl.addEventListener('click', () => void startJob('models'));
  gpu.addEventListener('click', () =>
    void startJob('runtime-gpu', '安装 GPU 运行时：下载约 2.5 GB，装完占约 6 GB 磁盘。现在开始？'),
  );
  cpu.addEventListener('click', () =>
    void startJob('runtime-cpu', '安装 CPU 运行时：只要约 200 MB，但换声慢 6~8 倍。现在开始？'),
  );
  uvr.addEventListener('click', () =>
    void startJob('uvr', '安全安装 UVR5 精唱/去混响内核（audio-separator 锁定版，约 25 MB，绝不覆盖现有 torch 与 numpy）。现在开始？'),
  );
  stopBtn.addEventListener('click', () => {
    stopBtn.disabled = true;
    void call('cancel', []).then(() => setTimeout(() => void load(), 300));
  });
  refresh.addEventListener('click', () => void load());

  void load();

  return {
    dispose() {
      if (timer) clearInterval(timer);
    },
  };
}


/* ------------------------------------------------------------------ 模型 */

function fmtDate(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function mountModels(ctx) {
  ensureStyle();

  const root = ctx.root;
  root.classList.add('fs-wrap');

  const bar = el('div', 'fs-mhead');
  const refresh = el('button', 'fs-btn', '刷新');
  const imp = el('button', 'fs-btn', '导入 .pth');
  const fuseToggle = el('button', 'fs-btn', '🧪 音色融合');
  fuseToggle.title = '把两个同规格 RVC 模型按比例线性融合，秒级揉出新音色（无需重新训练）';
  const reveal = el('button', 'fs-btn', '打开目录');
  const expFilter = el('select', 'fs-btn');
  expFilter.title = '按实验名筛选模型';
  const pruneBtn = el('button', 'fs-btn', '清理中间档');
  pruneBtn.disabled = true;
  pruneBtn.title = '先在左侧选一个具体实验，按每 50 轮留一个清理其导出的中间档';
  const meta = el('span', 'fs-meta');
  bar.append(refresh, imp, fuseToggle, reveal, expFilter, pruneBtn, el('span', 'fs-grow'), meta);

  // 内联导入栏，替代在 Electron 中可能被禁用的 window.prompt
  const impBar = el('div', 'fs-impbar');
  impBar.style.display = 'none';
  const impIn = el('input', 'fs-tpath');
  impIn.placeholder = '粘贴 .pth 的完整路径（会复制到 assets/weights，并自动尝试匹配同名实验索引）';
  const impOk = el('button', 'fs-btn', '确认导入');
  const impCancel = el('button', 'fs-btn', '取消');
  impBar.append(impIn, impOk, impCancel);

  // 内联模型权重融合栏
  const fuseBar = el('div', 'fs-impbar');
  fuseBar.style.display = 'none';
  const fuseA = el('select', 'fs-btn');
  const fuseB = el('select', 'fs-btn');
  const fuseRange = el('input', '');
  fuseRange.type = 'range';
  fuseRange.min = '10';
  fuseRange.max = '90';
  fuseRange.step = '5';
  fuseRange.value = '50';
  fuseRange.style.width = '110px';
  const fuseRatioLbl = el('span', 'fs-meta', 'A 50% / B 50%');
  const fuseNameIn = el('input', 'fs-input');
  fuseNameIn.style.flex = '0 0 160px';
  fuseNameIn.placeholder = '新模型名（留空自动生成）';
  const fuseGo = el('button', 'fs-btn on', '生成融合模型');
  const fuseCancel = el('button', 'fs-btn', '取消');
  fuseBar.append(
    el('span', 'fs-meta', '模型 A：'), fuseA,
    el('span', 'fs-meta', '模型 B：'), fuseB,
    fuseRange, fuseRatioLbl,
    fuseNameIn, fuseGo, fuseCancel,
  );

  const msg = el('div', 'fs-msg');
  const box = el('div', '');
  root.append(bar, impBar, fuseBar, msg, box);

  let rows = [];
  let selectedExp = '';
  let pendingDelete = '';
  let pendingPruneExp = '';

  const say = (t, bad) => {
    msg.textContent = t || '';
    msg.classList.toggle('bad', Boolean(bad));
  };

  const call = async (method, args) => {
    try {
      const res = await ctx.invoke(method, args || []);
      if (res && typeof res.text === 'string') say(res.text);
      return res;
    } catch (e) {
      say((e && e.message) || String(e), true);
      throw e;
    }
  };

  const syncExpFilter = () => {
    const counts = new Map();
    for (const r of rows) {
      const k = r.exp || r.name;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    if (selectedExp && !counts.has(selectedExp)) selectedExp = '';
    expFilter.replaceChildren();
    const allOpt = el('option', '', `全部实验（${rows.length}）`);
    allOpt.value = '';
    expFilter.append(allOpt);
    for (const [exp, n] of counts.entries()) {
      const o = el('option', '', `${exp}（${n}）`);
      o.value = exp;
      if (exp === selectedExp) o.selected = true;
      expFilter.append(o);
    }
    const ckptCount = selectedExp
      ? rows.filter((r) => r.exp === selectedExp && r.epoch !== null).length
      : 0;
    pruneBtn.disabled = !selectedExp || ckptCount === 0;
    if (pendingPruneExp !== selectedExp) {
      pendingPruneExp = '';
      pruneBtn.textContent = ckptCount ? `清理中间档（${ckptCount}）` : '清理中间档';
    }
  };

  const render = () => {
    box.replaceChildren();
    const visible = selectedExp ? rows.filter((r) => r.exp === selectedExp) : rows;
    if (!visible.length) {
      box.append(el('div', 'fs-empty', rows.length ? '当前筛选下没有模型' : '还没有模型。下载权重或训练一个之后会出现在这里。'));
      return;
    }
    const table = el('table', 'fs-mtable');
    const thead = el('thead');
    const htr = el('tr');
    for (const h of ['', '模型', '实验', '轮次', '音域 (Hz)', '大小', '时间', '索引', '操作']) htr.append(el('th', '', h));
    thead.append(htr);
    const tbody = el('tbody');

    for (const r of visible) {
      const tr = el('tr', r.current ? 'on' : '');
      tr.append(el('td', 'fs-dot', r.current ? '●' : ''));

      const nameTd = el('td');
      const nameSpan = el('span', 'fs-mname', r.name);
      nameSpan.title = r.name;
      nameTd.append(nameSpan);
      if (r.current) nameTd.append(el('span', 'fs-tagx', '使用中'));
      tr.append(nameTd);

      tr.append(el('td', 'fs-meta', r.exp || '—'));
      tr.append(el('td', 'fs-num', r.epoch !== null ? `e${r.epoch}` : '最终'));
      const rgTd = el('td', 'fs-num');
      if (r.range && r.range.p5 && r.range.p95) {
        rgTd.textContent = `${r.range.p5}–${r.range.median}–${r.range.p95}`;
        rgTd.title = `低音(P5) ${r.range.p5} Hz · 中位 ${r.range.median} Hz · 高音(P95) ${r.range.p95} Hz（样本帧 ${r.range.frames || 0}）`;
      } else {
        rgTd.textContent = '—';
        rgTd.classList.add('fs-meta');
        rgTd.title = '尚未生成 logs/<exp>/range.json（首次用该模型自动变调或试唱时会自动测算）';
      }
      tr.append(rgTd);
      tr.append(el('td', 'fs-num', `${r.sizeMb} MB`));
      tr.append(el('td', 'fs-num', fmtDate(r.mtime)));

      const idxTd = el('td');
      if (r.index) {
        idxTd.append(el('span', 'fs-ok', '有'));
      } else {
        idxTd.append(el('span', 'fs-warn', '无'));
        idxTd.append(el('span', 'fs-meta', `（logs/${r.exp} 里没 .index）`));
      }
      tr.append(idxTd);

      const acts = el('td', 'fs-acts');
      const use = el('button', 'fs-btn', r.current ? '已使用' : '使用');
      use.disabled = r.current;
      use.addEventListener('click', async () => {
        use.disabled = true;
        try {
          await call('use', [r.name]);
          await load();
        } finally {
          use.disabled = false;
        }
      });
      acts.append(use);

      if (!r.current) {
        const del = el('button', 'fs-btn danger', pendingDelete === r.name ? '确认删除？' : '删除');
        del.addEventListener('click', async () => {
          if (pendingDelete !== r.name) {
            pendingDelete = r.name;
            render();
            setTimeout(() => {
              if (pendingDelete === r.name) {
                pendingDelete = '';
                render();
              }
            }, 4000);
            return;
          }
          pendingDelete = '';
          try {
            await call('delete', [r.name]);
            await load();
          } catch {
            render();
          }
        });
        acts.append(del);
      }
      tr.append(acts);
      tbody.append(tr);
    }

    table.append(thead, tbody);
    box.append(table);
  };

  const load = async () => {
    try {
      const data = await ctx.invoke('list', []);
      rows = Array.isArray(data && data.items) ? data.items : [];
      meta.textContent = rows.length
        ? `共 ${rows.length} 个 · 当前 ${data.current.model}${data.busy ? ' · 正在唱' : ''}`
        : '还没有模型';
      syncExpFilter();
      // 同步融合下拉选项
      const prevA = fuseA.value;
      const prevB = fuseB.value;
      fuseA.replaceChildren();
      fuseB.replaceChildren();
      rows.forEach((m, idx) => {
        const oa = el('option', '', m.name);
        oa.value = m.name;
        if (prevA ? m.name === prevA : idx === 0) oa.selected = true;
        fuseA.append(oa);
        const ob = el('option', '', m.name);
        ob.value = m.name;
        if (prevB ? m.name === prevB : idx === Math.min(1, rows.length - 1)) ob.selected = true;
        fuseB.append(ob);
      });
      render();
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
  };

  expFilter.addEventListener('change', () => {
    selectedExp = String(expFilter.value || '');
    pendingPruneExp = '';
    syncExpFilter();
    render();
  });

  pruneBtn.addEventListener('click', async () => {
    if (!selectedExp) return;
    if (pendingPruneExp !== selectedExp) {
      pendingPruneExp = selectedExp;
      pruneBtn.textContent = `确认清理 ${selectedExp}？每 50 轮留一个`;
      setTimeout(() => {
        if (pendingPruneExp === selectedExp) {
          pendingPruneExp = '';
          syncExpFilter();
        }
      }, 5000);
      return;
    }
    pendingPruneExp = '';
    pruneBtn.disabled = true;
    pruneBtn.textContent = '清理中…';
    try {
      await call('prune', [selectedExp, 50]);
      await load();
    } catch {
      syncExpFilter();
    }
  });

  const submitImport = async () => {
    const path = String(impIn.value || '').trim().replace(/^["']|["']$/g, '');
    if (!path) {
      say('请先粘贴 .pth 的完整路径', true);
      impIn.focus();
      return;
    }
    impOk.disabled = true;
    try {
      await call('import', [path]);
      impIn.value = '';
      impBar.style.display = 'none';
      await load();
    } catch {
      /* 错误已经显示在消息行 */
    } finally {
      impOk.disabled = false;
    }
  };

  refresh.addEventListener('click', () => void load());
  reveal.addEventListener('click', () => void call('reveal', []));
  imp.addEventListener('click', () => {
    const show = impBar.style.display === 'none';
    impBar.style.display = show ? 'flex' : 'none';
    if (show) {
      fuseBar.style.display = 'none';
      impIn.focus();
    }
  });
  fuseToggle.addEventListener('click', () => {
    const show = fuseBar.style.display === 'none';
    fuseBar.style.display = show ? 'flex' : 'none';
    if (show) impBar.style.display = 'none';
  });
  fuseRange.addEventListener('input', () => {
    const a = Number(fuseRange.value) || 50;
    fuseRatioLbl.textContent = `A ${a}% / B ${100 - a}%`;
  });
  fuseCancel.addEventListener('click', () => {
    fuseBar.style.display = 'none';
  });
  fuseGo.addEventListener('click', async () => {
    const a = String(fuseA.value || '');
    const b = String(fuseB.value || '');
    if (!a || !b || a === b) {
      say('请选择两个不同的模型进行融合', true);
      return;
    }
    const alpha = (Number(fuseRange.value) || 50) / 100;
    const outName = String(fuseNameIn.value || '').trim();
    fuseGo.disabled = true;
    say(`正在融合 ${a} (${Math.round(alpha * 100)}%) + ${b} (${Math.round((1 - alpha) * 100)}%)…`);
    try {
      await call('fuse', [a, b, outName, alpha]);
      fuseNameIn.value = '';
      fuseBar.style.display = 'none';
      await load();
    } finally {
      fuseGo.disabled = false;
    }
  });
  impOk.addEventListener('click', () => void submitImport());
  impCancel.addEventListener('click', () => {
    impBar.style.display = 'none';
  });
  impIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submitImport();
    if (e.key === 'Escape') impBar.style.display = 'none';
  });

  void load();

  return { dispose() {} };
}


/* ------------------------------------------------------------------ 训练数据 */

function fmtSec(v) {
  const s = Math.max(0, Math.round(Number(v) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function mountTrain(ctx) {
  ensureStyle();

  const root = ctx.root;
  root.classList.add('fs-wrap');

  const bar = el('div', 'fs-bar');
  const pathIn = el('input', 'fs-tpath');
  pathIn.placeholder = '粘贴素材文件夹或单个文件路径，可多个用 ; 分隔';
  const scanBtn = el('button', 'fs-btn', '扫描');
  bar.append(pathIn, scanBtn);

  const dsBar = el('div', 'fs-bar');
  const dsSel = el('select', 'fs-btn');
  dsSel.title = '已切好片的数据集。切完没训练的数据集会一直占磁盘，可以在这里删。';
  dsSel.style.maxWidth = '520px';
  const dsMeta = el('span', 'fs-meta', '');
  const dsDel = el('button', 'fs-btn danger', '删除数据集');
  dsDel.disabled = true;
  const dsReveal = el('button', 'fs-btn', '打开目录');
  dsReveal.disabled = true;
  dsBar.append(el('span', 'fs-meta', '数据集：'), dsSel, dsMeta, el('span', 'fs-grow'), dsDel, dsReveal);

  const importBar = el('div', 'fs-bar');
  const expSel = el('select', 'fs-btn');
  expSel.title = '本机已有的训练实验（logs/<实验>/0_gt_wavs 里还留着切片的）';
  const importBtn = el('button', 'fs-btn', '导入已训练模型的数据');
  const expMeta = el('span', 'fs-meta', '');
  importBar.append(el('span', 'fs-meta', '已有模型：'), expSel, importBtn, expMeta);

  const bar2 = el('div', 'fs-bar');
  const modeSel = el('select', 'fs-btn');
  for (const [v, t] of [['auto', '自动切片（按乐句，2–4.5 秒）'], ['fixed', '固定长度']]) {
    const o = el('option', '', t);
    o.value = v;
    modeSel.append(o);
  }
  const lenIn = el('input', 'fs-input');
  lenIn.placeholder = '固定秒数（如 3.7）';
  lenIn.style.display = 'none';
  const sepSel = el('select', 'fs-btn');
  sepSel.title = '训练素材分离引擎：UVR5 RoFormer 干声更干净（未装 audio-separator 自动回落 htdemucs）';
  for (const [v, t] of [
    ['roformer', 'UVR5 RoFormer 精分（推荐）'],
    ['htdemucs', 'htdemucs 快速分离'],
  ]) {
    const o = el('option', '', t);
    o.value = v;
    sepSel.append(o);
  }
  const derevChk = el('input', 'fs-ck');
  derevChk.type = 'checkbox';
  derevChk.checked = true;
  const derevLabel = el('label', 'fs-meta', '去混响');
  derevLabel.title = '分离后再用 UVR5 De-Reverb 净化原唱混响，推荐训练时开启';
  derevLabel.prepend(derevChk);
  const startBtn = el('button', 'fs-btn', '开始处理');
  startBtn.disabled = true;
  const stopBtn = el('button', 'fs-btn danger', '停止');
  stopBtn.disabled = true;
  const appendChk = el('input', 'fs-ck');
  appendChk.type = 'checkbox';
  appendChk.checked = false; // 用户要求：不默认追加，切片时自己勾
  appendChk.disabled = true;
  const appendLabel = el('label', 'fs-meta', '追加到当前数据集');
  appendLabel.style.display = 'none';

  bar2.append(modeSel, lenIn, sepSel, derevLabel, startBtn, stopBtn, appendChk, appendLabel, el('span', 'fs-grow'));

  const msg = el('div', 'fs-msg');
  const prog = el('div', 'fs-prog');
  const fill = el('i');
  prog.append(fill);
  const listBox = el('div', '');
  const resultBox = el('div', '');
  const weightBox = el('div', '');

  const trainBox = el('div', '');

  // ---- 分步折叠布局：①素材 ②训练 ③高级 ------------------------------
  // 之前这里是把 10 个 bar/box 平铺，新用户第一眼看到素材路径、数据集、实验、
  // 参数、5 个勾选、低音滑块、进度、曲线、清理——完全不知道从哪下手。
  const mkSec = (title, hint, open) => {
    const d = el('details', 'fs-sec');
    if (open) d.open = true;
    const sum = el('summary', '');
    sum.append(el('span', '', title), el('span', 'fs-sec-hint', hint));
    const body = el('div', 'fs-sec-body');
    d.append(sum, body);
    return { d, body };
  };

  const secA = mkSec('① 素材 → 数据集', '把歌放进来、扫描、切成训练用的片', false);
  secA.body.append(bar, bar2, importBar, listBox, resultBox, dsBar);

  const secB = mkSec('② 训练', '一般只需要改「轮次」，其余都在展开项里', false);
  secB.body.append(trainBox);

  const lowChk = el('input', 'fs-ck');
  lowChk.type = 'checkbox';
  lowChk.checked = false;
  const lowLbl = el('label', 'fs-meta', '低音增强（合成 -2 / -4 半音副本）');
  lowLbl.prepend(lowChk);
  lowLbl.title = '有限改善：把每个切片合成 -2/-4 半音的副本一起训练。实测只能缓解、不能根治"低音不像"，且 F0/特征提取时间约 ×3';
  const augBar = el('div', 'fs-augbar');
  augBar.append(lowLbl, el('span', 'fs-meta', '仅在缺少真实低音素材时尝试，特征提取时间约 ×3'));

  const secC = mkSec('③ 高级：低音增强 / 音域加权', '给数据加降调副本、按音域调采样权重（有效但有限）', false);
  secC.body.append(augBar, weightBox);

  root.append(prog, msg, secA.d, secB.d, secC.d);

  let items = [];
  let checked = new Set();
  let timer = null;
  let lastDir = '';
  let lastSecState = '';
  let evalLoaded = false;
  let evalExpanded = false;

  const say = (t, bad) => {
    msg.textContent = t || '';
    msg.classList.toggle('bad', Boolean(bad));
  };

  const call = async (method, args) => {
    try {
      const res = await ctx.invoke(method, args || []);
      if (res && typeof res.text === 'string') say(res.text);
      return res;
    } catch (e) {
      say((e && e.message) || String(e), true);
      throw e;
    }
  };

  const renderList = () => {
    listBox.replaceChildren();
    if (!items.length) return;
    const table = el('table', 'fs-mtable');
    const thead = el('thead');
    const htr = el('tr');
    const all = el('input', 'fs-ck');
    all.type = 'checkbox';
    all.checked = items.length > 0 && checked.size === items.length;
    all.addEventListener('change', () => {
      checked = all.checked ? new Set(items.map((x) => x.path)) : new Set();
      renderList();
    });
    const th0 = el('th', '');
    th0.append(all);
    for (const h of [th0, el('th', '', '文件'), el('th', '', '时长'), el('th', '', '格式'), el('th', '', '处理方式')]) htr.append(h);
    thead.append(htr);
    const tbody = el('tbody');

    for (const it of items) {
      const tr = el('tr', '');
      const td0 = el('td', '');
      if (!it.error) {
        const ck = el('input', 'fs-ck');
        ck.type = 'checkbox';
        ck.checked = checked.has(it.path);
        ck.addEventListener('change', () => {
          if (ck.checked) checked.add(it.path);
          else checked.delete(it.path);
          startBtn.disabled = checked.size === 0;
        });
        td0.append(ck);
      }
      tr.append(td0);
      tr.append(el('td', 'fs-file', it.name));
      tr.append(el('td', 'fs-num', it.error ? '—' : fmtSec(it.duration)));
      tr.append(el('td', 'fs-num', it.error ? '读不出' : `${it.codec} ${it.sr}Hz`));
      tr.append(el('td', '', it.error ? it.error.slice(0, 40) : it.dry ? '已是干声，跳过分离' : '会分离人声'));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    listBox.append(table);
    startBtn.disabled = checked.size === 0;
  };

  const renderResult = (ds) => {
    resultBox.replaceChildren();
    if (!ds) return;
    const st = ds.stats;

    const cards = el('div', 'fs-cards');
    const mk = (k, v) => {
      const c = el('div', 'fs-card2');
      c.append(el('div', 'k', k), el('div', 'v', v));
      return c;
    };
    cards.append(
      mk('素材', `${st.sources} 首`),
      mk('有效切片', `${st.kept} 片`),
      mk('总时长', `${(st.seconds / 60).toFixed(1)} 分钟`),
      mk('丢弃', `${st.dropped} 片`),
    );
    resultBox.append(cards);

    const sum = el('div', 'fs-tsum', ds.summary);
    resultBox.append(sum);

    const hist = ds.histogram || [];
    if (hist.length) {
      const maxN = Math.max(...hist.map((b) => b.n), 1);
      const box = el('div', 'fs-hist');
      hist.forEach((b, i) => {
        const bar = el('div', `bar${b.n === maxN ? ' peak' : ''}`);
        bar.style.height = `${Math.max(3, (b.n / maxN) * 92)}px`;
        bar.title = `${b.from}–${b.to} Hz：${b.n} 片`;
        box.append(bar);
      });
      resultBox.append(box);
      const axis = el('div', 'fs-haxis');
      axis.append(el('span', '', `${hist[0].from} Hz`), el('span', '', `${hist[hist.length - 1].to} Hz`));
      resultBox.append(axis);
    }

    const bands = el('div', 'fs-bandrow');
    const labels = ds.bandLabels || {};
    for (const [id, n] of Object.entries(st.byBand || {})) {
      bands.append(el('span', 'fs-band', `${labels[id] || id}：${n} 片`));
    }
    resultBox.append(bands);

    if (ds.sourceQuality && ds.sourceQuality.length) {
      const qDet = el('details', 'fs-sec');
      const qSum = el('summary', '');
      const lowCnt = ds.sourceQuality.filter((x) => x.keepRate < 60).length;
      const failCnt = (ds.f0Failed || []).length;
      qSum.append(
        el('span', '', `各素材质检明细（${ds.sourceQuality.length} 首）`),
        el('span', 'fs-sec-hint',
          (lowCnt ? `${lowCnt} 首保留率偏低 · ` : '')
          + (failCnt ? `${failCnt} 片音高分析失败需复查` : '保留率按低到高排列')),
      );
      const qBody = el('div', 'fs-sec-body');
      const qTbl = el('table', 'fs-table');
      const qHead = el('thead');
      const qTr = el('tr');
      for (const h of ['素材', '保留/总片', '保留率', '有效时长', '丢弃明细']) qTr.append(el('th', '', h));
      qHead.append(qTr);
      const qTb = el('tbody');
      const dLabels = ds.dropLabels || {};
      for (const q of ds.sourceQuality) {
        const tr = el('tr');
        const tdName = el('td', 'fs-file', q.source);
        tdName.title = q.source;
        const rateTd = el('td', 'fs-num', `${q.keepRate}%`);
        if (q.keepRate < 60) rateTd.classList.add('fs-qual-low');
        const why = Object.entries(q.reasons || {})
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${dLabels[k] || k}×${v}`)
          .join('，') || '无';
        tr.append(
          tdName,
          el('td', 'fs-num', `${q.kept}/${q.total}`),
          rateTd,
          el('td', 'fs-num', `${q.keptSec}s`),
          el('td', 'fs-meta', why),
        );
        qTb.append(tr);
      }
      qTbl.append(qHead, qTb);
      qBody.append(qTbl);

      if (failCnt) {
        const fBox = el('div', 'fs-list');
        fBox.append(el('div', 'fs-warn', `需复查切片（f0_analysis_failed，共 ${failCnt} 片）：`));
        for (const f of (ds.f0Failed || []).slice(0, 15)) {
          const row = el('div', 'fs-row');
          row.append(
            el('span', 'n', `${f.file} · ${f.source}`),
            el('span', 'r', `起点 ${f.start}s · 长 ${f.dur}s`),
          );
          fBox.append(row);
        }
        qBody.append(fBox);
      }
      qDet.append(qSum, qBody);
      resultBox.append(qDet);
    }

    if (ds.preview && ds.preview.length) {
      const pv = el('div', 'fs-list');
      for (const p of ds.preview) {
        const row = el('div', 'fs-row');
        row.append(el('span', 'n', `${p.file} · ${p.source.slice(0, 18)}`));
        row.append(el('span', 'r', `${p.dur.toFixed(1)}s · ${p.f0}Hz`));
        pv.append(row);
      }
      resultBox.append(pv);
    }
  };

  let wcfg = { mode: 'median', bands: { low: 1, mid: 1, high: 1, top: 1 } };
  let wrows = [];
  let wPresets = [];
  let wRefs = [];
  let wFootMeta = null;

  const currentBatch = () => Math.max(1, Number((bsSel && bsSel.value) || 4));

  const afterShares = () => {
    const batch = currentBatch();
    const counts = wrows.map(() => 0);
    let total = 0;
    for (let bucket = 0; bucket < 8; bucket++) {
      const n = wrows.reduce((sum, r) => sum + (r.buckets?.[bucket] || 0), 0);
      if (!n) continue;
      const draws = Math.ceil(n / batch) * batch;
      const denominator = wrows.reduce((sum, r) => sum + (r.buckets?.[bucket] || 0) * (wcfg.bands[r.id] ?? 1), 0);
      wrows.forEach((r, i) => { counts[i] += draws * (r.buckets?.[bucket] || 0) * (wcfg.bands[r.id] ?? 1) / denominator; });
      total += draws;
    }
    return counts.map(n => n / (total || 1));
  };

  const paintWeightNumbers = () => {
    const batch = currentBatch();
    const afters = afterShares();
    wrows.forEach((r, i) => {
      const ref = wRefs[i];
      if (!ref) return;
      const now = afters[i];
      const dir = now > r.share + 0.005 ? 'up' : now < r.share - 0.005 ? 'down' : 'same';
      ref.share.textContent = `${(r.share * 100).toFixed(0)}% → ${(now * 100).toFixed(0)}%`;
      ref.share.className = `fs-wshift ${dir}`;
      ref.times.textContent = `${wcfg.bands[r.id] ?? 1}x`;
    });
    if (wFootMeta) {
      wFootMeta.textContent = `预览为桶内抽样片数占比（非增强 / batch ${batch}），不是时长占比；以训练采样报告为准，增强副本按原片音域归组`;
    }
  };

  const renderWeights = (cfg, rows) => {
    if (cfg) wcfg = cfg;
    if (rows) wrows = rows;
    weightBox.replaceChildren();
    wRefs = [];
    if (!wrows.length) return;

    const head = el('div', 'fs-bar');
    head.append(el('span', 'fs-wtitle', '音域权重'));
    const modes = el('div', 'fs-wmodes');
    for (const [m, label, tip] of [
      ['median', '按主音域', '按每片的中位音高分档：代表这片主要唱在哪个音区'],
      ['p90', '按最高音', '按每片 90 分位音高分档：代表这片有没有唱上去'],
      ['mix', '两端兼顾', '低音按主音域判、高音按最高音(540Hz+)判：只有这个口径能同时给两头加量'],
    ]) {
      const b = el('button', `fs-btn${wcfg.mode === m ? ' on' : ''}`, label);
      b.title = tip;
      b.addEventListener('click', async () => {
        if (wcfg.mode === m) return;
        wcfg = { ...wcfg, mode: m };
        try {
          const res = await ctx.invoke('weights', [wcfg]);
          wcfg = res.cfg;
          renderWeights(res.cfg, res.rows);
        } catch (e) {
          say((e && e.message) || String(e), true);
        }
      });
      modes.append(b);
    }
    head.append(modes, el('span', 'fs-grow'));
    weightBox.append(head);

    const presetBar = el('div', 'fs-wpresets');
    for (const p of wPresets) {
      const b = el('button', 'fs-btn', p.name);
      b.title = p.desc;
      const on = p.cfg.mode === wcfg.mode && ['low', 'mid', 'high', 'top'].every((k) => Math.abs((p.cfg.bands[k] ?? 1) - (wcfg.bands[k] ?? 1)) < 0.01);
      if (on) b.classList.add('on');
      b.addEventListener('click', async () => {
        try {
          const res = await ctx.invoke('weights', [p.cfg]);
          wcfg = res.cfg;
          renderWeights(res.cfg, res.rows);
          say(`${p.name}：${p.desc}`, false);
        } catch (e) {
          say((e && e.message) || String(e), true);
        }
      });
      presetBar.append(b);
    }
    weightBox.append(presetBar);

    for (const r of wrows) {
      const row = el('div', 'fs-wrow');
      row.append(el('span', 'fs-wname', r.label));
      row.append(el('span', 'fs-wmeta', `${r.n} 片 · ${(r.seconds / 60).toFixed(1)} 分`));
      const share = el('span', 'fs-wshift', '');
      row.append(share);
      const range = el('input', 'fs-wrange');
      range.type = 'range';
      range.min = '0.5';
      range.max = '5';
      range.step = '0.5';
      range.value = String(wcfg.bands[r.id] ?? 1);
      range.addEventListener('input', () => {
        wcfg = { ...wcfg, bands: { ...wcfg.bands, [r.id]: Number(range.value) } };
        paintWeightNumbers();
      });
      row.append(range);
      const times = el('span', 'fs-wtimes', '');
      row.append(times);
      weightBox.append(row);
      wRefs.push({ share, times });
    }

    const foot = el('div', 'fs-bar');
    const saveBtn = el('button', 'fs-btn', '保存权重');
    saveBtn.addEventListener('click', async () => {
      try {
        const res = await call('saveWeights', [wcfg]);
        if (res && res.rows) wrows = res.rows;
        renderWeights(wcfg, wrows);
      } catch {
        /* 错误已显示 */
      }
    });
    wFootMeta = el('span', 'fs-meta', '');
    foot.append(saveBtn, wFootMeta);
    weightBox.append(foot);

    paintWeightNumbers();
  };

  const poll = async () => {
    let st;
    try {
      st = await ctx.invoke('status', []);
    } catch (e) {
      say((e && e.message) || String(e), true);
      return;
    }
    const job = st.job;
    if (job) {
      const running = job.state === 'running';
      startBtn.disabled = running || checked.size === 0;
      stopBtn.disabled = !running;
      fill.style.width = `${running ? job.pct : job.state === 'done' ? 100 : 0}%`;
      if (running) say(`${job.pct}% · ${job.msg}`);
      else if (job.state === 'done') say(`完成 · ${job.dir}`);
      else if (job.state === 'error') say(`失败：${job.msg}`, true);
      if (running && !timer) timer = setInterval(() => void poll(), 900);
      if (!running && timer) {
        clearInterval(timer);
        timer = null;
      }
      if (wasRunning && !running) {
        void loadDatasets(true);
        void pollTrain();
      }
      wasRunning = running;
    }
    if (st.dataset) {
      lastDir = st.dataset.dir || '';
      appendChk.disabled = !lastDir;
      appendLabel.style.display = lastDir ? '' : 'none';
      renderResult(st.dataset);
      if (st.dataset.rows && st.dataset.rows.length) {
        if (st.dataset.presets) wPresets = st.dataset.presets;
        // 已经渲染过就只更新数字：整块重建会把正在拖的滑块打断（轮询 900ms 一次）
        if (weightBox.children.length) paintWeightNumbers();
        else renderWeights(st.dataset.weights, st.dataset.rows);
      }
    }
    return Boolean(job && job.state === 'running');
  };

  let datasets = [];
  let pendingDel = '';
  let wasRunning = false;

  const loadDatasets = async (keepSelection) => {
    try {
      const r = await ctx.invoke('datasets', []);
      datasets = (r && r.items) || [];
      const cur = (r && r.current) || '';
      dsSel.replaceChildren();
      if (!datasets.length) {
        const o = el('option', '', '（还没有数据集）');
        o.value = '';
        dsSel.append(o);
        dsDel.disabled = true;
        dsReveal.disabled = true;
        dsMeta.textContent = '';
        return;
      }
      for (const d of datasets) {
        const tag = d.imported ? `导入·${d.fromExp}` : '自建';
        const o = el('option', '', `${d.name} · ${d.slices}片 · ${(d.seconds / 60).toFixed(1)}分 · ${d.sizeMb}MB · ${tag}`);
        o.value = d.dir;
        if (d.dir === cur) o.selected = true;
        dsSel.append(o);
      }
      if (!keepSelection && cur) dsSel.value = cur;
      const hit = datasets.find((d) => d.dir === (dsSel.value || cur)) || datasets[0];
      dsMeta.textContent = hit && hit.models.length ? `已训出 ${hit.models.join(',')}` : '';
      dsDel.disabled = false;
      dsReveal.disabled = false;
    } catch (e) {
      dsMeta.textContent = (e && e.message) || String(e);
    }
  };

  dsSel.addEventListener('change', async () => {
    const dir = String(dsSel.value || '');
    if (!dir) return;
    try {
      await call('select', [dir]);
      pendingDel = '';
      dsDel.textContent = '删除数据集';
      await poll();
      await loadDatasets(true);
    } catch {
      /* 已显示错误 */
    }
  });

  dsDel.addEventListener('click', async () => {
    const dir = String(dsSel.value || '');
    const hit = datasets.find((d) => d.dir === dir);
    if (!hit) return;
    if (pendingDel !== dir) {
      pendingDel = dir;
      dsDel.textContent = hit.models.length
        ? `确认删除？（已训出 ${hit.models.join(',')}，数据删了模型还在）`
        : `确认删除？${hit.sizeMb} MB`;
      setTimeout(() => {
        if (pendingDel === dir) {
          pendingDel = '';
          dsDel.textContent = '删除数据集';
        }
      }, 5000);
      return;
    }
    pendingDel = '';
    dsDel.textContent = '删除数据集';
    try {
      await call('deleteDataset', [dir]);
      await loadDatasets();
      await poll();
    } catch {
      /* 已显示错误 */
    }
  });

  dsReveal.addEventListener('click', async () => {
    const dir = String(dsSel.value || '');
    if (!dir) return;
    try {
      await call('reveal', [dir]);
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
  });

  /* ---------------- 训练 ---------------- */
  const tForm = el('div', 'fs-tform');
  const expIn = el('input', 'fs-tin');
  expIn.placeholder = '实验名（英文，如 fish1029）';
  // 给个默认名，别让新用户卡在"实验名填什么"这一步（同名会复用目录，所以带日期）
  {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    expIn.value = `fish${mm}${dd}`;
  }
  const epIn = el('input', 'fs-tin');
  epIn.type = 'number';
  epIn.min = '10';
  epIn.max = '600';
  epIn.value = '70';
  const bsSel = el('select', 'fs-tin');
  for (const v of [2, 4, 6, 8]) {
    const o = el('option', '', `batch ${v}`);
    o.value = String(v);
    o.selected = v === 4;
    bsSel.append(o);
  }
  bsSel.addEventListener('change', () => {
    if (wrows.length) paintWeightNumbers();
  });
  const seIn = el('input', 'fs-tin');
  seIn.type = 'number';
  seIn.min = '1';
  seIn.max = '100';
  seIn.value = '10';
  const resumeChk = el('input', 'fs-ck');
  resumeChk.type = 'checkbox';
  const rebuildChk = el('input', 'fs-ck');
  rebuildChk.type = 'checkbox';
  const startT = el('button', 'fs-btn', '开始训练');
  const stopT = el('button', 'fs-btn danger', '停止训练');
  stopT.disabled = true;

  const mkField = (label, node, tip) => {
    const wrap = el('label', 'fs-field');
    wrap.append(el('span', 'fs-flabel', label), node);
    if (tip) wrap.title = tip;
    return wrap;
  };

  const resumeLastBtn = el('button', 'fs-btn', '');
  resumeLastBtn.style.display = 'none';
  resumeLastBtn.title = '填入上次实验名并勾选「从上次存档继续」（需保持数据集与增强参数完全一致）';
  let lastResumeInfo = null;
  resumeLastBtn.addEventListener('click', () => {
    if (!lastResumeInfo) return;
    expIn.value = lastResumeInfo.exp;
    resumeChk.checked = true;
    tMsg.textContent = `已切换到续训「${lastResumeInfo.exp}」（已有 ${lastResumeInfo.done} 轮，请确认轮次大于 ${lastResumeInfo.done}）`;
    tMsg.classList.remove('bad');
  });

  tForm.append(
    mkField('实验名', expIn, '从头训练使用新实验名；同名仅允许数据一致的断点续训'),
    mkField('轮次', epIn, '先训练 40～70 轮，使用独立试听选模，增加轮次不保证更好'),
    mkField('批大小', bsSel, '8G 显存用 4，爆显存就降到 2'),
    mkField('每 N 轮存档', seIn, '每 N 轮导出一个小模型到「模型」页'),
    resumeLastBtn,
  );
  const pruneAfterChk = el('input', 'fs-ck');
  pruneAfterChk.type = 'checkbox';
  const chkRow = el('div', 'fs-bar');
  const resumeLbl = el('label', 'fs-meta', '从上次存档继续');
  resumeLbl.prepend(resumeChk);
  const rebuildLbl = el('label', 'fs-meta', '重算特征');
  rebuildLbl.prepend(rebuildChk);
  rebuildLbl.title = '数据集换过、或上次特征提取失败时勾上';
  const pruneAfterLbl = el('label', 'fs-meta', '训练完自动清理中间档');
  pruneAfterLbl.prepend(pruneAfterChk);
  pruneAfterLbl.title = '按下面「每 N 轮留一个」保留，其余删掉。不勾就只是提醒你手动清。';
  const abChk = el('input', 'fs-ck');
  abChk.type = 'checkbox';
  abChk.checked = false;
  const abLbl = el('label', 'fs-meta', '训练完生成选模对比');
  abLbl.prepend(abChk);
  abLbl.title = '用独立的低、中、高音三段干声对比 final 和最后两个中间档，关闭检索';
  const evalToggleBtn = el('button', 'fs-btn', '选模素材');
  evalToggleBtn.title = '展开或收起低、中、高音三段独立干声路径输入框（自动记住上次填写）';
  chkRow.append(resumeLbl, rebuildLbl, pruneAfterLbl, abLbl, evalToggleBtn, el('span', 'fs-grow'), startT, stopT);

  const evalBands = ['低音', '中音', '高音'];
  const evaluationInputs = [];
  const evaluationBox = el('div', 'fs-eval');
  evaluationBox.style.display = 'none';
  evaluationBox.append(el('div', 'fs-meta', '选模素材：固定低、中、高音三段独立干声（自动保存，勿使用训练素材或同一首歌的其他片段）。'));
  const persistEvalPaths = () => {
    const vals = evaluationInputs.map((inp) => String(inp.value || '').trim().replace(/^["']|["']$/g, ''));
    evaluationInputs.forEach((inp, idx) => { inp.value = vals[idx]; });
    void ctx.invoke('saveEvalPaths', [vals]).catch(() => undefined);
  };
  for (const band of evalBands) {
    const row = el('div', 'fs-eval-row');
    const lbl = el('span', 'fs-meta', band);
    const input = el('input', 'fs-eval-in');
    input.placeholder = `${band}独立干声绝对路径（含长音，建议 10～30 秒）`;
    input.addEventListener('change', persistEvalPaths);
    row.append(lbl, input);
    evaluationBox.append(row);
    evaluationInputs.push(input);
  }

  const syncEvalVisible = () => {
    const show = abChk.checked || evalExpanded;
    evaluationBox.style.display = show ? 'flex' : 'none';
    evalToggleBtn.classList.toggle('on', show);
  };
  abChk.addEventListener('change', syncEvalVisible);
  evalToggleBtn.addEventListener('click', () => {
    evalExpanded = !evalExpanded;
    syncEvalVisible();
    if (evalExpanded) {
      const firstEmpty = evaluationInputs.find((i) => !i.value.trim()) || evaluationInputs[0];
      firstEmpty.focus();
    }
  });

  const samplingText = el('div', 'fs-meta');
  const tProg = el('div', 'fs-prog');
  const tFill = el('i');
  tProg.append(tFill);
  const tMsg = el('div', 'fs-msg');
  const losses = el('div', 'fs-loss');
  const lossAxis = el('div', 'fs-haxis');
  const tModels = el('div', 'fs-list');

  const ckptBar = el('div', 'fs-bar');
  const ckptMeta = el('span', 'fs-meta', '');
  const keepIn = el('input', 'fs-tin');
  keepIn.type = 'number';
  keepIn.min = '1';
  keepIn.value = '50';
  keepIn.style.width = '64px';
  const pruneBtn = el('button', 'fs-btn', '清理中间档');
  pruneBtn.title = '只删 assets/weights/<exp>_eN_sX.pth 这种导出的小模型；完整存档、索引、最终模型都不动';
  const abBtn = el('button', 'fs-btn', '生成选模对比');
  abBtn.title = '用独立低、中、高音干声对比 final 和最后两个中间档，关闭检索';
  ckptBar.append(el('span', 'fs-meta', '中间档：'), ckptMeta, el('span', 'fs-meta', '每'),
    keepIn, el('span', 'fs-meta', '轮留一个'), el('span', 'fs-grow'), abBtn, pruneBtn);
  trainBox.append(tForm, chkRow, evaluationBox, tProg, tMsg, samplingText, losses, lossAxis, tModels, ckptBar);

  let trainExp = '';
  let trainTimer = null;
  let pendingPrune = false;

  const refreshCkpt = async () => {
    try {
      const st2 = await ctx.invoke('trainStatus', [trainExp]);
      const ck = st2.ckpt || { n: 0, totalMb: 0 };
      ckptMeta.textContent = ck.n ? `${ck.n} 个 · ${ck.totalMb} MB` : '暂无';
      pruneBtn.disabled = !ck.n;
    } catch { /* 忽略 */ }
  };

  abBtn.addEventListener('click', async () => {
    const exp = String(expIn.value || '').trim() || trainExp;
    if (!exp) {
      tMsg.textContent = '先填实验名（或跑一次训练）再生成选模对比';
      return;
    }
    const paths = evaluationInputs.map((input) => input.value.trim().replace(/^["']|["']$/g, ''));
    const missingIdx = paths.findIndex((p) => !p);
    if (missingIdx >= 0) {
      evalExpanded = true;
      syncEvalVisible();
      evaluationInputs[missingIdx].focus();
      tMsg.textContent = '请先填完低、中、高音三段独立干声路径，再生成选模对比';
      tMsg.classList.add('bad');
      return;
    }
    abBtn.disabled = true;
    abBtn.textContent = '生成中…';
    try {
      const r = await ctx.invoke('trainAbTest', [{ exp, evaluationPaths: paths }]);
      tMsg.textContent = (r && r.text) || `选模对比已生成（${exp}）`;
      tMsg.classList.remove('bad');
    } catch (e) {
      tMsg.textContent = `选模对比失败：${(e && e.message) || e}`;
      tMsg.classList.add('bad');
    } finally {
      abBtn.disabled = false;
      abBtn.textContent = '生成选模对比';
    }
  });

  pruneBtn.addEventListener('click', async () => {
    if (!trainExp) return;
    const step = Math.max(1, Number(keepIn.value) || 50);
    if (!pendingPrune) {
      // 先看要删多少，再确认——中间档删了只能重训才拿得回来
      try {
        const st2 = await ctx.invoke('trainStatus', [trainExp]);
        const n = (st2.ckpt || {}).n || 0;
        if (!n) return;
        pendingPrune = true;
        pruneBtn.textContent = `确认删除？每 ${step} 轮留一个`;
        setTimeout(() => {
          if (pendingPrune) {
            pendingPrune = false;
            pruneBtn.textContent = '清理中间档';
          }
        }, 5000);
      } catch { /* 忽略 */ }
      return;
    }
    pendingPrune = false;
    pruneBtn.textContent = '清理中…';
    pruneBtn.disabled = true;
    try {
      await call('prune', [trainExp, step]);
    } catch {
      /* 错误已在消息行显示 */
    }
    await refreshCkpt();
    pruneBtn.textContent = '清理中间档';
  });

  const fmtDur = (sec) => {
    const s0 = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s0 / 3600);
    const m = Math.floor((s0 % 3600) / 60);
    if (h) return `${h} 小时 ${m} 分`;
    if (m) return `${m} 分 ${s0 % 60} 秒`;
    return `${s0} 秒`;
  };

  const paintLoss = (log) => {
    losses.replaceChildren();
    lossAxis.replaceChildren();
    const pts = (log && log.losses) || [];
    if (!pts.length) return;
    const mel = pts.map((p) => p.mel).filter((v) => v > 0);
    const hi = Math.max(...mel);
    const lo = Math.min(...mel);
    const span = Math.max(0.001, hi - lo);
    for (const p of pts) {
      const bar = el('div', 'fs-lbar');
      // mel 越小越好，所以越低的柱子画得越高，视觉上「往下走 = 在进步」
      const h = 4 + 52 * (1 - (p.mel - lo) / span);
      bar.style.height = `${Math.round(h)}px`;
      bar.title = `第 ${p.epoch} 轮 · mel ${p.mel}`;
      losses.append(bar);
    }
    lossAxis.append(
      el('span', '', `mel ${hi.toFixed(1)} → ${mel[mel.length - 1].toFixed(1)}`),
      el('span', '', `${pts.length} 个记录点`),
    );
  };

  const paintTrain = (st) => {
    const report = st.sampling;
    const sampleTotal = Object.values(report?.counts || {}).reduce((sum, n) => sum + Number(n), 0);
    samplingText.textContent = report ? `第 ${report.epoch} 轮采样计划：${sampleTotal} 次 / ${Object.keys(report.counts || {}).length} 个不同切片；` +
      Object.entries(report.bands || {}).map(([band, n]) => `${({low:'低', mid:'中', high:'偏高', top:'高', unknown:'未知'})[band] || band} ${(Number(n) / (sampleTotal || 1) * 100).toFixed(1)}%`).join(' · ') +
      (report.replicas > 1 ? '（仅 rank0）' : '') : '实际采样报告：训练启动后显示';
    const job = st.job;
    // 有 job 就看 job；没有但日志还在写 = 重启前留下的训练还在跑，一样要当成「进行中」
    const owned = Boolean(job && job.id);
    const fresh = st.logAgeSec !== null && st.logAgeSec !== undefined && st.logAgeSec < 180;
    const running = (job && job.state === 'running') || (!job && fresh) || Boolean(job && job.state === 'running');
    const log = st.log || { done: 0, losses: [], latest: null, secPerEpoch: null, error: '' };
    const total = st.total || 0;

    if (!evalLoaded && Array.isArray(st.evaluationPaths)) {
      evalLoaded = true;
      st.evaluationPaths.forEach((p, idx) => {
        if (evaluationInputs[idx] && !evaluationInputs[idx].value && p) {
          evaluationInputs[idx].value = String(p);
        }
      });
    }
    // 分区自动展开：谁在跑就展开谁；都空闲就全收起（用户手动展开的不动）
    const secState = running ? 'train' : (st.datasetBusy ? 'ds' : 'idle');
    if (secState !== lastSecState) {
      lastSecState = secState;
      secB.d.open = secState === 'train';
      secA.d.open = secState === 'ds';
    }
    // 取消静默代勾「从上次存档继续」，改为显式快捷按钮，避免新实验误触指纹报错
    if (!running && log.done > 0 && st.exp) {
      lastResumeInfo = { exp: st.exp, done: log.done };
      resumeLastBtn.textContent = `续训 ${st.exp}（${log.done} 轮）`;
      resumeLastBtn.style.display = '';
    } else {
      lastResumeInfo = null;
      resumeLastBtn.style.display = 'none';
    }

    startT.disabled = running || st.datasetBusy;
    // 即使不是本次启动的也能停：/stop 取消的是 worker 当前任务，跟谁提交的无关
    stopT.disabled = !running;
    stopT.title = owned ? '' : '这个训练不是本次启动的（可能是重启前留下的），按下会让 worker 取消它当前的任务';
    tFill.style.width = `${running ? (job ? job.pct : Math.min(99, Math.round((log.done / Math.max(1, total)) * 100))) : job && job.state === 'done' ? 100 : 0}%`;

    if (job) {
      trainExp = job.exp || trainExp;
      if (!expIn.value) expIn.value = job.exp || '';
    } else if (st.exp) {
      trainExp = st.exp;
      if (!expIn.value) expIn.value = st.exp;
    }

    if (running && !job) {
      const per = log.secPerEpoch ? ` · ${log.secPerEpoch.toFixed(0)} 秒/轮` : '';
      const left = log.secPerEpoch && total ? Math.max(0, total - log.done) * log.secPerEpoch : 0;
      const eta = left ? ` · 预计还要 ${fmtDur(left)}` : '';
      tMsg.textContent = `训练中（日志 ${st.logAgeSec} 秒前更新，进程不由面板接管）：${log.done}/${total || '?'} 轮${per}${eta}`;
      tMsg.classList.remove('bad');
    } else if (running) {
      const eta = st.etaSec ? ` · 预计还要 ${fmtDur(st.etaSec)}` : '';
      const per = log.secPerEpoch ? ` · ${log.secPerEpoch.toFixed(0)} 秒/轮` : '';
      tMsg.textContent = `${job.pct}% · ${job.msg}（${Math.min(log.done, total || job.epochs)}/${total || job.epochs} 轮${per}${eta}）`;
      tMsg.classList.remove('bad');
    } else if (job && job.state === 'done') {
      const ck = st.ckpt || { n: 0, totalMb: 0 };
      tMsg.textContent = `训练完成：${job.exp}，共 ${log.done} 轮。去「模型」页挑一档试听（不会自动切换）`
        + (ck.n > 1 ? ` · 中间档 ${ck.n} 个 / ${ck.totalMb} MB，不会自动删，记得在下面清理` : '');
      tMsg.classList.remove('bad');
    } else if (job && job.state === 'error') {
      tMsg.textContent = `训练中断：${job.error || job.msg}`;
      tMsg.classList.add('bad');
    } else if (log.done) {
      tMsg.textContent = `logs/${st.exp} 里已有 ${log.done} 轮记录`;
      tMsg.classList.remove('bad');
    }

    if (log.error && running) {
      tMsg.textContent += ` · 日志里有报错：${log.error}`;
      tMsg.classList.add('bad');
    }

    // 顶栏状态始终反映正在进行的任务；空闲时不动（保留上一次操作的反馈）
    if (running) {
      msg.textContent = tMsg.textContent;
      msg.classList.toggle('bad', tMsg.classList.contains('bad'));
      fill.style.width = tFill.style.width;
    } else if (st.datasetBusy) {
      fill.style.width = '96%';
      msg.textContent = '数据集任务进行中…（切片中，取决于素材时长）';
      msg.classList.remove('bad');
    }

    paintLoss(log);

    tModels.replaceChildren();
    const ms = st.models || [];
    for (const m of ms.slice(-8)) {
      const row = el('div', 'fs-row');
      row.append(el('span', 'n', `${m.name}${m.current ? '（使用中）' : ''}`));
      row.append(el('span', 'r', `${m.epoch !== null ? 'e' + m.epoch : '最终'} · ${m.sizeMb} MB`));
      tModels.append(row);
    }
    if (!ms.length && st.exp) {
      tModels.append(el('div', 'fs-meta', `logs/${st.exp} 还没有产出模型`));
    }

    // 中间档统计：训练时每 10 轮写一个，200 轮会堆 20 个 × 53MB ≈ 1GB
    const ck = st.ckpt || { n: 0, totalMb: 0 };
    ckptMeta.textContent = ck.n ? `${ck.n} 个 · ${ck.totalMb} MB` : '暂无';
    pruneBtn.disabled = !ck.n || running || pendingPrune;
    if (!pendingPrune) pruneBtn.textContent = '清理中间档';

    if (running && !trainTimer) trainTimer = setInterval(() => void pollTrain(), 3000);
    if (!running && trainTimer) {
      clearInterval(trainTimer);
      trainTimer = null;
    }
  };

  const pollTrain = async () => {
    try {
      const st = await ctx.invoke('trainStatus', [trainExp]);
      if (st.exp) trainExp = st.exp;
      paintTrain(st);
      if (st.job && st.job.state !== 'running' && trainTimer) {
        clearInterval(trainTimer);
        trainTimer = null;
        await loadDatasets(true);
      }
    } catch (e) {
      tMsg.textContent = (e && e.message) || String(e);
      tMsg.classList.add('bad');
    }
  };

  startT.addEventListener('click', async () => {
    if (!lastDir) {
      say('先选一个数据集', true);
      return;
    }
    const evalPaths = evaluationInputs.map((input) => input.value.trim().replace(/^["']|["']$/g, ''));
    if (abChk.checked) {
      const missingIdx = evalPaths.findIndex((p) => !p);
      if (missingIdx >= 0) {
        evalExpanded = true;
        syncEvalVisible();
        evaluationInputs[missingIdx].focus();
        say('已勾选「训练完生成选模对比」，请先填完低、中、高音三段独立干声路径', true);
        return;
      }
    }
    startT.disabled = true;
    try {
      const r = await call('trainStart', [{
        exp: String(expIn.value || '').trim(),
        epochs: Number(epIn.value) || 70,
        batch: Number(bsSel.value) || 4,
        saveEvery: Number(seIn.value) || 10,
        resume: resumeChk.checked,
        rebuild: rebuildChk.checked,
        pruneAfter: pruneAfterChk.checked,
        abTest: abChk.checked,
        evaluationPaths: evalPaths,
        augment: lowChk.checked,
        keepEvery: Math.max(1, Number(keepIn.value) || 50),
      }]);
      if (r && r.exp) {
        trainExp = r.exp;
        expIn.value = r.exp;
      }
      await pollTrain();
    } catch {
      startT.disabled = false;
    }
  });

  stopT.addEventListener('click', async () => {
    stopT.disabled = true;
    try {
      const r = await call('trainStop', []);
      // 把 world 的实话显示出来：真停了 / 没停住 都要看得见
      if (r && r.text) say(r.text, !/^已停止/.test(String(r.text)));
    } catch {
      /* 已显示 */
    }
    await pollTrain();
  });

  let exps = [];

  const loadExperiments = async () => {
    try {
      const r = await ctx.invoke('experiments', []);
      exps = (r && r.items) || [];
      expSel.replaceChildren();
      if (!exps.length) {
        const o = el('option', '', '（没有可导入的实验）');
        o.value = '';
        expSel.append(o);
        importBtn.disabled = true;
        expMeta.textContent = '训练切片（logs/<实验>/0_gt_wavs）已经不在了，只能从原始音频重建';
        return;
      }
      for (const it of exps) {
        const o = el('option', '', `${it.exp}（${it.slices} 片${it.models.length ? ' · ' + it.models.join(',') : ''}）`);
        o.value = it.exp;
        expSel.append(o);
      }
      importBtn.disabled = false;
      expMeta.textContent = '';
    } catch (e) {
      expMeta.textContent = (e && e.message) || String(e);
    }
  };

  importBtn.addEventListener('click', async () => {
    const exp = String(expSel.value || '');
    if (!exp) return;
    const cur = lastDir;
    const appendTo = cur && appendChk.checked ? cur : '';
    importBtn.disabled = true;
    try {
      await call('import', [exp, appendTo]);
      timer = setInterval(() => void poll(), 900);
      await poll();
    } finally {
      importBtn.disabled = false;
    }
  });

  appendChk.addEventListener('change', () => {
    appendLabel.textContent = appendChk.checked ? '追加到当前数据集' : '新建数据集';
  });


  scanBtn.addEventListener('click', async () => {
    const raw = String(pathIn.value || '').trim();
    if (!raw) {
      say('先填路径', true);
      return;
    }
    const paths = raw.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
    say('扫描中…');
    try {
      const res = await call('scan', [paths]);
      items = (res && res.items) || [];
      checked = new Set(items.filter((x) => !x.error).map((x) => x.path));
      renderList();
      const bad = items.filter((x) => x.error).length;
      say(`扫到 ${items.length} 个文件${bad ? `，${bad} 个读不了` : ''}`);
    } catch {
      items = [];
      renderList();
    }
  });

  modeSel.addEventListener('change', () => {
    lenIn.style.display = modeSel.value === 'fixed' ? '' : 'none';
  });

  startBtn.addEventListener('click', async () => {
    const picked = items.filter((x) => checked.has(x.path));
    if (!picked.length) {
      say('没勾选任何素材', true);
      return;
    }
    const params = {
      sliceMode: modeSel.value,
      separator: sepSel.value,
      dereverb: derevChk.checked,
    };
    if (modeSel.value === 'fixed') params.targetLen = Number(lenIn.value) || 3.7;
    const opts = lastDir && appendChk.checked ? { dir: lastDir, append: true } : {};
    startBtn.disabled = true;
    try {
      await call('start', [picked, params, opts]);
      timer = setInterval(() => void poll(), 900);
      await poll();
    } catch {
      startBtn.disabled = false;
    }
  });

  stopBtn.addEventListener('click', () => void call('cancel', []).then(() => poll()));

  void poll();
  void loadDatasets();
  void loadExperiments();
  void pollTrain();

  return {
    dispose() {
      if (timer) clearInterval(timer);
      if (trainTimer) clearInterval(trainTimer);
    },
  };
}

/* ------------------------------------------------------------------ 试唱 / 点歌 */

function mountSing(ctx) {
  ensureStyle();

  const root = ctx.root;
  root.classList.add('fs-wrap');

  const mkField = (label, node) => {
    const box = el('label', 'fs-field');
    box.append(el('span', 'fs-flabel', label), node);
    return box;
  };
  const mkSel = (opts, defVal) => {
    const s = el('select', 'fs-btn');
    for (const [v, t] of opts) {
      const o = el('option', '', t);
      o.value = v;
      if (String(v) === String(defVal)) o.selected = true;
      s.append(o);
    }
    return s;
  };

  // ---- 顶栏：搜索 / 指定来源 + 核心操作
  const bar1 = el('div', 'fs-bar');
  const songIn = el('input', 'fs-tpath');
  songIn.placeholder = '输入歌名（搜 B 站）、BV 号（BV1xx...）、B 站链接或本机音频绝对路径';
  const orderSel = mkSel([['default', 'B 站综合'], ['click', '按播放量'], ['pubdate', '按最新']], 'default');
  const searchBtn = el('button', 'fs-btn', 'B 站搜歌');
  const singBtn = el('button', 'fs-btn on', '开始试唱');
  const enqueueBtn = el('button', 'fs-btn', '+ 加入队列');
  const stopBtn = el('button', 'fs-btn danger', '停止');
  const unloadBtn = el('button', 'fs-btn', '释放显存');
  unloadBtn.title = '立即卸载常驻 GPU 模型归还显存（下次点歌自动拉回）';
  bar1.append(songIn, orderSel, searchBtn, singBtn, enqueueBtn, stopBtn, unloadBtn);

  // ---- 调参栏
  const bar2 = el('div', 'fs-sgrid');
  const startIn = el('input', 'fs-sin-sm');
  startIn.type = 'number';
  startIn.placeholder = '0';
  const durIn = el('input', 'fs-sin-sm');
  durIn.type = 'number';
  durIn.placeholder = '整首';
  const pitchIn = el('input', 'fs-sin-sm');
  pitchIn.value = 'auto';
  pitchIn.title = 'auto 或半音数（如 0、+3、-2）';
  const idxIn = el('input', 'fs-sin-sm');
  idxIn.type = 'number';
  idxIn.step = '0.05';
  idxIn.min = '0';
  idxIn.max = '1';
  const protIn = el('input', 'fs-sin-sm');
  protIn.type = 'number';
  protIn.step = '0.02';
  protIn.min = '0';
  protIn.max = '0.5';
  const rmsIn = el('input', 'fs-sin-sm');
  rmsIn.type = 'number';
  rmsIn.step = '0.05';
  rmsIn.min = '0';
  rmsIn.max = '1';

  const modeSel = mkSel([['full', '带伴奏'], ['vocals', '清唱']], 'full');
  const sepSel = mkSel([['htdemucs', '快速 htdemucs'], ['roformer', 'UVR5 RoFormer 精唱']], 'htdemucs');
  const derevSel = mkSel([['off', '关去混响'], ['on', '开去混响']], 'off');
  const karaokeSel = mkSel([['off', '关去伴唱'], ['on', '开去伴唱(Karaoke)']], 'off');
  karaokeSel.title = '分离后再用 UVR5 MelBand RoFormer Karaoke 剥离原唱垫音/伴唱和声';
  const f0Sel = mkSel([['rmvpe', 'rmvpe'], ['fcpe', 'fcpe']], 'rmvpe');
  const dynSel = mkSel([['off', '统一音色'], ['soft-verse-bright-chorus', '主歌柔/副歌亮']], 'off');
  const harmSel = mkSel([
    ['off', '无和声'],
    ['double', '双轨厚声(副歌)'],
    ['double+third', '双轨+轻三度'],
    ['third', '三度和声'],
    ['third+fifth', '三+五度'],
  ], 'off');
  const revSel = mkSel([['off', '关混响'], ['light', '轻度混响']], 'off');
  const duetSel = mkSel([['', '单人演唱']], '');
  duetSel.title = '选择另一个音色模型做双人真合唱/对唱';
  const duetModeSel = mkSel([['alternate', '主歌对唱+副歌合唱'], ['unison', '全程双声部合唱']], 'alternate');
  const toIn = el('input', 'fs-tin');
  toIn.value = 'local';
  toIn.title = 'local / group:群号 / private:QQ号';
  const refreshChk = el('input', 'fs-ck');
  refreshChk.type = 'checkbox';
  const refreshLbl = el('label', 'fs-meta', '忽略缓存');
  refreshLbl.prepend(refreshChk);

  bar2.append(
    mkField('起始(秒)', startIn),
    mkField('时长(秒)', durIn),
    mkField('移调', pitchIn),
    mkField('indexRate', idxIn),
    mkField('protect', protIn),
    mkField('rmsMix', rmsIn),
    mkField('模式', modeSel),
    mkField('分离', sepSel),
    mkField('去混响', derevSel),
    mkField('去伴唱', karaokeSel),
    mkField('F0', f0Sel),
    mkField('主副歌', dynSel),
    mkField('和声', harmSel),
    mkField('混响', revSel),
    mkField('合唱搭档', duetSel),
    mkField('合唱方式', duetModeSel),
    mkField('投递', toIn),
    refreshLbl,
  );

  const prog = el('div', 'fs-prog');
  const fill = el('i');
  prog.append(fill);
  const msg = el('div', 'fs-msg');
  const statusMeta = el('div', 'fs-meta', '');

  // ---- 点歌队列 / 小歌会条
  const qCard = el('div', 'fs-card2');
  const qBar = el('div', 'fs-bar');
  const qTitle = el('span', 'fs-wtitle', '点歌队列（0 首）');
  const qModeSel = mkSel([['sequence', '顺序连唱'], ['loop-one', '单曲循环'], ['loop-all', '列表循环']], 'sequence');
  const qRepBtn = el('button', 'fs-btn', '⭐ 排入拿手歌会');
  const qNextBtn = el('button', 'fs-btn', '切下一首');
  const qClearBtn = el('button', 'fs-btn', '清空');
  qBar.append(qTitle, el('span', 'fs-grow'), qModeSel, qRepBtn, qNextBtn, qClearBtn);
  const qList = el('div', 'fs-list');
  qList.style.marginTop = '4px';
  qCard.append(qBar, qList);

  const hitsBox = el('div', '');

  // ---- 折叠区：歌词时间轴、声学体检 & 局部返工补录
  const patchSec = el('details', 'fs-sec');
  const patchSum = el('summary', '');
  patchSum.append(
    el('span', '', '歌词时间轴 / 声学体检 & 局部返工补录'),
    el('span', 'fs-sec-hint', '唱完后可查看体检、按句号/副歌/当前句局部重唱'),
  );
  const patchBody = el('div', 'fs-sec-body');
  const pBar = el('div', 'fs-sgrid');
  const lyrLoadBtn = el('button', 'fs-btn', '读取歌词与体检');
  const lyrQueryIn = el('input', 'fs-tin');
  lyrQueryIn.style.width = '140px';
  lyrQueryIn.placeholder = '指定歌名(如 潮汐 傅梦彤)';
  const lyrRefBtn = el('button', 'fs-btn', '重新联网匹配歌词');
  const pLocSel = mkSel([['lines', '按句号/关键词'], ['chorus', '第 1 段副歌'], ['current', '当前正唱这句']], 'lines');
  const pLinesIn = el('input', 'fs-sin-sm');
  pLinesIn.placeholder = '如 7-9';
  const pKwIn = el('input', 'fs-tin');
  pKwIn.placeholder = '歌词关键词';
  const pProtIn = el('input', 'fs-sin-sm');
  pProtIn.type = 'number';
  pProtIn.step = '0.02';
  pProtIn.placeholder = '不变';
  const pIdxIn = el('input', 'fs-sin-sm');
  pIdxIn.type = 'number';
  pIdxIn.step = '0.05';
  pIdxIn.placeholder = '不变';
  const pPrevChk = el('input', 'fs-ck');
  pPrevChk.type = 'checkbox';
  pPrevChk.checked = true;
  const pPrevLbl = el('label', 'fs-meta', '仅试听这句');
  pPrevLbl.prepend(pPrevChk);
  const pRunBtn = el('button', 'fs-btn on', '局部返工补录');
  const autoFixBtn = el('button', 'fs-btn', '🩺 自动修问题句');
  autoFixBtn.title = '根据声学体检报告标出的破音/越界段，自动切 fcpe 或调参逐段修补并无缝贴回';
  pBar.append(
    lyrLoadBtn,
    lyrQueryIn,
    lyrRefBtn,
    mkField('定位', pLocSel),
    mkField('句号', pLinesIn),
    mkField('关键词', pKwIn),
    mkField('protect', pProtIn),
    mkField('indexRate', pIdxIn),
    pPrevLbl,
    pRunBtn,
    autoFixBtn,
  );
  const pMsg = el('div', 'fs-msg');
  const offBar = el('div', 'fs-lyr-bar');
  const offMeta = el('span', 'fs-meta', '偏移：0.0s');
  const mkOffBtn = (lbl, delta, reset) => {
    const b = el('button', 'fs-btn', lbl);
    b.addEventListener('click', () => void adjustOffset(delta, reset));
    return b;
  };
  const seekStartBtn = el('button', 'fs-btn', '▶ 从头播');
  const seekChBtn = el('button', 'fs-btn', '▶ 跳副歌');
  offBar.append(
    el('span', 'fs-meta', '歌词对齐：'),
    mkOffBtn('-2s', -2, false),
    mkOffBtn('-0.5s', -0.5, false),
    mkOffBtn('+0.5s', 0.5, false),
    mkOffBtn('+2s', 2, false),
    mkOffBtn('重置', 0, true),
    offMeta,
    seekStartBtn,
    seekChBtn,
  );
  const lyrHead = el('div', 'fs-hint', '点「读取歌词与体检」查看最近一首歌的时间轴歌词与声学体检明细（点击任意一句可直接跳播）');
  const lyrList = el('div', 'fs-lyr-list');
  patchBody.append(pBar, offBar, pMsg, lyrHead, lyrList);
  patchSec.append(patchSum, patchBody);

  root.append(bar1, bar2, prog, msg, statusMeta, qCard, hitsBox, patchSec);

  let inited = false;
  let pollTimer = null;
  let lastLyricsData = null;

  const say = (t, bad) => {
    msg.textContent = t || '';
    msg.classList.toggle('bad', Boolean(bad));
  };

  const renderLyrics = (r, activeLineIdx) => {
    lastLyricsData = r;
    const off = Number((r && r.offsetSec) || 0);
    const autoOff = r && r.autoOffsetSec;
    const isAuto = typeof autoOff === 'number' && Math.abs(autoOff - off) < 0.05 && Math.abs(off) >= 0.05;
    offMeta.textContent = `偏移：${off > 0 ? '+' : ''}${off.toFixed(1)}s${isAuto ? '（自动校准）' : ''}`;
    const infoLines = [];
    if (r && r.title) {
      infoLines.push(`《${r.title}》（${fmtDur(r.durationSec)}）${r.sourceLabel ? ` · ${r.sourceLabel}` : ''}`);
    }
    if (r && r.summary) infoLines.push(`声学体检：${r.summary}`);
    if (r && Array.isArray(r.issues) && r.issues.length) {
      infoLines.push('风险时间段：' + r.issues.map((it) => it.note).join('；'));
    }
    lyrHead.textContent = infoLines.length ? infoLines.join('\n') : ((r && r.text) || '暂无歌词记录');

    lyrList.replaceChildren();
    const lines = (r && r.lines) || [];
    if (!lines.length) {
      lyrList.append(el('div', 'fs-meta', '（暂无逐句歌词，点「读取歌词与体检」加载）'));
      return;
    }
    const nowIdx = Number(activeLineIdx || (r && r.playingLine) || 0);
    for (const ln of lines) {
      const row = el('div', `fs-lyr-item${nowIdx === ln.index ? ' now' : ''}`);
      row.title = `点击从第 ${ln.index} 句（${fmtDur(ln.start)}）开始跳播`;
      row.append(
        el('span', 'fs-lyr-idx', String(ln.index)),
        el('span', 'fs-lyr-tm', `${fmtDur(ln.start)}–${fmtDur(ln.end)}`),
      );
      if (ln.section === 'chorus') row.append(el('span', 'fs-lyr-ch', '副歌'));
      row.append(el('span', 'fs-lyr-txt', ln.text));
      row.addEventListener('click', () => void runSeek({ line: ln.index }));
      lyrList.append(row);
    }
  };

  const adjustOffset = async (delta, reset) => {
    try {
      const r = await ctx.invoke('offset', [delta, Boolean(reset)]);
      pMsg.classList.remove('bad');
      pMsg.textContent = (r && r.text) || '偏移已更新';
      renderLyrics(r);
    } catch (e) {
      pMsg.classList.add('bad');
      pMsg.textContent = (e && e.message) || String(e);
    }
  };

  const runSeek = async (payload) => {
    try {
      const r = await ctx.invoke('seek', [payload]);
      pMsg.classList.remove('bad');
      pMsg.textContent = (r && r.text) || '已跳播';
      void refreshStatus();
    } catch (e) {
      pMsg.classList.add('bad');
      pMsg.textContent = (e && e.message) || String(e);
    }
  };

  seekStartBtn.addEventListener('click', () => void runSeek({ sec: 0 }));
  seekChBtn.addEventListener('click', () => void runSeek({ section: 'chorus', chorusIndex: 1 }));

  const refreshStatus = async () => {
    try {
      const st = await ctx.invoke('status', []);
      if (!inited && st && st.defaults) {
        inited = true;
        const d = st.defaults;
        pitchIn.value = String(d.pitch ?? 'auto');
        idxIn.value = String(d.indexRate ?? 0.75);
        protIn.value = String(d.protect ?? 0.33);
        rmsIn.value = String(d.rmsMixRate ?? 0);
        modeSel.value = d.mode || 'full';
        sepSel.value = d.separator || 'htdemucs';
        derevSel.value = d.dereverb ? 'on' : 'off';
        karaokeSel.value = d.karaoke ? 'on' : 'off';
        f0Sel.value = d.f0Method || 'rmvpe';
        dynSel.value = d.dynamicStyle || 'off';
        harmSel.value = d.harmony || 'off';
        revSel.value = d.reverb || 'off';
      }
      if (st && Array.isArray(st.models) && duetSel.options.length <= 1) {
        const curVal = duetSel.value;
        duetSel.replaceChildren();
        const noneOpt = el('option', '', '单人演唱');
        noneOpt.value = '';
        duetSel.append(noneOpt);
        for (const m of st.models) {
          const o = el('option', '', m.current ? `${m.name}（当前）` : m.name);
          o.value = m.name;
          if (m.name === curVal) o.selected = true;
          duetSel.append(o);
        }
      }
      const w = st && st.worker;
      const cur = w && w.current;
      const pb = st && st.playback;
      const parts = [];
      parts.push(`模型：${(st && st.model) || '—'}`);
      if (w && w.engine) {
        parts.push(w.engine.ready ? '显存已预热' : '已休眠省显存');
        if (w.engine.uvrAvailable) parts.push('UVR5可用');
      } else {
        parts.push('worker 待启动');
      }
      if (cur) {
        const pct = Math.round((cur.progress || 0) * 100);
        fill.style.width = `${pct}%`;
        parts.push(`进度 ${pct}%：${cur.message || ''}`);
      } else if (!st.busy) {
        fill.style.width = '0%';
      }
      if (pb && pb.playing) {
        const ltxt = pb.currentLine ? ` · 第 ${pb.currentLine.index} 句「${pb.currentLine.text}」` : '';
        parts.push(`播放中《${pb.title || ''}》${fmtDur(pb.elapsedSec)}/${fmtDur(pb.durationSec)}${ltxt}`);
        if (lastLyricsData && pb.currentLine) renderLyrics(lastLyricsData, pb.currentLine.index);
      }
      statusMeta.textContent = parts.join(' · ');
      singBtn.disabled = Boolean(st && (st.busy || st.training));

      // 更新队列区
      const q = (st && st.queue) || { mode: 'sequence', items: [] };
      const qItems = Array.isArray(q.items) ? q.items : [];
      qTitle.textContent = `点歌队列（${qItems.length} 首）`;
      if (q.mode) qModeSel.value = q.mode;
      qNextBtn.disabled = qItems.length === 0;
      qClearBtn.disabled = qItems.length === 0;
      qList.replaceChildren();
      if (!qItems.length) {
        qList.append(el('div', 'fs-meta', '暂无待唱曲目：点「+ 加入队列」连点多首，或点「⭐ 排入拿手歌会」一键连唱（唱第 1 首时自动在后台预热第 2 首）'));
      } else {
        const stLbl = (s) => (s === 'ready' ? '已就绪' : s === 'warming' ? '后台预热中' : s === 'failed' ? '失败' : '待准备');
        qItems.forEach((it, idx) => {
          const row = el('div', 'fs-row');
          const left = el('span', 'n', `${idx + 1}. 《${it.title}》`);
          const right = el('span', 'r');
          const tag = el('span', 'fs-tag', stLbl(it.state));
          if (it.state === 'ready') tag.classList.add('fs-ok');
          else if (it.state === 'failed') tag.classList.add('fs-bad');
          const rm = el('button', 'fs-btn', '移出');
          rm.style.marginLeft = '6px';
          rm.addEventListener('click', async () => {
            try {
              const r = await ctx.invoke('queueRemove', [it.qid]);
              say((r && r.text) || '已移出');
            } catch (e) {
              say((e && e.message) || String(e), true);
            }
            void refreshStatus();
          });
          right.append(tag, rm);
          row.append(left, right);
          qList.append(row);
        });
      }
    } catch (e) {
      statusMeta.textContent = (e && e.message) || String(e);
    }
  };

  const runSing = async (songOverride) => {
    const song = String(songOverride ?? songIn.value ?? '').trim();
    if (!song) {
      say('请先输入歌名、BV 号或本机路径', true);
      return;
    }
    if (songOverride) songIn.value = songOverride;
    const payload = {
      song,
      mode: modeSel.value,
      to: toIn.value.trim() || 'local',
      order: orderSel.value,
      separator: sepSel.value,
      dereverb: derevSel.value === 'on',
      karaoke: karaokeSel.value === 'on',
      f0Method: f0Sel.value,
      dynamicStyle: dynSel.value,
      harmony: harmSel.value,
      reverb: revSel.value,
      duetModel: duetSel.value || '',
      duetMode: duetModeSel.value || 'alternate',
      refresh: refreshChk.checked,
    };
    if (startIn.value !== '') payload.start = Number(startIn.value);
    if (durIn.value !== '') payload.duration = Number(durIn.value);
    if (pitchIn.value.trim() !== '') payload.pitch = pitchIn.value.trim();
    if (idxIn.value !== '') payload.indexRate = Number(idxIn.value);
    if (protIn.value !== '') payload.protect = Number(protIn.value);
    if (rmsIn.value !== '') payload.rmsMixRate = Number(rmsIn.value);

    singBtn.disabled = true;
    say('处理中（分离 / 换声 / 体检 / 混音），请观察下方实时进度…');
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void refreshStatus(), 1200);
    try {
      const r = await ctx.invoke('sing', [payload]);
      fill.style.width = '100%';
      say((r && r.text) || '试唱完成');
      void loadLyrics(false);
    } catch (e) {
      say((e && e.message) || String(e), true);
    } finally {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      await refreshStatus();
    }
  };

  const loadLyrics = async (forceRefresh) => {
    try {
      const q = forceRefresh ? String(lyrQueryIn.value || '').trim() : '';
      const r = await ctx.invoke('lyrics', [Boolean(forceRefresh), q]);
      renderLyrics(r);
    } catch (e) {
      lyrHead.textContent = (e && e.message) || String(e);
    }
  };

  searchBtn.addEventListener('click', async () => {
    const kw = songIn.value.trim();
    if (!kw) {
      say('请先输入要搜的歌名或关键词', true);
      return;
    }
    searchBtn.disabled = true;
    say(`正在 B 站搜索「${kw}」…`);
    hitsBox.replaceChildren();
    try {
      const r = await ctx.invoke('search', [kw, orderSel.value]);
      const hits = (r && r.hits) || [];
      if (!hits.length) {
        say('B 站没搜到候选，换个关键词或直接贴 BV 号', true);
        return;
      }
      say(`搜到 ${hits.length} 条，点「选这条唱」即可拉取试唱`);
      const tbl = el('table', 'fs-table');
      const thead = el('thead');
      const htr = el('tr');
      for (const h of ['#', '标题', '时长', 'UP 主', '播放', 'BV 号', '操作']) htr.append(el('th', '', h));
      thead.append(htr);
      const tbody = el('tbody');
      hits.forEach((h, i) => {
        const tr = el('tr');
        const wan = h.play >= 10000 ? `${(h.play / 10000).toFixed(1)}万` : String(h.play);
        const tdT = el('td', 'fs-title', h.title);
        tdT.title = h.title;
        const tdA = el('td', 'fs-acts');
        const pick = el('button', 'fs-btn on', '选这条唱');
        pick.addEventListener('click', () => void runSing(h.bvid));
        const qAdd = el('button', 'fs-btn', '+ 队列');
        qAdd.addEventListener('click', () => void runEnqueue(h.bvid));
        const fillBv = el('button', 'fs-btn', '填 BV');
        fillBv.addEventListener('click', () => {
          songIn.value = h.bvid;
          songIn.focus();
        });
        tdA.append(pick, qAdd, fillBv);
        tr.append(
          el('td', 'fs-num', String(i + 1)),
          tdT,
          el('td', 'fs-num', fmtDur(h.durationSec)),
          el('td', 'fs-meta', h.author || ''),
          el('td', 'fs-num', wan),
          el('td', 'fs-mname', h.bvid),
          tdA,
        );
        tbody.append(tr);
      });
      tbl.append(thead, tbody);
      hitsBox.append(tbl);
    } catch (e) {
      say((e && e.message) || String(e), true);
    } finally {
      searchBtn.disabled = false;
    }
  });

  const runEnqueue = async (songOverride) => {
    const song = String(songOverride ?? songIn.value ?? '').trim();
    if (!song) {
      say('请先输入要排进队列的歌名、BV 号或路径', true);
      return;
    }
    const payload = {
      song,
      mode: modeSel.value,
      separator: sepSel.value,
      dereverb: derevSel.value === 'on',
      karaoke: karaokeSel.value === 'on',
      f0Method: f0Sel.value,
      dynamicStyle: dynSel.value,
      harmony: harmSel.value,
      reverb: revSel.value,
      duetModel: duetSel.value || '',
      duetMode: duetModeSel.value || 'alternate',
    };
    if (pitchIn.value.trim() !== '') payload.pitch = pitchIn.value.trim();
    if (idxIn.value !== '') payload.indexRate = Number(idxIn.value);
    if (protIn.value !== '') payload.protect = Number(protIn.value);
    if (rmsIn.value !== '') payload.rmsMixRate = Number(rmsIn.value);
    try {
      const r = await ctx.invoke('queueAdd', [payload]);
      say((r && r.text) || '已加入队列');
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
    void refreshStatus();
  };

  singBtn.addEventListener('click', () => void runSing());
  enqueueBtn.addEventListener('click', () => void runEnqueue());
  qModeSel.addEventListener('change', async () => {
    try {
      const r = await ctx.invoke('queueMode', [qModeSel.value]);
      say((r && r.text) || '已切换循环模式');
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
    void refreshStatus();
  });
  qRepBtn.addEventListener('click', async () => {
    try {
      const r = await ctx.invoke('queueRepertoire', []);
      say((r && r.text) || '已排入拿手歌会');
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
    void refreshStatus();
  });
  qNextBtn.addEventListener('click', async () => {
    try {
      const r = await ctx.invoke('queueNext', []);
      say((r && r.text) || '已切下一首');
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
    void refreshStatus();
  });
  qClearBtn.addEventListener('click', async () => {
    try {
      const r = await ctx.invoke('queueClear', []);
      say((r && r.text) || '已清空队列');
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
    void refreshStatus();
  });
  stopBtn.addEventListener('click', async () => {
    try {
      const r = await ctx.invoke('stop', []);
      say((r && r.text) || '已停止');
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
    void refreshStatus();
  });
  unloadBtn.addEventListener('click', async () => {
    unloadBtn.disabled = true;
    try {
      const r = await ctx.invoke('unload', []);
      say((r && r.text) || '已释放显存');
    } catch (e) {
      say((e && e.message) || String(e), true);
    } finally {
      unloadBtn.disabled = false;
      void refreshStatus();
    }
  });
  songIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchBtn.click();
  });

  lyrLoadBtn.addEventListener('click', () => void loadLyrics(false));
  lyrRefBtn.addEventListener('click', () => void loadLyrics(true));
  pRunBtn.addEventListener('click', async () => {
    const payload = { previewOnly: pPrevChk.checked, to: 'local' };
    if (pLocSel.value === 'chorus') payload.section = 'chorus';
    else if (pLocSel.value === 'current') payload.atCurrent = true;
    else {
      if (pLinesIn.value.trim()) payload.lines = pLinesIn.value.trim();
      if (pKwIn.value.trim()) payload.lyric = pKwIn.value.trim();
    }
    if (pProtIn.value !== '') payload.protect = Number(pProtIn.value);
    if (pIdxIn.value !== '') payload.indexRate = Number(pIdxIn.value);
    pRunBtn.disabled = true;
    pMsg.classList.remove('bad');
    pMsg.textContent = '局部返工换声中（仅重跑目标句，约 2~6 秒）…';
    try {
      const r = await ctx.invoke('patch', [payload]);
      pMsg.textContent = (r && r.text) || '返工完成';
    } catch (e) {
      pMsg.classList.add('bad');
      pMsg.textContent = (e && e.message) || String(e);
    } finally {
      pRunBtn.disabled = false;
      void refreshStatus();
    }
  });

  autoFixBtn.addEventListener('click', async () => {
    autoFixBtn.disabled = true;
    pMsg.classList.remove('bad');
    pMsg.textContent = '正在按声学体检报告自动修补问题段（逐段切 fcpe / 调参贴回）…';
    try {
      const r = await ctx.invoke('autoFix', []);
      pMsg.textContent = (r && r.text) || '自动修补完成';
    } catch (e) {
      pMsg.classList.add('bad');
      pMsg.textContent = (e && e.message) || String(e);
    } finally {
      autoFixBtn.disabled = false;
      void refreshStatus();
    }
  });

  void refreshStatus();
  return {
    dispose() {
      if (pollTimer) clearInterval(pollTimer);
    },
  };
}

export default {
  panels: {
    setup: { mount: mountSetup },
    sing: { mount: mountSing },
    train: { mount: mountTrain },
    models: { mount: mountModels },
    library: { mount },
  },
};
