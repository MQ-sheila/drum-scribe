const assert = require('node:assert/strict');
const core = require('../core.js');
const measures = require('../measure-order.js');

const ink = new Float32Array(250);
const white = new Float32Array(250);
const chroma = new Float32Array(250);
for (let y = 224; y <= 228; y += 1) {
  ink[y] = y === 226 ? .50 : .44;
  white[y] = .07;
  chroma[y] = .428;
}
const staffPeaks = [214, 220, 232, 238].map((y) => ({ y, support: .928, white: .07 }));
const recovered = core.recoverChromaticStaffPeaks(staffPeaks, ink, white, chroma);
assert.deepEqual(recovered.map((item) => item.y), [214, 220, 226, 232, 238],
  'blue playback highlight must not erase the unnumbered opening staff');
assert.equal(recovered[2].chromatic, true);
assert.equal(core.recoverChromaticStaffPeaks(staffPeaks, ink, white, new Float32Array(250)).length, 4,
  'do not invent a staff line without a coloured occlusion');

const partialCandidate = { status: 'top-partial', sourceBounds: { top: 0 }, quality: { score: .99 } };
const lowerCompleteCandidate = { status: 'complete', sourceBounds: { top: 140 }, quality: { score: .9 } };
const upperCompleteCandidate = { status: 'complete', sourceBounds: { top: 60 }, quality: { score: .2 } };
assert.equal(core.chooseBestCandidate([partialCandidate, lowerCompleteCandidate, upperCompleteCandidate]),
  upperCompleteCandidate, 'default image must be the highest complete capture');

const measure = (number, frame, confidence, source = 'ocr-consensus') => ({
  measureNumber: number, sourceFrameIndex: frame,
  measureConfidence: confidence, measureSource: source,
});
assert.equal(measures.sameMeasureNearbyDuplicate(measure(219, 149, 100), measure(219, 147, 100)), true);
assert.equal(measures.sameMeasureNearbyDuplicate(measure(29, 7, 38.9), measure(29, 4, 27.8)), true);
assert.equal(measures.sameMeasureNearbyDuplicate(measure(195, 135, 22.2), measure(195, 136, 27.8)), true);
assert.equal(measures.sameMeasureNearbyDuplicate(measure(29, 7, 38.9), measure(29, 2, 27.8)), false);
assert.equal(measures.sameMeasureNearbyDuplicate(measure(215, 145, 100), measure(215, 146, 100)), true);
assert.equal(measures.sameMeasureNearbyDuplicate(measure(203, 135, 72.2), measure(203, 148, 66.7)), true);
assert.equal(measures.sameMeasureNearbyDuplicate(measure(203, 134, 72.2), measure(203, 149, 44.4)), true);
assert.equal(measures.sameMeasureNearbyDuplicate(measure(21, 0, 88.9), measure(21, 141, 33.3)), false);
assert.equal(measures.sameMeasureNearbyDuplicate(measure(117, 122, 44.4), measure(117, 72, 55.6)), false);
assert.equal(measures.sameMeasureNearbyDuplicate(measure(219, 149, 100), measure(215, 147, 100)), false);
assert.equal(measures.sameMeasureNearbyDuplicate({ measureNumber: 219, measureConfidence: 100 }, measure(219, 147, 100)), false,
  'rows without a source frame must not merge solely by OCR number');
