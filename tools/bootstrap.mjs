/**
 * 自托管迁移/安装器。
 *
 * 目标结构（<dataDir>/runtime/）：
 *   rvc/     ← 从插件包 vendor/rvc 复制的代码 + 下载/复制来的权重
 *   venv/    ← Python 运行时（torch/demucs/faiss/soundfile）
 *
 * 用法（从插件根目录跑，任何一步都可重复执行、失败重试）：
 *   node tools/bootstrap.mjs                  # 只体检，不动磁盘
 *   node tools/bootstrap.mjs rvc              # 复制代码（3 MB）
 *   node tools/bootstrap.mjs models           # 从已有 RVC 复制权重（约 1 GB）
 *   node tools/bootstrap.mjs models --download # 按 manifest 从 Release 下载
 *   node tools/bootstrap.mjs venv             # 复制现有 venv 并补 demucs（约 6.3 GB）
 *   node tools/bootstrap.mjs venv --fresh     # 新建 venv 从零装（要下 2.5 GB）
 *   node tools/bootstrap.mjs all              # rvc + models（不含 venv）
 *   node tools/bootstrap.mjs verify           # 检查运行时依赖是否齐
 *
 * 常用参数：
 *   --data <dir>    插件数据目录（默认探测 Coopanion）
 *   --from <dir>    已有 RVC 项目根（默认 D:\AI\rvc）
 *   --link          权重复制改用硬链接（同盘时几乎不占空间）
 *   --venv-src <p>  复制哪个 venv（默认自动找 <from>/venv）
 */
import { createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, statSync, cpSync, copyFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'assets', 'models.manifest.json'), 'utf8'));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const cmd = argv.find((a) => !a.startsWith('--') && !['copy', 'fresh', 'download'].includes(a)) || 'plan';

const COO = process.env.COOPANION_DIR || 'D:\\Coopanion';
const dataDir = resolve(
  opt('data', '') ||
    join(COO, 'data', 'home', 'companion', 'data', 'fish-sing'),
);
const runtimeRoot = join(dataDir, 'runtime');
const rvcRoot = join(runtimeRoot, 'rvc');
const venvRoot = join(runtimeRoot, 'venv');
const venvPy = join(venvRoot, 'Scripts', 'python.exe');
const fromRoot = resolve(opt('from', 'D:\\AI\\rvc'));
const venvSrc = resolve(opt('venv-src', join(fromRoot, 'venv')));

