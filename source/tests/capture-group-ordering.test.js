const assert = require('node:assert/strict');
const order = require('../measure-order.js');
const rows = [0,1,2,3,4,5,6,7,8,9,10,11].map(index => ({ sequenceIndex: Math.floor(index / 4), sequenceRowIndex: index % 4 }));
const result = (candidates) => ({ candidates: candidates.map(([value,votes]) => ({ value,votes,confidence:votes * 5.5 })) });
const ocr = [
 result([[7,3]]), result([[5,6]]), result([[7,2]]), result([[13,18]]),
 result([[49,18],[65,15]]), result([[69,18],[53,12]]), result([[73,18],[57,15]]), result([[77,18],[61,18]]),
 result([[97,18]]), result([[101,18],[181,18]]), result([[105,18]]), result([[109,18]]),
];
const numbers = order.selectCaptureGroupMeasures(rows, ocr, 4).map(item => item?.value);
assert.deepEqual(numbers, [1,5,9,13,49,53,57,61,97,101,105,109]);
const row = { measureNumber:53, measureSource:'group-sequence', measureVotes:12 };
assert.equal(order.preferSelectedImageMeasure(row, result([[69,18]])),false);
assert.equal(row.measureNumber,53);
console.log('Capture group ordering regression passed');
