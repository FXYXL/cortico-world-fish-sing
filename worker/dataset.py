# -*- coding: utf-8 -*-
"""
训练数据准备：扫描 → 分离 → 自适应切片 → F0 统计 → 质检 → manifest.json

为什么自己切片而不用 RVC 的 preprocess.py：
1. RVC 是固定 3.7 秒窗口硬切，切点经常落在字中间（听起来像"半个音"),而且不管歌的快慢；
   这里按**静音间隙**找自然乐句，片段长度自动落在 2~6 秒。
2. 我们要给每一片打上音域标签（F0 中位）用于训练加权，RVC 的切分不产出这个信息。
3. 质检要能解释"为什么丢掉这一片"，RVC 只报个总数。

产物（<out>/）：
  sep/<序号>/vocals.wav, inst.wav   分离结果（已经是干声的源不产生）
  slices/0001.wav ...               切片，40 kHz / PCM_24
  manifest.json                     每片元数据 + 统计

调用方是 server.py 的 dataset 任务；进度靠 progress(pct, msg) 回调。
"""

import json
import math
import os
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import soundfile as sf

try:
    import pyworld as pw
except Exception:  # noqa: BLE001
    pw = None

AUDIO_EXT = {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".wma", ".opus"}

#: 切片时的目标采样率。跟 RVC 的 40k 配置一致，后面提取特征就不用再重采样。
OUT_SR = 40000

#: 自适应切片的边界（秒）。低于 MIN 合并、高于 MAX 再切。
MIN_LEN = 2.0
#: 上限给 4.5 而不是 6：RVC 训练时整段读进 batch，6 秒样本的显存占用比 3.7 秒多 60%，
#: 8G 卡上容易 OOM；4.5 秒既容得下自然乐句，又不至于把 batch 撑爆。
MAX_LEN = 4.5

#: 音域分档默认边界（Hz）。面板上可改，这里只是 manifest 里的初始标注。
BANDS = [(0, 280, "low"), (280, 400, "mid"), (400, 520, "high"), (520, 99999, "top")]


def log(msg: str) -> None:
    print(f"[dataset] {msg}", flush=True)


