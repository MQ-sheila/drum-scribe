const assert = require('node:assert/strict');

global.window = { DrumScopeCore: require('../core-engine.js') };
require('../core-v04.js');
const core = window.DrumScopeCore;

const row = (absoluteY, id, status = 'complete', cursorPenalty = 0) => ({
  id,
  status,
  sourceBounds: { top: absoluteY - 41, bottom: absoluteY + 53 },
  staffTop: 41,
  staffSpacing: 6,
  quality: { cursorPenalty },
});

const scroll = [
  { rows: [row(214, 'first-bad', 'complete', 0.5), row(299, 'second'), row(384, 'third'), row(469, 'partial', 'bottom-partial')] },
  { rows: [row(156, 'first-good'), row(241, 'second'), row(326, 'third'), row(411, 'fourth')] },
  { rows: [row(99, 'first'), row(184, 'second'), row(269, 'third'), row(354, 'fourth'), row(439, 'fifth')] },
  { rows: [row(126, 'second'), row(211, 'third'), row(296, 'fourth'), row(381, 'fifth')] },
];
const merged = core.mergeScrollingSequences(scroll);
assert.ok(merged, 'detect consistently scrolling staff geometry');
assert.deepEqual(merged.scrollOffsets, [0, 58, 115, 173]);
assert.equal(merged.rows.length, 5, 'repeated captures of each staff become one row');
assert.equal(merged.rows[0].id, 'first-good', 'prefer a complete capture without playback cursor');
assert.equal(merged.rows[0].candidates.length >= 2, true, 'retain other captures for manual review');
assert.equal(merged.rows.every((item) => item.status === 'complete'), true);

const staticPages = [
  { rows: [row(120, 'a'), row(220, 'b'), row(320, 'c')] },
  { rows: [row(120, 'd'), row(220, 'e'), row(320, 'f')] },
  { rows: [row(120, 'g'), row(220, 'h'), row(320, 'i')] },
];
assert.equal(core.mergeScrollingSequences(staticPages), null,
  'page turns must retain the existing measure-number reconciliation path');

const stableRow = (y, id) => ({
  ...row(y, id),
  signature: 0,
  __v04Feature: { anchor: 0, high: 0, ink: 0 },
  __v04Fingerprint: {
    bits: new Uint8Array(64).fill(1), width: 8, height: 8, ink: 1, high: 1,
  },
});
const pausedThenSlowScroll = [
  { rows: [stableRow(120, 'a'), stableRow(220, 'b'), stableRow(320, 'c')] },
  { rows: [stableRow(120, 'a'), stableRow(220, 'b'), stableRow(320, 'c')] },
  { rows: [stableRow(111, 'a'), stableRow(211, 'b'), stableRow(311, 'c')] },
  { rows: [stableRow(92, 'a'), stableRow(192, 'b'), stableRow(292, 'c')] },
];
const mergedSlowScroll = core.mergeScrollingSequences(pausedThenSlowScroll);
assert.ok(mergedSlowScroll, 'a stationary frame and a 9px scroll must not abort geometry merging');
assert.deepEqual(mergedSlowScroll.scrollOffsets, [0, 0, 9, 28]);
assert.equal(mergedSlowScroll.rows.length, 3);

console.log('scroll geometry regression passed');
