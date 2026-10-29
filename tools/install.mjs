/**
 * 安装到 Coopanion：复制文件 → 加依赖 → 合并配置。
 *
 *   node tools/install.mjs            # 检查到 Coo 在跑就不动手
 *   node tools/install.mjs --force    # 硬来（配置可能被 Coo 退出时覆盖）
 *
 * 只做三件幂等的事，重复跑不会坏；不碰 data/ 和 node_modules。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = PKG.name;

const COO = process.env.COOPANION_DIR || 'D:\\Coopanion';
const EXT_DIR = join(COO, 'data', 'extensions');
const DEST = join(EXT_DIR, 'node_modules', NAME);
const EXT_PKG = join(EXT_DIR, 'package.json');
const CONFIG = join(COO, 'data', 'home', 'companion', 'config.json');
const force = process.argv.includes('--force');

function cooRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Coopanion.exe', '/FO', 'CSV'], { encoding: 'utf8' });
    return out.includes('Coopanion.exe');
  } catch {
    return false;
  }
}

if (!existsSync(EXT_DIR)) {
  console.error(`找不到扩展目录：${EXT_DIR}\n用 COOPANION_DIR 环境变量指到 Coo 安装目录。`);
  process.exit(1);
}
if (cooRunning() && !force) {
  console.error('Coopanion 正在运行。先退出它再装（否则配置可能被退出时覆盖），或者加 --force。');
  process.exit(2);
}

// 1. 复制
const SKIP = new Set(['data', 'node_modules', '.git', '.tmp']);
rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
for (const name of readdirSync(ROOT)) {
  if (SKIP.has(name) || name.endsWith('.log')) continue;
  const src = join(ROOT, name);
  const dst = join(DEST, name);
  if (statSync(src).isDirectory()) {
    cpSync(src, dst, { recursive: true, filter: (p) => !SKIP.has(p.split(/[\\/]/).pop() ?? '') && !p.includes('__pycache__') });
  } else {
    cpSync(src, dst);
  }
}
console.log(`✓ 已复制到 ${DEST}`);

// 2. 依赖
const extPkg = JSON.parse(readFileSync(EXT_PKG, 'utf8'));
extPkg.dependencies = extPkg.dependencies || {};
extPkg.dependencies[NAME] = PKG.version;
writeFileSync(EXT_PKG, `${JSON.stringify(extPkg, null, 2)}\n`, 'utf8');
console.log(`✓ ${join('data', 'extensions', 'package.json')} 已登记 ${NAME}@${PKG.version}`);

// 3. 配置段
const cfg = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
cfg.worlds = cfg.worlds || {};
if (!cfg.worlds['fish-sing']) {
  const mine = { enabled: true };
  // 顺手把 fishtools 那边的 OneBot 地址/令牌抄过来：同一个 config.json，
  // 不新增暴露面，但省掉手填一串 token 的麻烦。
  const legacy = cfg.worlds.fishtools?.onebot;
  if (legacy?.httpUrl) {
    mine.send = { httpUrl: String(legacy.httpUrl) };
    if (legacy.token) mine.send.token = String(legacy.token);
    if (legacy.tokenSecret) mine.send.tokenSecret = String(legacy.tokenSecret);
    console.log(`· 已从 fishtools 抄来 OneBot 地址 ${legacy.httpUrl}`);
  }
  cfg.worlds['fish-sing'] = mine;
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  console.log('✓ config.json 加了 worlds["fish-sing"]');
} else {
  console.log('· config.json 里已有 worlds["fish-sing"]，没动它');
}

console.log(`
装好了。接下来：
  1. 启动 Coopanion
  2. 控制台 → Worlds 确认「大肥鱼唱歌」在线
  3. 控制台 →「大肥鱼唱歌」页按需改路径（RVC 根目录 / ffmpeg / OneBot 地址）
  4. 先跑一次自检：node tools/doctor.mjs
`);
