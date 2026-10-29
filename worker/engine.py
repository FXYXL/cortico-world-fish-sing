# -*- coding: utf-8 -*-
"""
fish-sing worker 的核心：常驻 RVC + 切片换声 + 分离/混音。

为什么要把 RVC 常驻：`infer/cli.py` 每次启动都要重新加载 hubert(181M) + rmvpe(173M)
+ G(52M) + faiss 索引(311M)，实测 8 秒；常驻之后 55 秒音频只要 4 秒。

为什么要强制切片：整段喂给 RVC 会一次性过 encoder，320 秒 ≈ 32k 帧，注意力 O(n²)，
实测跑 10 分钟不结束、进程内存涨到 13GB。切 55 秒后 6 片共 76 秒跑完。

外部依赖：
  · RVC 环境（D:\\AI\\rvc\\venv）：torch 2.7.1+cu118，提供 VC / ContentVec / rmvpe
  · Seed-VC 环境（D:\\AI\\seed-vc\\venv）：demucs 4.1.0，权重已缓存在
    %USERPROFILE%\\.cache\\torch\\hub\\checkpoints\\955717e8-8726e21a.th
  · ffmpeg / ffprobe（D:\\ffmpeg\\bin）
"""

import json
import os
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

RVC_ROOT = Path(os.environ.get("FISHSING_RVC_ROOT", r"D:\AI\rvc"))
RVC_PY = RVC_ROOT / "venv" / "Scripts" / "python.exe"
SEEDVC_PY = Path(os.environ.get("FISHSING_SEEDVC_PY", r"D:\AI\seed-vc\venv\Scripts\python.exe"))
SEEDVC_SEP = Path(os.environ.get("FISHSING_SEEDVC_SEP", r"D:\AI\seed-vc-src\separate.py"))
FFMPEG = Path(os.environ.get("FISHSING_FFMPEG", r"D:\ffmpeg\bin\ffmpeg.exe"))

DEFAULT_MODEL = os.environ.get("FISHSING_MODEL", "dfy2.pth")
DEFAULT_INDEX = os.environ.get(
    "FISHSING_INDEX",
    str(RVC_ROOT / "logs" / "dfy2" / "added_IVF2529_Flat_nprobe_1_dfy2_v2.index"),
)

#: 每片时长（秒）。60 是 RVC 的舒适区，55 留 5 秒余量给整首除不尽的情况。
CHUNK_SEC = float(os.environ.get("FISHSING_CHUNK_SEC", "55"))

SILENCE = 0.0


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
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data, sr, subtype="PCM_24")


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


