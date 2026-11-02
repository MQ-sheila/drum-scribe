const assert = require('node:assert/strict');
const core = require('../core.js');

function row(measure, id, sequenceIndex = 0) {
  return {
    measureNumber: measure,
    sequenceIndex,
    signature: [id, id, id, id, id, id],
    canvas: { width: 1000, height: 180 },
    quality: { score: .5 + id / 100 },
  };
}

// A row touching a source edge is held for review; a row with room above and
// below is exportable.
const complete = core.candidateCompleteness({ lines: [40, 50, 60, 70, 80], spacing: 10, supported: 5 }, 180, null, null);
assert.equal(complete.status, 'complete');
assert.ok(complete.completeness > .8);
assert.equal(core.candidateCompleteness({ lines: [2, 12, 22, 32, 42], spacing: 10, supported: 5 }, 180, null, null).status, 'top-partial');
assert.equal(core.candidateCompleteness({ lines: [130, 140, 150, 160, 170], spacing: 10, supported: 5 }, 180, null, null).status, 'bottom-partial');

// Variable scroll distances: one frame overlaps one row, another overlaps
// three rows. Both must join without duplicating the overlap.
const merged = core.mergeRowSequences([
  { rows: [row(1, 1), row(5, 5), row(9, 9)] },
  { rows: [row(9, 9), row(13, 13)] },
  { rows: [row(13, 13), row(17, 17), row(21, 21)] },
], { threshold: .2 });
assert.deepEqual(merged.rows.map((item) => item.measureNumber), [1, 5, 9, 13, 17, 21]);
assert.equal(merged.warnings.length, 0);

// No overlap is appended in time order and surfaced for the user to inspect.
const gap = core.mergeRowSequences([{ rows: [row(1, 1)] }, { rows: [row(40, 40)] }], { threshold: .2 });
assert.deepEqual(gap.rows.map((item) => item.measureNumber), [1, 40]);
assert.equal(gap.warnings[0].type, 'gap');

// Signature matching is structural and remains usable with color-neutral
// array signatures; equal measure numbers help when two drum patterns look alike.
const deduped = core.dedupeRows([row(17, 17), row(17, 18), row(21, 21)], { threshold: .2 });
assert.equal(deduped.rows.length, 2);
assert.equal(deduped.duplicates.length, 1);

// Content-driven pagination accepts rows of different heights and balances a
// short final page when the preceding page has room.
const pages = core.paginateRows([
  { canvas: { width: 1000, height: 170 } },
  { canvas: { width: 1000, height: 210 } },
  { canvas: { width: 1000, height: 150 } },
  { canvas: { width: 1000, height: 190 } },
  { canvas: { width: 1000, height: 220 } },
], { pageWidth: 800, pageHeight: 800, marginX: 40, marginY: 40, header: 30, footer: 30, rowGap: 12, maxRowHeight: 250 });
assert.ok(pages.length >= 1);
assert.equal(pages.flatMap((page) => page.items).length, 5);
assert.ok(pages.every((page) => page.items.every((item) => item.y >= page.contentTop && item.y + item.height <= page.contentBottom + 1)));

// The row-gap control is an exact layout value; pages must not silently
// stretch a smaller requested gap to fill the sheet.
const exactGapRows = [
  { canvas: { width: 1000, height: 100 } },
  { canvas: { width: 1000, height: 100 } },
  { canvas: { width: 1000, height: 100 } },
];
const compactGapPage = core.paginateRows(exactGapRows, {
  pageWidth: 800, pageHeight: 1200, marginX: 40, marginY: 40,
  header: 30, footer: 30, rowGap: 12, maxRowHeight: 250,
})[0];
assert.equal(
  compactGapPage.items[1].y - compactGapPage.items[0].y - compactGapPage.items[0].height,
  12
);
const wideGapPage = core.paginateRows(exactGapRows, {
  pageWidth: 800, pageHeight: 1200, marginX: 40, marginY: 40,
  header: 30, footer: 30, rowGap: 80, maxRowHeight: 250,
})[0];
assert.equal(
  wideGapPage.items[1].y - wideGapPage.items[0].y - wideGapPage.items[0].height,
  80
);

const markedPage = core.paginateRows([
  { sectionMarker: 'B', canvas: { width: 1000, height: 100 } },
  { canvas: { width: 1000, height: 100 } },
], {
  pageWidth: 800, pageHeight: 1200, marginX: 40, marginY: 40,
  header: 30, footer: 30, rowGap: 18, maxRowHeight: 250,
})[0];
assert.equal(markedPage.items[0].markerSpace, 42, '段落标识必须预留独立的上方空间');
assert.ok(markedPage.items[0].y >= markedPage.contentTop + 42, '段落标识不得覆盖谱行');
assert.equal(
  markedPage.items[1].y - markedPage.items[0].y - markedPage.items[0].height,
  18,
  '下一行与已标注行之间仍应保持用户设置的行距'
);

const composedCrop = core.composeNormalizedCrop(
  { x: .1, y: .2, width: .8, height: .6 },
  { x: .25, y: .1, width: .5, height: .5 }
);
assert.deepEqual(composedCrop, { x: .30000000000000004, y: .26, width: .4, height: .3 },
  'successive free crops must compose against the original row image');

const baselineCrop = core.resolveRowCropBounds(1000, 2, 6, { top: 200, bottom: 600 });
assert.deepEqual(
  { top: baselineCrop.top, bottom: baselineCrop.bottom },
  { top: 208, bottom: 576 },
  '相对 0% 必须应用已验证的上 2%、下 6% 基础裁切'
);
const recoveredCrop = core.resolveRowCropBounds(1000, -18, -14, { top: 200, bottom: 600 });
assert.deepEqual(
  { top: recoveredCrop.top, bottom: recoveredCrop.bottom },
  { top: 128, bottom: 656 },
  '相对 -20% 必须从完整原帧恢复基础窗口之外的内容'
);
const inwardCrop = core.resolveRowCropBounds(1000, 22, 26, { top: 200, bottom: 600 });
assert.deepEqual(
  { top: inwardCrop.top, bottom: inwardCrop.bottom },
  { top: 288, bottom: 496 },
  '相对 +20% 必须在基础裁切上继续向内裁切'
);

// Explicit single mode and auto-detected one-row frames both use chronological
// ordering; a real multi-row frame keeps measure-number processing enabled.
assert.equal(core.isSingleLineCapture('single', []), true);
assert.equal(core.isSingleLineCapture('auto', [
  { rows: [row(null, 1)] },
  { rows: [row(null, 2)] },
  { rows: [row(null, 3)] },
]), true);
assert.equal(core.isSingleLineCapture('auto', [
  { rows: [row(null, 1), row(null, 2)] },
]), false);

// A tight single-line crop naturally touches both vertical edges. It must be
// treated as a complete, included row instead of being excluded as a partial.
const tightSingle = { status: 'both-partial', completeness: 0.52 };
assert.deepEqual(
  core.normalizeReviewState(tightSingle, { singleCapture: true, minCompleteness: 0.62 }),
  { status: 'complete', completeness: 0.96, included: true }
);
assert.equal(
  core.normalizeReviewState(tightSingle, { singleCapture: false, minCompleteness: 0.62 }).included,
  false
);
assert.equal(
  core.normalizeReviewState({ ...tightSingle, included: false }, { singleCapture: true }).included,
  false,
  'a manual exclusion must stay excluded'
);

console.log('DrumScope core tests passed');
