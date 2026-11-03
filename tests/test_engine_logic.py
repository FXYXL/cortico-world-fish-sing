"""引擎侧纯逻辑测试（需要 numpy + soundfile；torch/librosa 不需要）。

跑法：python -m unittest discover -s tests -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker"))

# RVC_ROOT 探测链在 import 时求值：指向一个确定的空目录，别让测试落到开发机的旧路径
_TMP = tempfile.mkdtemp(prefix="fishsing-test-")
os.environ["FISHSING_RVC_ROOT"] = _TMP

import numpy as np  # noqa: E402
import engine  # noqa: E402

SR = 40000


class SuggestPitch(unittest.TestCase):
    def setUp(self):
        self.model = {"p5": 313.0, "median": 356.0, "p95": 477.0}

    def test_female_source_stays_zero(self):
        # 源曲低音比模型数据下限低 7.9 半音——在 8 半音容忍范围内，不移调
        s = engine.SingEngine.suggest_pitch({"p5": 198.0}, self.model)
        self.assertEqual(s["pitch"], 0)

    def test_male_source_capped_plus6(self):
        s = engine.SingEngine.suggest_pitch({"p5": 120.0}, self.model)
        self.assertEqual(s["pitch"], 6)
        self.assertIn("男声", s["reason"])

    def test_moderate_male(self):
        # 差 12.75 半音 → ceil(12.75-8)=5
        s = engine.SingEngine.suggest_pitch({"p5": 150.0}, self.model)
        self.assertEqual(s["pitch"], 5)

    def test_way_higher_capped_minus3(self):
        s = engine.SingEngine.suggest_pitch({"p5": 700.0}, self.model)
        self.assertEqual(s["pitch"], -3)

    def test_missing_data_zero(self):
        self.assertEqual(engine.SingEngine.suggest_pitch(None, self.model)["pitch"], 0)
        self.assertEqual(engine.SingEngine.suggest_pitch({"p5": 200}, None)["pitch"], 0)


class ResolveRvcRoot(unittest.TestCase):
    def test_env_wins(self):
        os.environ["FISHSING_RVC_ROOT"] = str(Path(_TMP) / "custom")
        try:
            self.assertEqual(str(engine._resolve_rvc_root()), str(Path(_TMP) / "custom"))
        finally:
            os.environ["FISHSING_RVC_ROOT"] = _TMP

    def test_fallback_workdir_sibling(self):
        os.environ.pop("FISHSING_RVC_ROOT", None)
        work = Path(_TMP) / "data" / "fish-sing" / "work"
        rvc = Path(_TMP) / "data" / "fish-sing" / "runtime" / "rvc"
        (rvc / "assets" / "weights").mkdir(parents=True, exist_ok=True)
        os.environ["FISHSING_WORK"] = str(work)
        try:
            self.assertEqual(engine._resolve_rvc_root(), rvc)
        finally:
            os.environ.pop("FISHSING_WORK", None)


class SmoothSeams(unittest.TestCase):
    @staticmethod
    def sine(freq, sec, amp=0.3, phase=0.0):
        t = np.arange(int(SR * sec)) / SR
        return (amp * np.sin(2 * np.pi * freq * t + phase)).reshape(-1, 1).astype(np.float32)

    def test_click_removed(self):
        # 两段同频正弦，第二段开头有 0.5 的台阶——硬拼会咔哒一声
        a = self.sine(440, 1.0)
        b = self.sine(440, 1.0) + np.float32(0.5)
        raw_jump = abs(float(a[-1, 0]) - float(b[0, 0]))
        self.assertGreater(raw_jump, 0.1)  # 确实有跳变
        out = engine.SingEngine._smooth_seams([a.copy(), b.copy()], SR)
        n = int(SR * 0.05)
        seam = out[0][-n:]  # 交叉淡化区
        d = np.abs(np.diff(seam[:, 0]))
        # 0.5 的台阶被摊到 2000 个样本上，逐样本差应只剩正弦斜率量级
        self.assertLess(float(np.max(d)), 0.05)

    def test_dynamics_preserved(self):
        # 安静主歌 vs 炸副歌的响度差是音乐动态，不许被拉平
        # （接缝淡化会把少量响侧能量混进静侧尾部，比值略降是正常物理，不许趋近 1）
        quiet = self.sine(440, 1.0, amp=0.02)
        loud = self.sine(220, 1.0, amp=0.30)
        out = engine.SingEngine._smooth_seams([quiet.copy(), loud.copy()], SR)
        r = [float(np.sqrt(np.mean(p.astype(np.float64) ** 2))) for p in out]
        self.assertGreater(r[1] / max(r[0], 1e-9), 5.0)  # 响度差还在（完全拉平会是 ~1）

    def test_lengths_preserved(self):
        # 接缝处理**必须不改时长**：0.4.0 的重叠交叉淡化每条缝吃掉 50ms，
        # 4 分半的歌人声就比伴奏快 200ms（用户实测越唱越不合拍）。
        a = self.sine(440, 2.0)
        b = self.sine(440, 2.0)
        c = self.sine(440, 2.0)
        out = engine.SingEngine._smooth_seams([a, b, c], SR)
        for i in range(3):
            self.assertEqual(out[i].shape[0], 2 * SR, f'第 {i} 片长度被改了')
        self.assertEqual(sum(p.shape[0] for p in out), 6 * SR)

    def test_single_piece_untouched(self):
        a = self.sine(440, 1.0)
        out = engine.SingEngine._smooth_seams([a.copy()], SR)
        self.assertTrue(np.array_equal(out[0], a))


class AugmentWeightExpansion(unittest.TestCase):
    """trainer 的同名逻辑在这里再验一遍口径（两处共用命名约定）。"""

    def test_naming_matches_trainer(self):
        import trainer
        w = {"slice001.wav": 3.0}
        e = trainer.expand_aug_weights(w, [-2, -4])
        # 增强副本文件名（prepare 生成）必须能被权重表覆盖
        for shift in (-2, -4):
            self.assertIn(f"aug{shift}_slice001.wav", e)


    def test_pitch_shift_filter_keeps_ratio(self):
        # 变调滤镜：asetrate 的倍率必须等于 2^(n/12)，atempo 必须是它的倒数（保时长）
        import re as _re
        for semi in (6, -5, 3):
            flt = engine.SingEngine.pitch_shift_filter(44100, semi)
            m = _re.search(r'asetrate=(\d+)', flt)
            t = _re.search(r'atempo=([\d.]+)', flt)
            self.assertIsNotNone(m, flt)
            ratio = int(m.group(1)) / 44100
            self.assertAlmostEqual(ratio, 2 ** (semi / 12), places=3)
            self.assertAlmostEqual(float(t.group(1)), 1 / ratio, places=3)

if __name__ == "__main__":
    unittest.main()
