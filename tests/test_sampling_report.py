"""直接执行仓库采样器，验证 FLOAT 分桶修正后的加权与报告（不加载模型）。"""
import ast
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import torch
except ImportError:  # CI 只装 numpy/soundfile/pyworld，没有 torch → 整个模块跳过
    torch = None

ROOT = Path(__file__).resolve().parent.parent
Sampler = None
if torch is not None:
    tree = ast.parse((ROOT / 'vendor/rvc/train/data_utils.py').read_text(encoding='utf8'))
    node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'DistributedBucketSampler')
    scope = {'torch': torch, 'os': os}
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'data_utils.py', 'exec'), scope)
    Sampler = scope['DistributedBucketSampler']


@unittest.skipIf(Sampler is None, '没装 torch（CI 环境），跳过采样器测试')
class SamplingReport(unittest.TestCase):
    def test_buckets_weights_and_report(self):
        class Dataset:
            lengths = [250, 250, 350, 350]
            audiopaths_and_text = [[f'{n}.wav'] for n in range(4)]
            def __len__(self):
                return 4
        with tempfile.TemporaryDirectory() as td:
            report = Path(td) / 'sampling.json'
            bands = Path(td) / 'bands.json'
            bands.write_text(json.dumps({'0.wav': 'low', '1.wav': 'mid', '2.wav': 'high', '3.wav': 'top'}))
            with patch.dict(os.environ, {'FISHSING_SAMPLING_REPORT': str(report), 'FISHSING_SAMPLE_BANDS': str(bands)}):
                sampler = Sampler(Dataset(), 2, [100, 200, 300, 400], num_replicas=1, rank=0)
                sampler.set_weights([1 / 3] * 4)
                self.assertIsNone(sampler.sample_weights)
                sampler.set_weights([100000, 0.000001, 1, 1])
                batches = list(sampler)
                self.assertEqual(len(batches), 2)
                self.assertEqual(sum(i == 0 for b in batches for i in b), 2)
                data = json.loads(report.read_text())
                self.assertEqual(sum(data['counts'].values()), 4)
                self.assertEqual(data['bands']['low'], 2)


if __name__ == '__main__':
    unittest.main()