class SingEngine:
    """一个进程里只建一次，之后所有请求共用（模型常驻）。"""

    def __init__(self, model: str = DEFAULT_MODEL, index: str = DEFAULT_INDEX):
        self.model = model
        self.index = index if index and Path(index).is_file() else ""
        self.ready = False
        self.load_ms = 0
        self.sr = 40000
        self._lock = threading.Lock()
        self._vc = None

    # -- 加载 ------------------------------------------------------

    def load(self) -> None:
        if self.ready:
            return
        t0 = time.time()
        # RVC 的 infer 模块用相对路径找 assets/rmvpe、configs/，必须站在项目根
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
        self.ready = True
        self.load_ms = int((time.time() - t0) * 1000)
        log(f"模型就绪：{self.model}（{self.load_ms} ms）索引={'有' if self.index else '无'}")

    def info(self) -> dict:
        return {
            "ready": self.ready,
            "model": self.model,
            "index": Path(self.index).name if self.index else "",
            "samplerate": self.sr,
            "loadMs": self.load_ms,
            "chunkSec": CHUNK_SEC,
        }

    # -- 分离 ------------------------------------------------------

    def separate(self, src: Path, out_dir: Path, cancel: threading.Event) -> tuple:
        """demucs htdemucs 出 vocals/inst。跑在 Seed-VC 环境（那边才有 demucs）。"""
        out_dir.mkdir(parents=True, exist_ok=True)
        vocals = out_dir / "vocals.wav"
        inst = out_dir / "inst.wav"
        if vocals.is_file() and inst.is_file():
            return vocals, inst
        if not SEEDVC_PY.is_file():
            raise RuntimeError(f"找不到 Seed-VC 的 python：{SEEDVC_PY}")
        if not SEEDVC_SEP.is_file():
            raise RuntimeError(f"找不到分离脚本：{SEEDVC_SEP}")

        proc = subprocess.Popen(
            [str(SEEDVC_PY), str(SEEDVC_SEP), str(src), str(out_dir)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        while proc.poll() is None:
            if cancel.is_set():
                proc.kill()
                raise RuntimeError("已取消")
            time.sleep(0.2)
        out = proc.stdout.read().decode("utf-8", "ignore") if proc.stdout else ""
        if proc.returncode != 0:
            raise RuntimeError("分离失败：" + out[-400:])
        if not vocals.is_file():
            raise RuntimeError("分离没产出 vocals.wav：" + out[-300:])
        return vocals, inst if inst.is_file() else None

    # -- 换声 ------------------------------------------------------

    def convert(self, src: Path, dst: Path, *, pitch: int = 0, index_rate: float = 0.75,
                protect: float = 0.33, rms_mix_rate: float = 1.0,
                progress: Optional[Callable[[float, str], None]] = None,
                cancel: Optional[threading.Event] = None) -> dict:
        """把整段音频切片换声，返回 {sr, chunks, seconds}。"""
        if not self.ready:
            self.load()
        cancel = cancel or threading.Event()
        dur = probe_duration(src)
        n = max(1, int(np.ceil(dur / CHUNK_SEC))) if dur > 0 else 1
        tmp = Path(tempfile.mkdtemp(prefix="fishsing-"))
        pieces, out_sr = [], self.sr
        try:
            # 先整段解码成 wav，再用 soundfile 按片切（避免 ffmpeg 每片都读一遍源文件）
            whole = to_wav(src, tmp / "whole.wav")
            data, out_sr = read_audio(whole)
            step = int(CHUNK_SEC * out_sr)
            for i in range(n):
                if cancel.is_set():
                    raise RuntimeError("已取消")
                seg = data[i * step:(i + 1) * step]
                if seg.shape[0] < out_sr * 0.05:  # 尾巴不足 50ms 丢掉，避免爆音
                    break
                seg_path = tmp / f"chunk_{i:03d}.wav"
                write_audio(seg_path, seg, out_sr)
                with self._lock:  # VC 只有一份，串行
                    status, result = self._vc.vc_single(
                        0, str(seg_path), int(pitch), "rmvpe",
                        self.index, float(index_rate), 0, float(rms_mix_rate), float(protect),
                    )
                if not result or result[0] is None or result[1] is None:
                    raise RuntimeError(f"第 {i + 1} 片换声失败：{status}")
                out_sr, audio = int(result[0]), np.asarray(result[1], dtype=np.float32)
                if audio.ndim == 1:
                    audio = audio.reshape(-1, 1)
                pieces.append(audio)
                if progress:
                    progress((i + 1) / n, f"换声 {i + 1}/{n} 片")
            if not pieces:
                raise RuntimeError("没有产出任何音频")
            mer = np.concatenate(pieces, axis=0)
            write_audio(dst, mer, out_sr)
            return {"sr": out_sr, "chunks": len(pieces), "seconds": mer.shape[0] / out_sr}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # -- 混音 ------------------------------------------------------

    def mix(self, vocals: Path, inst: Optional[Path], dst: Path, *,
            vocal_gain: float = 1.15, inst_gain: float = 0.85,
            target_sr: int = 44100, peak: float = 0.95) -> dict:
        v, vsr = read_audio(vocals)
        if inst is None or not Path(inst).is_file():
            out = v
        else:
            if vsr != target_sr:  # 人声先升到目标采样率
                tmpv = Path(tempfile.mkdtemp(prefix="fishsing-")) / "v.wav"
                run_ff([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", vocals,
                        "-ar", str(target_sr), "-ac", "2", "-c:a", "pcm_s24le", tmpv])
                v, vsr = read_audio(tmpv)
                shutil.rmtree(tmpv.parent, ignore_errors=True)
            tmpi = Path(tempfile.mkdtemp(prefix="fishsing-")) / "i.wav"
            run_ff([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", inst,
                    "-ar", str(target_sr), "-ac", "2", "-c:a", "pcm_s24le", tmpi])
            i, _ = read_audio(tmpi)
            shutil.rmtree(tmpi.parent, ignore_errors=True)
            n = min(v.shape[0], i.shape[0])
            if v.shape[1] == 1 and i.shape[1] == 2:
                v = np.repeat(v, 2, axis=1)
            elif v.shape[1] == 2 and i.shape[1] == 1:
                i = np.repeat(i, 2, axis=1)
            out = v[:n] * vocal_gain + i[:n] * inst_gain

        m = float(np.abs(out).max()) if out.size else 0.0
        if m > peak:
            out = (out * (peak / m)).astype(np.float32)
        write_audio(dst, out, vsr if inst is None else target_sr)
        return {"sr": vsr if inst is None else target_sr,
                "seconds": out.shape[0] / (vsr if inst is None else target_sr), "peak": round(m, 3)}

    # -- 一键流程 --------------------------------------------------

    def song(self, src: Path, work: Path, *, separate: bool = True, mode: str = "full",
             pitch: int = 0, index_rate: float = 0.75, protect: float = 0.33,
             progress: Optional[Callable[[float, str], None]] = None,
             cancel: Optional[threading.Event] = None) -> dict:
        """
        整首歌：分离 → 换声 → 混音。
        mode: full=带伴奏 / vocals=只要人声（清唱）/ mixed 同 full 但保留中间文件
        """
        cancel = cancel or threading.Event()
        work.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        report = progress or (lambda p, m: None)

        vocal_src = src
        inst = None
        if separate:
            report(0.02, "分离人声与伴奏")
            vocal_src, inst = self.separate(to_wav(src, work / "src.wav"), work, cancel)
        else:
            vocal_src = to_wav(src, work / "src.wav")

        report(0.2, "加载模型" if not self.ready else "开始换声")
        conv = work / "vocals_converted.wav"
        info = self.convert(vocal_src, conv, pitch=pitch, index_rate=index_rate,
                            protect=protect,
                            progress=lambda p, m: report(0.2 + 0.6 * p, m), cancel=cancel)

        if mode == "vocals":
            out = work / "result.wav"
            shutil.copyfile(conv, out)
            mix_info = {"sr": info["sr"], "seconds": info["seconds"]}
        else:
            report(0.85, "混音")
            out = work / "result.wav"
            mix_info = self.mix(conv, inst, out)

        report(1.0, "完成")
        return {
            "output": str(out),
            "vocals": str(conv),
            "inst": str(inst) if inst else "",
            "chunks": info["chunks"],
            "seconds": round(info["seconds"], 2),
            "samplerate": mix_info.get("sr", info["sr"]),
            "elapsedSec": round(time.time() - t0, 1),
        }


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
    add("分离环境", SEEDVC_PY.is_file(), SEEDVC_PY)
    add("分离脚本", SEEDVC_SEP.is_file(), SEEDVC_SEP)
    try:
        import torch
        add("CUDA", torch.cuda.is_available(),
            torch.cuda.get_device_name(0) if torch.cuda.is_available() else "不可用")
    except Exception as e:  # noqa: BLE001
        add("CUDA", False, e)
    return out


if __name__ == "__main__":
    print(json.dumps(doctor(), ensure_ascii=False, indent=2))
