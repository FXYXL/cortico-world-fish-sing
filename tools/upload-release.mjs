/**
 * 把权重传到 GitHub Release（建 Release + 传 6 个文件 + 复核大小）。
 *
 *   $env:GITHUB_TOKEN="ghp_xxx"     （PowerShell）
 *   set GITHUB_TOKEN=ghp_xxx        （cmd）
 *
 *   node tools/upload-release.mjs                   # 上传（服务器上已有同尺寸文件的跳过）
 *   node tools/upload-release.mjs --dry             # 只列出要传什么
 *   node tools/upload-release.mjs --from D:\AI\rvc  # 权重来源目录（默认 D:\AI\rvc）
 *
 * Token：GitHub → Settings → Developer settings → Personal access tokens，
 * classic 勾 `repo`，或 fine-grained 只给这个仓库 Contents: Read and write。
 * 中断或失败直接重跑，已传好的文件会跳过。
 *
 * 两个踩过的坑（都在下面处理了）：
 * 1. 不能把文件流直接给 fetch 当 body —— 上传端点会 307 重定向，undici 自动跟随时无法重放
 *    已读空的流，抛 `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`（实际发出 0 字节 vs 声明 52 MB）。
 *    所以改成 Buffer + `redirect: 'manual'` 自己跟，且每一跳**重新读一次文件**。
 * 2. 同一个 Buffer 不能复用两次 —— undici 发送时会把底层 ArrayBuffer detach，
 *    第二次再 slice 就报 "detached ArrayBuffer"。所以每一跳都新建。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function need(init) {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fish-sing-uploader',
      ...(init.headers ?? {}),
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
  return MANIFEST.files.map((f) => {
    const p = join(fromRoot, f.target);
    const there = existsSync(p);
    return { ...f, path: p, exists: there, actual: there ? statSync(p).size : 0 };
  });
}

/** 上传单个文件，返回是否成功。内部处理重定向与重试。 */
async function uploadOne(release, f) {
  const startUrl = `${UPLOADS}/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(f.name)}`;
  let lastErr = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let url = startUrl;
    let fatal = false;

    for (let hop = 1; hop <= 5 && !fatal; hop += 1) {
      const t0 = Date.now();
      // 每一跳重新读：Buffer 被 undici detach 过，且重定向需要重放整个 body
      const body = readFileSync(f.path);
      process.stdout.write(`\r    上传中 ${mb(f.size)}…   `);
      const ticker = setInterval(() => {
        process.stdout.write(`\r    上传中 ${mb(f.size)}… 已 ${((Date.now() - t0) / 1000).toFixed(0)} 秒   `);
      }, 3000);

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(f.size),
            'User-Agent': 'fish-sing-uploader',
          },
          body,
          redirect: 'manual',
        });
      } catch (e) {
        clearInterval(ticker);
        process.stdout.write('\n');
        lastErr = e;
        break;
      }
      clearInterval(ticker);
      process.stdout.write('\n');

      if (REDIRECTS.has(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) {
          lastErr = new Error(`重定向 ${res.status} 但没有 Location`);
          break;
        }
        const next = new URL(loc, url).href;
        console.log(`  \x1b[90m· ${res.status} 重定向 → ${new URL(next).host}\x1b[0m`);
        url = next;
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
        // 4xx（除超时/限流）重试没意义
        if (res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status)) fatal = true;
        break;
      }
      const asset = JSON.parse(text);
      console.log(`  \x1b[32m✓\x1b[0m ${f.name}  ${mb(asset.size)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return true;
    }

    if (fatal) break;
    console.error(`  \x1b[33m第 ${attempt} 次失败：${lastErr?.message ?? '未知'}\x1b[0m`);
    if (attempt < 3) {
      const wait = attempt * 3000;
      console.error(`  ${wait / 1000} 秒后重试…`);
      await sleep(wait);
    }
  }

  console.error(`  \x1b[31m✗ ${f.name} 上传失败：${lastErr?.message ?? ''}\x1b[0m`);
  return false;
}

async function main() {
  const files = pickFiles();

  console.log(`仓库   ${OWNER}/${REPO}`);
  console.log(`Tag    ${TAG}`);
  console.log(`来源   ${fromRoot}`);
  console.log(`合计   ${mb(MANIFEST.files.reduce((n, f) => n + f.size, 0))}\n`);

  for (const f of files) {
    const state = !f.exists
      ? '\x1b[31m缺失\x1b[0m'
      : f.actual === f.size
        ? '\x1b[32m就绪\x1b[0m'
        : `\x1b[33m大小不符 ${mb(f.actual)}\x1b[0m`;
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
    console.error(`  或直接网页上传：https://github.com/${OWNER}/${REPO}/releases/new`);
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
      console.error('403 一般是 token 缺 repo 权限；422 一般是 tag 已被占用（重跑会用已有 Release）。');
      process.exit(1);
    }
    release = json;
    console.log(`✓ Release 建好：${release.html_url}`);
  } else {
    console.log(`\n· 复用已有 Release：${release.html_url}`);
  }

  // 2. 已有 asset：大小一致就跳过，不一致就删掉重传
  const existing = new Map(
    ((await api(`/repos/${OWNER}/${REPO}/releases/${release.id}/assets`)).json ?? []).map((a) => [a.name, a]),
  );

  for (const f of files) {
    const have = existing.get(f.name);
    if (have) {
      if (have.size === f.size) {
        console.log(`  \x1b[90m· ${f.name} 已在服务器上（${mb(have.size)}），跳过\x1b[0m`);
        continue;
      }
      console.log(`  · ${f.name} 服务器上大小不符（${mb(have.size)}），删掉重传`);
      await api(`/repos/${OWNER}/${REPO}/releases/assets/${have.id}`, { method: 'DELETE' });
    }
    console.log(`\n  上传 ${f.name}（${mb(f.size)}）…`);
    const one = await uploadOne(release, f);
    if (!one) {
      console.log('\n\x1b[31m停下：单个文件失败，先解决再重跑（已传好的会跳过）。\x1b[0m');
      process.exit(1);
    }
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
  if (bad) {
    console.log(`\n\x1b[31m还有 ${bad} 个文件不对，重跑本命令即可。\x1b[0m`);
    process.exit(1);
  }
  console.log('\n\x1b[32m全部就位。\x1b[0m');
  console.log(`下载地址前缀：${MANIFEST.base}`);
  console.log('别人装插件后跑 node tools/bootstrap.mjs models --download 即可自动下载并校验。');
}

await main();
