# -*- coding: utf-8 -*-
"""
人声分离脚本：支持快速档（demucs htdemucs）与精唱/训练档（UVR5 内核 audio-separator：RoFormer + 可选 De-Reverb）。

    python separate.py <输入.wav> <输出目录> [--device auto|cuda|cpu] [--engine htdemucs|roformer] [--dereverb] [--fallback]

输出 <输出目录>/vocals.wav 与 inst.wav（44.1 kHz，PCM_24）。
进度靠 stdout/stderr 里的百分比被调用方（worker/engine.py）解析，不要重定向或静音。
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

# htdemucs 的权重文件名（torch.hub 缓存目录下的名字）
_DEMUCS_CKPT = "955717e8-8726e21a.th"

# UVR5 / audio-separator 默认模型（均为 PyTorch 权重，直接走现有 PyTorch CUDA，无需额外折腾 onnxruntime-gpu）
_DEFAULT_ROFORMER_MODEL = os.environ.get(
    "FISHSING_ROFORMER_MODEL",
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
)
_DEFAULT_DEREVERB_MODEL = os.environ.get(
    "FISHSING_DEREVERB_MODEL",
    "UVR-DeEcho-DeReverb.pth",
)


def _ckpt_dir():
    base = os.environ.get("TORCH_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "torch")
    return os.path.join(base, "hub", "checkpoints")


def _uvr_model_dir():
    env = os.environ.get("FISHSING_UVR_MODEL_DIR", "").strip()
    if env:
        return env
    work = os.environ.get("FISHSING_WORK", "").strip()
    if work:
        return str(Path(work).parent / "runtime" / "uvr_models")
    return os.path.join(os.path.dirname(_ckpt_dir()), "uvr_models")


def _preflight_weights(model_name, say=None):
    """分离权重预检：本地有就直接用，没有才下载，而且限时。"""
    import socket

    socket.setdefaulttimeout(20)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    if model_name != "htdemucs":
        return
    ck = os.path.join(_ckpt_dir(), _DEMUCS_CKPT)
    if os.path.isfile(ck):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        if say:
            say(f"weights cached {os.path.basename(ck)} {os.path.getsize(ck) // (1 << 20)}MB")
    else:
        if say:
            say("weights MISSING 首次需下载 84MB（网络差会慢，最多等 20 秒/次）")


def _decode_44100(path):
    """解码成 (2, n) float32 的 44.1 kHz 立体声。"""
    exe = os.environ.get("FISHSING_FFMPEG", "ffmpeg")
    proc = subprocess.run(
        [exe, "-v", "error", "-i", str(path), "-ac", "2", "-ar", "44100", "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 解码失败：{(proc.stderr or b'')[-200:]}")
    y = np.frombuffer(proc.stdout, dtype=np.float32)
    if y.size < 2:
        raise RuntimeError("解码结果为空")
    return y.reshape(-1, 2).T.copy()


def _write_44100_pcm24(src_path, dst_path):
    """统一标准化为 44.1 kHz 立体声 PCM_24 WAV。"""
    data = _decode_44100(src_path)
    sf.write(str(dst_path), data.T, 44100, subtype="PCM_24")


def _resolve_sep_outputs(raw_outputs, out_dir):
    """兼容不同版本 audio-separator 返回相对文件名或绝对路径的差异。"""
    resolved = []
    for item in raw_outputs or []:
        p = Path(str(item))
        if not p.is_absolute():
            p = Path(out_dir) / p
        if p.is_file():
            resolved.append(p)
    return resolved


def _pick_stem(paths, positive_keys, negative_keys=()):
    """按文件名关键词挑选目标音轨。"""
    for p in paths:
        low = p.name.lower()
        if any(k in low for k in positive_keys) and not any(k in low for k in negative_keys):
            return p
    for p in paths:
        low = p.name.lower()
        if not any(k in low for k in negative_keys):
            return p
    return paths[0] if paths else None


def _run_dereverb(vocal_path, out_dir, device="auto", say=None):
    """使用 audio-separator 的轻量 De-Reverb 模型净化干声混响。"""
    from audio_separator.separator import Separator

    model_dir = _uvr_model_dir()
    os.makedirs(model_dir, exist_ok=True)
    use_cuda = device != "cpu" and torch.cuda.is_available()
    tmp_dir = Path(tempfile.mkdtemp(prefix="fishsing-derev-", dir=str(out_dir)))
    try:
        if say:
            say(f"去混响 78%（{_DEFAULT_DEREVERB_MODEL}）")
        sep = Separator(
            output_dir=str(tmp_dir),
            output_format="WAV",
            model_file_dir=model_dir,
            use_autocast=use_cuda,
        )
        sep.load_model(model_filename=_DEFAULT_DEREVERB_MODEL)
        files = _resolve_sep_outputs(sep.separate(str(vocal_path)), tmp_dir)
        dry = _pick_stem(
            files,
            positive_keys=("no reverb", "no_reverb", "noreverb", "dry"),
            negative_keys=("(reverb)", "_reverb", "echo"),
        )
        if not dry or not dry.is_file():
            if say:
                say("去混响未匹配到干声输出，保留原始分离人声")
            return False
        _write_44100_pcm24(dry, vocal_path)
        if say:
            say("去混响完成 96%")
        return True
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def _separate_roformer(src, out_dir, device="auto", dereverb=False, say=None):
    """使用 UVR5 内核（audio-separator + BS-RoFormer）分离人声与伴奏，可选串联去混响。"""
    from audio_separator.separator import Separator

    t0 = time.time()
    model_dir = _uvr_model_dir()
    os.makedirs(model_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    use_cuda = device != "cpu" and torch.cuda.is_available()
    tmp_dir = Path(tempfile.mkdtemp(prefix="fishsing-uvr-", dir=str(out_dir)))
    try:
        if say:
            say(f"分离 8%（UVR5 {_DEFAULT_ROFORMER_MODEL}，{'CUDA' if use_cuda else 'CPU'}）")
        # 先统一转标准 wav 喂给 audio-separator，避免 m4a/aac 偶发解码差异
        src_wav = tmp_dir / "input.wav"
        _write_44100_pcm24(src, src_wav)
        if say:
            say("分离 18%（加载 RoFormer 权重）")
        sep = Separator(
            output_dir=str(tmp_dir),
            output_format="WAV",
            model_file_dir=model_dir,
            use_autocast=use_cuda,
        )
        sep.load_model(model_filename=_DEFAULT_ROFORMER_MODEL)
        if say:
            say("分离 35%（RoFormer 推理中）")
        files = _resolve_sep_outputs(sep.separate(str(src_wav)), tmp_dir)
        if not files:
            raise RuntimeError("audio-separator 未产出任何音频文件")

        voc_raw = _pick_stem(
            files,
            positive_keys=("(vocals)", "_vocals", "vocals"),
            negative_keys=("instrumental", "no_vocals", "other"),
        )
        inst_raw = _pick_stem(
            files,
            positive_keys=("(instrumental)", "instrumental", "no_vocals", "other"),
            negative_keys=("(vocals)",),
        )
        if not voc_raw or not voc_raw.is_file():
            raise RuntimeError("audio-separator 未找到人声轨输出")

        vpath = os.path.join(out_dir, "vocals.wav")
        ipath = os.path.join(out_dir, "inst.wav")
        if say:
            say("分离 70%（写入人声与伴奏）")
        _write_44100_pcm24(voc_raw, vpath)
        if inst_raw and inst_raw.is_file() and inst_raw != voc_raw:
            _write_44100_pcm24(inst_raw, ipath)
        else:
            # 极端情况只有人声轨时，用原音减人声补伴奏
            orig = _decode_44100(src_wav)
            voc = _decode_44100(vpath)
            n = min(orig.shape[1], voc.shape[1])
            sf.write(ipath, (orig[:, :n] - voc[:, :n]).T, 44100, subtype="PCM_24")

        del sep
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        if dereverb:
            _run_dereverb(vpath, out_dir, device=device, say=say)

        if say:
            say(f"saved UVR5 vocals/inst 44100 用时 {time.time() - t0:.1f}s 100%")
        return vpath, ipath, 44100
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _separate_htdemucs(src, out_dir, device="auto", model_name="htdemucs", overlap=0.25,
                       dereverb=False, say=None, quiet=False):
    """使用 demucs htdemucs 快速分离。"""
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()

    if say:
        say(f"decode {src}")
    data = _decode_44100(src)
    sr = 44100
    if say:
        say(f"loaded {data.shape} {sr} dur {data.shape[1] / sr:.1f}s")
    x = torch.from_numpy(data)

    _preflight_weights(model_name, say)
    t_model = time.time()
    model = get_model(model_name)
    model.eval()
    if say:
        say(f"model loaded {time.time() - t_model:.1f}s")
        say(f"model {model.sources} sr {model.samplerate}")

    # 按整段参考信号做均值/方差归一，输出时再还原（demucs 官方做法）
    ref = x.mean(0, keepdim=True)
    mean, std = ref.mean(), ref.std()
    x = (x - mean) / std

    if device == "cpu":
        devices = ["cpu"]
    elif device == "cuda":
        devices = ["cuda"]
    else:
        devices = ["cuda", "cpu"] if torch.cuda.is_available() else ["cpu"]

    last_err = None
    out = None
    for dev in devices:
        try:
            with torch.no_grad():
                out = apply_model(model, x[None], device=dev, shifts=0, split=True,
                                  overlap=overlap, progress=not quiet)[0]
            if dev != devices[0] and say:
                say(f"注意：改用 {dev} 跑完了（前面失败：{str(last_err)[:160]}）")
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            if say:
                say(f"{dev} 失败，尝试下一个设备：{str(e)[:200]}")
            if dev == devices[-1]:
                raise RuntimeError("所有设备都失败：" + str(last_err)[:200])
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    out = out * std + mean
    srcs = dict(zip(model.sources, out))
    vocals = srcs["vocals"].numpy().T
    inst = (out.sum(0) - srcs["vocals"]).numpy().T

    vpath = os.path.join(out_dir, "vocals.wav")
    ipath = os.path.join(out_dir, "inst.wav")
    sf.write(vpath, vocals, sr, subtype="PCM_24")
    sf.write(ipath, inst, sr, subtype="PCM_24")

    del model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    if dereverb:
        try:
            _run_dereverb(vpath, out_dir, device=device, say=say)
        except ImportError:
            if say:
                say("未安装 audio-separator，跳过额外去混响")
        except Exception as e:  # noqa: BLE001
            if say:
                say(f"去混响跳过：{str(e)[:160]}")

    if say:
        say(f"saved {vocals.shape} {inst.shape} {sr} 用时 {time.time() - t0:.1f}s")
    return vpath, ipath, sr


def separate_file(src, out_dir, device="auto", model_name="htdemucs", overlap=0.25,
                  quiet=False, engine="htdemucs", dereverb=False, fallback=True):
    """把 src 分离成 <out_dir>/vocals.wav 与 inst.wav，返回 (vocals_path, inst_path, sr)。"""
    def say(msg):
        if not quiet:
            print(msg, flush=True)

    eng = str(engine or "htdemucs").strip().lower()
    if eng in ("roformer", "uvr", "uvr5"):
        try:
            return _separate_roformer(src, out_dir, device=device, dereverb=bool(dereverb), say=say)
        except ImportError as e:
            if not fallback:
                raise RuntimeError(
                    "未安装 audio-separator（UVR5 精唱/去混响内核）。"
                    "请在插件运行时 venv 执行：pip install audio-separator"
                ) from e
            say("未安装 audio-separator，自动回落到 htdemucs 快速分离")
        except Exception as e:  # noqa: BLE001
            if not fallback:
                raise
            say(f"UVR5 分离异常（{str(e)[:160]}），自动回落到 htdemucs")

    return _separate_htdemucs(
        src, out_dir, device=device, model_name=model_name, overlap=overlap,
        dereverb=bool(dereverb), say=say, quiet=quiet,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out_dir")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--overlap", type=float, default=0.25)
    ap.add_argument("--engine", default="htdemucs", choices=["htdemucs", "roformer"])
    ap.add_argument("--dereverb", action="store_true")
    ap.add_argument("--no-fallback", action="store_true")
    args = ap.parse_args()
    try:
        separate_file(
            args.src, args.out_dir,
            device=args.device,
            model_name=args.model,
            overlap=args.overlap,
            engine=args.engine,
            dereverb=args.dereverb,
            fallback=not args.no_fallback,
        )
    except RuntimeError as e:
        print(e, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