const truncatedHundreds = [
  { measureNumber: 137, measureConfidence: 83, sequenceIndex: 44 },
  { measureNumber: 14, measureConfidence: 61, sequenceIndex: 45, measureCandidates: [
    { value: 14, votes: 11, confidence: 61 }, { value: 141, votes: 5, confidence: 28 },
  ] },
  { measureNumber: 145, measureConfidence: 89, sequenceIndex: 46 },
];
assert.equal(measures.refineDigitAndNeighborAlternatives(truncatedHundreds), 1);
assert.equal(truncatedHundreds[1].measureNumber, 141);
const doNotDropHundreds = [
  { measureNumber: 207, measureConfidence: 50, sequenceIndex: 69, measureCandidates: [
    { value: 207, votes: 9, confidence: 50 }, { value: 7, votes: 5, confidence: 28 },
  ] },
  { measureNumber: 7, measureConfidence: 33, sequenceIndex: 70 },
];
assert.equal(measures.refineDigitAndNeighborAlternatives(doNotDropHundreds), 0);
assert.equal(doNotDropHundreds[0].measureNumber, 207);
const repeatedUnnumberedMeasure = [
  { measureNumber: 61, measureConfidence: 61.1 },
  { measureNumber: null, measureCandidates: [
    { value: 4, votes: 5, confidence: 27.8 },
    { value: 65, votes: 2, confidence: 11.1 },
  ] },
  { measureNumber: null, measureCandidates: [] },
  { measureNumber: 69, measureConfidence: 44.4 },
];
assert.equal(measures.refineBracketedMeasures(repeatedUnnumberedMeasure), 1);
assert.equal(repeatedUnnumberedMeasure[1].measureNumber, 65);
const finalRepeatedGap = [
  { measureNumber: 61, measureConfidence: 38.9 },
  { measureNumber: null, sourceFrameIndex: 41, sequenceIndex: 16, measureCandidates: [
    { value: 4, votes: 5 }, { value: 65, votes: 2 },
  ] },
  { measureNumber: null, sourceFrameIndex: 34, sequenceIndex: 17 },
  { measureNumber: 69, measureConfidence: 44.4 },
];
assert.equal(measures.refineRepeatedUnnumberedGap(finalRepeatedGap, () => .21), 2);
assert.deepEqual(finalRepeatedGap.map((row) => row.measureNumber), [61, 65, 65, 69]);
assert.equal(measures.refineRepeatedUnnumberedGap([
  { measureNumber: 61, measureConfidence: 38.9 },
  { measureNumber: null, sourceFrameIndex: 41, sequenceIndex: 16,
    measureCandidates: [{ value: 65, votes: 2 }] },
  { measureNumber: null, sourceFrameIndex: 34, sequenceIndex: 17 },
  { measureNumber: 69, measureConfidence: 44.4 },
], () => .4), 0, 'do not infer from different printed labels');
const bracketed = [
  { measureNumber: 37, measureConfidence: 72.2 },
  { measureNumber: 4, measureConfidence: 61.1, measureCandidates: [
    { value: 4, votes: 11, confidence: 61.1 },
    { value: 41, votes: 7, confidence: 38.9 },
  ] },
  { measureNumber: 45, measureConfidence: 66.7 },
];
assert.equal(measures.refineBracketedMeasures(bracketed), 1);
assert.equal(bracketed[1].measureNumber, 41);
assert.equal(bracketed[1].measureSource, 'local-sequence');
const unbracketed = [
  { measureNumber: 203, measureConfidence: 72.2 },
  { measureNumber: 203, measureConfidence: 38.9, measureCandidates: [
    { value: 203, votes: 7, confidence: 38.9 },
    { value: 211, votes: 6, confidence: 33.3 },
  ] },
  { measureNumber: 207, measureConfidence: 44.4 },
];
assert.equal(measures.refineBracketedMeasures(unbracketed), 0,
  'do not guess a measure when the neighboring numbering is ambiguous');
