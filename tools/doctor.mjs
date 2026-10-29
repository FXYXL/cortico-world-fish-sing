/**
 * 自检：扩展能不能用、worker 能不能起来、模型在不在。
 *   node tools/doctor.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const DEFAULTS = {
  rvcRoot: 'D:\\AI\\rvc',
  pythonPath: 'D:\\AI\\rvc\\venv\\Scripts\\python.exe',
  separatePython: 'D:\\AI\\seed-vc\\venv\\Scripts\\python.exe',
  separateScript: 'D:\\AI\\seed-vc-src\\separate.py',
  ffmpegDir: 'D:\\ffmpeg\\bin',
  model: 'dfy2.pth',
  port: 9890,
};

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail ?? '') });

add('package.json 名字', pkg.name === 'cortico-world-fish-sing', pkg.name);
add('keywords 含 cortico-world', (pkg.keywords || []).includes('cortico-world'), pkg.keywords || '');
add('cortico.kind', pkg.cortico?.kind === 'world', pkg.cortico?.kind);
add('入口文件', existsSync(join(ROOT, 'src', 'index.ts')), 'src/index.ts');
add('worker 脚本', existsSync(join(ROOT, 'worker', 'server.py')), 'worker/server.py');
add('环境提示词', existsSync(join(ROOT, 'ENV_PROMPT.md')), 'ENV_PROMPT.md');
add('describe.json', existsSync(join(ROOT, 'describe.json')), 'describe.json');
add('.npmignore 排除 .npmrc', existsSync(join(ROOT, '.npmignore'))
  && readFileSync(join(ROOT, '.npmignore'), 'utf8').includes('.npmrc'), '.npmignore');

for (const [k, v] of Object.entries(DEFAULTS)) {
  if (k === 'model') {
    add(`模型 ${v}`, existsSync(join(DEFAULTS.rvcRoot, 'assets', 'weights', v)), join(DEFAULTS.rvcRoot, 'assets', 'weights', v));
    continue;
  }
  if (k === 'port') continue;
  add(k, existsSync(v), v);
}

// worker 活着吗
const health = await fetch(`http://127.0.0.1:${DEFAULTS.port}/health`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.json())
  .catch(() => null);
add('worker 在线', health?.ok === true, health ? `模型 ${health.engine?.model}` : '没在跑（唱歌时会自动拉起）');

// python 能不能 import torch
const py = await new Promise((resolve) => {
  if (!existsSync(DEFAULTS.pythonPath)) return resolve({ ok: false, out: 'python 不存在' });
  const c = spawn(DEFAULTS.pythonPath, ['-c', 'import torch;print(torch.__version__, torch.cuda.is_available())'], { windowsHide: true });
  let out = '';
  c.stdout.on('data', (b) => { out += String(b); });
  c.once('exit', (code) => resolve({ ok: code === 0, out: out.trim() }));
  c.once('error', (e) => resolve({ ok: false, out: e.message }));
});
add('torch + CUDA', py.ok, py.out);

const bad = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(bad.length ? `\n${bad.length} 项不通过` : '\n全部通过');
process.exit(bad.length ? 1 : 0);
