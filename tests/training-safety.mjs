import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weightedRows, suggestTrainParams, validateEvaluation } from '../src/train.ts';

const sample = (dur, f0) => ({ kept: true, dur, f0_median: f0, f0_p90: f0 });
const cfg = { mode: 'median', bands: { low: 5, mid: 1, high: 1, top: 1 } };
// 不同桶的样本不能靠加权改变桶间比例。
let rows = weightedRows({ slices: [sample(2.5, 200), sample(3.5, 350)] }, cfg);
assert.equal(rows[0].after, 0.5);
assert.equal(rows[1].after, 0.5);
rows = weightedRows({ slices: [sample(2.5, 200), sample(2.5, 350)] }, cfg);
assert.equal(rows[0].after, 5 / 6);
assert.equal(suggestTrainParams(30 * 60).epochs, 70);
assert.equal(suggestTrainParams(5 * 60).epochs, 40);
const dir = mkdtempSync(join(tmpdir(), 'fish-eval-'));
try {
  const files = [0, 1, 2, 3].map(i => {
    const path = join(dir, `${i}.wav`);
    writeFileSync(path, `audio-${i}`);
    return path;
  });
  assert.equal(validateEvaluation(files.slice(0, 3), [files[3]]).length, 3);
  assert.throws(() => validateEvaluation(files.slice(0, 2), []));
  assert.throws(() => validateEvaluation([files[0], files[0], files[1]], []));
  assert.throws(() => validateEvaluation(files.slice(0, 3), [files[0]]));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('training safety checks passed');
