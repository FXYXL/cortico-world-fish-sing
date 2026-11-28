# -*- coding: utf-8 -*-
"""
fish-sing worker 的核心：常驻 RVC + 切片换声 + 分离/混音。

为什么要把 RVC 常驻：`infer/cli.py` 每次启动都要重新加载 hubert(181M) + rmvpe(173M)
+ G(52M) + faiss 索引(311M)，实测 8 秒；常驻之后 55 秒音频只要 4 秒。

为什么要强制切片：整段喂给 RVC 会一次性过 encoder，320 秒 ≈ 32k 帧，注意力 O(n²)，
实测跑 10 分钟不结束、进程内存涨到 13GB。切 55 秒后 6 片共 76 秒跑完。

外部依赖：
  · RVC 环境（D:\\AI\\rvc\\venv）：torch 2.7.1+cu118，提供 VC / ContentVec / rmvpe
  · 运行时 venv（torch + demucs）：分离也用同一个，脚本是插件自带的 worker/separate.py
    %USERPROFILE%\\.cache\\torch\\hub\\checkpoints\\955717e8-8726e21a.th
  · ffmpeg / ffprobe（D:\\ffmpeg\\bin）
"""

import gc
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import soundfile as sf

# ---------------------------------------------------------------- 常量

def _resolve_rvc_root() -> Path:
    """RVC 根目录的探测链。

    之前默认写死 D:\\AI\\rvc，导致手动起 worker（没传 FISHSING_RVC_ROOT）时
    引擎去 os.chdir 一个不存在的目录，报错还不直观。现在按顺序找：

    1. FISHSING_RVC_ROOT（插件拉起时必传）
    2. 自托管位置：FISHSING_WORK 的上级 runtime/rvc（runtime 里 venv 与 rvc 平级）
    3. 老机器的开发目录 D:\\AI\\rvc、C:\\rvc
    """
    env = os.environ.get("FISHSING_RVC_ROOT", "").strip()
    if env:
        return Path(env)
    work = os.environ.get("FISHSING_WORK", "").strip()
    if work:
        cand = Path(work).parent / "runtime" / "rvc"
        if (cand / "assets" / "weights").is_dir():
            return cand
    for legacy in (r"D:\AI\rvc", r"C:\rvc"):
        if (Path(legacy) / "assets" / "weights").is_dir():
            return Path(legacy)
    return Path(work).parent / "runtime" / "rvc" if work else Path(r"D:\AI\rvc")


RVC_ROOT = _resolve_rvc_root()
# 自托管时 venv 和 rvc 代码是**平级**的（runtime/venv 与 runtime/rvc），不在 rvc/venv 里，
# 所以这个路径必须能被外部指定；回落到老结构（rvc/venv）只是为了兼容开发机。
RVC_PY = Path(os.environ.get(
    "FISHSING_RVC_PY",
    str(RVC_ROOT / "venv" / "Scripts" / "python.exe"),
))
SEP_PY = Path(os.environ.get("FISHSING_SEP_PY", sys.executable))
SEP_SCRIPT = Path(os.environ.get("FISHSING_SEP_SCRIPT",
                         str(Path(__file__).resolve().parent / "separate.py")))
FFMPEG = Path(os.environ.get("FISHSING_FFMPEG")
              or shutil.which("ffmpeg")
              or r"D:\ffmpeg\bin\ffmpeg.exe")

DEFAULT_MODEL = os.environ.get("FISHSING_MODEL", "dfy2.pth")
DEFAULT_INDEX = os.environ.get(
    "FISHSING_INDEX",
    str(RVC_ROOT / "logs" / "dfy2" / "added_IVF2529_Flat_nprobe_1_dfy2_v2.index"),
)

#: 每片时长（秒）。60 是 RVC 的舒适区，55 留 5 秒余量给整首除不尽的情况。
CHUNK_SEC = float(os.environ.get("FISHSING_CHUNK_SEC", "55"))

SILENCE = 0.0

# 显存碎片：这张卡常被 TTS 服务占一半，expandable_segments 能少报很多 OOM
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
# 关闭 RVC 的 CUDA Graph 缓存：切段长度各不相同，每个长度都会捕获新图并锁死显存、
# 同时跳过 empty_cache，导致 8G 卡第 2 片起触发 WDDM 换页而急剧变慢
os.environ.setdefault("RVC_CUDA_GRAPH", "0")


def log(msg: str) -> None:
    print(f"[fish-sing] {msg}", flush=True)


# ---------------------------------------------------------------- 音频小工具


def run_ff(args: list, timeout: float = 1800) -> None:
    """跑一次 ffmpeg/ffprobe，失败把 stderr 抛出来（不然只剩 exit code 猜）。"""
    r = subprocess.run([str(a) for a in args], capture_output=True, timeout=timeout)
    if r.returncode != 0:
        tail = r.stderr.decode("utf-8", "ignore")[-600:]
        raise RuntimeError(f"ffmpeg 失败（{r.returncode}）：{tail}")


