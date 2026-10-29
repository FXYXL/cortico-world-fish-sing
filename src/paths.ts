/**
 * 路径解析：把「插件自带什么、用户装了什么」算清楚，别让四个路径框暴露给用户。
 *
 * 分发形态（默认）：
 *   <dataDir>/runtime/
 *     rvc/           ← 安装时从插件包 vendor/rvc 复制过来的代码 + 下载下去的权重
 *     venv/          ← 点按钮装的 Python 运行时（torch/demucs/faiss）
 *
 * 开发形态（把 worker.rvcRoot 填成自己的项目目录）：原样用外面的 RVC，不碰 runtime。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FishSingConfigSection } from './config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 插件包根目录（src 的上一层）。 */
export const PKG_ROOT = join(HERE, '..');
/** 随包分发的 RVC 代码。 */
export const VENDORED_RVC = join(PKG_ROOT, 'vendor', 'rvc');
/** 随包分发的分离脚本。 */
export const BUNDLED_SEPARATE = join(PKG_ROOT, 'worker', 'separate.py');

export interface WorkerPaths {
  /** 自托管根：代码 + venv + 权重都在这下面。 */
  runtimeRoot: string;
  /** RVC 代码根（含 infer/ configs/ assets/ logs/）。 */
  rvcRoot: string;
  /** 跑 worker 的 python。 */
  pythonPath: string;
  /** 跑 demucs 的 python（默认与 pythonPath 相同）。 */
  separatePython: string;
  /** demucs 分离脚本。 */
  separateScript: string;
  /** ffmpeg 目录（要有 ffmpeg/ffprobe/ffplay）。 */
  ffmpegDir: string;
  /** 是否自托管（用户没填外部 RVC 目录）。 */
  selfHosted: boolean;
  /** 运行时是否可用（代码 + venv 都在）。 */
  runtimeReady: boolean;
  /** 权重是否齐（至少要有模型和 rmvpe）。 */
  modelsReady: boolean;
}

const clean = (v: unknown): string => String(v ?? '').trim();

/**
 * 老机器上 RVC 项目常见的位置。
 *
 * 自托管之后 rvcRoot 指向 runtime/rvc，里面只有权重和索引，**没有 logs/<实验>/0_gt_wavs**
 * （那是训练时的中间产物）。想「在已有模型上补音域」就得回头找这些老目录。
 */
export const LEGACY_RVC_ROOTS = ['D:/AI/rvc', 'C:/rvc'];

export function resolvePaths(cfg: FishSingConfigSection, dataDir: string): WorkerPaths {
  const w = cfg.worker ?? ({} as FishSingConfigSection['worker']);
  const runtimeRoot = clean(w.runtimeRoot) || join(dataDir, 'runtime');
  const external = clean(w.rvcRoot);
  const selfHosted = !external;
  const rvcRoot = external || join(runtimeRoot, 'rvc');
  const pythonPath = clean(w.pythonPath) || join(runtimeRoot, 'venv', 'Scripts', 'python.exe');
  const separatePython = clean(w.separatePython) || pythonPath;
  const separateScript = clean(w.separateScript) || BUNDLED_SEPARATE;
  const ffmpegDir = clean(w.ffmpegDir) || 'D:\\ffmpeg\\bin';

  /** 权重是否齐（模型 + rmvpe + hubert 三件必备）。 */
  const modelsOk = (root: string): boolean =>
    existsSync(join(root, 'assets', 'weights', clean(cfg.voice?.model) || 'dfy2.pth'))
    && existsSync(join(root, 'assets', 'rmvpe', 'rmvpe.pt'))
    && existsSync(join(root, 'assets', 'hubert_base', 'pytorch_model.bin'));

  let modelsReady = modelsOk(rvcRoot);

  // 迁移兜底：老用户（升级前就装了插件、配置里没有 worker 段）手上只有一份外部 RVC，
  // 自托管目录还不存在。这种情况下沿用那份外部 RVC，否则一升级就唱不出声。
  // 只在「自托管 + 自托管目录里没模型」时触发，对新装用户无影响。
  let effectiveRoot = rvcRoot;
  let effectivePython = pythonPath;
  let effectiveSeparatePython = separatePython;
  if (selfHosted && !modelsReady) {
    for (const legacy of ['D:\\AI\\rvc', 'C:\\rvc']) {
      if (modelsOk(legacy)) {
        effectiveRoot = legacy;
        const venvPy = join(legacy, 'venv', 'Scripts', 'python.exe');
        if (!existsSync(effectivePython) && existsSync(venvPy)) effectivePython = venvPy;
        // 老机器上 demucs 通常装在另一个 venv（升级前就是这么分工的），继续沿用它，
        // 否则一升级分离就报「No module named demucs」。新装用户只有一个 venv，走不到这里。
        if (!clean(w.separatePython)) {
          for (const legacySep of ['D:\\seed-vc\\venv\\Scripts\\python.exe', 'D:\\AI\\seed-vc\\venv\\Scripts\\python.exe']) {
            if (existsSync(legacySep)) { effectiveSeparatePython = legacySep; break; }
          }
        }
        modelsReady = true;
        break;
      }
    }
  }

  return {
    rvcRoot: effectiveRoot,
    pythonPath: effectivePython,
    runtimeRoot,
    separatePython: effectiveSeparatePython,
    separateScript,
    ffmpegDir,
    selfHosted,
    runtimeReady: existsSync(effectiveRoot) && existsSync(effectivePython),
    modelsReady,
  };
}

/** 权重清单文件（随包分发）。 */
export const MODELS_MANIFEST = join(PKG_ROOT, 'assets', 'models.manifest.json');
