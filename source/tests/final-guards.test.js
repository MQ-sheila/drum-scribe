const assert = require('node:assert/strict');

const core = require('../core-engine.js');
global.window = { DrumScopeCore: core };
require('../core-conservative.js');
require('../core-final-guards.js');

const sharpPartial = { status: 'top-partial', completeness: .45, quality: { score: .99 } };
const softComplete = { status: 'complete', completeness: .91, quality: { score: .18 } };
assert.equal(core.chooseBestCandidate([sharpPartial, softComplete]), softComplete, '完整行必须优先于锐利残缺行');

const tenImportedGroups = core.groupStableFrames(Array.from({ length: 10 }, (_, index) => ({
  name: `image${index}.png`,
  canvas: { width: 1100, height: 184 },
})), { threshold: .15 });
assert.equal(tenImportedGroups.length, 10, '导入单行截图不能被稳定帧分组吞并');

// Capture frames use the calibrated conservative threshold. A .06 structural
// change is a different frame; an exact repeated frame still groups.
const repeated = core.groupStableFrames([
  { canvas: { width: 1, height: 1 }, timestamp: 0 },
  { canvas: { width: 1, height: 1 }, timestamp: 140 },
], { threshold: .15 });
assert.equal(repeated.length, 2, '无 Canvas 的纯逻辑输入不应伪造稳定相似度');

console.log('Final guard regression tests passed');
