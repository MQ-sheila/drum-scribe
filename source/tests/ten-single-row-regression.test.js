const assert = require('node:assert/strict');

const core = require('../core-engine.js');
global.window = { DrumScopeCore: core };
require('../core-conservative.js');

function signature(seed) {
  const bits = new Uint8Array(96 * 32);
  for (let index = 0; index < bits.length; index += 1) {
    bits[index] = ((index + seed * 7) % 19) < 7 ? 1 : 0;
  }
  const rows = new Uint8Array(32);
  const columns = new Uint8Array(96);
  for (let y = 0; y < 32; y += 1) for (let x = 0; x < 96; x += 1) {
    const value = bits[y * 96 + x];
    rows[y] += value;
    columns[x] += value;
  }
  return { bits, rows, columns, width: 96, height: 32 };
}

const rows = Array.from({ length: 10 }, (_, index) => ({
  signature: signature(index + 1),
  sequenceIndex: index,
  sequenceRowIndex: 0,
  measureNumber: null,
  canvas: { width: 1100, height: 184 },
  quality: { score: .8 },
}));

const nearestDistinct = Math.min(...rows.flatMap((row, index) => rows
  .slice(index + 1)
  .map((other) => core.signatureDistance(row.signature, other.signature))));
assert.ok(nearestDistinct > .052, 'fixtures must remain outside the conservative equality threshold');

const result = core.dedupeRows(rows, { strength: .72 });
assert.equal(result.rows.length, 10, 'ten distinct single-row screenshots must survive dedupe');
assert.equal(result.duplicates.length, 0);

console.log('Ten single-row dedupe regression tests passed');