// ---------- 小工具 ----------
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const gb = (n) => `${(n / 1073741824).toFixed(2)} GB`;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const no = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const dot = (m) => console.log(`  \x1b[90m·\x1b[0m ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function sha256(file) {
  const { createReadStream } = await import('node:fs');
  const h = createHash('sha256');
  await new Promise((res, rej) => {
    const s = createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', res);
    s.on('error', rej);
  });
  return h.digest('hex');
}

function dirSize(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const f = join(p, e.name);
    if (e.isDirectory()) total += dirSize(f);
    else {
      try {
        total += statSync(f).size;
      } catch {
        /* 忽略被占用的文件 */
      }
    }
  }
  return total;
}

// ---------- 体检 ----------
function inspect() {
  head('自托管目录');
  console.log(`  数据目录   ${dataDir}`);
  console.log(`  运行时根   ${runtimeRoot}${existsSync(runtimeRoot) ? `（已存在，${gb(dirSize(runtimeRoot))}）` : '（还没有）'}`);

  head('① 代码');
  if (existsSync(join(rvcRoot, 'infer'))) ok(`runtime/rvc 已有代码（${mb(dirSize(join(rvcRoot, 'infer')))}+）`);
  else no('runtime/rvc 还没有代码 → node tools/bootstrap.mjs rvc');

  head('② 权重');
  for (const f of MANIFEST.files) {
    const p = join(rvcRoot, f.target);
    if (!existsSync(p)) {
      no(`${f.name}（${mb(f.size)}）缺`);
      continue;
    }
    const sz = statSync(p).size;
    ok(`${f.name}  ${mb(sz)}${sz === f.size ? '' : ` \x1b[33m(大小不符，应为 ${mb(f.size)})\x1b[0m`}`);
  }

  head('③ 运行时');
  if (existsSync(venvPy)) ok(`venv 在 ${venvPy}`);
  else no(`venv 还没有 → node tools/bootstrap.mjs venv`);

  head('可用的外部资源（迁移时直接抄过来，不用下载）');
  const srcModels = fromRoot;
  const missing = MANIFEST.files.filter((f) => !existsSync(join(srcModels, f.target))).length;
  if (missing === 0) ok(`${srcModels} 里权重齐全`);
  else no(`${srcModels} 里有 ${missing} 个权重缺失`);
  if (existsSync(join(srcModels, 'venv', 'Scripts', 'python.exe'))) ok(`${join(srcModels, 'venv')} 可复制`);
  else dot(`${srcModels} 下没 venv`);

  const sepPy = 'D:\\AI\\seed-vc\\venv\\Scripts\\python.exe';
  if (existsSync(sepPy)) ok(`demucs 在 ${sepPy}（迁移后会重装进 runtime venv）`);

  head('迁移后要不要改配置？');
  dot('不用改。worker 段的路径全留空 = 自动用 <数据目录>/runtime。');
  dot('只有「venv 还没建、想先跑起来」的中间态，才在控制台把 worker.pythonPath 临时填成外部 python。');
}

// ---------- ① 代码 ----------
function copyRvc() {
  head('复制 RVC 代码');
  const src = join(ROOT, 'vendor', 'rvc');
  if (!existsSync(src)) throw new Error(`插件包里没有 vendor/rvc：${src}`);
  mkdirSync(rvcRoot, { recursive: true });
  // 逐层复制，已有文件跳过——避免把已下载的权重覆盖成 vendor 里的空目录
  cpSync(src, rvcRoot, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (p) => !p.includes('__pycache__'),
  });
  ok(`代码 → ${rvcRoot}（${mb(dirSize(rvcRoot))}）`);
  // vendor 里只有 hubert 的两个 json，权重目录要自己建出来
  for (const f of MANIFEST.files) mkdirSync(dirname(join(rvcRoot, f.target)), { recursive: true });
}

// ---------- ② 权重 ----------
function copyModels() {
  head('搬权重');
  for (const f of MANIFEST.files) {
    const dst = join(rvcRoot, f.target);
    if (existsSync(dst) && statSync(dst).size === f.size) {
      ok(`${f.name} 已就位`);
      continue;
    }
    const src = join(fromRoot, f.target);
    if (!existsSync(src)) {
      no(`${f.name} 在 ${src} 找不到，跳过（可改用 --download）`);
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    const t0 = Date.now();
    if (flag('link')) {
      try {
        linkSync(src, dst);
        ok(`${f.name} 硬链接（${mb(f.size)}，不占空间）`);
        continue;
      } catch {
        dot('硬链接失败（跨盘或权限），改复制');
      }
    }
    cpSync(src, dst);
    ok(`${f.name} 复制完成（${mb(f.size)}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  }
}

