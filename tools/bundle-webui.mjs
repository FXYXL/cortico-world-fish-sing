/**
 * 把 dist/webui.js 打包成带内容哈希的产物，并写回 package.json 的 cortico.webUiClient。
 *
 * 为什么要带哈希：Coo 的面板产物 URL 是按 manifest 里的路径生成的，文件名不变时
 * 浏览器会命中缓存——改完面板、重启 Coo 也没用，报「面板产物中没有 xxx」。
 * 文件名带上内容哈希，URL 自然变，缓存自动失效。
 *
 * 用法（改完 dist/webui.js 之后跑一次，然后重启 Coo）：
 *   node tools/bundle-webui.mjs
 */
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const SRC = join(DIST, 'webui.js');
const PKG = join(ROOT, 'package.json');

const code = readFileSync(SRC);
const hash = createHash('sha256').update(code).digest('hex').slice(0, 8);
const name = `webui-${hash}.js`;
const out = join(DIST, name);

// 清掉旧哈希产物，别让 dist 越堆越多
for (const f of readdirSync(DIST)) {
  if (/^webui-[0-9a-f]{8}\.js$/.test(f) && f !== name) rmSync(join(DIST, f), { force: true });
}
copyFileSync(SRC, out);

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const prev = pkg.cortico?.webUiClient ?? '';
pkg.cortico = { ...pkg.cortico, webUiClient: `dist/${name}` };
writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

console.log(`✓ dist/${name}（${(code.length / 1024).toFixed(1)} KB）`);
console.log(prev === `dist/${name}` ? '  package.json 没变（内容一样）' : `  package.json: ${prev || '(空)'} → dist/${name}`);
console.log('  重启 Coo 生效');
