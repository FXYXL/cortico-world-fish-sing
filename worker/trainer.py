"""
RVC 训练流水线（面板用）。

四步，和 D:\\AI\\rvc\\pipeline\\train_rvc.py 跑通的那套一致，区别只有一处：
切片不再由 preprocess 重新切——数据集里已经是按乐句切好的 40k 片段，
这里只做「铺到 1_16k_wavs 给 F0/特征脚本用 + 写 filelist」。

    F0 → ContentVec 特征 → faiss 索引 → 训练（按音域加权）

三个已知环境坑（都踩过）：
  1. 必须 `-m` 启动。直接 `python train/preprocess.py` 会把 train/ 塞进 sys.path，
     train.py 会遮蔽 train 包，触发循环导入。
  2. ffmpeg.exe / ffprobe.exe 要在 PATH 里，`infer.audio.load_audio` 依赖它。
  3. 训练日志走 FileHandler 只写 logs/<exp>/train.log，stdout 里没有进度，
     所以面板要 tail 这个文件拿轮次和 loss。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

RVC_ROOT = Path(os.environ.get("FISHSING_RVC_ROOT", r"D:\AI\rvc"))
RVC_PY = Path(os.environ.get("FISHSING_RVC_PY", str(RVC_ROOT / "venv" / "Scripts" / "python.exe")))
FFMPEG = Path(os.environ.get("FISHSING_FFMPEG", r"D:\ffmpeg\bin\ffmpeg.exe"))

VERSION = "v2"
SR_TAG = "40k"
SR_NUM = 40000
FEA_DIM = 768

PRETRAIN_G = RVC_ROOT / "assets" / "pretrained_v2" / "f0G40k.pth"
PRETRAIN_D = RVC_ROOT / "assets" / "pretrained_v2" / "f0D40k.pth"
INDEX_ROOT = RVC_ROOT / "assets" / "indices"

WEIGHTS_DIR = RVC_ROOT / "assets" / "weights"


def log(msg):
    print(msg, flush=True)


def child_env(extra=None):
    env = os.environ.copy()
    env["PATH"] = f"{FFMPEG.parent}{os.pathsep}{RVC_ROOT}{os.pathsep}{env.get('PATH', '')}"
    env["PYTHONPATH"] = str(RVC_ROOT)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if extra:
        env.update({k: str(v) for k, v in extra.items()})
    return env


def run(args, title, on_line=None, cancel=None) -> None:
    """跑一个子进程；on_line 逐行回调（用于从输出里抠进度）。"""
    log(f"\n>>> {title}")
    proc = subprocess.Popen(
        [str(a) for a in args],
        cwd=str(RVC_ROOT),
        env=child_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="ignore",
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            log(line)
            if on_line:
                try:
                    on_line(line)
                except Exception:  # noqa: BLE001
                    pass
        if cancel is not None and cancel.is_set():
            proc.kill()
            raise RuntimeError("已取消")
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"{title} 失败（退出码 {code}），看上面的日志")


def count_files(d: Path, suffix=".npy") -> int:
    if not d.is_dir():
        return 0
    return sum(1 for f in d.iterdir() if f.name.endswith(suffix))


def exp_dir_of(exp: str) -> Path:
    return RVC_ROOT / "logs" / exp


def find_checkpoint(exp: str):
    """最近一次训练的 G/D 存档，用于续训。"""
    d = exp_dir_of(exp)
    if not d.is_dir():
        return None
    gs = []
    for f in d.glob("G_*.pth"):
        m = re.search(r"G_(\d+)\.pth$", f.name)
        if m:
            gs.append((int(m.group(1)), f))
    if not gs:
        return None
    gs.sort()
    step, gpath = gs[-1]
    dpath = d / f"D_{step}.pth"
    return {
        "step": step,
        "G": str(gpath),
        "D": str(dpath) if dpath.is_file() else "",
        "epoch": step // 100,  # RVC 的 step 是 epoch × 100（每 epoch 100 个 batch 左右）
    }


def prepare(exp, dataset_dir: Path, progress, cancel, keep_existing=True):
    """
    建实验目录并把切片铺成 RVC 需要的三层结构。

    - 0_gt_wavs：40k 原样（训练时读它算 mel）
    - 1_16k_wavs：16k 单声道（F0 和 ContentVec 都只认这个）
    """
    exp_dir = exp_dir_of(exp)
    exp_dir.mkdir(parents=True, exist_ok=True)

    cfg = exp_dir / "config.json"
    if not cfg.exists():
        shutil.copyfile(RVC_ROOT / "configs" / "v1" / "40k.json", cfg)
        log(f"已建实验配置 {cfg}")

    gt = exp_dir / "0_gt_wavs"
    hi = exp_dir / "1_16k_wavs"
    gt.mkdir(exist_ok=True)
    hi.mkdir(exist_ok=True)

    slices = sorted((dataset_dir / "slices").glob("*.wav"))
    if not slices:
        raise RuntimeError(f"{dataset_dir / 'slices'} 里没有切片，先跑数据准备")
    total = len(slices)
    log(f"切片 {total} 个 → {exp_dir}")

    added = 0
    for i, src in enumerate(slices):
        if cancel.is_set():
            raise RuntimeError("已取消")
        dst0 = gt / src.name
        dst1 = hi / src.name
        if not dst0.exists():
            try:
                os.link(src, dst0)
            except OSError:
                shutil.copy2(src, dst0)
            added += 1
        if not dst1.exists():
            run([FFMPEG, "-y", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "16000",
                 "-c:a", "pcm_s16le", str(dst1)], "重采样 16k")
        if i % 50 == 0 or i == total - 1:
            progress(0.02 + 0.06 * ((i + 1) / total), f"铺切片 {i + 1}/{total}")
    log(f"新增 {added} 个（已存在的跳过）")
    return exp_dir


def write_filelist(exp_dir: Path) -> int:
    """
    RVC 命令行流程不写 filelist.txt（只有 WebUI 写），这里按 data_utils 的真实格式补：
        wav|特征.npy|2a_f0.npy|2b-f0nsf.npy|sid
    缺一个字段 data_utils 解包 record[:5] 就崩，所以先校验再写。
    """
    gt = exp_dir / "0_gt_wavs"
    fea = exp_dir / f"3_feature{FEA_DIM}"
    f0a = exp_dir / "2a_f0"
    f0b = exp_dir / "2b-f0nsf"

    rows, skipped = [], 0
    for wav in sorted(gt.glob("*.wav")):
        npy = fea / f"{wav.stem}.npy"
        a = f0a / f"{wav.name}.npy"
        b = f0b / f"{wav.name}.npy"
        if npy.exists() and a.exists() and b.exists():
            rows.append(f"{wav}|{npy}|{a}|{b}|0")
        else:
            skipped += 1

    if not rows:
        raise RuntimeError("没有可用的训练样本：特征提取可能全部失败了")

    # 不打乱：顺序要和权重文件对应。采样器每 epoch 自己 shuffle。
    (exp_dir / "filelist.txt").write_text("\n".join(rows), encoding="utf8")
    log(f"filelist.txt：{len(rows)} 条（跳过 {skipped} 条不完整）")
    return len(rows)


def build_weights_file(exp_dir: Path, weights: dict) -> Path | None:
    """
    把 {切片文件名: 权重} 写成训练进程读的 json。

    键用 basename，值只保留 != 1.0 的——全 1 时直接不传，让采样器走官方原路径。
    """
    if not weights:
        return None
    trimmed = {k: float(v) for k, v in weights.items() if abs(float(v) - 1.0) > 1e-9}
    if not trimmed:
        log("权重全为 1，按均匀采样训练")
        return None
    out = exp_dir / "sample_weights.json"
    out.write_text(json.dumps(trimmed, ensure_ascii=False), encoding="utf8")
    log(f"采样权重：{len(trimmed)} 片非 1（写入 {out.name}）")
    return out


def _epoch_of(line: str):
    m = re.search(r"====> 轮次：(\d+)", line)
    return int(m.group(1)) if m else None


def _loss_of(line: str):
    if "loss_disc" not in line:
        return None
    out = {}
    for k in ("loss_disc", "loss_gen", "loss_fm", "loss_mel", "loss_kl"):
        m = re.search(rf"{k}=([0-9.]+)", line)
        if m:
            out[k] = float(m.group(1))
    return out or None


def train_run(exp, dataset_dir, params, progress, cancel, weights=None):
    """
    完整流水线。params:
      epochs / batch / saveEvery / resume(bool) / fromG / fromD / rebuild(bool)
    """
    t0 = time.time()
    exp_dir = prepare(exp, Path(dataset_dir), progress, cancel)
    total = count_files(exp_dir / "0_gt_wavs", ".wav")

    rebuild = bool(params.get("rebuild", False))

    # ---- F0
    f0a = exp_dir / "2a_f0"
    if rebuild:
        for d in ("2a_f0", "2b-f0nsf", f"3_feature{FEA_DIM}"):
            shutil.rmtree(exp_dir / d, ignore_errors=True)
    have = count_files(f0a)
    if have >= total and total > 0 and not rebuild:
        log(f"F0 已齐（{have}），跳过")
        progress(0.16, f"F0 已存在（{have}）")
    else:
        progress(0.08, f"提取 F0（{total} 片）")

        def on_f0(line):
            got = count_files(f0a)
            if got:
                progress(0.08 + 0.10 * min(1.0, got / max(1, total)), f"F0 {got}/{total}")

        run([RVC_PY, "-m", "train.dataset.extract_f0", "cuda", "1", "0", "0", exp_dir, "True"],
            "提取 F0（RMVPE）", on_line=on_f0, cancel=cancel)

    if cancel.is_set():
        raise RuntimeError("已取消")

    # ---- 特征
    fea = exp_dir / f"3_feature{FEA_DIM}"
    have = count_files(fea)
    if have >= total and total > 0 and not rebuild:
        log(f"特征已齐（{have}），跳过")
        progress(0.30, f"特征已存在（{have}）")
    else:
        progress(0.18, f"提取 ContentVec 特征（{total} 片，最慢的一步）")

        def on_fea(line):
            got = count_files(fea)
            if got:
                progress(0.18 + 0.12 * min(1.0, got / max(1, total)), f"特征 {got}/{total}")

        run([RVC_PY, "-m", "train.dataset.extract_hubert_feature", "cuda", "1", "0", "0",
             exp_dir, VERSION, "True"],
            "提取 ContentVec 特征", on_line=on_fea, cancel=cancel)

    progress(0.31, "写训练清单")
    n_ok = write_filelist(exp_dir)

    # ---- 索引
    progress(0.32, "构建 faiss 检索索引")
    INDEX_ROOT.mkdir(parents=True, exist_ok=True)
    run([RVC_PY, "-m", "train.train_index", exp, VERSION, INDEX_ROOT, "4"],
        "构建检索索引", cancel=cancel)
    idx = sorted((exp_dir).glob("*.index"))
    log(f"索引：{[p.name for p in idx]}")

    # ---- 训练
    epochs = int(params.get("epochs", 200))
    batch = int(params.get("batch", 4))
    save_every = int(params.get("saveEvery", 10))

    env_extra = {}
    wfile = build_weights_file(exp_dir, weights or {})
    if wfile:
        env_extra["FISHSING_SAMPLE_WEIGHTS"] = str(wfile)

    from_g, from_d = str(PRETRAIN_G), str(PRETRAIN_D)
    if params.get("resume"):
        ck = None
        if params.get("fromG"):
            ck = {"step": 0, "G": str(params["fromG"]), "D": str(params.get("fromD") or "")}
        else:
            ck = find_checkpoint(exp)
        if ck and Path(ck["G"]).is_file():
            from_g = ck["G"]
            from_d = ck["D"] if ck.get("D") and Path(ck["D"]).is_file() else ""
            log(f"续训：从 {Path(from_g).name} 开始")
        else:
            log("没找到可续的存档，从底模开始")

    progress(0.35, f"开始训练 {epochs} 轮（batch {batch}）")
    log_file = exp_dir / "train.log"
    start_size = log_file.stat().st_size if log_file.is_file() else 0

    args = [RVC_PY, "-m", "train.train",
            "-se", save_every, "-te", epochs,
            "-pg", from_g]
    if from_d:
        args += ["-pd", from_d]
    args += ["-bs", batch, "-e", exp,
             "-sr", SR_TAG, "-sw", "1", "-v", VERSION,
             "-f0", "1", "-l", "1", "-c", "0"]

    log("\n>>> 训练开始（日志写到 logs/%s/train.log）" % exp)
    proc = subprocess.Popen(
        [str(a) for a in args],
        cwd=str(RVC_ROOT),
        env=child_env(env_extra),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="ignore",
        bufsize=1,
    )

    # stdout **必须**有人一直读。训练进程每轮都打日志，Windows 管道只有 64KB，
    # 写满之后子进程会永久阻塞在 write 上——现象是 CPU 归零、日志停在某一轮不动
    # （本地实测卡在第 3 轮，py-spy 抓栈显示主线程停在 logging.emit）。
    def drain():
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                log(line)

    threading.Thread(target=drain, daemon=True).start()

    # 训练进度只能从日志文件读（stdout 里没有轮次信息）
    last_epoch = 0
    tail_pos = start_size
    while proc.poll() is None:
        if cancel.is_set():
            proc.kill()
            proc.wait()
            raise RuntimeError("已取消")
        time.sleep(3)
        try:
            if not log_file.is_file():
                continue
            with open(log_file, "r", encoding="utf8", errors="ignore") as f:
                f.seek(tail_pos)
                chunk = f.read()
                tail_pos = f.tell()
        except OSError:
            continue
        for line in chunk.splitlines():
            ep = _epoch_of(line)
            if ep is not None:
                last_epoch = ep + 1
                pct = 0.35 + 0.63 * min(1.0, last_epoch / max(1, epochs))
                progress(pct, f"训练 {last_epoch}/{epochs} 轮")
            lo = _loss_of(line)
            if lo:
                log("loss " + " ".join(f"{k.replace('loss_', '')}={v}" for k, v in lo.items()))

    code = proc.wait()
    if code != 0:
        tail = ""
        try:
            tail = log_file.read_text(encoding="utf8", errors="ignore")[-800:]
        except OSError:
            pass
        raise RuntimeError(f"训练退出码 {code}。日志尾部：\n{tail}")

    # ---- 收尾：把最终模型落到 assets/weights
    progress(0.98, "整理产物")
    produced = []
    if WEIGHTS_DIR.is_dir():
        produced = sorted(p.name for p in WEIGHTS_DIR.glob(f"{exp}*.pth"))
    log(f"权重目录里的 {exp}*：{produced}")
    log(f"总耗时 {time.time() - t0:.0f}s")
    progress(1.0, "完成")
    return {"exp": exp, "epochs": last_epoch or epochs, "models": produced, "seconds": int(time.time() - t0)}