async function downloadModels() {
  head(`下载权重（${MANIFEST.tag}）`);
  const base = MANIFEST.base.endsWith('/') ? MANIFEST.base : `${MANIFEST.base}/`;
  for (const f of MANIFEST.files) {
    const dst = join(rvcRoot, f.target);
    if (existsSync(dst) && statSync(dst).size === f.size) {
      ok(`${f.name} 已就位`);
      continue;
    }
    const url = base + encodeURIComponent(f.name);
    dot(`GET ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      no(`${f.name} 下载失败 HTTP ${res.status}（Release 建好了吗？tag 是不是 ${MANIFEST.tag}？）`);
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    const total = Number(res.headers.get('content-length') ?? f.size);
    let got = 0;
    const out = createWriteStream(dst);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      if (total) process.stdout.write(`\r    ${f.name} ${((got / total) * 100).toFixed(1)}%  ${mb(got)}/${mb(total)}   `);
    }
    await new Promise((r) => out.end(r));
    process.stdout.write('\n');
    const sz = statSync(dst).size;
    if (sz !== f.size) {
      no(`${f.name} 大小不符：${sz} vs ${f.size}`);
      continue;
    }
    if (flag('checksum')) {
      const h = await sha256(dst);
      if (h === f.sha256) ok(`${f.name} sha256 一致`);
      else no(`${f.name} sha256 不符！删掉重下`);
    } else {
      ok(`${f.name} 下载完成（${mb(sz)}）`);
    }
  }
}

// ---------- ③ 运行时 ----------
function makeVenv() {
  head('准备 Python 运行时');
  const fresh = flag('fresh') || !existsSync(join(venvSrc, 'Scripts', 'python.exe'));

  if (!existsSync(venvPy)) {
    if (!fresh) {
      dot(`复制 ${venvSrc} → ${venvRoot}（${gb(dirSize(venvSrc))}，几分钟）`);
      mkdirSync(dirname(venvRoot), { recursive: true });
      cpSync(venvSrc, venvRoot, { recursive: true, verbatimSymlinks: true });
      ok('venv 复制完成');
    } else {
      const sysPy = opt('python', 'python');
      dot(`新建 venv（用 ${sysPy}）`);
      const r = spawnSync(sysPy, ['-m', 'venv', venvRoot], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('建 venv 失败：系统里没有可用的 python（PATH 里加一个 3.10+ 的）');
      ok('venv 建好');
      installDeps(true);
    }
  } else {
    ok('venv 已存在，跳过');
  }

  // 复制来的 venv 往往没有 demucs（老机器上它在另一个环境里）
  ensureDemucs();
  head('检查依赖');
  verify();
}

function installDeps(full) {
  head(full ? '安装依赖（首次较慢，torch 约 2.5 GB）' : '补装依赖');
  const pip = (args) => {
    dot(`pip ${args.join(' ')}`);
    const r = spawnSync(venvPy, ['-m', 'pip', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`pip ${args.join(' ')} 失败`);
  };
  if (full) {
    pip(['install', '--upgrade', 'pip', '-i', 'https://mirrors.pku.edu.cn/pypi/simple']);
    pip([
      'install',
      'torch==2.7.1+cu118',
      'torchaudio==2.7.1+cu118',
      '--index-url',
      'https://mirrors.nju.edu.cn/pytorch/whl/cu118',
      '--extra-index-url',
      'https://mirrors.pku.edu.cn/pypi/simple',
    ]);
  }
  const req = join(rvcRoot, 'requirments_cu118_py312.txt');
  if (existsSync(req)) pip(['install', '-r', req]);
  pip(['install', 'demucs>=4.0.1', '-i', 'https://mirrors.pku.edu.cn/pypi/simple']);
}

function ensureDemucs() {
  if (!existsSync(venvPy)) return;
  const probe = spawnSync(venvPy, ['-c', 'import demucs, torch, faiss, soundfile, librosa'], { encoding: 'utf8' });
  if (probe.status === 0) {
    ok('依赖齐（torch/demucs/faiss/soundfile/librosa）');
    return;
  }
  const err = (probe.stderr || '').split('\n').filter((l) => l.includes('No module') || l.includes('Error')).slice(-1)[0] || '';
  dot(`缺依赖：${err.trim() || '未知'}`);
  // 只补 demucs —— 其余是在复制来的 venv 里本来就有；真缺就引导到 --fresh
  const r = spawnSync(venvPy, ['-m', 'pip', 'install', 'demucs>=4.0.1', '-i', 'https://mirrors.pku.edu.cn/pypi/simple'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) no('装 demucs 失败，检查网络或改用 venv --fresh');
  else ok('demucs 装好');
}

function verify() {
  if (!existsSync(venvPy)) {
    no(`venv 不存在：${venvPy}`);
    return;
  }
  const code = `
import importlib, sys
print('python', sys.version.split()[0])
mods = ['torch','torchaudio','faiss','soundfile','librosa','numpy','demucs','einops','transformers']
bad = []
for m in mods:
    try:
        mod = importlib.import_module(m)
        v = getattr(mod, '__version__', '?')
        print(f'  {m:12s} {v}')
    except Exception as e:
        bad.append(m); print(f'  {m:12s} MISSING')
try:
    import torch
    print('cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')
except Exception as e:
    print('cuda 检测失败', e)
sys.exit(1 if bad else 0)
`;
  const r = spawnSync(venvPy, ['-c', code], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  if (r.status === 0) ok('运行时可用');
  else no('运行时还不完整');
  // 权重 + 代码
  const missing = MANIFEST.files.filter((f) => !existsSync(join(rvcRoot, f.target)));
  if (missing.length) no(`还缺 ${missing.length} 个权重文件`);
  else ok('权重齐');
  if (existsSync(join(rvcRoot, 'infer', 'cli.py'))) ok('RVC 代码齐');
  else no('runtime/rvc 里没有 infer/cli.py');
}

// ---------- 主流程 ----------
try {
  switch (cmd) {
    case 'plan':
      inspect();
      break;
    case 'rvc':
      copyRvc();
      break;
    case 'models':
      if (flag('download')) await downloadModels();
      else copyModels();
      break;
    case 'venv':
      makeVenv();
      break;
    case 'verify':
      head('运行时检查');
      verify();
      break;
    case 'all':
      copyRvc();
      copyModels();
      head('接下来');
      dot('node tools/bootstrap.mjs venv    # 准备 Python 运行时（复制现有 venv，几分钟）');
      dot('node tools/bootstrap.mjs verify  # 复查');
      break;
    default:
      console.error(`不认识的子命令：${cmd}`);
      console.error('可用：plan | rvc | models [--download] | venv [--fresh] | all | verify');
      process.exit(1);
  }
} catch (e) {
  console.error(`\n\x1b[31m失败：${e instanceof Error ? e.message : String(e)}\x1b[0m`);
  process.exit(1);
}
