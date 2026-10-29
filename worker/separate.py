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
import sys
import time

import numpy as np
import soundfile as sf
import torch
import torchaudio
from demucs.apply import apply_model
from demucs.pretrained import get_model


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out_dir")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--overlap", type=float, default=0.25)
    args = ap.parse_args()

    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()

    print(f"decode {args.src}", flush=True)
    wav, sr = sf.read(args.src, dtype="float32", always_2d=True)
    print(f"loaded {wav.shape} {sr} dur {len(wav) / sr:.1f}s", flush=True)

    x = torch.from_numpy(wav.T)
    if sr != 44100:
        x = torchaudio.functional.resample(x, sr, 44100)
        sr = 44100
    if x.shape[0] == 1:
        x = x.repeat(2, 1)

    model = get_model(args.model)
    model.eval()
    print(f"model {model.sources} sr {model.samplerate}", flush=True)

    # 按整段参考信号做均值/方差归一，输出时再还原（demucs 官方做法）
    ref = x.mean(0, keepdim=True)
    mean, std = ref.mean(), ref.std()
    x = (x - mean) / std

    if args.device == "cpu":
        devices = ["cpu"]
    elif args.device == "cuda":
        devices = ["cuda"]
    else:
        devices = ["cuda", "cpu"] if torch.cuda.is_available() else ["cpu"]

    last_err = None
    for dev in devices:
        try:
            with torch.no_grad():
                out = apply_model(model, x[None], device=dev, shifts=0, split=True,
                                  overlap=args.overlap, progress=True)[0]
            if dev != devices[0]:
                print(f"注意：改用 {dev} 跑完了（前面失败：{str(last_err)[:160]}）", flush=True)
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"{dev} 失败，尝试下一个设备：{str(e)[:200]}", flush=True)
            if dev == devices[-1]:
                print("所有设备都失败", flush=True)
                return 1
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    out = out * std + mean
    sources = dict(zip(model.sources, out))
    vocals = sources["vocals"].numpy().T
    inst = (out.sum(0) - sources["vocals"]).numpy().T

    sf.write(os.path.join(out_dir, "vocals.wav"), vocals, sr, subtype="PCM_24")
    sf.write(os.path.join(out_dir, "inst.wav"), inst, sr, subtype="PCM_24")
    print(f"saved {vocals.shape} {inst.shape} {sr} 用时 {time.time() - t0:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
