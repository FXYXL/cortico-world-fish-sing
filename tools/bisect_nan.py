#!/usr/bin/env python
"""对 dfy4 数据二分：找出哪些切片会让训练 loss 变 NaN。

用法：python bisect_nan.py <名字1> <名字2> ...
给一组 wav 文件名（不含扩展名也可），在临时实验里跑 1 轮，打印首个 loss。
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

RVC = Path(r"D:/Coopanion/data/home/companion/data/fish-sing/runtime/rvc")
LOGS = RVC / "logs"
SRC = LOGS / "dfy4diag"
PY = Path(r"D:/Coopanion/data/home/companion/data/fish-sing/runtime/venv/Scripts/python.exe")
EXP = LOGS / "bisect"
SUBS = ("0_gt_wavs", "1_16k_wavs", "2a_f0", "2b-f0nsf", "3_feature768")


def build(names):
    if EXP.exists():
        shutil.rmtree(EXP)
    EXP.mkdir(parents=True)
    for sub in SUBS:
        (EXP / sub).mkdir()
    for sub in ("config.json",):
        shutil.copy(SRC / sub, EXP / sub)
    rows = []
    for wav in (SRC / "0_gt_wavs").glob("*.wav"):
        stem = wav.stem
        if stem not in names:
            continue
        os.link(wav, EXP / "0_gt_wavs" / wav.name)
        for sub, fmt in (("1_16k_wavs", "{}.wav"), ("2a_f0", "{}.wav.npy"),
                         ("2b-f0nsf", "{}.wav.npy"), ("3_feature768", "{}.npy")):
            f = SRC / sub / fmt.format(stem)
            os.link(f, EXP / sub / f.name)
        rows.append(
            f"{EXP / '0_gt_wavs' / wav.name}|{EXP / '3_feature768' / (stem + '.npy')}"
            f"|{EXP / '2a_f0' / (wav.name + '.npy')}|{EXP / '2b-f0nsf' / (wav.name + '.npy')}|0"
        )
    (EXP / "filelist.txt").write_text("\n".join(rows), encoding="utf8")


def train_once():
    log = Path(os.environ.get("TEMP", ".")) / "bisect_run.log"
    env = os.environ.copy()
    env["PYTHONPATH"] = str(RVC)
    env["PYTHONIOENCODING"] = "utf-8"
    env["FISHSING_RVC_ROOT"] = str(RVC)
    with open(log, "w", encoding="utf-8") as fh:
        subprocess.run(
            [str(PY), "-m", "train.train", "-se", "10", "-te", "1",
             "-pg", str(RVC / "assets/pretrained_v2/f0G40k.pth"),
             "-pd", str(RVC / "assets/pretrained_v2/f0D40k.pth"),
             "-bs", "4", "-e", "bisect", "-sr", "40k", "-sw", "0", "-v", "v2",
             "-f0", "1", "-l", "0", "-c", "0"],
            cwd=str(RVC), env=env, stdout=fh, stderr=subprocess.STDOUT,
        )
    txt = log.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"loss_disc=([^,]+)", txt)
    return m.group(1) if m else "NO_LOSS"


if __name__ == "__main__":
    names = set()
    for a in sys.argv[1:]:
        names.add(Path(a).stem)
    build(names)
    print(f"测试 {len(names)} 片 → loss_disc = {train_once()}", flush=True)
