# -*- coding: utf-8 -*-
"""
人声分离（demucs htdemucs）。自带这份脚本是为了不再依赖 Seed-VC 那个外部项目——
只要运行时里装了 demucs，这个脚本就能跑。

    python separate.py <输入.wav> <输出目录> [--device auto|cuda|cpu] [--model htdemucs]

输出 <输出目录>/vocals.wav 与 inst.wav（44.1 kHz，PCM_24）。
进度靠 demucs 自己的 tqdm 打到 stderr，调用方（worker/server.py）会把 stderr 并进 stdout
再解析百分比——所以这里不要重定向或静音，否则外面看不到进度。
"""

import argparse
import os
import subprocess
import sys
import time

import numpy as np
import soundfile as sf
import torch
import torchaudio
from demucs.apply import apply_model
from demucs.pretrained import get_model


def _decode_44100(path):
    """解码成 (2, n) float32 的 44.1 kHz 立体声。

    不用 soundfile：它读不了 aac/m4a（`Format not recognised`），而这些恰恰是常见素材格式。
    ffmpeg 顺手把采样率和声道一起规整了，省掉后面两步。
    """
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


def separate_file(src, out_dir, device="auto", model_name="htdemucs", overlap=0.25, quiet=False):
    """把 src 分离成 <out_dir>/vocals.wav 与 inst.wav，返回 (vocals_path, inst_path, sr)。

    抽成函数是为了让 dataset.py 直接 import 复用——之前只有 main()，想复用只能再抄一遍。
    """
    def say(msg):
        if not quiet:
            print(msg, flush=True)

    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()

    say(f"decode {src}")
    data = _decode_44100(src)
    sr = 44100
    say(f"loaded {data.shape} {sr} dur {data.shape[1] / sr:.1f}s")
    x = torch.from_numpy(data)

    model = get_model(model_name)
    model.eval()
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
            if dev != devices[0]:
                say(f"注意：改用 {dev} 跑完了（前面失败：{str(last_err)[:160]}）")
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
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
    say(f"saved {vocals.shape} {inst.shape} {sr} 用时 {time.time() - t0:.1f}s")
    return vpath, ipath, sr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out_dir")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--overlap", type=float, default=0.25)
    args = ap.parse_args()
    try:
        separate_file(args.src, args.out_dir, args.device, args.model, args.overlap)
    except RuntimeError as e:
        print(e, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
