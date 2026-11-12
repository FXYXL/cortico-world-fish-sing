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

    def test_rms_mix_default_follows_source(self):
        # rms_mix_rate=0 才等于"音量跟随原唱"；1 在 RVC 里是"不做对齐"（轻唱会被唱满）。
        # 老版本默认 1.0 导致所有翻唱的渐弱消失，这里钉住默认值，别再改回去。
        import inspect
        for fn in (engine.SingEngine.convert, engine.SingEngine.song):
            sig = inspect.signature(fn)
            self.assertIn('rms_mix_rate', sig.parameters, f'{fn.__name__} 少了 rms_mix_rate')
            self.assertEqual(sig.parameters['rms_mix_rate'].default, 0.0, f'{fn.__name__} 默认值应为 0.0')

    def test_manifest_marks_optional_default_model(self):
        # 出厂默认模型（dfy2 + 它的索引）是可选示例：用户换模型后删掉很常见，
        # 不能因为缺它就把自检显示成"未就绪"。必需组件只有 hubert/rmvpe/两个底模。
        import json, pathlib
        m = json.loads(pathlib.Path('assets/models.manifest.json').read_text(encoding='utf-8'))
        req = [f['target'] for f in m['files'] if f.get('required') is not False]
        opt = [f['target'] for f in m['files'] if f.get('required') is False]
        self.assertEqual(len(req), 4, f'必需组件应为 4 个，实际 {req}')
        self.assertTrue(any('hubert' in t for t in req))
        self.assertTrue(any('rmvpe' in t for t in req))
        self.assertTrue(any('f0G40k' in t for t in req))
        self.assertTrue(any('f0D40k' in t for t in req))
        self.assertEqual(len(opt), 2, f'可选应为 dfy2 模型+索引两项，实际 {opt}')

    def test_looks_dry_ignores_directory_names(self):
        # 用户把素材放在「大肥鱼伴奏+人声-某某」这种目录下时，目录名带「人声」，
        # 老实现用 str(path) 整串匹配，会把整个文件夹都判成干声——实测误判过：
        # …\带伴奏\团子大家族.aac 其实是完整混音（伴奏比人声响 1.2 倍），却跳过分离。
        import sys, pathlib
        sys.path.insert(0, str(pathlib.Path('worker').resolve()))
        from dataset import looks_dry
        self.assertFalse(looks_dry(r'D://AI//大肥鱼伴奏+人声-某某//带伴奏//团子大家族.aac'))
        self.assertTrue(looks_dry(r'D://AI//大肥鱼伴奏+人声-某某//干声//大肥鱼-暖暖-人声.wav'))
        self.assertFalse(looks_dry(r'D://music//song-伴奏.wav'))
        self.assertFalse(looks_dry(r'D://music//普通歌曲.mp3'))
        self.assertTrue(looks_dry(r'D://music//vocal_take.wav'))

    def test_dry_check_switchable(self):
        # 干声实测校验（切 8 秒做快分离）可以用环境变量关掉，避免慢机器上扫描太慢
        import os, sys, pathlib
        sys.path.insert(0, str(pathlib.Path('worker').resolve()))
        from dataset import _quick_vocal_ratio
        os.environ['FISHSING_SKIP_DRY_CHECK'] = '1'
        try:
            self.assertIsNone(_quick_vocal_ratio('whatever.wav'))
        finally:
            os.environ.pop('FISHSING_SKIP_DRY_CHECK', None)

    def test_song_accepts_harmony(self):
        # 和声堆叠：默认关（harmony=None），开了才多渲和声轨，别让不用的用户白白多等
        import inspect
        sig = inspect.signature(engine.SingEngine.song)
        self.assertIn('harmony', sig.parameters, 'song() 少了 harmony 参数')
        self.assertIsNone(sig.parameters['harmony'].default, 'harmony 默认应为 None（关闭）')

if __name__ == "__main__":
    unittest.main()
