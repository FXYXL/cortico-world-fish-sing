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

const SETUP_STYLE_ID = 'fish-sing-setup-style';
const SETUP_CSS = `
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
.fs-hint{font-size:12px;opacity:.65;line-height:1.7}
`;

function mb(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
  return `${(v / 1048576).toFixed(1)} MB`;
}

function mountSetup(ctx) {
  if (!document.getElementById(SETUP_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = SETUP_STYLE_ID;
    style.textContent = SETUP_CSS;
    document.head.append(style);
  }

  const root = ctx.root;
  root.classList.add('fs-wrap');

  const cards = el('div', 'fs-cards');
  const bar = el('div', 'fs-bar');
  const dl = el('button', 'fs-btn', '下载模型权重');
  const gpu = el('button', 'fs-btn', '安装 GPU 运行时');
  const cpu = el('button', 'fs-btn', '安装 CPU 运行时');
  const stopBtn = el('button', 'fs-btn danger', '停止');
  const refresh = el('button', 'fs-btn', '刷新');
  bar.append(dl, gpu, cpu, stopBtn, el('span', 'fs-grow'), refresh);

  const prog = el('div', 'fs-prog');
  const fill = el('i');
  prog.append(fill);

  const msg = el('div', 'fs-msg');
  const list = el('div', 'fs-list');
  const hint = el('div', 'fs-hint');
  hint.textContent =
    '权重约 909 MB（模型 + 检索索引 + ContentVec + RMVPE + 底模），下载后会自动校验 sha256。\n'
    + '运行时是 Python 环境：GPU 版下载约 2.5 GB、装完约 6 GB（55 秒的歌约 8 秒换完）；'
    + 'CPU 版只要约 200 MB，但慢 6~8 倍。已经装好 torch 的不会被覆盖。';

  root.append(cards, bar, prog, msg, list, hint);

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
    cards.replaceChildren(
      card('RVC 代码', st.rvc && st.rvc.ready ? '已就绪' : '缺失', st.rvc && st.rvc.ready ? 'ok' : 'bad'),
      card('模型权重', `${ready}/${m.length} · ${mb(st.doneBytes)}`, ready === m.length ? 'ok' : ready ? 'warn' : 'bad'),
      card('Python 运行时', st.python && st.python.ok ? '已就绪' : '未安装', st.python && st.python.ok ? 'ok' : 'bad'),
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
    stopBtn.disabled = !running;
    fill.style.width = `${running ? job.pct : job && job.state === 'done' ? 100 : 0}%`;

    if (job) {
      const head = job.state === 'running' ? `${job.pct}% · ${job.msg}`
        : job.state === 'done' ? `✓ 完成：${job.kind === 'models' ? '权重下载' : '运行时安装'}`
          : `✗ ${job.error || job.msg}`;
      say(head, job.state === 'error');
      lastJob = `${job.state}${job.pct}${job.msg}`;
    }

    // 按钮文案跟着状态走，避免"已经装好了还写着安装"
    dl.textContent = ready === m.length ? '校验 / 补下权重' : `下载模型权重（${mb(st.totalBytes - st.doneBytes)}）`;
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

export default {
  panels: {
    setup: { mount: mountSetup },
    library: { mount },
  },
};
