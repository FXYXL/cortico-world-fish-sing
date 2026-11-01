#!/usr/bin/env node
/**
 * 发版一条龙：CHANGELOG 检查 → npm publish → 轮询 tarball 可用。
 *
 * 为什么不用裸 npm publish：
 *  · CHANGELOG 忘了写，用户不知道更新了啥（0.2.x 之前的教训，现在硬性拦截）；
 *  · publish 显示成功 ≠ 注册表可下载——tarball CDN 有 404 窗口期，实测 2~6 分钟，
 *    紧接着跑 pnpm add 会报 404（0.1.4~0.1.9 每个版本都踩了一遍）；
 *  · E409（版本被 npm 暂存）时给出明确指引，而不是让人对着报错猜。
 *
 * 用法（在仓库根目录）：
 *   node tools/publish.mjs              # 发布 package.json 里的当前版本
 *   node tools/publish.mjs --check      # 只检查 CHANGELOG，不发布
 *
 * 前置：npm 已登录（npx npm whoami 验证）；CHANGELOG.md 里有 `## [当前版本]` 条目。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const NAME = PKG.name;
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

const step = (m) => console.log(`\n==> ${m}`);

// ---- 1. CHANGELOG 检查 ------------------------------------------------------

step(`检查 CHANGELOG（${NAME}@${VERSION}）`);
const changelog = readFileSync(CHANGELOG, 'utf8');
if (!changelog.includes(`## [${VERSION}]`)) {
  console.error(`✗ CHANGELOG.md 里没有 "## [${VERSION}]" 条目。`);
  console.error('  先把这一版改了什么写进去，再发版——别人要知道更新了啥。');
  process.exit(1);
}
console.log('✓ CHANGELOG 条目在');

// --check 模式到此为止
if (process.argv.includes('--check')) {
  console.log('\n--check 通过，未发布。');
  process.exit(0);
}

// ---- 2. npm publish --------------------------------------------------------

step('npm publish');
try {
  execSync('npm publish --access public', { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  const out = String(e.stdout || '') + String(e.stderr || '');
  if (out.includes('E409') || out.includes('cannot be published') || out.includes(' 版本已被') || out.includes('staged')) {
    console.error('✗ npm 拒绝了这个版本（可能被暂存，如 0.1.1 那次）。');
    console.error('  处理：升一个版本号（package.json + CHANGELOG）后重试本脚本。');
  }
  process.exit(1);
}
console.log(`✓ ${NAME}@${VERSION} 已提交到注册表`);

// ---- 3. 轮询 tarball 可用 --------------------------------------------------

const tarball = `https://registry.npmjs.org/${NAME}/-/${NAME}-${VERSION}.tgz`;
const POLL_MAX = 12;          // 12 次 × 40 秒 ≈ 8 分钟，覆盖实测的 CDN 延迟
const POLL_EVERY = 40_000;

step(`轮询 tarball（${tarball}）`);
let ok = false;
for (let i = 1; i <= POLL_MAX; i += 1) {
  try {
    const res = await fetch(tarball, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
    console.log(`  第 ${i} 次：HTTP ${res.status}`);
    if (res.status === 200) {
      ok = true;
      break;
    }
  } catch (e) {
    console.log(`  第 ${i} 次：网络错误 ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, POLL_EVERY));
}
if (!ok) {
  console.error(`✗ ${POLL_MAX * (POLL_EVERY / 1000)} 秒后 tarball 仍 404。可能被暂存或 CDN 异常，稍后手动查：`);
  console.error(`  ${tarball}`);
  process.exit(1);
}

// ---- 4. 收尾提醒 -----------------------------------------------------------

console.log(`
✓ ${NAME}@${VERSION} 发布完成，tarball 已可下载。

别忘了两件事：
1. 本机/反馈者升级：pnpm add ${NAME}@${VERSION}（受 minimumReleaseAge 限制的话，
   把版本加进 pnpm-workspace.yaml 的 minimumReleaseAgeExclude）；
2. 市场更新日志：索引仓的同步 Action 靠 [sync] issue 触发。市场里没显示的话，
   去 Pal-AI-Lab/cortico-extensions 开一个标题为 "[sync] ${NAME}" 的空 issue。
`);
