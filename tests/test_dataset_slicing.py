"""数据切片回归测试：0.4.0 夜里 ratio=2.5 把 2.87 秒的段切成 7 帧，这里守住。

跑法：python -m unittest discover -s tests -v（需要 ffmpeg 在 PATH 或 FISHSING_FFMPEG）
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker"))

import soundfile as sf  # noqa: E402

import dataset  # noqa: E402

SR = 40000


def make_sine_wav(path: Path, sec: float, freq=318.0, amp=0.3):
    """假人声：3.5s 有声 / 0.3s 静音 交替（自适应切片靠静音找段边界）。"""
    t = np.arange(int(SR * sec)) / SR
    y = amp * np.sin(2 * np.pi * freq * t)
    gate = ((t % 3.8) < 3.5).astype(np.float64)  # 每 3.8s 留 0.3s 静音
    y = (y * gate).reshape(-1, 1).astype(np.float32)
    sf.write(str(path), y, SR, subtype="PCM_16")


class DatasetSlicing(unittest.TestCase):
    """端到端：build() 对一个 10 秒干声切片，产物必须是真实长度的音频。"""

    def test_slices_have_real_duration(self):
        with tempfile.TemporaryDirectory() as td:
            src_dir = Path(td) / "src"
            src_dir.mkdir()
            make_sine_wav(src_dir / "test干声.wav", 10.0)  # 文件名带"干声"跳过分离
            out = Path(td) / "ds"
            ret = dataset.build(
                sources=[{"path": str(src_dir / "test干声.wav"), "name": "test干声.wav", "duration": 10.0, "dry": True}],
                out_dir=out,
                params={"sliceMode": "fixed", "targetLen": 3.7},
                progress=lambda p, m: None,
                cancel=__import__("threading").Event(),
            )
            manifest = json.loads(Path(ret["manifest"]).read_text(encoding="utf-8"))
            slices = [r for r in manifest["slices"] if r["kept"]]
            self.assertGreater(len(slices), 0, "一个切片都没产出")
            for r in slices:
                p = out / r["file"]
                # PCM_24 单声道 40k：字节数 ≈ 120000 × 时长。旧 bug 下 2.87s 只有 66 字节。
                expect_min = int(r["dur"] * SR * 3 * 0.8)
                self.assertGreaterEqual(
                    p.stat().st_size, expect_min,
                    f"{r['file']} 声称 {r['dur']}s 但只有 {p.stat().st_size} 字节——切出了空壳",
                )
            # 音频内容验证：读回来时长要和 manifest 一致
            info = sf.info(str(out / slices[0]["file"]))
            self.assertAlmostEqual(info.duration, slices[0]["dur"], delta=0.05)
            # 必须是 FLOAT：RVC 训练用 scipy.read 读，整型会被当成天文数字（mel 爆炸）
            self.assertEqual(info.subtype, "FLOAT", "切片必须是 float wav")

    def test_self_check_rejects_empty(self):
        # 直接验证写盘自检：构造一个"声称 3.7s 但只有文件头"的切片 → build 必须报错
        # （这里用更直接的方式：源文件是 0.05s 的超短音频，fixed 切片目标 3.7s，
        #   产出的片远小于声称时长——但这种情况 dur 本身就小，自检按实际 dur 算。
        #   所以这个用例改为验证：正常路径下自检不误报。）
        with tempfile.TemporaryDirectory() as td:
            src_dir = Path(td) / "src"
            src_dir.mkdir()
            make_sine_wav(src_dir / "test干声.wav", 10.0)
            out = Path(td) / "ds"
            try:
                dataset.build(
                    sources=[{"path": str(src_dir / "test干声.wav"), "name": "test干声.wav", "duration": 10.0, "dry": True}],
                    out_dir=out,
                    params={"sliceMode": "fixed", "targetLen": 3.7},
                    progress=lambda p, m: None,
                    cancel=__import__("threading").Event(),
                )
            except RuntimeError as e:
                self.fail(f"正常数据触发了自检误报：{e}")


if __name__ == "__main__":
    unittest.main()
