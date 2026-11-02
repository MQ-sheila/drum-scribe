const assert = require('node:assert/strict');
const core = require('../core-engine.js');
global.window = { DrumScopeCore: core };
require('../core-v04.js');
const lower = { canvas: { id: 'lower' }, baseCanvas: { id: 'lower-base' } };
const upper = { canvas: { id: 'upper' }, baseCanvas: { id: 'upper-base' } };
assert.equal(core.selectedCandidateIndex({ baseCanvas: upper.baseCanvas, selectedCandidateIndex: 0 }, [lower, upper]), 1,
  'the candidate selector must reflect the image currently on display');
assert.equal(core.selectedCandidateIndex({ baseCanvas: lower.baseCanvas, selectedCandidateIndex: 1 }, [lower, upper]), 0,
  'manual selection must reflect the selected canvas');
const protectedBounds = core.staffRowSourceBounds([
  { bandTop: 120, bandBottom: 160, spacing: 10 },
  { bandTop: 300, bandBottom: 340, spacing: 10 },
], 500);
assert.deepEqual(protectedBounds, [
  { top: 20, bottom: 230 },
  { top: 230, bottom: 410 },
], 'row extraction must preserve distant tempo and tuplet marks without including the neighbouring staff');
const nonShrinkingBounds = core.staffRowSourceBounds([
  { bandTop: 100, bandBottom: 140, spacing: 10 },
  { bandTop: 170, bandBottom: 210, spacing: 10 },
], 320, [
  { top: 32, bottom: 188 },
  { top: 102, bottom: 258 },
]);
assert.deepEqual(nonShrinkingBounds, [
  { top: 0, bottom: 188 },
  { top: 102, bottom: 280 },
], 'annotation recovery may only expand the established row crop, never shrink it');
const layoutRow = [{ canvas: { width: 960, height: 120 } }];
const layoutWidth = (scoreScale) => core.paginateRows(layoutRow, { scoreScale })[0].items[0].width;
assert.ok(layoutWidth(0.7) < layoutWidth(1), 'the lower half of the size slider must shrink the score');
assert.ok(layoutWidth(1.25) > layoutWidth(1.16), 'the extended slider must visibly enlarge the score past 116%');
assert.ok(layoutWidth(1.25) <= 1240, 'the enlarged score must still fit the A4 page');
console.log('Candidate selection regression passed');
