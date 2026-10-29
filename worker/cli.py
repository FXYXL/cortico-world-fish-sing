# -*- coding: utf-8 -*-
"""
fish-sing 命令行：不开桌宠、不起服务也能跑完整条链。

    python cli.py "D:\\AI\\孙燕姿 - 我不难过.mp3" --play
    python cli.py in.mp3 --mode vocals --out 清唱.mp3
    python cli.py in.mp3 --start 95 --duration 30 --out 副歌.mp3
    python cli.py in.wav --no-separate           # 已经是干声

它会：解码 → 分离 → 55 秒切片换声 → 混音 → 导出 mp3 →（可选）本机播放。
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import FFMPEG, SingEngine, probe_duration, run_ff, to_wav  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def human(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    return f"{m}:{s:02d}"


def main() -> int:
    ap = argparse.ArgumentParser(description="大肥鱼唱歌：一条命令跑完分离+换声+混音")
    ap.add_argument("input", help="音频文件（mp3/wav/m4a/flac…）")
    ap.add_argument("--out", default="", help="输出文件，默认 data/work/<名字>/result.mp3")
    ap.add_argument("--mode", choices=["full", "vocals"], default="full",
                    help="full=带伴奏（默认）；vocals=只要人声")
    ap.add_argument("--no-separate", action="store_true", help="输入已经是干声，跳过 demucs")
    ap.add_argument("--pitch", type=int, default=0, help="移调半音（男歌女唱试 +2 ~ +4）")
    ap.add_argument("--index-rate", type=float, default=0.75, help="音色检索强度 0~1")
    ap.add_argument("--protect", type=float, default=0.33, help="气声保护 0~0.5")
    ap.add_argument("--start", type=float, default=0, help="从第几秒开始（只唱副歌用）")
    ap.add_argument("--duration", type=float, default=0, help="取多长（0=到结尾）")
    ap.add_argument("--format", default="mp3", choices=["mp3", "wav", "m4a"])
    ap.add_argument("--bitrate", default="256k")
    ap.add_argument("--play", action="store_true", help="跑完直接本机播放")
    ap.add_argument("--keep-work", action="store_true", help="保留中间文件（干声/换声人声）")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.is_file():
        print(f"找不到文件：{src}")
        return 2

    root = Path(__file__).resolve().parent.parent
    stamp = time.strftime("%Y%m%d-%H%M%S")
    work = root / "data" / "work" / f"{src.stem[:24]}-{stamp}"
    work.mkdir(parents=True, exist_ok=True)

    # 截取：先切再分离，省算力
    feed = src
    if args.start > 0 or args.duration > 0:
        cut = work / "cut.wav"
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
        if args.start > 0:
            cmd += ["-ss", str(args.start)]
        cmd += ["-i", str(src)]
        if args.duration > 0:
            cmd += ["-t", str(args.duration)]
        cmd += ["-ac", "2", "-c:a", "pcm_s24le", str(cut)]
        run_ff(cmd)
        feed = cut
        print(f"截取 {args.start:.0f}s 起 {args.duration or probe_duration(src) - args.start:.0f}s")

    eng = SingEngine()
    print("加载模型…")
    eng.load()

    t0 = time.time()
    last = {"t": 0.0}

    def progress(p: float, msg: str) -> None:
        if time.time() - last["t"] < 0.4 and p < 1.0:
            return
        last["t"] = time.time()
        bar = "█" * int(p * 24) + "·" * (24 - int(p * 24))
        print(f"\r[{bar}] {p * 100:5.1f}%  {msg}", end="", flush=True)

    try:
        info = eng.song(
            feed, work,
            separate=not args.no_separate,
            mode=args.mode,
            pitch=args.pitch,
            index_rate=args.index_rate,
            protect=args.protect,
            progress=progress,
        )
    except Exception as e:  # noqa: BLE001
        print(f"\n失败：{e}")
        return 1

    print()
    out = Path(args.out) if args.out else work / f"result.{args.format}"
    codec = {"mp3": ["-c:a", "libmp3lame", "-b:a", args.bitrate],
             "m4a": ["-c:a", "aac", "-b:a", args.bitrate],
             "wav": ["-c:a", "pcm_s24le"]}[args.format]
    run_ff([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", info["output"],
            "-ar", "44100"] + codec + [out])

    dur = probe_duration(out)
    print(json.dumps({
        "输出": str(out),
        "时长": human(dur),
        "切片数": info["chunks"],
        "采样率": info["samplerate"],
        "耗时": f"{time.time() - t0:.1f}s",
        "干声": info.get("vocals", "") if args.keep_work else "(已清理)",
    }, ensure_ascii=False, indent=2))

    if not args.keep_work:
        for p in (work / "vocals.wav", work / "inst.wav", work / "src.wav",
                  work / "vocals_converted.wav", work / "cut.wav"):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass

    if args.play:
        ffplay = FFMPEG.parent / "ffplay.exe"
        if ffplay.is_file():
            print("播放中…（关窗口或 Ctrl-C 停止）")
            subprocess.run([str(ffplay), "-nodisp", "-autoexit", "-loglevel", "quiet", str(out)])
        else:
            print(f"没找到 ffplay：{ffplay}")
            os.startfile(str(out))  # type: ignore[attr-defined]
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