def probe_duration(path: Path) -> float:
    r = subprocess.run(
        [str(FFMPEG.parent / "ffprobe.exe"), "-v", "error", "-show_entries",
         "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, timeout=60,
    )
    try:
        return float(r.stdout.decode().strip())
    except Exception:
        return 0.0


def to_wav(src: Path, dst: Path, sr: Optional[int] = None) -> Path:
    """把任意音频转成 wav（默认保留原采样率）。已经是 wav 且不需要重采样时直接返回。"""
    if src.suffix.lower() == ".wav" and sr is None:
        return src
    args = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", src]
    if sr:
        args += ["-ar", str(sr)]
    args += ["-ac", "2", "-c:a", "pcm_s24le", dst]
    run_ff(args)
    return dst


def read_audio(path: Path) -> tuple:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return data, sr


def write_audio(path: Path, data: np.ndarray, sr: int) -> None:
    """写 wav。超过满幅先压回来——RVC 有时会返回 int16 量纲的数组，
    直接当浮点写（PCM_24）会把 99% 的样本削平，听感是"炸/刺/吓人"。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    a = np.asarray(data, dtype=np.float32)
    peak = float(np.abs(a).max()) if a.size else 0.0
    if peak > 1.0:
        a = a * (0.99 / peak)
    sf.write(str(path), a, sr, subtype="PCM_24")


def to_unit_scale(audio: np.ndarray) -> np.ndarray:
    """
    RVC 的 `vc_single` 返回的是 **int16 量纲**的数组（±32767，且已按 0.99 归一）。
    必须除回 32768 才是 [-1,1] 的浮点，否则后面每一步都在处理一个 3 万倍的信号。
    """
    a = np.asarray(audio)
    if np.issubdtype(a.dtype, np.integer):
        return a.astype(np.float32) / 32768.0
    a = a.astype(np.float32)
    if a.size and float(np.abs(a).max()) > 1.5:  # 浮点数组但量纲像 int16
        return a / 32768.0
    return a


def resample_linear_fallback(data: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """只在 ffmpeg 不可用时用；音质一般，但不会因为缺依赖整条链断掉。"""
    if src_sr == dst_sr or data.size == 0:
        return data
    n_out = int(round(data.shape[0] * dst_sr / src_sr))
    idx = np.linspace(0, data.shape[0] - 1, n_out)
    lo = np.floor(idx).astype(np.int64)
    hi = np.minimum(lo + 1, data.shape[0] - 1)
    frac = (idx - lo).reshape(-1, 1)
    return (data[lo] * (1 - frac) + data[hi] * frac).astype(np.float32)


# ---------------------------------------------------------------- 引擎

#: 音域分析脚本：由 _f0_stats 在子进程里执行（sys.executable 与引擎同解释器，librosa 可用）。
#: 输出一行 JSON；无人声/读不了时输出 null。
_F0_ANALYZE_SRC = r"""
import json, sys
import numpy as np

def main():
    from pathlib import Path
    import librosa
    path = Path(sys.argv[1])
    max_sec = float(sys.argv[2]) if len(sys.argv) > 2 else 90.0
    dur = librosa.get_duration(path=str(path))
    if dur > max_sec:
        offset = (dur - max_sec) / 2
        y, sr = librosa.load(str(path), sr=16000, mono=True, offset=offset, duration=max_sec)
    else:
        y, sr = librosa.load(str(path), sr=16000, mono=True)
    f0, vflag, _ = librosa.pyin(y, fmin=80.0, fmax=800.0, sr=sr, frame_length=1024)
    v = f0[vflag & ~np.isnan(f0)]
    if v.size < 50:
        print(json.dumps(None))
        return
    q = lambda p: float(np.percentile(v, p))
    print(json.dumps({"p5": q(5), "p25": q(25), "median": q(50), "p95": q(95), "frames": int(v.size)}))

main()
"""

#: 轻量声学体检脚本（子进程执行，用 librosa.yin 快速扫描，4 分钟歌约 0.5 秒，不阻塞 HTTP 线程）。
_INSPECT_VOCALS_SRC = r"""
import json, math, sys
import numpy as np

def fmt_t(sec):
    s = max(0, int(round(sec)))
    return f"{s // 60}:{s % 60:02d}"

def merge_spans(mask, hop_sec, min_dur=0.6, gap_sec=1.5):
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return []
    spans = []
    a = b = int(idx[0])
    for k in idx[1:]:
        k = int(k)
        if (k - b) * hop_sec <= gap_sec:
            b = k
        else:
            if (b - a + 1) * hop_sec >= min_dur:
                spans.append((a * hop_sec, (b + 1) * hop_sec))
            a = b = k
    if (b - a + 1) * hop_sec >= min_dur:
        spans.append((a * hop_sec, (b + 1) * hop_sec))
    return spans

def main():
    import librosa
    src_path = sys.argv[1]
    conv_path = sys.argv[2] if len(sys.argv) > 2 else ""
    model_json = sys.argv[3] if len(sys.argv) > 3 else ""
    pitch_applied = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0

    model_range = json.loads(model_json) if model_json else None
    sr = 16000
    hop = 512
    hop_sec = hop / sr

    y, _ = librosa.load(src_path, sr=sr, mono=True)
    if y.size < sr // 2:
        print(json.dumps({"issues": [], "vocalRange": None}))
        return

    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
    peak_rms = float(np.percentile(rms, 98)) if rms.size else 0.0
    active = rms > max(1e-4, peak_rms * 0.08)

    f0 = librosa.yin(y, fmin=70.0, fmax=1000.0, sr=sr, frame_length=1024, hop_length=hop)
    n = min(len(f0), len(active))
    f0 = f0[:n]
    active = active[:n]
    valid = active & np.isfinite(f0) & (f0 > 75.0) & (f0 < 980.0)
    # 考虑本次变调后的实际演唱音高
    f0_shifted = f0 * (2.0 ** (pitch_applied / 12.0))

    vocal_range = None
    if int(valid.sum()) >= 20:
        v = f0_shifted[valid]
        vocal_range = {
            "p5": round(float(np.percentile(v, 5)), 1),
            "median": round(float(np.percentile(v, 50)), 1),
            "p95": round(float(np.percentile(v, 95)), 1),
        }

    issues = []
    if model_range and model_range.get("p5") and model_range.get("p95"):
        mp5 = float(model_range["p5"])
        mp95 = float(model_range["p95"])
        hi_lim = mp95 * (2.0 ** (4.0 / 12.0))
        lo_lim = mp5 * (2.0 ** (-6.0 / 12.0))
        hi_mask = valid & (f0_shifted > hi_lim)
        lo_mask = valid & (f0_shifted < lo_lim)
        for s, e in merge_spans(hi_mask, hop_sec, min_dur=0.6, gap_sec=1.6)[:3]:
            issues.append({
                "start": round(s, 2), "end": round(e, 2), "kind": "too_high",
                "note": f"{fmt_t(s)}–{fmt_t(e)} 高音略超模型舒适上限",
            })
        for s, e in merge_spans(lo_mask, hop_sec, min_dur=0.8, gap_sec=1.6)[:3]:
            issues.append({
                "start": round(s, 2), "end": round(e, 2), "kind": "too_low",
                "note": f"{fmt_t(s)}–{fmt_t(e)} 低音偏低、可能偏闷或失真",
            })

    # 检测换声输出是否存在连续剧烈音高抖动（疑似破音或伴奏漏音）
    if conv_path:
        try:
            yc, _ = librosa.load(conv_path, sr=sr, mono=True)
            if yc.size >= sr // 2:
                rmsc = librosa.feature.rms(y=yc, frame_length=1024, hop_length=hop)[0]
                pkc = float(np.percentile(rmsc, 98)) if rmsc.size else 0.0
                actc = rmsc > max(1e-4, pkc * 0.10)
                f0c = librosa.yin(yc, fmin=70.0, fmax=1000.0, sr=sr, frame_length=1024, hop_length=hop)
                nc = min(len(f0c), len(actc))
                f0c = f0c[:nc]
                actc = actc[:nc]
                vc = actc & np.isfinite(f0c) & (f0c > 75.0) & (f0c < 980.0)
                semi = np.where(vc, 12.0 * np.log2(np.maximum(f0c, 1.0)), np.nan)
                diff = np.abs(np.diff(semi, prepend=semi[0]))
                jump = vc & np.isfinite(diff) & (diff > 7.0)
                # 滑动 0.5 秒窗内出现 >=3 次剧烈跳变才标为疑似不稳定，过滤正常咬字换气
                win = max(3, int(round(0.5 / hop_sec)))
                dens = np.convolve(jump.astype(np.float32), np.ones(win, dtype=np.float32), mode="same")
                unstable = dens >= 3.0
                for s, e in merge_spans(unstable, hop_sec, min_dur=0.4, gap_sec=1.8)[:3]:
                    issues.append({
                        "start": round(s, 2), "end": round(e, 2), "kind": "unstable",
                        "note": f"{fmt_t(s)}–{fmt_t(e)} 音高波动较大（疑似破音或残余伴奏干扰）",
                    })
        except Exception:
            pass

    issues.sort(key=lambda x: x["start"])
    print(json.dumps({"issues": issues[:6], "vocalRange": vocal_range}, ensure_ascii=False))

main()
"""


class SingEngine:
    """一个进程里只建一次，之后所有请求共用（模型常驻）。"""

    def __init__(self, model: str = DEFAULT_MODEL, index: str = DEFAULT_INDEX):
        self.model = model
        self.model_path = str(RVC_ROOT / "assets" / "weights" / model)  # 绝对路径，恢复原模型时要用
        self.index = index if index and Path(index).is_file() else ""
        self.ready = False
        self.load_ms = 0
        self.sr = 40000
        self._lock = threading.Lock()
        self._vc = None

    # -- 模型热切换（选模对比试听用） --------------------------------

    def set_model(self, ckpt: "Path | str", index: str = "") -> None:
        """热切换加载的模型/索引，不用重启进程。

        ckpt 可以是任意位置的 .pth：RVC 的 get_vc 用 f'{weight_root}/{sid}' 拼路径，
        所以这里临时把 weight_root 指到 ckpt 所在目录。线程安全由任务串行保证。
        """
        ckpt = Path(ckpt)
        index = index if index and Path(index).is_file() else ""
        if self.ready and str(ckpt) == self.model_path and index == self.index:
            return
        if not self.ready:
            self.model = ckpt.name
            self.index = index
            self.load()
            self.model_path = str(ckpt)
            return
        cwd_bak = os.getcwd()
        os.chdir(RVC_ROOT)
        old_root = os.environ.get("weight_root")
        try:
            os.environ["weight_root"] = str(ckpt.parent)
            with self._lock:
                self._vc.get_vc(ckpt.name)
            self.model = ckpt.name
            self.model_path = str(ckpt)
            self.index = index
            try:
                self.sr = int(self._vc.cpt["config"][-1])
            except Exception:  # noqa: BLE001
                pass
            log(f"已切换模型：{self.model}（索引={'有' if self.index else '无'}）")
        finally:
            if old_root is not None:
                os.environ["weight_root"] = old_root
            os.chdir(cwd_bak)

    # -- 加载 ------------------------------------------------------

    def load(self) -> None:
        if self.ready:
            return
        t0 = time.time()
        # RVC 的 infer 模块用相对路径找 assets/rmvpe、configs/，必须站在项目根。
        # 注意这是进程级副作用：调用方传进来的相对路径会在 chdir 之后失效，
        # 所以 load() 结束时要把 cwd 还回去。
        cwd_bak = os.getcwd()
        os.chdir(RVC_ROOT)
        sys.path.insert(0, str(RVC_ROOT))
        os.environ["weight_root"] = str(RVC_ROOT / "assets" / "weights")
        os.environ["index_root"] = str(RVC_ROOT / "logs")
        os.environ["outside_index_root"] = str(RVC_ROOT / "assets" / "indices")
        os.environ["rmvpe_root"] = str(RVC_ROOT / "assets" / "rmvpe")
        os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

        from configs.config import Config
        from infer.vc.modules import VC

        argv_bak = sys.argv[:]
        sys.argv = [sys.argv[0]]  # Config() 会解析 argv，不清空会被 worker 自己的参数带歪
        try:
            cfg = Config()
        finally:
            sys.argv = argv_bak

        vc = VC(cfg)
        vc.get_vc(self.model)
        self._vc = vc
        try:  # cpt["config"][-1] 就是模型采样率；读不到就按 40k 兜底（后面还会用返回值覆盖）
            self.sr = int(vc.cpt["config"][-1])
        except Exception:  # noqa: BLE001
            self.sr = 40000
        os.chdir(cwd_bak)
        self.ready = True
        self.model_path = str(RVC_ROOT / "assets" / "weights" / self.model)
        self.load_ms = int((time.time() - t0) * 1000)
        log(f"模型就绪：{self.model}（{self.load_ms} ms）索引={'有' if self.index else '无'}")

    def unload(self, reason: str = "") -> bool:
        """主动卸载常驻 GPU 模型并清空 CUDA 缓存，归还 8G 卡约 1.5~2GB 显存。"""
        with self._lock:
            if not self.ready and self._vc is None:
                return False
            vc = self._vc
            self._vc = None
            self.ready = False
            if vc is not None:
                try:
                    pl = getattr(vc, "pipeline", None)
                    if pl is not None:
                        for attr in ("model_rmvpe", "model_fcpe"):
                            if hasattr(pl, attr):
                                try:
                                    delattr(pl, attr)
                                except Exception:  # noqa: BLE001
                                    pass
                    for attr in ("net_g", "hubert_model", "pipeline", "cpt"):
                        if hasattr(vc, attr):
                            try:
                                setattr(vc, attr, None)
                            except Exception:  # noqa: BLE001
                                pass
                except Exception:  # noqa: BLE001
                    pass
                del vc
            gc.collect()
            free_note = ""
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    try:
                        torch.cuda.ipc_collect()
                    except Exception:  # noqa: BLE001
                        pass
                    free_gb = self._free_gb()
                    free_note = f"，当前空闲显存 {free_gb:.2f} GB"
            except Exception:  # noqa: BLE001
                pass
            tag = f"（{reason}）" if reason else ""
            log(f"已卸载常驻模型释放显存{tag}{free_note}")
            return True

    def info(self) -> dict:
        return {
            "ready": self.ready,
            "model": self.model,
            "index": Path(self.index).name if self.index else "",
            "samplerate": self.sr,
            "loadMs": self.load_ms,
            "chunkSec": CHUNK_SEC,
            "uvrAvailable": importlib.util.find_spec("audio_separator") is not None,
            "fcpeAvailable": importlib.util.find_spec("torchfcpe") is not None,
        }

    # -- 分离 ------------------------------------------------------

    def separate(self, src: Path, out_dir: Path, cancel: threading.Event,
                 progress: Optional[Callable[[float, str], None]] = None,
                 *, engine: str = "htdemucs", dereverb: bool = False,
                 karaoke: bool = False, fallback: bool = True) -> tuple:
        """分离 vocals/inst：支持快速档 htdemucs 与精唱档 roformer（+ 可选去伴唱和声与去混响）。

        坑：`Popen(stdout=PIPE)` 之后必须**持续读**，否则子进程写满管道缓冲区（Windows 64KB）
        就会永久阻塞在 write 上——现象是 CPU 0%、显存也没动静、看起来"卡死"。
        """
        out_dir.mkdir(parents=True, exist_ok=True)
        vocals = out_dir / "vocals.wav"
        inst = out_dir / "inst.wav"
        if vocals.is_file() and inst.is_file():
            return vocals, inst
        if not SEP_PY.is_file():
            raise RuntimeError(f"找不到分离用的 python：{SEP_PY}")
        if not SEP_SCRIPT.is_file():
            raise RuntimeError(f"找不到分离脚本：{SEP_SCRIPT}")

        sep_engine = "roformer" if str(engine or "").strip().lower() in ("roformer", "uvr", "uvr5") else "htdemucs"
        # 8G 卡跑 RoFormer/Karaoke/De-Reverb 需要约 2.5~3.5GB 显存，空闲不足时先卸载常驻 RVC 避免 OOM
        if (sep_engine == "roformer" or dereverb or karaoke) and self.ready and self._free_gb() < 3.6:
            self.unload("精唱分离腾出显存")

        cmd = [
            str(SEP_PY), str(SEP_SCRIPT), str(src), str(out_dir),
            "--device", "auto",
            "--engine", sep_engine,
        ]
        if karaoke:
            cmd.append("--karaoke")
        if dereverb:
            cmd.append("--dereverb")
        if not fallback:
            cmd.append("--no-fallback")

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="ignore", bufsize=1,
        )
        tail: list = []
        label_sep = "UVR5 精唱分离" if sep_engine == "roformer" else "分离人声与伴奏"

        def reader() -> None:
            pct = 0
            assert proc.stdout is not None
            for line in proc.stdout:
                s = line.strip()
                if not s:
                    continue
                tail.append(s)
                del tail[:-40]
                if any(k in s for k in ("自动回落", "未安装 audio-separator", "去伴唱", "去混响")):
                    log(s)
                # tqdm 的 "... 12%|█  | 3/24" 或 "分离 12%" / "去混响 78%"
                m = re.search(r"(\d{1,3})%", s)
                if m and progress:
                    pct = max(pct, min(99, int(m.group(1))))
                    progress(0.02 + 0.18 * pct / 100.0, f"{label_sep} {pct}%")

        t = threading.Thread(target=reader, name="fishsing-sep", daemon=True)
        t.start()
        while proc.poll() is None:
            if cancel.is_set():
                proc.kill()
                t.join(timeout=3)
                raise RuntimeError("已取消")
            time.sleep(0.2)
        t.join(timeout=3)
        if proc.returncode != 0:
            raise RuntimeError("分离失败：" + " / ".join(tail[-3:]))
        if not vocals.is_file():
            raise RuntimeError("分离没产出 vocals.wav：" + " / ".join(tail[-3:]))
        return vocals, inst if inst.is_file() else None

    # -- 换声 ------------------------------------------------------

    def _free_gb(self) -> float:
        """当前空闲显存（GB）。取不到就当 0，走最小切片。"""
        try:
            import torch
            if not torch.cuda.is_available():
                return 0.0
            free, _total = torch.cuda.mem_get_info()
            return free / 1e9
        except Exception:  # noqa: BLE001
            return 0.0

    def _chunk_sec(self) -> float:
        """
        按当前空闲显存挑每片时长。encoder 的注意力是 O(n²)，片长翻倍显存约翻四倍，
        所以显存紧的时候要主动缩小，而不是等 OOM 再重试。
        """
        free = self._free_gb()
        if free >= 4.0:
            return CHUNK_SEC
        if free >= 2.6:
            return 40.0
        if free >= 1.8:
            return 28.0
        return 18.0

    def _infer_piece(self, seg: np.ndarray, sr: int, tmp: Path, tag: str, *,
                     pitch: int, index_rate: float, protect: float, rms_mix_rate: float,
                     f0_method: str = "rmvpe", cancel: threading.Event) -> tuple:
        """单片推理；显存不够就把这片对半切再试（唱歌时桌宠的 TTS 常驻会吃掉一半显存）。"""
        import torch

        if cancel.is_set():
            raise RuntimeError("已取消")
        method = "fcpe" if str(f0_method or "").strip().lower() == "fcpe" else "rmvpe"
        path = tmp / f"piece_{tag}.wav"
        write_audio(path, seg, sr)
        try:
            with self._lock:  # VC 只有一份，串行
                status, result = self._vc.vc_single(
                    0, str(path), int(pitch), method,
                    self.index, float(index_rate), 0, float(rms_mix_rate), float(protect),
                )
            if (not result or result[0] is None or result[1] is None) and method == "fcpe":
                if "torchfcpe" in str(status) or "No module named" in str(status):
                    log("当前环境缺少 torchfcpe，自动回落 rmvpe")
                    with self._lock:
                        status, result = self._vc.vc_single(
                            0, str(path), int(pitch), "rmvpe",
                            self.index, float(index_rate), 0, float(rms_mix_rate), float(protect),
                        )
            if not result or result[0] is None or result[1] is None:
                raise RuntimeError(f"第 {tag} 片换声失败：{status}")
            audio = to_unit_scale(result[1])
            if audio.ndim == 1:
                audio = audio.reshape(-1, 1)
            osr = int(result[0])
            return osr, self._fit_length(audio, int(round(seg.shape[0] * osr / sr)))
        except Exception as e:  # noqa: BLE001
            oom = isinstance(e, torch.OutOfMemoryError) or "out of memory" in str(e).lower()
            if not oom:
                raise
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            if seg.shape[0] < sr * 12:  # 已经短到 12 秒还 OOM，那就是真不够
                raise RuntimeError(
                    "显存不够：这块 8G 卡被别的任务占了（多半是桌宠的语音服务）。"
                    "关掉它，或者等它空闲了再唱。"
                ) from e
            log(f"显存不足，第 {tag} 片对半切重试（{seg.shape[0] / sr:.0f}s → 两半）")
            mid = seg.shape[0] // 2
            sr_a, a = self._infer_piece(seg[:mid], sr, tmp, f"{tag}a", pitch=pitch,
                                        index_rate=index_rate, protect=protect,
                                        rms_mix_rate=rms_mix_rate, f0_method=method, cancel=cancel)
            _sr_b, b = self._infer_piece(seg[mid:], sr, tmp, f"{tag}b", pitch=pitch,
                                         index_rate=index_rate, protect=protect,
                                         rms_mix_rate=rms_mix_rate, f0_method=method, cancel=cancel)
            return sr_a, np.concatenate([a, b], axis=0)
        finally:
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    @staticmethod
    def _fit_length(audio: np.ndarray, want: int) -> np.ndarray:
        """
        把单片输出对齐到输入的时长。

        为什么要这一步：RVC 的 cli 会把音频补齐到 hop 的整数倍，长片偶尔多出几百毫秒到几秒，
        拼起来就会和伴奏错位（听感是"越唱越偏"）。这里按输入长度精确裁剪/补零。
        """
        if want <= 0:
            return audio
        n = audio.shape[0]
        if n == want:
            return audio
        if n > want:
            return audio[:want]
        pad = np.zeros((want - n, audio.shape[1]), dtype=audio.dtype)
        return np.concatenate([audio, pad], axis=0)

    def _infer_piece_subprocess(self, seg: np.ndarray, sr: int, tmp: Path, tag: str, *,
                                pitch: int, index_rate: float, protect: float,
                                rms_mix_rate: float, f0_method: str = "rmvpe",
                                cancel: threading.Event) -> tuple:
        """
        单片换声，但**开一个独立进程**跑 `infer.cli`。

        为什么多片时不用常驻对象：实测同一个 VC 对象连续调 `vc_single`，第 2 片会从
        13 秒变成 214 秒（0% CPU、显存被吃住、WDDM 开始换页）。这是 RVC 那套 pipeline
        在长驻进程里的老问题，片越长越明显。独立进程每片多付 8 秒模型加载，但时间是线性的、
        不会随片数恶化——整首 5:20 实测 6 片 76 秒。
        """
        import torch  # noqa: F401

        if cancel.is_set():
            raise RuntimeError("已取消")
        method = "fcpe" if str(f0_method or "").strip().lower() == "fcpe" else "rmvpe"
        in_path = tmp / f"sp_{tag}.wav"
        out_path = tmp / f"sp_{tag}_out.wav"
        write_audio(in_path, seg, sr)
        env = os.environ.copy()
        env["PATH"] = str(FFMPEG.parent) + os.pathsep + env.get("PATH", "")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        env.setdefault("RVC_CUDA_GRAPH", "0")
        args = [
            sys.executable, "-m", "infer.cli",
            "--model", self.model_path or self.model,
            "--input", str(in_path),
            "--output", str(out_path),
            "--index-rate", str(float(index_rate)),
            "--pitch", str(int(pitch)),
            "--protect", str(float(protect)),
            "--rms-mix-rate", str(float(rms_mix_rate)),
            "--f0-method", method,
        ]
        if self.index:
            args += ["--index", self.index]
        proc = subprocess.Popen(args, cwd=str(RVC_ROOT), env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="ignore", bufsize=1)
        tail: list = []

        def reader() -> None:
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.strip()
                if line:
                    tail.append(line)
                    del tail[:-20]

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        while proc.poll() is None:
            if cancel.is_set():
                proc.kill()
                t.join(timeout=3)
                raise RuntimeError("已取消")
            time.sleep(0.2)
        t.join(timeout=3)
        if proc.returncode != 0 or not out_path.is_file():
            raise RuntimeError(f"第 {tag} 片失败：" + " / ".join(tail[-2:]))
        audio, out_sr = read_audio(out_path)
        return out_sr, self._fit_length(audio, int(round(seg.shape[0] * out_sr / sr)))

    def convert(self, src: Path, dst: Path, *, pitch: int = 0, index_rate: float = 0.75,
                protect: float = 0.33, rms_mix_rate: float = 0.0, f0_method: str = "rmvpe",
                progress: Optional[Callable[[float, str], None]] = None,
                cancel: Optional[threading.Event] = None) -> dict:
        """把整段音频切片换声，返回 {sr, chunks, seconds}。"""
        if not self.ready:
            self.load()
        cancel = cancel or threading.Event()
        dur = probe_duration(src)
        chunk_sec = self._chunk_sec()
        n = max(1, int(np.ceil(dur / chunk_sec))) if dur > 0 else 1
        if chunk_sec < CHUNK_SEC:
            log(f"空闲显存偏少，改按 {chunk_sec:.0f} 秒切（默认 {CHUNK_SEC:.0f} 秒）")
        tmp = Path(tempfile.mkdtemp(prefix="fishsing-"))
        pieces, out_sr = [], self.sr
        try:
            # 先整段解码成 wav，再用 soundfile 按片切（避免 ffmpeg 每片都读一遍源文件）
            whole = to_wav(src, tmp / "whole.wav")
            data, out_sr = read_audio(whole)
            in_sr = out_sr  # 输入采样率；别和输出采样率混用（混了会让第 2 片算错目标长度）
            step = int(chunk_sec * in_sr)
            # 关闭 CUDA Graph 后常驻引擎可稳定连续推理，省去每片重载模型的开销；
            # 如需回退旧的逐片独立子进程模式，可设 FISHSING_SUBPROCESS_CHUNKS=1
            use_sub = os.environ.get("FISHSING_SUBPROCESS_CHUNKS") == "1"
            for i in range(n):
                if cancel.is_set():
                    raise RuntimeError("已取消")
                seg = data[i * step:(i + 1) * step]
                if seg.shape[0] < in_sr * 0.05:  # 尾巴不足 50ms 丢掉，避免爆音
                    break
                runner = self._infer_piece_subprocess if (n > 1 and use_sub) else self._infer_piece
                out_sr, audio = runner(
                    seg, in_sr, tmp, f"{i:03d}",
                    pitch=pitch, index_rate=index_rate, protect=protect,
                    rms_mix_rate=rms_mix_rate, f0_method=f0_method, cancel=cancel,
                )
                pieces.append(audio)
                if progress:
                    progress(0.2 + 0.6 * (i + 1) / n, f"换声 {i + 1}/{n} 片")
            if not pieces:
                raise RuntimeError("没有产出任何音频")
            pieces = self._smooth_seams(pieces, out_sr)
            mer = np.concatenate(pieces, axis=0)
            write_audio(dst, mer, out_sr)
            return {"sr": out_sr, "chunks": len(pieces), "seconds": mer.shape[0] / out_sr}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @staticmethod
    def _smooth_seams(pieces: list, out_sr: int, *, fade_ms: int = 8) -> list:
        """
        分片接缝处理：各片独立推理，片边容易有响度跳变和相位不连续（听感是
        "接缝处咯噔一下"）。

        **绝不改时长**：只做边界等长的淡出/淡入（各 fade_ms），一个样本都不删。
        0.4.0 第一版用的是"重叠交叉淡化"，每条缝吃掉 50ms——4 分半的歌 4 条缝
        就少 200ms，人声比伴奏越唱越快（用户实测"越到后面越不合拍"）。改成等长
        淡化后，既压住爆音，时长又精确对齐伴奏。
        **也不做**片间响度归一：主歌/副歌的响度差是音乐动态，拉平会毁听感。
        """
        if len(pieces) < 2:
            return pieces
        n = int(out_sr * fade_ms / 1000)
        if n <= 0:
            return pieces
        ramp = np.linspace(0.0, 1.0, n).reshape(-1, 1)
        for i in range(1, len(pieces)):
            a, b = pieces[i - 1], pieces[i]
            if a.shape[0] > n and b.shape[0] > n:
                pieces[i - 1] = np.concatenate([a[:-n], a[-n:] * (1.0 - ramp)], axis=0)  # 尾巴淡出
                pieces[i] = np.concatenate([b[:n] * ramp, b[n:]], axis=0)                # 开头淡入
        return pieces

    # -- 混音 ------------------------------------------------------

    @staticmethod
    def _active_rms(audio: np.ndarray) -> float:
        """计算有效发声段 RMS（过滤静音帧，避免长前奏/间奏拉偏响度估计）。"""
        if audio.size == 0:
            return 0.0
        mono = audio.mean(axis=1) if audio.ndim > 1 else audio
        a = np.abs(mono.astype(np.float64))
        peak = float(a.max())
        if peak <= 1e-6:
            return 0.0
        active = mono[a > peak * 0.05]
        if active.size < 256:
            active = mono
        return float(np.sqrt(np.mean(active.astype(np.float64) ** 2)))

    def mix(self, vocals: Path, inst: Optional[Path], dst: Path, *,
            vocal_gain: Optional[float] = None, inst_gain: Optional[float] = None,
            ref_vocal: Optional[Path] = None, reverb: str = "off", polish: bool = True,
            target_sr: int = 44100, peak: float = 0.95) -> dict:
        v, vsr = read_audio(vocals)
        if inst is None or not Path(inst).is_file():
            if polish:
                tmp_dir = Path(tempfile.mkdtemp(prefix="fishsing-mix-"))
                try:
                    pol_wav = tmp_dir / "v_pol.wav"
                    run_ff([
                        FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", vocals,
                        "-af", self._vocal_polish_filter(reverb="off"),
                        "-ar", str(vsr), "-ac", str(v.shape[1]), "-c:a", "pcm_s24le", pol_wav,
                    ])
                    v, vsr = read_audio(pol_wav)
                except Exception as e:  # noqa: BLE001
                    log(f"清唱人声润色跳过：{e}")
                finally:
                    shutil.rmtree(tmp_dir, ignore_errors=True)
            out = v
        else:
            tmp_dir = Path(tempfile.mkdtemp(prefix="fishsing-mix-"))
            try:
                vocal_in = vocals
                v_filter = self._vocal_polish_filter(reverb=reverb) if polish else (
                    self._reverb_filter() if reverb == "light" else ""
                )
                if v_filter:
                    proc_wav = tmp_dir / "v_proc.wav"
                    try:
                        run_ff([
                            FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", vocal_in,
                            "-af", v_filter,
                            "-ar", str(target_sr), "-ac", "2", "-c:a", "pcm_s24le", proc_wav,
                        ])
                        vocal_in = proc_wav
                        v, vsr = read_audio(vocal_in)
                    except Exception as e:  # noqa: BLE001
                        log(f"人声润色/混响跳过，退回原干声：{e}")
                if vsr != target_sr:
                    tmpv = tmp_dir / "v.wav"
                    run_ff([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", vocal_in,
                            "-ar", str(target_sr), "-ac", "2", "-c:a", "pcm_s24le", tmpv])
                    v, vsr = read_audio(tmpv)
                tmpi = tmp_dir / "i.wav"
                inst_args = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", inst]
                if polish:
                    # 混音师常用的人声让位（Vocal Pocket）：伴奏 2.5kHz 轻压 1.5dB，人声更清晰不打架
                    inst_args += ["-af", "equalizer=f=2500:t=q:w=1.4:g=-1.5"]
                inst_args += ["-ar", str(target_sr), "-ac", "2", "-c:a", "pcm_s24le", tmpi]
                run_ff(inst_args)
                i, _ = read_audio(tmpi)
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)

            n = min(v.shape[0], i.shape[0])
            if v.shape[1] == 1 and i.shape[1] == 2:
                v = np.repeat(v, 2, axis=1)
            elif v.shape[1] == 2 and i.shape[1] == 1:
                i = np.repeat(i, 2, axis=1)

            # 有原唱参考干声时，温和对齐人声响度到原唱水平，避免不同伴奏下人声突兀或被淹没
            match_gain = 1.0
            has_ref = False
            if ref_vocal is not None and Path(ref_vocal).is_file():
                try:
                    rv, _ = read_audio(Path(ref_vocal))
                    ref_rms = self._active_rms(rv)
                    v_rms = self._active_rms(v[:n])
                    if ref_rms > 1e-4 and v_rms > 1e-4:
                        match_gain = max(0.65, min(1.5, ref_rms / v_rms))
                        has_ref = True
                except Exception:  # noqa: BLE001
                    pass
            vg = (1.06 if has_ref else 1.15) if vocal_gain is None else float(vocal_gain)
            ig = (0.94 if has_ref else 0.85) if inst_gain is None else float(inst_gain)
            out = v[:n] * (vg * match_gain) + i[:n] * ig

        # 柔和防削波：高于 0.90 的瞬态尖峰轻度软限幅，避免单个爆音拉低整首响度
        out = out.astype(np.float32)
        m = float(np.abs(out).max()) if out.size else 0.0
        if m > 0.90:
            knee = 0.88
            excess = np.maximum(0.0, np.abs(out) - knee)
            compressed = knee + (peak - knee) * np.tanh(excess / max(0.05, peak - knee))
            out = np.where(np.abs(out) > knee, np.sign(out) * compressed, out).astype(np.float32)
            m = float(np.abs(out).max())
        if m > peak:
            out = (out * (peak / m)).astype(np.float32)
        write_audio(dst, out, vsr if inst is None else target_sr)
        return {"sr": vsr if inst is None else target_sr,
                "seconds": out.shape[0] / (vsr if inst is None else target_sr), "peak": round(m, 3)}

    @staticmethod
    def _reverb_filter() -> str:
        """干湿分离的轻度自然短房间混响（不糊字头、不掩蔽双轨延迟）。"""
        return (
            "asplit[dry][wet];"
            "[wet]highpass=f=240,lowpass=f=5600,"
            "aecho=0.75:0.85:29|47|73|109:0.20|0.15|0.10|0.06,volume=0.32[rev];"
            "[dry][rev]amix=inputs=2:normalize=0"
        )

    @classmethod
    def _vocal_polish_filter(cls, reverb: str = "off") -> str:
        """针对 RVC 人声特性的克制润色：清低噪、轻压 6.8kHz 齿音毛刺、补暖与空气感、温和压缩。"""
        base = (
            "highpass=f=85,"
            "equalizer=f=280:t=q:w=1.2:g=1.2,"
            "equalizer=f=6800:t=q:w=1.8:g=-2.0,"
            "highshelf=f=10500:g=1.4,"
            "acompressor=threshold=-18dB:ratio=2.4:attack=15:release=140:makeup=1.4"
        )
        if reverb == "light":
            return f"{base},{cls._reverb_filter()}"
        return base

    # -- 一键流程 --------------------------------------------------

    # -- 音域与变调推荐 ---------------------------------------------

    def _f0_stats(self, path: "Path | str", *, max_sec: float = 90.0) -> Optional[dict]:
        """一段人声的音域统计。在**子进程**里跑——pyin 会长时间持有 GIL，
        进程内分析会把 HTTP 线程卡死，进度轮询 10 秒收不到响应就超时（0.1.6 实测）。
        只分析中段 90 秒，成本可控。"""
        path = Path(path)
        try:
            proc = subprocess.run(
                [sys.executable, "-c", _F0_ANALYZE_SRC, str(path), str(max_sec)],
                capture_output=True, text=True, encoding="utf-8", errors="ignore",
                timeout=180,
            )
            out = (proc.stdout or "").strip().splitlines()
            d = json.loads(out[-1]) if out else None
            if isinstance(d, dict) and d.get("frames", 0) > 0:
                return d
            return None
        except Exception as e:  # noqa: BLE001
            log(f"音域分析失败（{path.name}）：{e}")
            return None

    def model_range(self, model: str) -> Optional[dict]:
        """模型（训练数据）的音域。缓存在 logs/<exp>/range.json，训完第一次唱歌时现算一次。"""
        exp = str(model).removesuffix(".pth")
        log_dir = RVC_ROOT / "logs" / exp
        cache = log_dir / "range.json"
        try:
            if cache.is_file():
                d = json.loads(cache.read_text(encoding="utf-8"))
                if d.get("frames", 0) > 0:
                    return d
        except Exception:  # noqa: BLE001
            pass
        gt = log_dir / "0_gt_wavs"
        if not gt.is_dir():
            return None
        files = sorted(gt.glob("*.wav"))
        if not files:
            return None
        # 隔段采样，覆盖整首歌而不是只听开头
        step = max(1, len(files) // 8)
        picked = files[::step][:8]
        stats = [s for s in (self._f0_stats(f) for f in picked) if s]
        if not stats:
            return None
        merged = {k: sum(s[k] for s in stats) / len(stats) for k in ("p5", "p25", "median", "p95")}
        merged["frames"] = sum(s["frames"] for s in stats)
        merged["files"] = len(stats)
        merged["computedAt"] = time.time()
        try:
            cache.write_text(json.dumps(merged, ensure_ascii=False), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
        return merged

    @staticmethod
    def suggest_pitch(source: Optional[dict], model: Optional[dict]) -> dict:
        """保守策略：只对明显出音域的源（男声原调）移调，女声源一律 0。

        实测教训（0.1.5）：按 P5 精确对齐会给女声源推 +6，移调带来的音色损失
        比低音区稍微出格更伤——模型对数据下限以下有泛化能力，8 个半音以内都兜得住。
        """
        out = {"pitch": 0, "reason": "", "source": source, "model": model}
        if not source or not model:
            out["reason"] = "缺音域数据，保持 0"
            return out
        sp, mp = source.get("p5", 0), model.get("p5", 0)
        if sp <= 0 or mp <= 0:
            out["reason"] = "音域数据无效，保持 0"
            return out
        semi = 12 * math.log2(mp / sp)  # >0：源曲低音比模型数据下限低
        if semi > 8:
            pitch = min(6, math.ceil(semi - 8))
            out["reason"] = f"源曲低音 {sp:.0f}Hz 比模型数据下限低 {semi:.1f} 半音（男声原调区间），建议 +{pitch}"
        elif semi < -8:
            pitch = max(-3, math.floor(semi + 8))
            out["reason"] = f"源曲比模型数据高 {(-semi):.1f} 半音，建议 {pitch}"
        else:
            pitch = 0
            out["reason"] = f"源曲低音 {sp:.0f}Hz 比模型数据下限低 {max(0.0, semi):.1f} 半音，在模型可覆盖范围内（8 半音才移调），保持 0"
        out["pitch"] = pitch
        return out

    def song(self, src: Path, work: Path, *, separate: bool = True, mode: str = "full",
             pitch: "int | str" = 0, index_rate: float = 0.75, protect: float = 0.33,
             rms_mix_rate: float = 0.0,
             f0_method: str = "rmvpe",
             separator: str = "htdemucs",
             dereverb: bool = False,
             karaoke: bool = False,
             model: str = "",
             duet_model: str = "",
             duet_mode: str = "alternate",
             dynamic_style: str = "off",
             segments: "list | None" = None,
             snap_cut: "dict | None" = None,
             session_dir: Optional[Path] = None,
             harmony: "dict | None" = None,
             reverb: str = "off",
             polish: bool = True,
             sep_cache: Optional[Path] = None,
             progress: Optional[Callable[[float, str], None]] = None,
             cancel: Optional[threading.Event] = None) -> dict:
        """
        整首歌：分离 → 换声（支持临时换模型/主歌柔副歌亮/分段换音色 + 可选和声） → 混音 → 声学体检。
        mode: full=带伴奏 / vocals=只要人声（清唱）/ mixed 同 full 但保留中间文件
        pitch: 半音数；'auto' = 分离后按源曲与模型音域自动推荐。
        """
        cancel = cancel or threading.Event()
        work.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        report = progress or (lambda p, m: None)
        sep_engine = "roformer" if str(separator or "").strip().lower() in ("roformer", "uvr", "uvr5") else "htdemucs"
        f0_m = "fcpe" if str(f0_method or "").strip().lower() == "fcpe" else "rmvpe"
        dyn_style = str(dynamic_style or "off").strip().lower()
        req_model = str(model or "").strip()
        req_duet = str(duet_model or "").strip()
        req_duet_mode = "unison" if str(duet_mode or "").strip().lower() == "unison" else "alternate"
        original_model = (self.model_path or str(RVC_ROOT / "assets" / "weights" / self.model), self.index)
        switched_model = False

        try:
            if req_model:
                ckpt, idx_p = self._resolve_model_ckpt(req_model)
                if ckpt and str(ckpt) != original_model[0]:
                    self.set_model(ckpt, idx_p)
                    switched_model = True

            return self._song_body(
                src, work, separate=separate, mode=mode, pitch=pitch,
                index_rate=index_rate, protect=protect, rms_mix_rate=rms_mix_rate,
                f0_m=f0_m, sep_engine=sep_engine, dereverb=dereverb, karaoke=karaoke, dyn_style=dyn_style,
                segments=segments, snap_cut=snap_cut, session_dir=session_dir,
                duet_model=req_duet, duet_mode=req_duet_mode,
                harmony=harmony, reverb=reverb, polish=polish, sep_cache=sep_cache,
                report=report, cancel=cancel, t0=t0,
            )
        finally:
            if switched_model:
                try:
                    self.set_model(Path(original_model[0]), original_model[1])
                except Exception as e:  # noqa: BLE001
                    log(f"唱完恢复原默认模型失败：{e}")

    def _song_body(self, src: Path, work: Path, *, separate: bool, mode: str,
                   pitch: "int | str", index_rate: float, protect: float,
                   rms_mix_rate: float, f0_m: str, sep_engine: str, dereverb: bool, karaoke: bool,
                   dyn_style: str, segments: "list | None", snap_cut: "dict | None",
                   session_dir: Optional[Path], duet_model: str, duet_mode: str,
                   harmony: "dict | None", reverb: str,
                   polish: bool, sep_cache: Optional[Path], report, cancel: threading.Event,
                   t0: float) -> dict:

        auto_pitch = isinstance(pitch, str) and pitch.strip().lower() == "auto"
        suggestion: Optional[dict] = None
        if auto_pitch:
            pitch = 0

        vocal_src = src
        inst = None
        sep_cached = False
        if separate:
            cache_v = (sep_cache / "vocals.wav") if sep_cache else None
            cache_i = (sep_cache / "inst.wav") if sep_cache else None
            if (cache_v and cache_v.is_file() and cache_v.stat().st_size > 1000
                    and (mode == "vocals" or (cache_i and cache_i.is_file() and cache_i.stat().st_size > 1000))):
                vocal_src = cache_v
                inst = cache_i if (cache_i and cache_i.is_file()) else None
                sep_cached = True
                log(f"复用分离缓存：{sep_cache}")
                report(0.18, "复用已分离的干声与伴奏")
            else:
                report(0.02, "UVR5 精唱分离" if sep_engine == "roformer" else "分离人声与伴奏")
                sep_out = work / "sep_tmp" if sep_cache else work
                vocal_src, inst = self.separate(
                    to_wav(src, work / "src.wav"), sep_out, cancel,
                    progress=lambda p, m: report(p, m),
                    engine=sep_engine, dereverb=bool(dereverb), karaoke=bool(karaoke), fallback=True,
                )
                if sep_cache and vocal_src.is_file():
                    try:
                        sep_cache.mkdir(parents=True, exist_ok=True)
                        tmp_v = sep_cache / "vocals.wav.tmp"
                        shutil.copy2(vocal_src, tmp_v)
                        os.replace(tmp_v, sep_cache / "vocals.wav")
                        if inst and inst.is_file():
                            tmp_i = sep_cache / "inst.wav.tmp"
                            shutil.copy2(inst, tmp_i)
                            os.replace(tmp_i, sep_cache / "inst.wav")
                        # 同步指向缓存持久文件，供会话快照与后续局部返工直接复用
                        vocal_src = sep_cache / "vocals.wav"
                        if inst and (sep_cache / "inst.wav").is_file():
                            inst = sep_cache / "inst.wav"
                    except OSError as e:
                        log(f"写入分离缓存失败（不影响本次出声）：{e}")
        else:
            vocal_src = to_wav(src, work / "src.wav")

        # 单句/短片段试唱复用整首分离缓存时，自动吸附到前后换气静音谷底再切
        snapped_range = None
        if snap_cut and (snap_cut.get("start") or snap_cut.get("duration")):
            v_all, vsr_all = read_audio(vocal_src)
            total_dur = v_all.shape[0] / float(vsr_all)
            s_req = max(0.0, float(snap_cut.get("start") or 0.0))
            d_req = float(snap_cut.get("duration") or 0.0)
            e_req = min(total_dur, s_req + d_req) if d_req > 0 else total_dur
            if e_req > s_req + 0.5:
                s_snap, e_snap = self._snap_bounds(v_all.mean(axis=1), vsr_all, s_req, e_req, max_shift=1.2)
                snapped_range = {"start": round(s_snap, 2), "end": round(e_snap, 2)}
                cut_v = work / "vocal_snapped.wav"
                self._slice_wav_fade(vocal_src, cut_v, s_snap, e_snap)
                vocal_src = cut_v
                if inst is not None and Path(inst).is_file():
                    cut_i = work / "inst_snapped.wav"
                    self._slice_wav_fade(inst, cut_i, s_snap, e_snap)
                    inst = cut_i
                log(f"单句静音边界吸附：{s_req:.1f}–{e_req:.1f}s → {s_snap:.2f}–{e_snap:.2f}s")

        if auto_pitch:
            report(0.19, "分析音域，推荐变调")
            suggestion = self.suggest_pitch(self._f0_stats(vocal_src), self.model_range(self.model))
            pitch = int(suggestion["pitch"])
            log(f"变调推荐：{suggestion['reason']}")

        # 提取副歌区间与自然乐句（既用于主歌柔副歌亮，也用于声学体检和无歌词兜底）
        phrases, chorus_ranges = self._detect_phrases_and_chorus(vocal_src, inst)

        report(0.2, "加载模型" if not self.ready else "开始换声")
        conv = work / "vocals_converted.wav"
        eff_segments = list(segments) if segments else None
        if not eff_segments and dyn_style == "soft-verse-bright-chorus" and chorus_ranges:
            eff_segments = self._build_dynamic_segments(
                vocal_src, chorus_ranges,
                index_rate=index_rate, protect=protect,
            )
            log(f"主歌柔/副歌亮分段换声：共 {len(eff_segments)} 段（副歌 {len(chorus_ranges)} 处）")

        if duet_model:
            info = self._convert_duet(
                vocal_src, conv,
                duet_model=duet_model, duet_mode=duet_mode,
                chorus_ranges=chorus_ranges, phrases=phrases,
                pitch=int(pitch), index_rate=index_rate, protect=protect,
                rms_mix_rate=rms_mix_rate, f0_method=f0_m, work=work,
                progress=lambda p, m: report(p, m), cancel=cancel,
            )
        elif eff_segments:
            info = self._convert_segmented(
                vocal_src, conv, eff_segments,
                pitch=int(pitch), index_rate=index_rate, protect=protect,
                rms_mix_rate=rms_mix_rate, f0_method=f0_m,
                progress=lambda p, m: report(p, m), cancel=cancel,
            )
        else:
            info = self.convert(vocal_src, conv, pitch=int(pitch), index_rate=index_rate,
                                protect=protect, rms_mix_rate=rms_mix_rate, f0_method=f0_m,
                                progress=lambda p, m: report(p, m), cancel=cancel)

        # 留存未叠和声的纯净主唱干声，供后续局部返工 fish_sing_patch 无损贴回
        saved_conv = ""
        saved_vsrc = str(vocal_src)
        saved_inst = str(inst) if inst else ""
        if session_dir is not None:
            try:
                session_dir.mkdir(parents=True, exist_ok=True)
                dst_conv = session_dir / "vocals_conv.wav"
                shutil.copy2(conv, dst_conv)
                saved_conv = str(dst_conv)
                if not sep_cache or not (sep_cache / "vocals.wav").is_file() or snapped_range is not None:
                    dst_vs = session_dir / "vocals_src.wav"
                    shutil.copy2(vocal_src, dst_vs)
                    saved_vsrc = str(dst_vs)
                    if inst and Path(inst).is_file():
                        dst_in = session_dir / "inst_src.wav"
                        shutil.copy2(inst, dst_in)
                        saved_inst = str(dst_in)
            except OSError as e:
                log(f"保存会话干声快照失败（不影响本次出声）：{e}")

        # 唱后轻量声学体检（副歌区间 + 乐句时间轴 + 音域越界/疑似跳变段）
        report(0.80, "声学体检")
        voc_report = self._inspect_vocals(
            vocal_src, conv, inst,
            model_range=self.model_range(self.model),
            pitch_applied=int(pitch),
            phrases=phrases,
            chorus_ranges=chorus_ranges,
        )

        # 和声堆叠：支持 double（副歌双轨厚声）、double+third、三度/五度和声
        harm_cfg = harmony or {}
        harm_mode = str(harm_cfg.get("mode") or "").strip().lower()
        harm_semis = [int(x) for x in (harm_cfg.get("semis") or []) if int(x) != 0]
        if harm_mode in ("double", "double+third") or harm_semis:
            label_h = "副歌双轨厚声" if harm_mode == "double" else (
                "副歌双轨 + 轻三度" if harm_mode == "double+third" else f"叠和声（{len(harm_semis)} 轨）"
            )
            report(0.82, label_h)
            stacked = self._stack_harmony(
                conv, vocal_src, harm_semis, pitch=int(pitch), index_rate=index_rate,
                protect=protect, rms_mix_rate=rms_mix_rate, f0_method=f0_m,
                gain=float(harm_cfg.get("gain", 0.22)),
                scope=str(harm_cfg.get("scope", "chorus")),
                mode=harm_mode or "pitch",
                inst_path=inst,
                work=work, report=report, cancel=cancel, base_report=0.82,
            )
            if stacked is not None:
                conv = stacked

        if mode == "vocals":
            out = work / "result.wav"
            mix_info = self.mix(conv, None, out, polish=polish)
        else:
            inst_for_mix = inst
            if pitch and inst is not None:
                # 整体变调：伴奏必须跟着一起移，否则人声和伴奏差 N 个半音。
                # （0.4.12 之前的真实问题：pitch≠0 时"听着怪但说不出哪不对"，
                #   唱男声歌几乎必中——自动变调会给 +6，伴奏却一直在原调。）
                report(0.84, f"伴奏同步变调 {int(pitch):+d} 半音")
                inst_for_mix = work / "inst_shifted.wav"
                try:
                    sr_i = int(sf.info(str(inst)).samplerate)
                except Exception:  # noqa: BLE001
                    sr_i = 44100
                run_ff([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(inst),
                        "-af", self.pitch_shift_filter(sr_i, int(pitch)), str(inst_for_mix)])
            report(0.88, "混音")
            out = work / "result.wav"
            mix_info = self.mix(conv, inst_for_mix, out, ref_vocal=vocal_src, reverb=reverb, polish=polish)

        report(1.0, "完成")
        result = {
            "output": str(out),
            "vocals": str(conv),
            "convVocal": saved_conv,
            "vocalSrc": saved_vsrc,
            "inst": saved_inst,
            "chunks": info["chunks"],
            "seconds": round(info["seconds"], 2),
            "samplerate": mix_info.get("sr", info["sr"]),
            "elapsedSec": round(time.time() - t0, 1),
            "sepCached": sep_cached,
            "separator": sep_engine,
            "dereverb": bool(dereverb),
            "f0Method": f0_m,
            "dynamicStyle": dyn_style,
            "pitchApplied": int(pitch),
            "report": voc_report,
        }
        if snapped_range is not None:
            result["snappedRange"] = snapped_range
        if duet_model:
            result["duetModel"] = duet_model
            result["duetMode"] = duet_mode
        if suggestion is not None:
            result["pitchSuggest"] = suggestion
        return result

    # -- 静音吸附 / 乐句切分 / 声学体检 / 分段换声 / 局部返工 ------------

    @staticmethod
    def _slice_wav_fade(src: Path, dst: Path, start_sec: float, end_sec: float, fade_ms: int = 25) -> None:
        """按起止秒裁剪音频并加轻微首尾淡入淡出，避免硬切产生咔哒声。"""
        data, sr = read_audio(src)
        a = max(0, min(data.shape[0], int(round(start_sec * sr))))
        b = max(a, min(data.shape[0], int(round(end_sec * sr))))
        seg = data[a:b].copy()
        fn = min(int(sr * fade_ms / 1000), seg.shape[0] // 4)
        if fn > 1:
            ramp = np.linspace(0.0, 1.0, fn, dtype=np.float32).reshape(-1, 1)
            seg[:fn] *= ramp
            seg[-fn:] *= (1.0 - ramp)
        write_audio(dst, seg, sr)

    @staticmethod
    def _snap_bounds(mono: np.ndarray, sr: int, start_sec: float, end_sec: float,
                     max_shift: float = 1.2) -> tuple:
        """把起止时间吸附到前后 max_shift 秒内能量最低的换气静音谷底，避免劈在字中间。"""
        dur = len(mono) / float(sr) if sr > 0 else 0.0
        s = max(0.0, min(dur, float(start_sec)))
        e = max(s, min(dur, float(end_sec)))
        if dur < 1.0 or e - s < 0.4:
            return s, e

        hop = max(1, int(round(0.02 * sr)))
        win = max(hop, int(round(0.04 * sr)))
        n_fr = max(1, (len(mono) - win) // hop)
        if n_fr < 5:
            return s, e
        rms = np.array(
            [float(np.sqrt(np.mean(mono[i * hop:i * hop + win] ** 2) + 1e-12)) for i in range(n_fr)],
            dtype=np.float32,
        )

        def _find_valley(target_sec: float, lo_bound: float, hi_bound: float) -> float:
            lo = max(lo_bound, target_sec - max_shift)
            hi = min(hi_bound, target_sec + max_shift)
            if hi <= lo:
                return target_sec
            i0 = max(0, int(lo / 0.02))
            i1 = min(n_fr, int(hi / 0.02) + 1)
            if i1 <= i0:
                return target_sec
            sub = rms[i0:i1]
            # 谷底能量相近时优先离目标更近的点（加极轻的距离惩罚）
            times = (np.arange(i0, i1, dtype=np.float32) * 0.02)
            pk = max(1e-5, float(np.percentile(rms, 95)))
            cost = (sub / pk) + 0.04 * np.abs(times - target_sec)
            best = i0 + int(np.argmin(cost))
            return float(best * 0.02)

        s_new = _find_valley(s, 0.0, max(0.0, e - 0.5))
        e_new = _find_valley(e, min(dur, s_new + 0.5), dur)
        return s_new, e_new

    def _detect_phrases_and_chorus(self, vocal_src: Path, inst_path: Optional[Path] = None) -> tuple:
        """从分离干声（及可选伴奏）检测副歌时间轴区间与静音分割的自然乐句列表。"""
        try:
            vy, sr = read_audio(vocal_src)
            mono = vy.mean(axis=1)
        except Exception:  # noqa: BLE001
            return [], []

        if len(mono) < sr:
            return [], []

        inst_mono = None
        if inst_path is not None and Path(inst_path).is_file():
            try:
                iy, isr = read_audio(Path(inst_path))
                im = iy.mean(axis=1)
                if isr != sr:
                    im = resample_linear_fallback(im.reshape(-1, 1), isr, sr)[:, 0]
                inst_mono = im
            except Exception:  # noqa: BLE001
                inst_mono = None

        gate = self._chorus_gate(mono, sr, scope="chorus", inst_mono=inst_mono)
        # 1) 提取连续副歌时间轴（gate > 0.35）
        chorus_ranges = []
        step_g = max(1, int(0.1 * sr))
        g_ds = gate[::step_g] > 0.35
        st = None
        for idx, flag in enumerate(g_ds):
            if flag and st is None:
                st = idx * 0.1
            elif not flag and st is not None:
                en = idx * 0.1
                if en - st >= 3.0:
                    chorus_ranges.append({"start": round(st, 2), "end": round(en, 2)})
                st = None
        if st is not None:
            en = len(mono) / float(sr)
            if en - st >= 3.0:
                chorus_ranges.append({"start": round(st, 2), "end": round(en, 2)})

        # 2) 按换气静音谷底切出自然乐句（保底歌词时间轴）
        hop = max(1, int(round(0.02 * sr)))
        win = max(hop, int(round(0.04 * sr)))
        n_fr = max(1, (len(mono) - win) // hop)
        rms = np.array(
            [float(np.sqrt(np.mean(mono[i * hop:i * hop + win] ** 2) + 1e-12)) for i in range(n_fr)],
            dtype=np.float32,
        )
        db = 20.0 * np.log10(rms + 1e-9)
        pk_db = float(np.percentile(db, 98))
        voiced = db > max(-48.0, pk_db - 28.0)

        # 填平 <0.30s 的短顿挫，使同一句保持连贯
        min_gap = int(round(0.30 / 0.02))
        v_idx = np.flatnonzero(voiced)
        if v_idx.size > 1:
            for a, b in zip(v_idx[:-1], v_idx[1:]):
                if 1 < (b - a) <= min_gap:
                    voiced[a:b] = True

        raw_spans = []
        cur_s = None
        for i, flag in enumerate(voiced):
            if flag and cur_s is None:
                cur_s = i
            elif not flag and cur_s is not None:
                if (i - cur_s) * 0.02 >= 0.7:
                    raw_spans.append([cur_s * 0.02, i * 0.02])
                cur_s = None
        if cur_s is not None and (n_fr - cur_s) * 0.02 >= 0.7:
            raw_spans.append([cur_s * 0.02, n_fr * 0.02])

        # 合并过短相邻碎句（<1.8s 且间隔 <1.0s）；拆分超长句（>10s 在最弱谷底拆）
        merged = []
        for s0, e0 in raw_spans:
            if merged and (merged[-1][1] - merged[-1][0] < 1.8) and (s0 - merged[-1][1] < 1.0):
                merged[-1][1] = e0
            else:
                merged.append([s0, e0])

        final_spans = []
        for s0, e0 in merged:
            if e0 - s0 <= 10.0:
                final_spans.append((s0, e0))
            else:
                cur = s0
                while e0 - cur > 10.0:
                    mid_lo = int((cur + 3.5) / 0.02)
                    mid_hi = min(n_fr, int((cur + 8.5) / 0.02))
                    if mid_hi > mid_lo:
                        cut_i = mid_lo + int(np.argmin(rms[mid_lo:mid_hi]))
                        cut_t = cut_i * 0.02
                    else:
                        cut_t = cur + 6.0
                    final_spans.append((cur, cut_t))
                    cur = cut_t
                if e0 - cur >= 0.8:
                    final_spans.append((cur, e0))

        phrases = []
        for k, (s0, e0) in enumerate(final_spans, 1):
            a_i = max(0, min(len(gate) - 1, int(s0 * sr)))
            b_i = max(a_i + 1, min(len(gate), int(e0 * sr)))
            is_ch = float(gate[a_i:b_i].mean()) >= 0.40
            phrases.append({
                "index": k,
                "start": round(s0, 2),
                "end": round(e0, 2),
                "section": "chorus" if is_ch else "verse",
            })
        return phrases, chorus_ranges

    def _inspect_vocals(self, vocal_src: Path, conv_wav: Optional[Path], inst_path: Optional[Path],
                        *, model_range: Optional[dict], pitch_applied: int,
                        phrases: list, chorus_ranges: list) -> dict:
        """唱后声学体检：音域风险段 + 疑似跳变段 + 副歌区间 + 一句话可读摘要。"""
        issues = []
        vocal_range = None
        try:
            proc = subprocess.run(
                [
                    sys.executable, "-c", _INSPECT_VOCALS_SRC,
                    str(vocal_src),
                    str(conv_wav) if (conv_wav and Path(conv_wav).is_file()) else "",
                    json.dumps(model_range, ensure_ascii=False) if model_range else "",
                    str(pitch_applied),
                ],
                capture_output=True, text=True, encoding="utf-8", errors="ignore",
                timeout=90,
            )
            lines = (proc.stdout or "").strip().splitlines()
            if lines:
                parsed = json.loads(lines[-1])
                if isinstance(parsed, dict):
                    issues = parsed.get("issues") or []
                    vocal_range = parsed.get("vocalRange")
        except Exception as e:  # noqa: BLE001
            log(f"声学体检跳过（不影响出声）：{e}")

        def _ft(sec: float) -> str:
            s = max(0, int(round(sec)))
            return f"{s // 60}:{s % 60:02d}"

        parts = []
        if chorus_ranges:
            ch_txt = "、".join(f"{_ft(c['start'])}–{_ft(c['end'])}" for c in chorus_ranges[:4])
            parts.append(f"副歌在 {ch_txt}")
        if issues:
            parts.append("需留意：" + "；".join(it["note"] for it in issues[:3]))
        else:
            parts.append("整首音域和音高整体平稳，未发现明显破音或越界段")

        return {
            "summary": "。".join(parts),
            "chorusRanges": chorus_ranges,
            "phrases": phrases,
            "issues": issues,
            "vocalRange": vocal_range,
            "modelRange": {
                "p5": round(float(model_range["p5"]), 1),
                "median": round(float(model_range["median"]), 1),
                "p95": round(float(model_range["p95"]), 1),
            } if model_range and model_range.get("p5") else None,
        }

    def _build_dynamic_segments(self, vocal_src: Path, chorus_ranges: list, *,
                                index_rate: float, protect: float) -> list:
        """按副歌区间构造「主歌柔、副歌亮」分段计划（边界自动吸附静音谷底）。"""
        vy, sr = read_audio(vocal_src)
        mono = vy.mean(axis=1)
        dur = len(mono) / float(sr)
        snapped_ch = []
        for c in chorus_ranges:
            s, e = self._snap_bounds(mono, sr, float(c["start"]), float(c["end"]), max_shift=1.0)
            if e - s >= 2.5:
                if snapped_ch and s <= snapped_ch[-1][1] + 0.5:
                    snapped_ch[-1] = (snapped_ch[-1][0], max(snapped_ch[-1][1], e))
                else:
                    snapped_ch.append((s, e))
        segs = []
        cursor = 0.0
        for s, e in snapped_ch:
            if s - cursor >= 0.8:
                segs.append({
                    "start": cursor, "end": s, "role": "verse",
                    "indexRate": max(0.30, round(index_rate - 0.08, 3)),
                    "protect": min(0.48, round(protect + 0.06, 3)),
                    "gain": 0.94,
                })
            segs.append({
                "start": s, "end": e, "role": "chorus",
                "indexRate": index_rate,
                "protect": protect,
                "gain": 1.03,
            })
            cursor = e
        if dur - cursor >= 0.8:
            segs.append({
                "start": cursor, "end": dur, "role": "verse",
                "indexRate": max(0.30, round(index_rate - 0.08, 3)),
                "protect": min(0.48, round(protect + 0.06, 3)),
                "gain": 0.94,
            })
        return segs

    def _resolve_model_ckpt(self, model_name: str) -> tuple:
        """按模型名查找权重文件与对应索引路径，用于分段换音色或局部换模返工。"""
        raw = str(model_name or "").strip()
        if not raw:
            return None, ""
        p = Path(raw)
        if not p.is_file():
            p = RVC_ROOT / "assets" / "weights" / (raw if raw.endswith(".pth") else f"{raw}.pth")
        if not p.is_file():
            raise RuntimeError(f"找不到要切换的模型：{model_name}")
        exp = p.stem.split("_e")[0]
        idx_path = ""
        log_dir = RVC_ROOT / "logs" / exp
        if log_dir.is_dir():
            cands = sorted(log_dir.glob("added_*.index")) or sorted(log_dir.glob("*.index"))
            if cands:
                idx_path = str(cands[0])
        return p, idx_path

    def _convert_segmented(self, vocal_src: Path, dst: Path, segments: list, *,
                           pitch: int, index_rate: float, protect: float,
                           rms_mix_rate: float, f0_method: str,
                           progress: Optional[Callable[[float, str], None]] = None,
                           cancel: Optional[threading.Event] = None) -> dict:
        """分段换声：支持主歌柔/副歌亮或显式分段换音色，静音边界 60ms 交叉淡化，总时长零漂移。"""
        if not self.ready:
            self.load()
        cancel = cancel or threading.Event()
        tmp = Path(tempfile.mkdtemp(prefix="fishsing-seg-"))
        original = (self.model_path or str(RVC_ROOT / "assets" / "weights" / self.model), self.index)
        try:
            whole = to_wav(vocal_src, tmp / "whole.wav")
            data, in_sr = read_audio(whole)
            total_n = data.shape[0]
            dur = total_n / float(in_sr)
            mono = data.mean(axis=1)

            # 规范并补全未覆盖区间，保证完整覆盖 [0, dur]
            norm = []
            for seg in segments:
                s = max(0.0, min(dur, float(seg.get("start", 0.0))))
                e = max(s, min(dur, float(seg.get("end", dur))))
                if e - s < 0.2:
                    continue
                if seg.get("snap", True) and not seg.get("role"):
                    s, e = self._snap_bounds(mono, in_sr, s, e, max_shift=0.8)
                norm.append({**seg, "start": s, "end": e})
            norm.sort(key=lambda x: x["start"])

            plan = []
            cursor = 0.0
            for seg in norm:
                s, e = seg["start"], seg["end"]
                if s > cursor + 0.15:
                    plan.append({"start": cursor, "end": s})
                s_eff = max(cursor, s)
                if e > s_eff + 0.1:
                    plan.append({**seg, "start": s_eff, "end": e})
                    cursor = e
            if dur - cursor > 0.15:
                plan.append({"start": cursor, "end": dur})
            if not plan:
                return self.convert(vocal_src, dst, pitch=pitch, index_rate=index_rate,
                                    protect=protect, rms_mix_rate=rms_mix_rate,
                                    f0_method=f0_method, progress=progress, cancel=cancel)

            pad_sec = 0.35
            out_sr = self.sr
            out_buf = None
            fade_ms = 60
            total_chunks = 0

            for idx, seg in enumerate(plan):
                if cancel.is_set():
                    raise RuntimeError("已取消")
                s, e = float(seg["start"]), float(seg["end"])
                req_model = str(seg.get("model") or "").strip()
                if req_model:
                    ckpt, idx_p = self._resolve_model_ckpt(req_model)
                    self.set_model(ckpt, idx_p)
                else:
                    self.set_model(Path(original[0]), original[1])

                a_pad = max(0.0, s - pad_sec)
                b_pad = min(dur, e + pad_sec)
                i0 = max(0, int(round(a_pad * in_sr)))
                i1 = min(total_n, int(round(b_pad * in_sr)))
                seg_in = tmp / f"seg_{idx:02d}_in.wav"
                seg_out = tmp / f"seg_{idx:02d}_out.wav"
                write_audio(seg_in, data[i0:i1], in_sr)

                res = self.convert(
                    seg_in, seg_out,
                    pitch=int(seg.get("pitch", pitch)),
                    index_rate=float(seg.get("indexRate", seg.get("index_rate", index_rate))),
                    protect=float(seg.get("protect", protect)),
                    rms_mix_rate=float(seg.get("rmsMixRate", seg.get("rms_mix_rate", rms_mix_rate))),
                    f0_method=str(seg.get("f0Method", seg.get("f0_method", f0_method))),
                    progress=lambda p, m: None,
                    cancel=cancel,
                )
                total_chunks += int(res.get("chunks", 1))
                y_seg, sr_cur = read_audio(seg_out)
                out_sr = sr_cur
                if out_buf is None:
                    out_buf = np.zeros((int(round(total_n * out_sr / in_sr)), y_seg.shape[1]), dtype=np.float32)

                # 精确裁回 [s, e] 并把多余前后垫音用于交叉淡化重叠
                gain = float(seg.get("gain", 1.0))
                if gain != 1.0:
                    y_seg = y_seg * gain

                o_start = int(round(s * out_sr))
                o_end = min(out_buf.shape[0], int(round(e * out_sr)))
                want_len = max(0, o_end - o_start)
                lead = int(round((s - a_pad) * out_sr))
                core = y_seg[lead:lead + want_len]
                if core.shape[0] < want_len:
                    core = np.pad(core, ((0, want_len - core.shape[0]), (0, 0)))

                xf = min(int(out_sr * fade_ms / 1000), want_len // 3)
                if idx > 0 and xf > 1 and o_start >= xf:
                    # 左侧用前导垫音和上一段尾巴做平滑交叉淡化
                    pre_avail = min(xf, lead, o_start)
                    if pre_avail > 1:
                        ramp = np.linspace(0.0, 1.0, pre_avail, dtype=np.float32).reshape(-1, 1)
                        prev_tail = out_buf[o_start - pre_avail:o_start]
                        new_head = y_seg[lead - pre_avail:lead]
                        out_buf[o_start - pre_avail:o_start] = prev_tail * (1.0 - ramp) + new_head * ramp
                out_buf[o_start:o_end] = core[:o_end - o_start]

                if progress:
                    role = seg.get("role") or (req_model if req_model else f"第{idx + 1}段")
                    progress(0.2 + 0.58 * (idx + 1) / len(plan), f"分段换声 {idx + 1}/{len(plan)}（{role}）")

            if out_buf is None:
                raise RuntimeError("分段换声未产出任何音频")
            write_audio(dst, out_buf, out_sr)
            return {"sr": out_sr, "chunks": total_chunks, "seconds": out_buf.shape[0] / float(out_sr)}
        finally:
            try:
                self.set_model(Path(original[0]), original[1])
            except Exception as e:  # noqa: BLE001
                log(f"分段换声后恢复原模型失败：{e}")
            shutil.rmtree(tmp, ignore_errors=True)

    def _convert_duet(self, vocal_src: Path, dst: Path, *, duet_model: str, duet_mode: str,
                      chorus_ranges: list, phrases: list, pitch: int, index_rate: float,
                      protect: float, rms_mix_rate: float, f0_method: str, work: Path,
                      progress: Optional[Callable[[float, str], None]] = None,
                      cancel: Optional[threading.Event] = None) -> dict:
        """双音色真合唱 / 对唱：
        - alternate：主歌按乐段由主模型 A 与搭档模型 B 交替轮唱，副歌左右立体声双声部真合唱；
        - unison：整首 A 左 B 右真双人合唱（含 14ms 微延迟拉开立体声宽度防同相干涉）。
        """
        if not self.ready:
            self.load()
        cancel = cancel or threading.Event()
        report = progress or (lambda p, m: None)
        ckpt_b, idx_b = self._resolve_model_ckpt(duet_model)
        original = (self.model_path or str(RVC_ROOT / "assets" / "weights" / self.model), self.index)
        conv_a = work / "duet_a.wav"
        conv_b = work / "duet_b.wav"
        try:
            report(0.22, f"双音色合唱（主唱 {Path(original[0]).name}）")
            info_a = self.convert(
                vocal_src, conv_a, pitch=pitch, index_rate=index_rate, protect=protect,
                rms_mix_rate=rms_mix_rate, f0_method=f0_method,
                progress=lambda p, m: report(0.22 + 0.27 * p, f"合唱轨 A · {m}"),
                cancel=cancel,
            )
            if cancel.is_set():
                raise RuntimeError("已取消")
            report(0.50, f"双音色合唱（搭档 {ckpt_b.name}）")
            self.set_model(ckpt_b, idx_b)
            info_b = self.convert(
                vocal_src, conv_b, pitch=pitch, index_rate=index_rate, protect=protect,
                rms_mix_rate=rms_mix_rate, f0_method=f0_method,
                progress=lambda p, m: report(0.50 + 0.27 * p, f"合唱轨 B · {m}"),
                cancel=cancel,
            )
        finally:
            try:
                self.set_model(Path(original[0]), original[1])
            except Exception as e:  # noqa: BLE001
                log(f"双音色合唱后恢复原模型失败：{e}")

        ya, sr_a = read_audio(conv_a)
        yb, sr_b = read_audio(conv_b)
        if sr_b != sr_a:
            yb = resample_linear_fallback(yb, sr_b, sr_a)
        n = min(ya.shape[0], yb.shape[0])
        ma = ya[:n].mean(axis=1).astype(np.float32)
        mb = yb[:n].mean(axis=1).astype(np.float32)

        # 按有效发声 RMS 平衡双轨响度，防止一个模型天生更响盖住另一个
        ra = self._active_rms(ma.reshape(-1, 1))
        rb = self._active_rms(mb.reshape(-1, 1))
        if ra > 1e-4 and rb > 1e-4:
            mb = mb * float(np.clip(ra / rb, 0.72, 1.38))

        # 给 B 声部加 14ms 微延迟用于合唱段防同相干涉、撑开双声部宽度
        delay = max(1, int(round(0.014 * sr_a)))
        mb_wide = np.concatenate([np.zeros(delay, dtype=np.float32), mb[:-delay]]) if delay < n else mb

        if duet_mode == "unison" or not chorus_ranges:
            left = ma * 0.78 + mb_wide * 0.50
            right = ma * 0.50 + mb_wide * 0.78
        else:
            # 构造平滑副歌掩码与主歌交替掩码
            ch_raw = np.zeros(n, dtype=np.float32)
            for c in chorus_ranges:
                i0 = max(0, min(n, int(round(float(c["start"]) * sr_a))))
                i1 = max(i0, min(n, int(round(float(c["end"]) * sr_a))))
                ch_raw[i0:i1] = 1.0

            # 0.5s 滑动均值让主副歌切换柔和自然
            win_ch = max(1, int(round(0.5 * sr_a)))
            k_ch = np.ones(win_ch, dtype=np.float32) / win_ch
            ch_mask = np.convolve(ch_raw, k_ch, mode="same").astype(np.float32)

            # 主歌段落：按非副歌乐句每 2 句轮换 A / B
            verse_phrases = [p for p in (phrases or []) if p.get("section") != "chorus"]
            turn_b = np.zeros(n, dtype=np.float32)
            if len(verse_phrases) >= 2:
                for idx, p in enumerate(verse_phrases):
                    if (idx // 2) % 2 == 1:
                        i0 = max(0, min(n, int(round(float(p["start"]) * sr_a))))
                        i1 = max(i0, min(n, int(round(float(p["end"]) * sr_a))))
                        turn_b[i0:i1] = 1.0
            else:
                # 兜底：没有细乐句时，第 1 段副歌之后的主歌切给 B
                first_end = float(chorus_ranges[0]["end"])
                i0 = max(0, min(n, int(round(first_end * sr_a))))
                turn_b[i0:] = 1.0

            win_v = max(1, int(round(0.35 * sr_a)))
            k_v = np.ones(win_v, dtype=np.float32) / win_v
            b_solo = np.convolve(turn_b, k_v, mode="same").astype(np.float32)
            a_solo = 1.0 - b_solo

            solo_l = ma * a_solo + mb * b_solo
            solo_r = solo_l
            choir_l = ma * 0.78 + mb_wide * 0.52
            choir_r = ma * 0.52 + mb_wide * 0.78
            left = solo_l * (1.0 - ch_mask) + choir_l * ch_mask
            right = solo_r * (1.0 - ch_mask) + choir_r * ch_mask

        stereo = np.stack([left, right], axis=1).astype(np.float32)
        peak = float(np.abs(stereo).max())
        if peak > 0.98:
            stereo *= 0.98 / peak
        write_audio(dst, stereo, sr_a)
        log(f"双音色合唱完成（{duet_mode}）：{Path(original[0]).name} + {ckpt_b.name}")
        return {
            "sr": sr_a,
            "chunks": int(info_a.get("chunks", 1)) + int(info_b.get("chunks", 1)),
            "seconds": n / float(sr_a),
        }

    def fuse_models(self, model_a: str, model_b: str, out_name: str, alpha: float = 0.5) -> dict:
        """RVC 模型权重 CPU 线性融合：alpha * A + (1 - alpha) * B，秒级生成新音色 .pth。"""
        import torch

        ckpt_a, idx_a = self._resolve_model_ckpt(model_a)
        ckpt_b, idx_b = self._resolve_model_ckpt(model_b)
        if str(ckpt_a.resolve()) == str(ckpt_b.resolve()):
            raise RuntimeError("请选择两个不同的模型进行融合")
        a_ratio = float(np.clip(float(alpha), 0.05, 0.95))
        b_ratio = 1.0 - a_ratio

        clean_name = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", str(out_name or "").strip()).strip("_")
        if not clean_name:
            clean_name = f"{ckpt_a.stem}_{ckpt_b.stem}_{int(round(a_ratio * 100))}"
        if not clean_name.endswith(".pth"):
            clean_name = f"{clean_name}.pth"
        dst = RVC_ROOT / "assets" / "weights" / clean_name
        if dst.exists():
            raise RuntimeError(f"目标模型已存在：{clean_name}，请换一个新名字")

        ca = torch.load(str(ckpt_a), map_location="cpu", weights_only=False)
        cb = torch.load(str(ckpt_b), map_location="cpu", weights_only=False)
        if not isinstance(ca, dict) or not isinstance(cb, dict) or "weight" not in ca or "weight" not in cb:
            raise RuntimeError("所选文件不是有效的 RVC 推理模型（缺少 weight 字典）")

        for k in ("sr", "f0", "version"):
            va = ca.get(k)
            vb = cb.get(k)
            if va is not None and vb is not None and str(va) != str(vb):
                raise RuntimeError(f"两个模型规格不一致（{k}: {va} vs {vb}），无法直接融合")

        wa = ca["weight"]
        wb = cb["weight"]
        merged = {}
        fused_tensors = 0
        for k, ta in wa.items():
            tb = wb.get(k)
            if (tb is not None and isinstance(ta, torch.Tensor) and isinstance(tb, torch.Tensor)
                    and ta.shape == tb.shape and ta.is_floating_point()):
                merged[k] = (ta.float() * a_ratio + tb.float() * b_ratio).to(ta.dtype)
                fused_tensors += 1
            else:
                merged[k] = ta

        if fused_tensors == 0:
            raise RuntimeError("两个模型没有可对齐的权重张量，融合中止")

        out_obj = dict(ca)
        out_obj["weight"] = merged
        out_obj["info"] = (
            f"fused {ckpt_a.name}({int(round(a_ratio * 100))}%) + "
            f"{ckpt_b.name}({int(round(b_ratio * 100))}%)"
        )
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp_dst = dst.with_suffix(".pth.tmp")
        torch.save(out_obj, str(tmp_dst))
        os.replace(tmp_dst, dst)

        # 自动零空间硬链接占比更高父模型的 .index，并按比例加权合成 range.json 音域统计
        out_exp = dst.stem
        out_log_dir = RVC_ROOT / "logs" / out_exp
        inherited_index = ""
        primary_idx = (idx_a or idx_b) if a_ratio >= 0.5 else (idx_b or idx_a)
        if primary_idx and Path(primary_idx).is_file():
            try:
                out_log_dir.mkdir(parents=True, exist_ok=True)
                src_idx = Path(primary_idx)
                dst_idx = out_log_dir / f"added_fused_{src_idx.parent.name}_{out_exp}.index"
                if dst_idx.exists():
                    dst_idx.unlink()
                try:
                    os.link(str(src_idx), str(dst_idx))
                except OSError:
                    shutil.copy2(str(src_idx), str(dst_idx))
                inherited_index = dst_idx.name
            except Exception as e:  # noqa: BLE001
                log(f"融合模型继承索引失败（不影响使用）：{e}")

        try:
            ra = self.model_range(ckpt_a.name)
            rb = self.model_range(ckpt_b.name)
            fused_range = None
            if ra and rb:
                fused_range = {
                    "p5": round(float(ra["p5"]) * a_ratio + float(rb["p5"]) * b_ratio, 1),
                    "median": round(float(ra["median"]) * a_ratio + float(rb["median"]) * b_ratio, 1),
                    "p95": round(float(ra["p95"]) * a_ratio + float(rb["p95"]) * b_ratio, 1),
                    "frames": int(round(float(ra.get("frames", 0)) * a_ratio + float(rb.get("frames", 0)) * b_ratio)),
                    "source": out_obj["info"],
                }
            elif ra or rb:
                base_r = ra if (a_ratio >= 0.5 and ra) or not rb else rb
                fused_range = {
                    "p5": round(float(base_r["p5"]), 1),
                    "median": round(float(base_r["median"]), 1),
                    "p95": round(float(base_r["p95"]), 1),
                    "frames": int(base_r.get("frames", 0)),
                    "source": out_obj["info"],
                }
            if fused_range:
                out_log_dir.mkdir(parents=True, exist_ok=True)
                (out_log_dir / "range.json").write_text(
                    json.dumps(fused_range, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
        except Exception as e:  # noqa: BLE001
            log(f"融合模型生成音域统计失败（不影响使用）：{e}")

        size_mb = round(dst.stat().st_size / 1048576.0, 1)
        log(f"模型融合完成：{dst.name}（{size_mb} MB，合并 {fused_tensors} 个张量"
            f"{f'，已继承索引 {inherited_index}' if inherited_index else ''}）")
        return {
            "output": str(dst),
            "name": dst.name,
            "sizeMb": size_mb,
            "fusedTensors": fused_tensors,
            "index": inherited_index,
            "info": out_obj["info"],
        }

    def patch(self, vocal_src: Path, base_conv: Path, inst_path: Optional[Path], work: Path, *,
              start_sec: float, end_sec: float, snap: bool = True,
              base_pitch: int = 0, patch_pitch: Optional[int] = None,
              index_rate: float = 0.75, protect: float = 0.33,
              rms_mix_rate: float = 0.0, f0_method: str = "rmvpe",
              model: str = "", harmony: "dict | None" = None,
              reverb: str = "off", polish: bool = True, mode: str = "full",
              preview_only: bool = False,
              session_dir: Optional[Path] = None,
              progress: Optional[Callable[[float, str], None]] = None,
              cancel: Optional[threading.Event] = None) -> dict:
        """局部返工重唱：仅重跑 [start_sec, end_sec] 区间并 60ms 交叉淡化无缝贴回原换声干声轨。"""
        if not self.ready:
            self.load()
        cancel = cancel or threading.Event()
        work.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        report = progress or (lambda p, m: None)
        if not vocal_src.is_file():
            raise RuntimeError(f"找不到分离干声（缓存可能已清理）：{vocal_src}")
        if not base_conv.is_file():
            raise RuntimeError(f"找不到上一版换声干声：{base_conv}")

        v_data, v_sr = read_audio(vocal_src)
        c_data, c_sr = read_audio(base_conv)
        dur = v_data.shape[0] / float(v_sr)
        s0 = max(0.0, min(dur, float(start_sec)))
        e0 = max(s0, min(dur, float(end_sec)))
        if e0 - s0 < 0.3:
            raise RuntimeError(f"返工区间太短：{s0:.1f}–{e0:.1f}s")
        if snap:
            s0, e0 = self._snap_bounds(v_data.mean(axis=1), v_sr, s0, e0, max_shift=1.2)
            log(f"局部返工吸附静音边界：{start_sec:.1f}–{end_sec:.1f}s → {s0:.2f}–{e0:.2f}s")

        use_pitch = int(base_pitch if patch_pitch is None else patch_pitch)
        f0_m = "fcpe" if str(f0_method or "").strip().lower() == "fcpe" else "rmvpe"
        original = (self.model_path or str(RVC_ROOT / "assets" / "weights" / self.model), self.index)

        pad_sec = 0.35
        a_pad = max(0.0, s0 - pad_sec)
        b_pad = min(dur, e0 + pad_sec)
        seg_in = work / "patch_in.wav"
        seg_out = work / "patch_out.wav"
        i0 = max(0, int(round(a_pad * v_sr)))
        i1 = min(v_data.shape[0], int(round(b_pad * v_sr)))
        write_audio(seg_in, v_data[i0:i1], v_sr)

        try:
            if model:
                ckpt, idx_p = self._resolve_model_ckpt(model)
                self.set_model(ckpt, idx_p)
            report(0.15, f"局部返工换声（{s0:.1f}–{e0:.1f}s）")
            self.convert(
                seg_in, seg_out,
                pitch=use_pitch, index_rate=index_rate, protect=protect,
                rms_mix_rate=rms_mix_rate, f0_method=f0_m,
                progress=lambda p, m: report(0.15 + 0.45 * p, m),
                cancel=cancel,
            )
        finally:
            if model:
                try:
                    self.set_model(Path(original[0]), original[1])
                except Exception as e:  # noqa: BLE001
                    log(f"局部返工后恢复原模型失败：{e}")

        p_data, p_sr = read_audio(seg_out)
        if p_sr != c_sr:
            p_data = resample_linear_fallback(p_data, p_sr, c_sr)
        if p_data.shape[1] != c_data.shape[1]:
            if c_data.shape[1] == 1:
                p_data = p_data.mean(axis=1, keepdims=True)
            else:
                p_data = np.repeat(p_data[:, :1], c_data.shape[1], axis=1)

        # 按原位响度微调对齐（防止新参数或换模型导致单句突然偏大/偏小）
        c_start = max(0, min(c_data.shape[0], int(round(s0 * c_sr))))
        c_end = max(c_start, min(c_data.shape[0], int(round(e0 * c_sr))))
        want_len = c_end - c_start
        lead = int(round((s0 - a_pad) * c_sr))
        core = p_data[lead:lead + want_len].copy()
        if core.shape[0] < want_len:
            core = np.pad(core, ((0, want_len - core.shape[0]), (0, 0)))

        old_rms = self._active_rms(c_data[c_start:c_end])
        new_rms = self._active_rms(core)
        if old_rms > 1e-4 and new_rms > 1e-4:
            ratio = max(0.75, min(1.35, old_rms / new_rms))
            core = (core * ratio).astype(np.float32)

        patched = c_data.copy()
        xf = min(int(c_sr * 0.06), want_len // 3)
        if xf > 1:
            ramp = np.linspace(0.0, 1.0, xf, dtype=np.float32).reshape(-1, 1)
            patched[c_start:c_start + xf] = c_data[c_start:c_start + xf] * (1.0 - ramp) + core[:xf] * ramp
            if want_len > 2 * xf:
                patched[c_start + xf:c_end - xf] = core[xf:want_len - xf]
            patched[c_end - xf:c_end] = core[want_len - xf:want_len] * (1.0 - ramp) + c_data[c_end - xf:c_end] * ramp
        else:
            patched[c_start:c_end] = core

        new_conv = work / "vocals_patched.wav"
        write_audio(new_conv, patched, c_sr)

        # 原地更新会话干声快照（支持连续多句返工）
        saved_conv = str(base_conv)
        if session_dir is not None and not preview_only:
            try:
                session_dir.mkdir(parents=True, exist_ok=True)
                dst_conv = session_dir / "vocals_conv.wav"
                tmp_conv = session_dir / "vocals_conv.wav.tmp"
                shutil.copy2(new_conv, tmp_conv)
                os.replace(tmp_conv, dst_conv)
                saved_conv = str(dst_conv)
            except OSError as e:
                log(f"更新会话返工快照失败：{e}")

        conv_for_mix = new_conv
        harm_cfg = harmony or {}
        harm_mode = str(harm_cfg.get("mode") or "").strip().lower()
        harm_semis = [int(x) for x in (harm_cfg.get("semis") or []) if int(x) != 0]
        if not preview_only and (harm_mode in ("double", "double+third") or harm_semis):
            report(0.72, "重新叠加副歌和声")
            stacked = self._stack_harmony(
                conv_for_mix, vocal_src, harm_semis, pitch=int(base_pitch),
                index_rate=index_rate, protect=protect, rms_mix_rate=rms_mix_rate,
                f0_method=f0_m, gain=float(harm_cfg.get("gain", 0.22)),
                scope=str(harm_cfg.get("scope", "chorus")),
                mode=harm_mode or "pitch", inst_path=inst_path,
                work=work, report=report, cancel=cancel, base_report=0.72,
            )
            if stacked is not None:
                conv_for_mix = stacked

        # 若只需预览返工句，裁出前后各多留 2 秒上下文快速混音试听
        inst_for_mix = inst_path if (inst_path and Path(inst_path).is_file()) else None
        ref_for_mix = vocal_src
        if preview_only:
            ps = max(0.0, s0 - 2.0)
            pe = min(dur, e0 + 2.0)
            pv = work / "preview_v.wav"
            self._slice_wav_fade(conv_for_mix, pv, ps, pe)
            conv_for_mix = pv
            prv = work / "preview_ref.wav"
            self._slice_wav_fade(vocal_src, prv, ps, pe)
            ref_for_mix = prv
            if inst_for_mix is not None:
                pi = work / "preview_i.wav"
                self._slice_wav_fade(inst_for_mix, pi, ps, pe)
                inst_for_mix = pi

        if mode == "vocals" or inst_for_mix is None:
            out = work / "result.wav"
            mix_info = self.mix(conv_for_mix, None, out, polish=polish)
        else:
            if base_pitch:
                report(0.84, f"伴奏同步变调 {int(base_pitch):+d} 半音")
                inst_shifted = work / "inst_shifted.wav"
                try:
                    sr_i = int(sf.info(str(inst_for_mix)).samplerate)
                except Exception:  # noqa: BLE001
                    sr_i = 44100
                run_ff([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(inst_for_mix),
                        "-af", self.pitch_shift_filter(sr_i, int(base_pitch)), str(inst_shifted)])
                inst_for_mix = inst_shifted
            report(0.88, "重新混音")
            out = work / "result.wav"
            mix_info = self.mix(conv_for_mix, inst_for_mix, out, ref_vocal=ref_for_mix, reverb=reverb, polish=polish)

        report(1.0, "返工完成")
        return {
            "output": str(out),
            "convVocal": saved_conv,
            "start": round(s0, 2),
            "end": round(e0, 2),
            "previewOnly": bool(preview_only),
            "seconds": round(float(mix_info.get("seconds", 0.0)), 2),
            "elapsedSec": round(time.time() - t0, 1),
        }

    @staticmethod
    def _chorus_gate(mono: np.ndarray, sr: int, scope: str = "chorus",
                     inst_mono: Optional[np.ndarray] = None) -> np.ndarray:
        """定位完整的高能副歌段落，输出 0~1 的平滑包络。

        采用「伴奏能量辅助 + 迟滞双阈值（高阈值进入、低阈值维持）」：
        副歌后半段稍微收着唱时不会半路断掉，等整段副歌结束再 1 秒慢淡出。
        """
        n_samples = len(mono)
        if n_samples == 0:
            return np.zeros(0, dtype="float32")
        if scope == "all":
            return np.ones(n_samples, dtype="float32")

        fl, hl = 2048, 512
        n_fr = max(1, (n_samples - fl) // hl)
        if n_fr < 8:
            return np.zeros(n_samples, dtype="float32")

        def _frame_db(sig: np.ndarray) -> np.ndarray:
            arr = np.array(
                [float(np.sqrt(np.mean(sig[i * hl:i * hl + fl] ** 2) + 1e-12)) for i in range(n_fr)],
                dtype=np.float32,
            )
            return 20.0 * np.log10(arr + 1e-9)

        db = _frame_db(mono)
        peak_db = float(np.percentile(db, 98))
        active_mask = db > max(-48.0, peak_db - 28.0)
        if int(active_mask.sum()) < 10:
            return np.zeros(n_samples, dtype="float32")

        # 3 秒滑动窗提取段落级能量；有效发声内静音按 20 分位填充，防止句间换气拉低副歌
        fps = sr / hl
        floor_db = float(np.percentile(db[active_mask], 20))
        filled = np.where(active_mask, db, floor_db)
        win_fr = max(1, int(round(3.0 * fps)))
        kernel = np.ones(win_fr, dtype=np.float32) / win_fr
        v_seg = np.convolve(filled, kernel, mode="same")

        # 标准化到 0~1 分位尺度；若有伴奏则融合伴奏段落能量（副歌伴奏满，尾句收气也不会误断）
        def _norm_score(curve: np.ndarray, mask: np.ndarray) -> np.ndarray:
            lo = float(np.percentile(curve[mask], 10))
            hi = float(np.percentile(curve[mask], 95))
            return np.clip((curve - lo) / max(1.0, hi - lo), 0.0, 1.0)

        score = _norm_score(v_seg, active_mask)
        if inst_mono is not None and len(inst_mono) >= fl:
            if len(inst_mono) < n_samples:
                inst_pad = np.pad(inst_mono, (0, n_samples - len(inst_mono)))
            else:
                inst_pad = inst_mono[:n_samples]
            i_db = _frame_db(inst_pad)
            i_seg = np.convolve(i_db, kernel, mode="same")
            i_active = i_db > max(-52.0, float(np.percentile(i_db, 98)) - 30.0)
            if int(i_active.sum()) >= 10:
                score = 0.58 * score + 0.42 * _norm_score(i_seg, i_active)

        # 迟滞双阈值：高阈值进入副歌，进入后降到低阈值才退出，防止副歌尾句半路腰斩
        active_scores = score[active_mask]
        enter_thr = float(np.percentile(active_scores, 65))
        exit_thr = float(np.percentile(active_scores, 38))
        raw = np.zeros(n_fr, dtype=bool)
        in_chorus = False
        for i in range(n_fr):
            if not in_chorus:
                if score[i] >= enter_thr and active_mask[i]:
                    in_chorus = True
                    raw[i] = True
            else:
                if score[i] >= exit_thr:
                    raw[i] = True
                else:
                    in_chorus = False

        # 形态学清理：填平副歌内 <2.5s 的换气/乐句间隙，滤掉主歌里 <2.2s 的孤立高音
        def _fill_short_gaps(mask: np.ndarray, max_gap: int) -> np.ndarray:
            out = mask.copy()
            idx = np.flatnonzero(out)
            if idx.size < 2:
                return out
            for a, b in zip(idx[:-1], idx[1:]):
                if 1 < (b - a) <= max_gap:
                    out[a:b] = True
            return out

        def _drop_short_runs(mask: np.ndarray, min_run: int) -> np.ndarray:
            out = np.zeros_like(mask, dtype=bool)
            start = None
            for i, v in enumerate(mask):
                if v and start is None:
                    start = i
                elif not v and start is not None:
                    if i - start >= min_run:
                        out[start:i] = True
                    start = None
            if start is not None and len(mask) - start >= min_run:
                out[start:] = True
            return out

        cleaned = _fill_short_gaps(raw, max(1, int(round(2.5 * fps))))
        cleaned = _drop_short_runs(cleaned, max(1, int(round(2.2 * fps))))

        # 副歌结束后多拖尾 0.5 秒再淡出，确保最后一个字的长音被和声完整托住
        hold_fr = max(1, int(round(0.5 * fps)))
        extended = cleaned.copy()
        for i in range(1, n_fr):
            if cleaned[i - 1] and not cleaned[i]:
                extended[i:min(n_fr, i + hold_fr)] = True

        # 非对称平滑：0.5s 淡入、1.0s 慢淡出
        g = extended.astype(np.float32)
        fade_in = max(1, int(round(0.5 * fps)))
        fade_out = max(1, int(round(1.0 * fps)))
        out_g = np.zeros(n_fr, dtype=np.float32)
        cur = 0.0
        for i in range(n_fr):
            target = g[i]
            if target > cur:
                cur = min(target, cur + 1.0 / fade_in)
            else:
                cur = max(target, cur - 1.0 / fade_out)
            out_g[i] = cur
        return np.interp(np.arange(n_samples), np.arange(len(out_g)) * hl, out_g).astype("float32")

    @classmethod
    def _vocal_doubler(cls, main_wav: Path, mono: np.ndarray, sr: int, gain: float,
                       gate: np.ndarray, work: Path) -> tuple:
        """唱片式副歌双轨厚声：左右 ±12 cents 真实微失谐 + 18/28ms 宽声场延迟 + 明亮带通。"""
        from scipy.signal import butter, sosfilt

        n = len(mono)

        def _detuned(cents: float, tag: str) -> np.ndarray:
            dst = work / f"doubler_{tag}.wav"
            try:
                run_ff([
                    FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(main_wav),
                    "-af", cls.pitch_shift_filter(sr, cents / 100.0),
                    "-ar", str(sr), "-ac", "1", "-c:a", "pcm_f32le", str(dst),
                ])
                y, _ = read_audio(dst)
                arr = y[:, 0]
                if len(arr) >= n:
                    return arr[:n]
                return np.pad(arr, (0, n - len(arr)))
            except Exception as e:  # noqa: BLE001
                log(f"双轨微失谐回退原音高（{tag}）：{e}")
                return mono

        sig_l = _detuned(-12.0, "L")
        sig_r = _detuned(+12.0, "R")

        # 150Hz~6500Hz 明亮带通：清掉浑浊低频，保留泛音亮度避免被伴奏埋掉
        hi_cut = min(6500.0, sr * 0.45)
        sos = butter(2, [150.0 / (sr / 2), hi_cut / (sr / 2)], btype="bandpass", output="sos")
        sig_l = sosfilt(sos, sig_l).astype("float32")
        sig_r = sosfilt(sos, sig_r).astype("float32")

        # 左右不对称延迟（18ms / 28ms），主唱居中、双轨往左右撑开声场
        dl = max(1, int(round(0.018 * sr)))
        dr = max(1, int(round(0.028 * sr)))
        pad_l = np.concatenate([np.zeros(dl, dtype="float32"), sig_l[:-dl]]) if dl < n else sig_l
        pad_r = np.concatenate([np.zeros(dr, dtype="float32"), sig_r[:-dr]]) if dr < n else sig_r

        # double 模式自带 -3dB 左右的滤波器损耗，提高内部系数让默认 0.22 在伴奏里清晰可闻
        eff = gain * 1.95
        left = pad_l * gate * eff
        right = pad_r * gate * eff
        return left, right

    def _stack_harmony(self, main_wav: Path, vocal_src: Path, semis: list,
                       *, pitch: int, index_rate: float, protect: float,
                       rms_mix_rate: float, gain: float, scope: str,
                       f0_method: str = "rmvpe",
                       mode: str = "pitch",
                       inst_path: Optional[Path] = None,
                       work: Path, report, cancel, base_report: float = 0.82) -> "Path | None":
        """把主轨和双轨厚声 / 移调和声轨叠成一个立体声人声文件。

        mode='double'：副歌双轨厚声（±12 cents 真微失谐、不跑调、不额外跑 RVC）；
        mode='double+third'：双轨厚声 + 背景轻三度和声；
        mode='pitch'：移调和声轨（三度/五度），180Hz~4500Hz 带通后移，左右分开。
        """
        from scipy.signal import butter, sosfilt

        def read(p: Path):
            y, sr = sf.read(str(p), dtype="float32")
            if y.ndim == 1:
                y = np.stack([y, y], axis=1)
            return y, sr

        base, sr = read(main_wav)
        mono = base.mean(axis=1)

        inst_mono = None
        if scope == "chorus" and inst_path is not None and Path(inst_path).is_file():
            try:
                iy, isr = read_audio(Path(inst_path))
                im = iy.mean(axis=1)
                if isr != sr:
                    im = resample_linear_fallback(im.reshape(-1, 1), isr, sr)[:, 0]
                inst_mono = im
            except Exception:  # noqa: BLE001
                inst_mono = None

        gate = self._chorus_gate(mono, sr, scope=scope, inst_mono=inst_mono)
        active_ratio = float((gate > 0.2).mean()) if gate.size else 0.0
        log(f"和声门限（{mode}/{scope}）：覆盖整曲约 {active_ratio * 100:.1f}%")

        total = base.copy()
        left = np.zeros(len(mono), dtype="float32")
        right = np.zeros(len(mono), dtype="float32")

        if mode in ("double", "double+third"):
            dl, dr = self._vocal_doubler(main_wav, mono, sr, gain, gate, work)
            left += dl
            right += dr

        if mode != "double" and semis:
            hi_cut = min(4800.0, sr * 0.45)
            sos = butter(2, [180.0 / (sr / 2), hi_cut / (sr / 2)], btype="bandpass", output="sos")
            third_scale = 0.65 if mode == "double+third" else 1.0
            for i, semi in enumerate(semis):
                if cancel.is_set():
                    raise RuntimeError("已取消")
                report(base_report + (0.12 * (i + 1) / max(1, len(semis))), f"叠和声 {semi:+d} 半音")
                tmp = work / f"harmony_{semi:+d}.wav"
                self.convert(vocal_src, tmp, pitch=int(pitch) + int(semi), index_rate=index_rate,
                             protect=protect, rms_mix_rate=rms_mix_rate, f0_method=f0_method,
                             progress=lambda p, m: None, cancel=cancel)
                h, _ = read(tmp)
                n = min(len(h), len(mono))
                m = h[:n].mean(axis=1) * gate[:n] * gain * third_scale * (0.45 if abs(semi) >= 7 else 1.0)
                m = sosfilt(sos, m).astype("float32")
                side = -0.35 if i % 2 == 0 else 0.35
                left[:n] += m * np.sqrt((1 - side) / 2) * 1.41
                right[:n] += m * np.sqrt((1 + side) / 2) * 1.41

        total[:, 0] += left[:len(total)]
        total[:, 1] += right[:len(total)]
        peak = float(np.abs(total).max())
        if peak > 0.99:
            total *= 0.99 / peak
        out = work / "vocals_stacked.wav"
        write_audio(out, total, sr)
        return out

    @staticmethod
    def pitch_shift_filter(sr: int, semitones: float) -> str:
        """
        变调但**保持时长**的 ffmpeg 滤镜串。

        asetrate 改采样率等价于"升调+加速"，所以后面必须用 atempo 把时长拉回来
        （atempo=1/factor）。这样人声/伴奏都能整段移调而不改变节奏。
        """
        f = 2.0 ** (float(semitones) / 12.0)
        return f"asetrate={int(round(sr * f))},aresample={sr},atempo={1.0 / f:.6f}"

    # -- 选模对比试听 -----------------------------------------------

    def ab_test(self, test: Path, out_dir: Path, variants: list, *, tests=None, pitch: int = 0,
                index_rate: float = 0.75, protect: float = 0.33, rms_mix_rate: float = 0.0,
                f0_method: str = "rmvpe",
                progress: Optional[Callable[[float, str], None]] = None,
                cancel: Optional[threading.Event] = None) -> dict:
        """
        选模对比：同一测试句，每个变体（.pth）各换声一遍，结束后恢复原模型。

        variants: [{"ckpt": <pth 路径>, "label": "e100", "index": <index 路径或 "">}, ...]
        tests 为独立低、中、高音干声。每档使用相同输入和参数，避免训练集自测。
        """
        cancel = cancel or threading.Event()
        out_dir.mkdir(parents=True, exist_ok=True)
        report = progress or (lambda p, m: None)
        original = (self.model_path or str(RVC_ROOT / "assets" / "weights" / self.model), self.index)
        outputs: list = []
        tests = tests or [test]
        variants = [{**v, "label": f"{v['label']}_{band}", "test": str(source)}
                    for v in variants for band, source in zip(("low", "mid", "high"), tests)]
        n = max(1, len(variants))
        try:
            for i, v in enumerate(variants):
                if cancel.is_set():
                    raise RuntimeError("已取消")
                label = str(v.get("label") or Path(str(v["ckpt"])).stem)
                report(i / n, f"切换到 {label}")
                self.set_model(Path(str(v["ckpt"])), str(v.get("index") or ""))
                dst = out_dir / f"{label}.wav"
                report((i + 0.25) / n, f"换声：{label}")
                self.convert(
                    Path(v["test"]), dst, pitch=pitch, index_rate=index_rate, protect=protect,
                    rms_mix_rate=rms_mix_rate, f0_method=f0_method,
                    progress=lambda p, m, _i=i, _n=n: report((_i + 0.25 + 0.7 * p) / _n, m),
                    cancel=cancel,
                )
                outputs.append({"label": label, "ckpt": str(v["ckpt"]), "file": str(dst)})
        finally:
            try:
                self.set_model(Path(original[0]), original[1])  # 恢复原模型，别让唱歌用错档
            except Exception as e:  # noqa: BLE001
                log(f"恢复原模型失败：{e}")

        # 按音区把多个存档拼成串联对比轨（响度对齐 + 0.8 秒间隔），方便连续盲听对比
        compares: list = []
        for band in ("low", "mid", "high"):
            items = [o for o in outputs if o["label"].endswith(f"_{band}") and Path(o["file"]).is_file()]
            if len(items) < 2:
                continue
            segs, labels, sr_ref = [], [], None
            for it in items:
                try:
                    y, sr_cur = read_audio(Path(it["file"]))
                except Exception:  # noqa: BLE001
                    continue
                if sr_ref is None:
                    sr_ref = sr_cur
                elif sr_cur != sr_ref:
                    y = resample_linear_fallback(y, sr_cur, sr_ref)
                if y.shape[1] > 1:
                    y = y.mean(axis=1, keepdims=True)
                rms = SingEngine._active_rms(y)
                if rms > 1e-4:
                    y = y * min(2.0, 0.12 / rms)
                pk = float(np.abs(y).max()) if y.size else 0.0
                if pk > 0.95:
                    y = y * (0.95 / pk)
                if segs:
                    segs.append(np.zeros((int(sr_ref * 0.8), 1), dtype=np.float32))
                segs.append(y.astype(np.float32))
                labels.append(it["label"].removesuffix(f"_{band}"))
            if len(labels) >= 2 and sr_ref:
                cmp_file = out_dir / f"compare_{band}.wav"
                write_audio(cmp_file, np.concatenate(segs, axis=0), sr_ref)
                compares.append({"band": band, "labels": labels, "file": str(cmp_file)})

        report(1.0, "完成")
        return {"outputs": outputs, "compares": compares}


# ---------------------------------------------------------------- 自检


def doctor() -> dict:
    out = {"ok": True, "checks": []}

    def add(name, ok, detail=""):
        out["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)})
        if not ok:
            out["ok"] = False

    add("RVC 根目录", RVC_ROOT.is_dir(), RVC_ROOT)
    add("RVC python", RVC_PY.is_file(), RVC_PY)
    add("模型文件", (RVC_ROOT / "assets" / "weights" / DEFAULT_MODEL).is_file(),
        RVC_ROOT / "assets" / "weights" / DEFAULT_MODEL)
    add("检索索引", Path(DEFAULT_INDEX).is_file(), DEFAULT_INDEX)
    add("ffmpeg", FFMPEG.is_file(), FFMPEG)
    add("分离环境", SEP_PY.is_file(), SEP_PY)
    add("分离脚本", SEP_SCRIPT.is_file(), SEP_SCRIPT)
    try:
        import torch
        add("CUDA", torch.cuda.is_available(),
            torch.cuda.get_device_name(0) if torch.cuda.is_available() else "不可用")
    except Exception as e:  # noqa: BLE001
        add("CUDA", False, e)
    out["checks"].append({
        "name": "UVR5 精唱分离（可选）",
        "ok": importlib.util.find_spec("audio_separator") is not None,
        "detail": "已安装 audio-separator" if importlib.util.find_spec("audio_separator") else "未安装（精唱/去混响自动回落 htdemucs）",
    })
    out["checks"].append({
        "name": "FCPE 音高提取（可选）",
        "ok": importlib.util.find_spec("torchfcpe") is not None,
        "detail": "已安装 torchfcpe" if importlib.util.find_spec("torchfcpe") else "未安装（默认用 rmvpe）",
    })
    return out


if __name__ == "__main__":
    print(json.dumps(doctor(), ensure_ascii=False, indent=2))
