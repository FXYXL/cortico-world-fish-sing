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

const CSS = `
.fs-wrap{display:flex;flex-direction:column;gap:10px;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.fs-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fs-bar .fs-grow{flex:1}
.fs-btn{appearance:none;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;
  border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.fs-btn:hover{background:rgba(127,127,127,.12)}
.fs-btn:disabled{opacity:.4;cursor:default}
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
.fs-title{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-acts{display:flex;gap:6px;white-space:nowrap}
.fs-empty{padding:24px;text-align:center;opacity:.6}
.fs-tag{display:inline-block;padding:0 6px;border-radius:4px;background:rgba(127,127,127,.16);
  font-size:11px;margin-left:6px;opacity:.9}
.fs-edit{width:100%;padding:2px 6px;border-radius:4px;border:1px solid rgba(127,127,127,.4);
  background:transparent;color:inherit;font-size:12.5px}
`;

const STYLE_ID = 'fish-sing-library-style';

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
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }

  const root = ctx.root;
  root.classList.add('fs-wrap');

  // ---- 工具栏
  const bar = el('div', 'fs-bar');
  const refresh = el('button', 'fs-btn', '刷新');
  const stop = el('button', 'fs-btn', '停止播放');
  const reveal = el('button', 'fs-btn', '打开目录');
  const search = el('input', 'fs-input');
  search.placeholder = '按标题过滤…';
  const meta = el('span', 'fs-meta');
  bar.append(refresh, stop, reveal, el('span', 'fs-grow'), search, meta);

  const msg = el('div', 'fs-msg');
  const box = el('div', '');

  root.append(bar, msg, box);

  let items = [];
  let sortKey = 'at';
  let sortAsc = false;
  let filter = '';
  let playingId = '';
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
      stop.disabled = !playingId;
      const n = items.length;
      meta.textContent = n
        ? `共 ${n} 首 · ${data.totalMb || 0} MB · ${data.playingEnabled === false ? '本机播放已关' : ''}`
        : '还一首都没唱过';
      render();
      // 有在播的就每 2 秒对一次状态，播完自动取消高亮
      if (timer) clearTimeout(timer);
      if (playingId) timer = setTimeout(() => void load(), 2000);
    } catch {
      /* say() 已经提示过了 */
    }
  };

  const sorted = () => {
    const rows = filter
      ? items.filter((r) => String(r.title).toLowerCase().includes(filter))
      : items.slice();
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
      ['sizeMb', '大小'],
      ['at', '时间'],
      ['', '操作'],
    ];
    for (const [key, label] of cols) {
      const th = el('th', key ? '' : 'fs-num', label);
      if (key) {
        th.title = '点一下按这列排序';
        th.addEventListener('click', () => {
          if (sortKey === key) sortAsc = !sortAsc;
          else {
            sortKey = key;
            sortAsc = key !== 'at';
          }
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
    titleSpan.title = `${r.title}\n${r.bvid || ''}`;
    tdTitle.append(titleSpan);
    if (r.missing) tdTitle.append(el('span', 'fs-tag', '文件缺失'));
    if (r.target) tdTitle.append(el('span', 'fs-tag', r.target));

    tr.append(
      tdTitle,
      el('td', 'fs-num', fmtDur(r.durationSec)),
      el('td', 'fs-num', r.pitch ? `${r.pitch > 0 ? '+' : ''}${r.pitch}` : '0'),
      el('td', '', r.mode === 'vocals' ? '清唱' : '带伴奏'),
      el('td', 'fs-num', `${r.sizeMb} MB`),
      el('td', '', fmtTime(r.at)),
    );

    const acts = el('div', 'fs-acts');
    const play = el('button', 'fs-btn', '播放');
    play.addEventListener('click', () => void call('play', [r.id]));
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

    acts.append(play, rename, del);
    const tdActs = el('td');
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
    const table = el('table', 'fs-table');
    header(table);
    const tbody = el('tbody');
    for (const r of rows) tbody.append(rowOf(r));
    table.append(tbody);
    box.append(table);
  }

  refresh.addEventListener('click', () => {
    say('');
    void load();
  });
  stop.addEventListener('click', () => void call('stop', []).then(load).catch(() => {}));
  reveal.addEventListener('click', () => void call('reveal', []));
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    render();
  });

  void load();

  return {
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}

export default {
  panels: {
    library: { mount },
  },
};