def ffprobe(path) -> dict:
    exe = os.environ.get("FISHSING_FFPROBE") or str(Path(os.environ.get("FISHSING_FFMPEG", "ffmpeg"))
                                                  .with_name("ffprobe.exe"))
    out = subprocess.run(
        [exe, "-v", "error", "-show_entries",
         "format=duration:stream=sample_rate,channels,codec_name",
         "-of", "json", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="ignore",
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe 读不了 {Path(path).name}：{(out.stderr or '')[-200:]}")
    j = json.loads(out.stdout or "{}")
    st = (j.get("streams") or [{}])[0]
    return {
        "duration": float((j.get("format") or {}).get("duration") or 0.0),
        "sr": int(st.get("sample_rate") or 0),
        "channels": int(st.get("channels") or 0),
        "codec": str(st.get("codec_name") or ""),
    }


def looks_dry(path) -> bool:
    """文件名/目录名像不像已经分离好的人声。"""
    s = str(path).lower()
    return any(k in s for k in ("vocal", "干声", "人声", "dry_"))


def scan(paths) -> list:
    """把路径展开成源列表（文件夹递归，只收音频后缀）。"""
    found = []
    for raw in paths:
        p = Path(str(raw)).expanduser()
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_file() and f.suffix.lower() in AUDIO_EXT:
                    found.append(f)
        elif p.is_file() and p.suffix.lower() in AUDIO_EXT:
            found.append(p)
    seen, out = set(), []
    for f in found:
        key = str(f.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        try:
            meta = ffprobe(f)
        except Exception as e:  # noqa: BLE001
            out.append({"path": str(f), "name": f.name, "error": str(e)})
            continue
        out.append({
            "path": str(f),
            "name": f.name,
            "duration": round(meta["duration"], 2),
            "sr": meta["sr"],
            "channels": meta["channels"],
            "codec": meta["codec"],
            "dry": looks_dry(f),
        })
    return out


# ---------------------------------------------------------------- 音频分析

def load_mono(path, sr=16000) -> np.ndarray:
    """统一用 ffmpeg 解码，aac/m4a 也吃得下（soundfile 读不了 aac）。"""
    exe = os.environ.get("FISHSING_FFMPEG", "ffmpeg")
    proc = subprocess.run(
        [exe, "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr),
         "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"解码失败 {Path(path).name}：{(proc.stderr or b'')[-200:]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def frame_db(y: np.ndarray, sr: int, win=0.04, hop=0.01):
    n, h = int(win * sr), int(hop * sr)
    if y.size < n:
        return np.array([-80.0]), hop / sr
    frames = np.lib.stride_tricks.sliding_window_view(y, n)[::h]
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1) + 1e-12)
    # 注意是 h / sr（样本数换算成秒），不是参数 hop / sr——写成后者会得到 6e-7 这种值，
    # 导致所有帧被判定成"同一段"，切片数永远是 1。
    return 20 * np.log10(rms + 1e-9), h / sr


def voiced_runs(db: np.ndarray, hop_sec: float, min_gap=0.30, rel_db=28.0, abs_db=-45.0):
    """按能量找出连续发声段 [(t0, t1)]，短于 min_gap 的间隙视为同一句。"""
    thr = max(abs_db, float(np.percentile(db, 95)) - rel_db)
    idx = np.where(db > thr)[0]
    if idx.size == 0:
        return []
    runs, start, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if (i - prev) * hop_sec > min_gap:
            runs.append((start * hop_sec, (prev + 1) * hop_sec))
            start = i
        prev = i
    runs.append((start * hop_sec, (prev + 1) * hop_sec))
    return runs


def split_long(t0: float, t1: float, db: np.ndarray, hop_sec: float, max_len: float):
    """把过长的段切成若干份，切点选在局部能量最低处（尽量不切在字中间）。"""
    span = t1 - t0
    k = max(1, int(math.ceil(span / max_len)))
    if k == 1:
        return [(t0, t1)]
    cuts = [t0]
    for i in range(1, k):
        ideal = t0 + span * i / k
        lo = max(t0, ideal - 0.4)
        hi = min(t1, ideal + 0.4)
        a, b = int(lo / hop_sec), int(hi / hop_sec)
        if b > a + 1:
            seg = db[a:b]
            best = a + int(np.argmin(seg))
            cuts.append(best * hop_sec)
        else:
            cuts.append(ideal)
    cuts.append(t1)
    return [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]


def adaptive_segments(y: np.ndarray, sr: int, min_len=MIN_LEN, max_len=MAX_LEN):
    """自适应切片：按静音找乐句，太短合并、太长再切。返回 [(t0, t1)]。"""
    db, hop_sec = frame_db(y, sr)
    runs = voiced_runs(db, hop_sec)
    if not runs:
        return []

    # 先合并过短的段（把 < min_len 的并进后一段，间隔放宽容忍 0.6 秒）
    merged = []
    for r in runs:
        if merged:
            gap = r[0] - merged[-1][1]
            length = merged[-1][1] - merged[-1][0]
            if length < min_len and gap < 0.6:
                merged[-1] = (merged[-1][0], r[1])
                continue
        merged.append(r)

    out = []
    for t0, t1 in merged:
        if t1 - t0 < min_len:
            continue  # 合并后还是太短，丢掉（会在质检里被记为 too_short）
        out.extend(split_long(t0, t1, db, hop_sec, max_len))
    return out


def f0_stats(y: np.ndarray, sr=16000):
    """返回 (中位 Hz, p90 Hz, 发声帧占比)。没装 pyworld 时返回 (0,0,0)，质检会放过。"""
    if pw is None or y.size < sr * 0.2:
        return 0.0, 0.0, 0.0
    y64 = np.ascontiguousarray(y.astype(np.float64))
    try:
        f0, t = pw.dio(y64, sr, frame_period=10.0)
        f0 = pw.stonemask(y64, f0, t, sr)
    except Exception:  # noqa: BLE001
        return 0.0, 0.0, 0.0
    v = f0[f0 > 0]
    if v.size == 0:
        return 0.0, 0.0, 0.0
    return float(np.median(v)), float(np.percentile(v, 90)), float(v.size / max(1, f0.size))


def band_of(f0: float, bands=BANDS) -> str:
    if f0 <= 0:
        return "unknown"
    for lo, hi, name in bands:
        if lo <= f0 < hi:
            return name
    return "unknown"


# ---------------------------------------------------------------- 主流程

def resample_to(y: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return y
    # 用 numpy 的多相重采样，避免为这一步引入 librosa 的额外开销
    from math import gcd
    g = gcd(int(sr), int(target))
    up, down = int(target // g), int(sr // g)
    try:
        from scipy.signal import resample_poly
        return resample_poly(y, up, down).astype(np.float32)
    except Exception:  # noqa: BLE001
        # 没有 scipy 就线性插值，质量差一点但不至于失败
        n = int(round(y.size * target / sr))
        xp = np.linspace(0, 1, y.size, endpoint=False)
        x = np.linspace(0, 1, n, endpoint=False)
        return np.interp(x, xp, y).astype(np.float32)


def build(sources, out_dir, params, progress, cancel) -> dict:
    """
    跑完整个数据准备。sources 是 scan() 的结果（或子集），out_dir 是任务目录。
    params 可含：sliceMode(auto|fixed), targetLen, minLen, maxLen, minVoiced, skipSeparate
    """
    out = Path(out_dir)
    (out / "slices").mkdir(parents=True, exist_ok=True)
    (out / "sep").mkdir(parents=True, exist_ok=True)

    mode = str(params.get("sliceMode") or "auto")
    target_len = float(params.get("targetLen") or 3.7)
    min_len = float(params.get("minLen") or MIN_LEN)
    max_len = target_len if mode == "fixed" else float(params.get("maxLen") or MAX_LEN)
    min_voiced = float(params.get("minVoiced") or 0.25)
    skip_sep = bool(params.get("skipSeparate", False))

    usable = [s for s in sources if not s.get("error")]
    if not usable:
        raise RuntimeError("没有可用的音频文件")
    if pw is None:
        # 不能静默降级：F0 全填 0 会让音域分档全部变成 unknown，权重功能形同虚设，
        # 但界面上看起来"跑完了"，用户会以为数据正常。
        raise RuntimeError("缺 pyworld（音域分析要用）。在「安装与运行时」页点「重装」补上，"
                           "或手动 pip install pyworld")

    t_start = time.time()
    records, src_meta = [], []
    n = len(usable)

    for i, s in enumerate(usable):
        if cancel.is_set():
            raise RuntimeError("已取消")
        src_path = Path(s["path"])
        label = s["name"]
        progress(0.02 + 0.5 * (i / n), f"分离 {i + 1}/{n}：{label[:28]}")

        need_sep = not skip_sep and not s.get("dry", False)
        vocal_wav = src_path
        sep_dir = out / "sep" / f"{i:02d}"
        if need_sep:
            try:
                from separate import separate_file
                vpath, _ipath, _sr = separate_file(str(src_path), str(sep_dir), device="auto", quiet=True)
                vocal_wav = Path(vpath)
                log(f"分离完成：{label} → {vpath}")
            except Exception as e:  # noqa: BLE001
                # 不退回原文件：混音里伴奏会被当成"人声"切进去，训出来的模型会把钢琴当元音。
                # 宁可在这一步停下来告诉她缺什么。
                raise RuntimeError(f"分离失败（{label}）：{e}。检查运行时里有没有 demucs") from e

        src_meta.append({
            "index": i,
            "path": str(src_path),
            "name": label,
            "duration": s.get("duration", 0),
            "separated": need_sep,
            "vocalFile": str(vocal_wav),
        })

        # 解码成 16k 单声道做分析（切片时再按 40k 重读，保证音质）
        y16 = load_mono(vocal_wav, 16000)
        if y16.size == 0:
            log(f"空文件，跳过：{label}")
            continue

        segs = (adaptive_segments(y16, 16000, min_len=min_len, max_len=max_len) if mode == "auto"
                else fixed_segments(y16, 16000, target_len))
        if not segs:
            log(f"没找到有效人声段：{label}")
            continue

        # 40k 版本用于写盘，按时间片取（与 16k 分析结果对齐）
        y40 = load_mono(vocal_wav, OUT_SR)
        ratio = OUT_SR / 16000

        for j, (t0, t1) in enumerate(segs):
            if cancel.is_set():
                raise RuntimeError("已取消")
            p0 = max(0, int(t0 * 16000))
            p1 = min(y16.size, int(t1 * 16000))
            if p1 - p0 < 16000 * 0.5:
                continue
            seg16 = y16[p0:p1]
            f0_med, f0_p90, vratio = f0_stats(seg16, 16000)
            dur = (p1 - p0) / 16000

            q0 = max(0, int(t0 * ratio))
            q1 = min(y40.size, int(t1 * ratio))
            seg40 = y40[q0:q1]
            if seg40.size == 0:
                continue

            peak = float(np.abs(seg40).max()) if seg40.size else 0.0
            clip = float((np.abs(seg40) > 0.999).mean()) if seg40.size else 0.0

            drop = None
            if dur < min_len:
                drop = "too_short"
            elif vratio and vratio < min_voiced:
                drop = "too_quiet"
            elif clip > 0.002:
                drop = "clipped"
            elif f0_med and (f0_med < 70 or f0_med > 1200):
                drop = "f0_outlier"

            name = f"{i:02d}_{j:03d}.wav"
            rel = f"slices/{name}"
            if drop is None:
                sf.write(str(out / rel), seg40, OUT_SR, subtype="PCM_24")

            records.append({
                "file": rel,
                "source": label,
                "sourceIndex": i,
                "start": round(t0, 3),
                "dur": round(dur, 3),
                "f0_median": round(f0_med, 1),
                "f0_p90": round(f0_p90, 1),
                "voiced": round(vratio, 3),
                "peak": round(peak, 4),
                "band": band_of(f0_med),
                "kept": drop is None,
                "drop": drop,
            })

        progress(0.02 + 0.5 * ((i + 1) / n), f"已处理 {i + 1}/{n}：{label[:28]}")

    progress(0.55, "统计音域分布")
    kept = [r for r in records if r["kept"]]
    bands = {}
    for r in kept:
        bands[r["band"]] = bands.get(r["band"], 0) + 1
    drops = {}
    for r in records:
        if not r["kept"]:
            drops[r["drop"]] = drops.get(r["drop"], 0) + 1

    manifest = {
        "version": 1,
        "createdAt": int(time.time() * 1000),
        "sr": OUT_SR,
        "params": {
            "sliceMode": mode, "targetLen": target_len,
            "minLen": min_len, "maxLen": max_len,
            "minVoiced": min_voiced, "skipSeparate": skip_sep,
        },
        "bands": [{"id": b[2], "min": b[0], "max": b[1]} for b in BANDS],
        "sources": src_meta,
        "slices": records,
        "stats": {
            "sources": len(src_meta),
            "slices": len(records),
            "kept": len(kept),
            "dropped": len(records) - len(kept),
            "seconds": round(sum(r["dur"] for r in kept), 1),
            "droppedByReason": drops,
            "byBand": bands,
            "elapsedSec": round(time.time() - t_start, 1),
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    progress(1.0, f"完成：{len(kept)} 片 / {manifest['stats']['seconds'] / 60:.1f} 分钟")
    log(f"完成 {out}：{len(kept)} 片，丢弃 {len(records) - len(kept)}，"
        f"用时 {manifest['stats']['elapsedSec']}s")
    return {
        "dir": str(out),
        "manifest": str(out / "manifest.json"),
        "stats": manifest["stats"],
        "bands": manifest["bands"],
        "bandLabels": {"low": "<280", "mid": "280-400", "high": "400-520", "top": ">520", "unknown": "未定"},
    }


def fixed_segments(y: np.ndarray, sr: int, target_len: float):
    """固定长度切片（用户选了 fixed 模式）：仍然跳过纯静音的部分。"""
    db, hop_sec = frame_db(y, sr)
    runs = voiced_runs(db, hop_sec)
    if not runs:
        return []
    total_end = runs[-1][1]
    out, t = [], 0.0
    while t < total_end - 0.5:
        end = min(t + target_len, total_end)
        a, b = int(t / hop_sec), int(end / hop_sec)
        if b > a and float((db[a:b] > max(-45.0, float(np.percentile(db, 95)) - 28.0)).mean()) > 0.15:
            out.append((t, end))
        t = end
    return out
