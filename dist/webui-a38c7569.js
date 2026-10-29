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


/* ------------------------------------------------------------------ 模型 */

const MODELS_STYLE_ID = 'fish-sing-models-style';
const MODELS_CSS = `
.fs-mhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fs-mtable{width:100%;border-collapse:collapse;font-size:12.5px}
.fs-mtable th,.fs-mtable td{padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.18);
  text-align:left;vertical-align:middle}
.fs-mtable th{font-weight:600;opacity:.75;white-space:nowrap}
.fs-mtable tbody tr:hover{background:rgba(127,127,127,.07)}
.fs-mtable tr.on{background:rgba(80,160,255,.12)}
.fs-dot{color:#3fae62;font-weight:700}
.fs-mname{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.fs-tagx{display:inline-block;padding:0 5px;border-radius:4px;background:rgba(127,127,127,.16);
  font-size:11px;margin-left:6px}
`;

function fmtDate(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function mountModels(ctx) {
  if (!document.getElementById(MODELS_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = MODELS_STYLE_ID;
    style.textContent = MODELS_CSS;
    document.head.append(style);
  }

  const root = ctx.root;
  root.classList.add('fs-wrap');

  const bar = el('div', 'fs-mhead');
  const refresh = el('button', 'fs-btn', '刷新');
  const imp = el('button', 'fs-btn', '导入 .pth');
  const reveal = el('button', 'fs-btn', '打开目录');
  const meta = el('span', 'fs-meta');
  bar.append(refresh, imp, reveal, el('span', 'fs-meta', ' '), el('span', 'fs-grow'), meta);

  const msg = el('div', 'fs-msg');
  const box = el('div', '');
  root.append(bar, msg, box);

  let rows = [];
  let pendingDelete = '';

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

  const render = () => {
    box.replaceChildren();
    if (!rows.length) {
      box.append(el('div', 'fs-empty', '还没有模型。下载权重或训练一个之后会出现在这里。'));
      return;
    }
    const table = el('table', 'fs-mtable');
    const thead = el('thead');
    const htr = el('tr');
    for (const h of ['', '模型', '轮次', '大小', '时间', '索引', '操作']) htr.append(el('th', '', h));
    thead.append(htr);
    const tbody = el('tbody');

    for (const r of rows) {
      const tr = el('tr', r.current ? 'on' : '');
      tr.append(el('td', 'fs-dot', r.current ? '●' : ''));

      const nameTd = el('td');
      nameTd.append(el('span', 'fs-mname', r.name));
      if (r.current) nameTd.append(el('span', 'fs-tagx', '使用中'));
      tr.append(nameTd);

      tr.append(el('td', 'fs-num', r.epoch !== null ? `e${r.epoch}` : '最终'));
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
      render();
    } catch (e) {
      say((e && e.message) || String(e), true);
    }
  };

  refresh.addEventListener('click', () => void load());
  reveal.addEventListener('click', () => void call('reveal', []));
  imp.addEventListener('click', async () => {
    const path = window.prompt('粘贴 .pth 的完整路径（会复制到 assets/weights）');
    if (!path) return;
    try {
      await call('import', [path.trim()]);
      await load();
    } catch {
      /* 错误已经显示在消息行 */
    }
  });

  void load();

  return { dispose() {} };
}


/* ------------------------------------------------------------------ 训练数据 */

const TRAIN_STYLE_ID = 'fish-sing-train-style';
const TRAIN_CSS = `
.fs-tpath{flex:1;min-width:280px;padding:5px 8px;border-radius:6px;
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
.fs-ck{width:14px;height:14px;cursor:pointer}
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
.fs-card2 .k{opacity:.6;font-size:11px}
.fs-card2 .v{font-size:15px;font-weight:600;margin-top:1px}
`;

function fmtSec(v) {
  const s = Math.max(0, Math.round(Number(v) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function mountTrain(ctx) {
  if (!document.getElementById(TRAIN_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = TRAIN_STYLE_ID;
    style.textContent = TRAIN_CSS;
    document.head.append(style);
  }

  const root = ctx.root;
  root.classList.add('fs-wrap');

  const bar = el('div', 'fs-bar');
  const pathIn = el('input', 'fs-tpath');
  pathIn.placeholder = '粘贴素材文件夹或单个文件路径，可多个用 ; 分隔';
  const scanBtn = el('button', 'fs-btn', '扫描');
  bar.append(pathIn, scanBtn);

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
  const startBtn = el('button', 'fs-btn', '开始处理');
  startBtn.disabled = true;
  const stopBtn = el('button', 'fs-btn danger', '停止');
  stopBtn.disabled = true;
  const revealBtn = el('button', 'fs-btn', '打开目录');
  bar2.append(modeSel, lenIn, startBtn, stopBtn, el('span', 'fs-grow'), revealBtn);

  const msg = el('div', 'fs-msg');
  const prog = el('div', 'fs-prog');
  const fill = el('i');
  prog.append(fill);
  const listBox = el('div', '');
  const resultBox = el('div', '');
  const weightBox = el('div', '');

  root.append(bar, bar2, prog, msg, listBox, resultBox, weightBox);

  let items = [];
  let checked = new Set();
  let timer = null;

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

  const afterShares = () => {
    const total = wrows.reduce((n, r) => n + r.seconds * (wcfg.bands[r.id] ?? 1), 0) || 1;
    return wrows.map((r) => (r.seconds * (wcfg.bands[r.id] ?? 1)) / total);
  };

  const paintWeightNumbers = () => {
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
    foot.append(saveBtn, el('span', 'fs-meta', '保存后训练会用这套权重：同一档的片段被抽到的概率按倍数放大，每轮步数不变'));
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
    }
    if (st.dataset) {
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
    const params = { sliceMode: modeSel.value };
    if (modeSel.value === 'fixed') params.targetLen = Number(lenIn.value) || 3.7;
    startBtn.disabled = true;
    try {
      await call('start', [picked, params]);
      timer = setInterval(() => void poll(), 900);
      await poll();
    } catch {
      startBtn.disabled = false;
    }
  });

  stopBtn.addEventListener('click', () => void call('cancel', []).then(() => poll()));
  revealBtn.addEventListener('click', () => void call('reveal', []).catch(() => {}));

  void poll();

  return {
    dispose() {
      if (timer) clearInterval(timer);
    },
  };
}

export default {
  panels: {
    setup: { mount: mountSetup },
    train: { mount: mountTrain },
    models: { mount: mountModels },
    library: { mount },
  },
};
