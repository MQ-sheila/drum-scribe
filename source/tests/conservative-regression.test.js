const assert = require('node:assert/strict');

// The browser layer mutates the same core object. Providing a minimal window
// lets the conservative distance/merge logic run in Node without a Canvas.
const core = require('../core-engine.js');
global.window = { DrumScopeCore: core };
require('../core-conservative.js');

function structural(seed, flipCount = 0) {
  const bits = new Uint8Array(96 * 32);
  for (let index = 0; index < bits.length; index += 1) bits[index] = ((index + seed * 7) % 19) < 7 ? 1 : 0;
  for (let index = 0; index < flipCount; index += 1) bits[(seed * 31 + index * 97) % bits.length] ^= 1;
  const rows = new Uint8Array(32);
  const columns = new Uint8Array(96);
  for (let y = 0; y < 32; y += 1) for (let x = 0; x < 96; x += 1) {
    const value = bits[y * 96 + x];
    rows[y] += value;
    columns[x] += value;
  }
  return { bits, rows, columns, width: 96, height: 32 };
}

function row(signature, sequenceIndex, sequenceRowIndex, measureNumber = null) {
  return {
    signature,
    sequenceIndex,
    sequenceRowIndex,
    measureNumber,
    canvas: { width: 1100, height: 184 },
    quality: { score: .5 },
  };
}

// Different measures can have a similar drum shape. A large structural
// distance must remain two rows even when the old loose threshold was .2.
const first = row(structural(1), 0, 0, null);
const second = row(structural(2), 1, 0, null);
assert.ok(core.signatureDistance(first.signature, second.signature) > .052);
const conservative = core.dedupeRows([first, second], { strength: .72 });
assert.equal(conservative.rows.length, 2, 'different score rows must not be swallowed by dedupe');
assert.equal(conservative.duplicates.length, 0);

// Near-identical repeated captures are still merged, including when they
// cross a sequence boundary.
const repeatedA = row(structural(9), 0, 2, null);
const repeatedB = row(structural(9, 2), 1, 0, null);
assert.ok(core.signatureDistance(repeatedA.signature, repeatedB.signature) < .052);
assert.equal(core.dedupeRows([repeatedA, repeatedB]).rows.length, 1);

// Imported image files are intentional score units. Similar-looking adjacent
// files must each remain a sequence, while exact duplicates can still be
// removed later by the conservative row pass.
const imported = core.groupStableFrames(Array.from({ length: 10 }, (_, index) => ({
  name: `image${index}.png`,
  canvas: { width: 1100, height: 184 },
})), { threshold: .15 });
assert.equal(imported.length, 10);
assert.ok(imported.every((group) => group.items.length === 1));

// A reliable shared measure is useful evidence, but it cannot override a
// clearly different visual pattern.
const sameMeasureA = row(structural(5), 0, 0, 17);
sameMeasureA.measure = { value: 17, confidence: .95 };
const sameMeasureB = row(structural(6), 1, 0, 17);
sameMeasureB.measure = { value: 17, confidence: .95 };
assert.equal(core.dedupeRows([sameMeasureA, sameMeasureB]).rows.length, 2);

console.log('Conservative dedupe regression tests passed');
