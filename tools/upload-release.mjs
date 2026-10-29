/**
 * 把权重传到 GitHub Release（一次建 Release + 传 6 个文件 + 校验大小）。
 *
 *   set GITHUB_TOKEN=ghp_xxx           （cmd）
 *   $env:GITHUB_TOKEN="ghp_xxx"        （PowerShell）
 *
 *   node tools/upload-release.mjs                 # 上传（已存在的同名 asset 会先删再传）
 *   node tools/upload-release.mjs --dry           # 只列出要传什么
 *   node tools/upload-release.mjs --from D:\AI\rvc  # 权重来源目录（默认 D:\AI\rvc）
 *
 * Token 只需一次：GitHub → Settings → Developer settings → Personal access tokens，
 * classic 勾 `repo`，或 fine-grained 只给这个仓库的 Contents: Read and write。
 * 上传 900 MB 建议挂机跑，中断了直接重跑，已上传的文件会跳过。
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'assets', 'models.manifest.json'), 'utf8'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const repoUrl = typeof PKG.repository === 'string' ? PKG.repository : PKG.repository?.url ?? '';
const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
if (!m) {
  console.error(`package.json 里的 repository 认不出：${repoUrl}`);
  process.exit(1);
}
const [, OWNER, REPO] = m;
const fromRoot = resolve(opt('from', 'D:\\AI\\rvc'));
const TAG = MANIFEST.tag;
const NAME = `模型权重 ${TAG}`;

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function need(args) {
  return {
    method: 'GET',
    ...args,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fish-sing-uploader',
      ...(args.headers ?? {}),
    },
  };
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, need(init));
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  return { res, json, text };
}

function pickFiles() {
  const out = [];
  for (const f of MANIFEST.files) {
    const p = join(fromRoot, f.target);
    out.push({ ...f, path: p, exists: existsSync(p), actual: existsSync(p) ? statSync(p).size : 0 });
  }
  return out;
}

async function main() {
  const files = pickFiles();

  console.log(`仓库   ${OWNER}/${REPO}`);
  console.log(`Tag    ${TAG}`);
  console.log(`来源   ${fromRoot}`);
  console.log(`合计   ${mb(MANIFEST.files.reduce((n, f) => n + f.size, 0))}\n`);

  for (const f of files) {
    const state = !f.exists ? '\x1b[31m缺失\x1b[0m' : f.actual === f.size ? '\x1b[32m就绪\x1b[0m' : `\x1b[33m大小不符 ${mb(f.actual)}\x1b[0m`;
    console.log(`  ${f.name.padEnd(44)} ${mb(f.size).padStart(10)}  ${state}`);
  }
  if (files.some((f) => !f.exists)) {
    console.error(`\n有文件在 ${fromRoot} 里找不到，先确认路径（或用 --from 指到别处）。`);
    process.exit(1);
  }
  if (flag('dry')) {
    console.log('\n--dry：什么都没做。');
    return;
  }
  if (!token) {
    console.error('\n没给 GITHUB_TOKEN。设置环境变量后再跑：');
    console.error('  PowerShell:  $env:GITHUB_TOKEN="ghp_xxx"');
    console.error('  或直接网页上传：https://github.com/' + OWNER + '/' + REPO + '/releases/new');
    process.exit(1);
  }

  // 1. 找/建 Release
  let release = (await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`)).json;
  if (!release?.id) {
    console.log(`\n建 Release（tag=${TAG}）…`);
    const { res, json, text } = await api(`/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: TAG,
        name: NAME,
        body: '插件首次启动需要这 6 个文件（模型 + 检索索引 + ContentVec + RMVPE + 底模）。\n由 `node tools/bootstrap.mjs models --download` 自动下载并校验 sha256。',
        draft: false,
        prerelease: false,
      }),
    });
    if (!res.ok) {
      console.error(`建 Release 失败 HTTP ${res.status}：${text.slice(0, 300)}`);
      console.error('如果是 403，token 缺 repo 权限；如果是 422，tag 可能已被占用。');
      process.exit(1);
    }
    release = json;
    console.log(`✓ Release 建好：${release.html_url}`);
  } else {
    console.log(`\n· 复用已有 Release：${release.html_url}`);
  }

  // 2. 已有 asset：大小一致就跳过，不一致就删掉重传
  const existing = new Map(((await api(`/repos/${OWNER}/${REPO}/releases/${release.id}/assets`)).json ?? []).map((a) => [a.name, a]));

  for (const f of files) {
    const have = existing.get(f.name);
    if (have) {
      if (have.size === f.size) {
        console.log(`  \x1b[90m· ${f.name} 已在服务器上（${mb(have.size)}），跳过\x1b[0m`);
        continue;
      }
      console.log(`  · ${f.name} 服务器上大小不符，删掉重传`);
      await api(`/repos/${OWNER}/${REPO}/releases/assets/${have.id}`, { method: 'DELETE' });
    }

    console.log(`\n  上传 ${f.name}（${mb(f.size)}）…`);
    const t0 = Date.now();
    let sent = 0;
    const stream = createReadStream(f.path);
    stream.on('data', (c) => {
      sent += c.length;
      const pct = ((sent / f.size) * 100).toFixed(1);
      const speed = sent / ((Date.now() - t0) / 1000) / 1048576;
      process.stdout.write(`\r    ${pct}%  ${mb(sent)}/${mb(f.size)}  ${speed.toFixed(1)} MB/s   `);
    });

    const res = await fetch(`${UPLOADS}/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(f.name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(f.size),
        'User-Agent': 'fish-sing-uploader',
      },
      body: stream,
      duplex: 'half',
    });
    const text = await res.text();
    process.stdout.write('\n');
    if (!res.ok) {
      console.error(`  \x1b[31m✗ ${f.name} 上传失败 HTTP ${res.status}\x1b[0m\n  ${text.slice(0, 300)}`);
      console.error('  重跑本命令会跳过已传好的文件。');
      process.exit(1);
    }
    const asset = JSON.parse(text);
    console.log(`  ✓ ${f.name}  ${mb(asset.size)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // 3. 复核
  console.log('\n复核服务器上的文件：');
  const final = (await api(`/repos/${OWNER}/${REPO}/releases/${release.id}/assets`)).json ?? [];
  let bad = 0;
  for (const f of MANIFEST.files) {
    const a = final.find((x) => x.name === f.name);
    if (!a) {
      console.log(`  \x1b[31m✗ ${f.name} 不在服务器上\x1b[0m`);
      bad += 1;
    } else if (a.size !== f.size) {
      console.log(`  \x1b[31m✗ ${f.name} 大小 ${mb(a.size)} ≠ ${mb(f.size)}\x1b[0m`);
      bad += 1;
    } else {
      console.log(`  ✓ ${f.name}`);
    }
  }
  console.log(
    bad
      ? `\n\x1b[31m还有 ${bad} 个文件不对。\x1b[0m`
      : `\n\x1b[32m全部就位。\x1b[0m 下载地址前缀：${MANIFEST.base}\n别人装插件后点「下载模型」或跑 node tools/bootstrap.mjs models --download 即可。`,
  );
  if (bad) process.exit(1);
}

await main();
