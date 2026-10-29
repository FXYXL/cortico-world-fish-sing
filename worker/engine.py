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

import json
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

RVC_ROOT = Path(os.environ.get("FISHSING_RVC_ROOT", r"D:\AI\rvc"))
RVC_PY = RVC_ROOT / "venv" / "Scripts" / "python.exe"
SEP_PY = Path(os.environ.get("FISHSING_SEP_PY", sys.executable))
SEP_SCRIPT = Path(os.environ.get("FISHSING_SEP_SCRIPT",
                         str(Path(__file__).resolve().parent / "separate.py")))
FFMPEG = Path(os.environ.get("FISHSING_FFMPEG", r"D:\ffmpeg\bin\ffmpeg.exe"))

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

    def separate(self, src: Path, out_dir: Path, cancel: threading.Event,
                 progress: Optional[Callable[[float, str], None]] = None) -> tuple:
        """demucs htdemucs 出 vocals/inst。分离与推理共用一个运行时 venv，脚本是插件自带的 worker/separate.py。

        坑：`Popen(stdout=PIPE)` 之后必须**持续读**，否则子进程写满管道缓冲区（Windows 64KB）
        就会永久阻塞在 write 上——现象是 CPU 0%、显存也没动静、看起来"卡死"。
        demucs 的 tqdm 进度条正好会把它喂满。这里开一个线程专门读，顺便解析出百分比。
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

        proc = subprocess.Popen(
            [str(SEP_PY), str(SEP_SCRIPT), str(src), str(out_dir), "--device", "auto"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="ignore", bufsize=1,
        )
        tail: list = []

        def reader() -> None:
            pct = 0
            assert proc.stdout is not None
            for line in proc.stdout:
                s = line.strip()
                if not s:
                    continue
                tail.append(s)
                del tail[:-40]
                # tqdm 的 "... 12%|█  | 3/24" 或 "分离 12%"
                m = re.search(r"(\d{1,3})%", s)
                if m and progress:
                    pct = max(pct, min(99, int(m.group(1))))
                    progress(0.02 + 0.18 * pct / 100.0, f"分离人声与伴奏 {pct}%")

        t = threading.Thread(target=reader, name="fishsing-demucs", daemon=True)
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
                     cancel: threading.Event) -> tuple:
        """单片推理；显存不够就把这片对半切再试（唱歌时桌宠的 TTS 常驻会吃掉一半显存）。"""
        import torch

        if cancel.is_set():
            raise RuntimeError("已取消")
        path = tmp / f"piece_{tag}.wav"
        write_audio(path, seg, sr)
        try:
            with self._lock:  # VC 只有一份，串行
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
                                        rms_mix_rate=rms_mix_rate, cancel=cancel)
            _sr_b, b = self._infer_piece(seg[mid:], sr, tmp, f"{tag}b", pitch=pitch,
                                         index_rate=index_rate, protect=protect,
                                         rms_mix_rate=rms_mix_rate, cancel=cancel)
            return sr_a, np.concatenate([a, b], axis=0)
        finally:
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
                                rms_mix_rate: float, cancel: threading.Event) -> tuple:
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
        in_path = tmp / f"sp_{tag}.wav"
        out_path = tmp / f"sp_{tag}_out.wav"
        write_audio(in_path, seg, sr)
        env = os.environ.copy()
        env["PATH"] = str(FFMPEG.parent) + os.pathsep + env.get("PATH", "")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        args = [
            sys.executable, "-m", "infer.cli",
            "--model", self.model,
            "--input", str(in_path),
            "--output", str(out_path),
            "--index-rate", str(float(index_rate)),
            "--pitch", str(int(pitch)),
            "--protect", str(float(protect)),
            "--rms-mix-rate", str(float(rms_mix_rate)),
            "--f0-method", "rmvpe",
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
                protect: float = 0.33, rms_mix_rate: float = 1.0,
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
            for i in range(n):
                if cancel.is_set():
                    raise RuntimeError("已取消")
                seg = data[i * step:(i + 1) * step]
                if seg.shape[0] < in_sr * 0.05:  # 尾巴不足 50ms 丢掉，避免爆音
                    break
                runner = self._infer_piece if n == 1 else self._infer_piece_subprocess
                out_sr, audio = runner(
                    seg, in_sr, tmp, f"{i:03d}",
                    pitch=pitch, index_rate=index_rate, protect=protect,
                    rms_mix_rate=rms_mix_rate, cancel=cancel,
                )
                pieces.append(audio)
                if progress:
                    progress(0.2 + 0.6 * (i + 1) / n, f"换声 {i + 1}/{n} 片")
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
            vocal_src, inst = self.separate(to_wav(src, work / "src.wav"), work, cancel,
                                            progress=lambda p, m: report(p, m))
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
    add("分离环境", SEP_PY.is_file(), SEP_PY)
    add("分离脚本", SEP_SCRIPT.is_file(), SEP_SCRIPT)
    try:
        import torch
        add("CUDA", torch.cuda.is_available(),
            torch.cuda.get_device_name(0) if torch.cuda.is_available() else "不可用")
    except Exception as e:  # noqa: BLE001
        add("CUDA", False, e)
    return out


if __name__ == "__main__":
    print(json.dumps(doctor(), ensure_ascii=False, indent=2))
