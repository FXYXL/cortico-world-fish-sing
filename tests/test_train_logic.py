"""训练侧纯逻辑测试（无 GPU、无 ffmpeg 依赖）。跑法：python -m unittest discover -s tests -v"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker"))

import trainer  # noqa: E402


class ExpandAugWeights(unittest.TestCase):
    """低音增强副本的采样权重摊薄。"""

    def test_inherit_and_divide(self):
        w = {"a.wav": 3.0, "b.wav": 1.0}
        e = trainer.expand_aug_weights(w, [-2, -4])
        # 源片权重不变
        self.assertEqual(e["a.wav"], 3.0)
        self.assertEqual(e["b.wav"], 1.0)
        # 副本继承 ÷ (副本数 + 1)：3x 源 + 2 副本 → 各 1x
        self.assertAlmostEqual(e["aug-2_a.wav"], 1.0)
        self.assertAlmostEqual(e["aug-4_a.wav"], 1.0)
        self.assertAlmostEqual(e["aug-2_b.wav"], 1 / 3)
        self.assertAlmostEqual(e["aug-4_b.wav"], 1 / 3)

    def test_empty_cases(self):
        self.assertEqual(trainer.expand_aug_weights({}, [-2]), {})
        self.assertEqual(trainer.expand_aug_weights(None, [-2]), {})
        self.assertEqual(trainer.expand_aug_weights({"a.wav": 2.0}, []), {"a.wav": 2.0})

    def test_all_unit_weights_not_expanded(self):
        # 全 1x 源权重：不该造副本权重表（否则会写出全 0.333 的伪加权表）
        e = trainer.expand_aug_weights({"a.wav": 1.0}, [-2, -4])
        self.assertEqual(e, {"a.wav": 1.0})

    def test_zero_shift_ignored(self):
        # 0 半音不是有效副本：[-2] 只有 1 个副本 → 3x 源片摊薄为 3/2
        e = trainer.expand_aug_weights({"a.wav": 3.0}, [0, -2])
        self.assertNotIn("aug0_a.wav", e)
        self.assertAlmostEqual(e["aug-2_a.wav"], 1.5)


class BuildWeightsFile(unittest.TestCase):
    def test_writes_and_filters(self):
        with tempfile.TemporaryDirectory() as td:
            exp = Path(td)
            gt = exp / "0_gt_wavs"
            gt.mkdir()
            # 两个"完整"样本 + 一个缺特征的（特征 npy 用 stem，f0 npy 用全名）
            for name in ("x.wav", "y.wav"):
                (gt / name).write_bytes(b"RIFF")
                (exp / "3_feature768").mkdir(exist_ok=True)
                (exp / "3_feature768" / f"{name[:-4]}.npy").write_bytes(b"\x00")
                (exp / "2a_f0").mkdir(exist_ok=True)
                (exp / "2a_f0" / f"{name}.npy").write_bytes(b"\x00")
                (exp / "2b-f0nsf").mkdir(exist_ok=True)
                (exp / "2b-f0nsf" / f"{name}.npy").write_bytes(b"\x00")
            (gt / "broken.wav").write_bytes(b"RIFF")  # 没有对应特征
            n = trainer.write_filelist(exp)
            self.assertEqual(n, 2)
            rows = (exp / "filelist.txt").read_text(encoding="utf8").splitlines()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0].count("|"), 4)

            # 权重：全 1 → 不写文件；非 1 → 写入 json
            self.assertIsNone(trainer.build_weights_file(exp, {"x.wav": 1.0, "y.wav": 1.0}))
            wfile = trainer.build_weights_file(exp, {"x.wav": 3.0})
            self.assertIsNotNone(wfile)
            data = json.loads(wfile.read_text(encoding="utf8"))
            self.assertEqual(data, {"x.wav": 3.0})


class LogParsing(unittest.TestCase):
    def test_epoch_of(self):
        self.assertEqual(trainer._epoch_of("====> 轮次：42 loss=1.2"), 42)
        self.assertIsNone(trainer._epoch_of("没有轮次信息"))

    def test_loss_of(self):
        d = trainer._loss_of("loss_disc=1.5, loss_gen=2.5, loss_fm=0.3")
        self.assertEqual(d["loss_disc"], 1.5)
        self.assertEqual(d["loss_gen"], 2.5)
        self.assertIsNone(trainer._loss_of("无关日志"))


if __name__ == "__main__":
    unittest.main()