const repeatedWithSupportedAlternative = [
  { measureNumber: 203, measureConfidence: 72.2 },
  { measureNumber: 203, measureConfidence: 38.9, measureCandidates: [
    { value: 203, votes: 7, confidence: 38.9 },
    { value: 211, votes: 6, confidence: 33.3 },
  ] },
  { measureNumber: 207, measureConfidence: 44.4 },
  { measureNumber: 215, measureConfidence: 100 },
];
assert.equal(measures.refineRepeatedMeasureAlternatives(repeatedWithSupportedAlternative), 1);
assert.equal(repeatedWithSupportedAlternative[1].measureNumber, 211);
assert.equal(measures.refineRepeatedMeasureAlternatives([
  { measureNumber: 97, measureConfidence: 60 },
  { measureNumber: 97, measureConfidence: 60, measureCandidates: [
    { value: 97, votes: 11 }, { value: 101, votes: 1 },
  ] },
  { measureNumber: 105, measureConfidence: 90 },
]), 0, 'an unsupported alternative must not replace a real repeated section');
const localOrder = measures.sortLocalFourMeasureInversions([
  { measureNumber: 203, measureConfidence: 72, sequenceIndex: 68 },
  { measureNumber: 211, measureConfidence: 33, sequenceIndex: 71 },
  { measureNumber: 207, measureConfidence: 44, sequenceIndex: 72 },
  { measureNumber: 215, measureConfidence: 100, sequenceIndex: 72 },
]);
assert.deepEqual(localOrder.map((row) => row.measureNumber), [203, 207, 211, 215]);
const outOfOrderButReal = [
  { measureNumber: 93, measureConfidence: 78 },
  { measureNumber: 49, measureConfidence: 78, measureCandidates: [
    { value: 49, votes: 14, confidence: 78 },
    { value: 97, votes: 11, confidence: 61 },
  ] },
  { measureNumber: 101, measureConfidence: 67 },
];
assert.equal(measures.refineBracketedMeasures(outOfOrderButReal), 0,
  'a two-digit measure from a displaced frame must not be rewritten by sequence alone');
assert.equal(outOfOrderButReal[1].measureNumber, 49);
const digitTruncation = [
  { measureNumber: 77, measureConfidence: 44 },
  { measureNumber: 81, measureConfidence: 44 },
  { measureNumber: 85, measureConfidence: 44 },
  { measureNumber: 89, measureConfidence: 44 },
  { measureNumber: 7, measureConfidence: 39, measureCandidates: [
    { value: 7, votes: 7, confidence: 39 },
    { value: 77, votes: 6, confidence: 33 },
  ] },
];
assert.equal(measures.refineDigitAndNeighborAlternatives(digitTruncation), 1);
assert.equal(digitTruncation[4].measureNumber, 77);
const neighborDuplicate = [
  { measureNumber: 183, measureConfidence: 56, sequenceIndex: 34, measureCandidates: [
    { value: 183, votes: 10, confidence: 56 },
    { value: 113, votes: 6, confidence: 33 },
  ] },
  { measureNumber: 113, measureConfidence: 83, sequenceIndex: 35 },
];
assert.equal(measures.refineDigitAndNeighborAlternatives(neighborDuplicate), 1);
assert.equal(neighborDuplicate[0].measureNumber, 113);
const finalImageMismatch = { measureNumber: 49, measureSource: 'ocr-consensus' };
assert.equal(measures.preferSelectedImageMeasure(finalImageMismatch, { candidates: [
  { value: 57, votes: 12, confidence: 66.7 },
  { value: 7, votes: 5, confidence: 27.8 },
] }), true);
assert.equal(finalImageMismatch.measureNumber, 57);
const tooFewDigits = { measureNumber: 211, measureSource: 'local-sequence' };
assert.equal(measures.preferSelectedImageMeasure(tooFewDigits, { candidates: [
  { value: 21, votes: 6, confidence: 33.3 },
  { value: 211, votes: 3, confidence: 16.7 },
] }), false);
assert.equal(tooFewDigits.measureNumber, 211);
const wrongDuplicatedLabel = { measureNumber: 69, measureSource: 'ocr-consensus' };
assert.equal(measures.preferSelectedImageMeasure(wrongDuplicatedLabel, { candidates: [
  { value: 29, votes: 5, confidence: 27.8 },
  { value: 5, votes: 1, confidence: 5.6 },
] }, { duplicateCurrent: true }), true);
assert.equal(wrongDuplicatedLabel.measureNumber, 29);
const supportedCurrent = { measureNumber: 141, measureSource: 'ocr-consensus' };
assert.equal(measures.preferSelectedImageMeasure(supportedCurrent, { candidates: [
  { value: 131, votes: 6, confidence: 33.3 },
  { value: 141, votes: 4, confidence: 22.2 },
] }, { lockedByNeighbors: true }), false);
assert.equal(supportedCurrent.measureNumber, 141);
console.log('Video opening and duplicate regression passed');
