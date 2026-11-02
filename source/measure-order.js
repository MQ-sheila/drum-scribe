(function attachDrumScribeMeasureOrder(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DrumScribeMeasureOrder = factory();
}(typeof self !== 'undefined' ? self : this, function createMeasureOrder() {
  'use strict';

  function validMeasureNumber(value) {
    const text = String(value ?? '').trim();
    if (!text || !/^\d{1,4}$/.test(text)) return null;
    const number = Number(text);
    return Number.isInteger(number) && number >= 1 && number <= 9999 ? number : null;
  }

  function resetAutomaticMeasures(rows) {
    (rows || []).forEach((row) => {
      row.isUnnumberedOpening = false;
      if (row.measureSource === 'manual') return;
      row.measureNumber = null;
      row.measureSource = null;
      row.measureConfidence = null;
      row.measureVotes = null;
      row.measureCandidates = [];
    });
    return rows || [];
  }

  function bestAlignedChainStart(rows, pattern) {
    const numbered = (rows || []).map((row, index) => ({
      index,
      value: validMeasureNumber(row.measureNumber),
      source: row.measureSource || null,
    })).filter((item) => item.value != null);
    if (!numbered.length) return -1;
    const manual = numbered.find((item) => item.source === 'manual');
    const step = Number(pattern?.step) || 0;
    if (!step || numbered.length < 2) return manual?.index ?? numbered[0].index;

    const lengths = new Array(numbered.length).fill(1);
    for (let left = numbered.length - 1; left >= 0; left -= 1) {
      for (let right = left + 1; right < numbered.length; right += 1) {
        const difference = numbered[right].value - numbered[left].value;
        if (difference > 0 && difference % step === 0) {
          lengths[left] = Math.max(lengths[left], 1 + lengths[right]);
        }
      }
    }
    let selected = 0;
    for (let index = 1; index < numbered.length; index += 1) {
      if (lengths[index] > lengths[selected]) selected = index;
    }
    const automaticStart = numbered[selected].index;
    return manual && manual.index < automaticStart ? manual.index : automaticStart;
  }

  function protectUnnumberedOpening(rows, pattern) {
    if (!rows?.length) return 0;
    const firstAnchor = bestAlignedChainStart(rows, pattern);
    const prefixLength = firstAnchor < 0 ? 1 : firstAnchor;
    let protectedCount = 0;
    for (let index = 0; index < prefixLength; index += 1) {
      const row = rows[index];
      if (!row || row.measureSource === 'manual') continue;
      row.measureNumber = index === 0 ? 1 : null;
      row.measureSource = index === 0 ? 'inferred-opening' : 'unnumbered-opening';
      row.measureConfidence = null;
      row.measureVotes = null;
      row.isUnnumberedOpening = true;
      row.included = true;
      protectedCount += 1;
    }
    return protectedCount;
  }

  function sameMeasureNearbyDuplicate(left, right) {
    const first = validMeasureNumber(left?.measureNumber);
    const second = validMeasureNumber(right?.measureNumber);
    if (first == null || first !== second ||
        left?.measureSource === 'sequence-inferred' ||
        right?.measureSource === 'sequence-inferred') return false;
    if (left?.sourceFrameIndex == null || right?.sourceFrameIndex == null) return false;
    const leftFrame = Number(left?.sourceFrameIndex);
    const rightFrame = Number(right?.sourceFrameIndex);
    if (!Number.isInteger(leftFrame) || !Number.isInteger(rightFrame)) return false;
    const frameGap = Math.abs(leftFrame - rightFrame);
    if (frameGap > 16) return false;
    const minimumConfidence = frameGap <= 2 ? 20 : frameGap <= 4 ? 25 : 30;
    return Number(left?.measureConfidence) >= minimumConfidence &&
      Number(right?.measureConfidence) >= minimumConfidence;
  }

  function refineBracketedMeasures(rows) {
    let repaired = 0;
    (rows || []).forEach((row, index) => {
      if (!row || row.measureSource === 'manual' || row.measureSource === 'group-sequence' ||
          validMeasureNumber(row.measureNumber) >= 10) return;
      const candidates = normalizedCandidates({ candidates: row.measureCandidates });
      if (!candidates.length) return;
      const previous = [index - 1, index - 2].map((at) => ({ at, row: rows[at] }))
        .find((item) => item.row && validMeasureNumber(item.row.measureNumber) >= 10 &&
          Number(item.row.measureConfidence) >= 25);
      const next = [index + 1, index + 2].map((at) => ({ at, row: rows[at] }))
        .find((item) => item.row && validMeasureNumber(item.row.measureNumber) >= 10 &&
          Number(item.row.measureConfidence) >= 25);
      if (!previous || !next) return;
      const from = validMeasureNumber(previous.row.measureNumber);
      const to = validMeasureNumber(next.row.measureNumber);
      const count = next.at - previous.at;
      const oneRepeatedUnnumberedRow = count === 3 && to - from === 8 &&
        index === previous.at + 1 && row.measureNumber == null &&
        rows[index + 1]?.measureNumber == null;
      if (to - from !== count * 4 && !oneRepeatedUnnumberedRow) return;
      const expected = from + (index - previous.at) * 4;
      const candidate = candidates.find((item) => item.value === expected);
      const strongest = Math.max(...candidates.map((item) => item.votes));
      const minimumVotes = oneRepeatedUnnumberedRow ? 2 : 4;
      if (!candidate || candidate.votes < minimumVotes || candidate.votes < strongest * 0.3 ||
          row.measureNumber === expected) return;
      row.measureNumber = expected;
      row.measureSource = 'local-sequence';
      row.measureConfidence = candidate.confidence;
      row.measureVotes = candidate.votes;
      repaired += 1;
    });
    return repaired;
  }

  function refineDigitAndNeighborAlternatives(rows) {
    let repaired = 0;
    (rows || []).forEach((row, index) => {
      const current = validMeasureNumber(row?.measureNumber);
      if (current == null || row.measureSource === 'manual' || row.measureSource === 'group-sequence') return;
      const candidates = normalizedCandidates({ candidates: row.measureCandidates });
      const bestVotes = Math.max(0, ...candidates.map((item) => item.votes));
      let alternative = null;
      if (current < 100) {
        alternative = candidates.find((item) => item.value >= 100 &&
          String(item.value).startsWith(String(current)) &&
          item.votes >= 4 && item.votes >= bestVotes * 0.35 &&
          rows.slice(Math.max(0, index - 3), Math.min(rows.length, index + 4))
            .some((neighbor) => neighbor !== row &&
              Math.abs(validMeasureNumber(neighbor?.measureNumber) - item.value) === 4 &&
              Number.isInteger(neighbor.sequenceIndex) &&
              Number.isInteger(row.sequenceIndex) &&
              Math.abs(neighbor.sequenceIndex - row.sequenceIndex) <= 5));
      }
      if (!alternative && current < 10 && index > 0) {
        alternative = candidates.find((item) => item.value >= 10 && item.votes >= 4 &&
          item.votes >= bestVotes * 0.7 &&
          rows.slice(Math.max(0, index - 6), index).some((earlier) =>
            validMeasureNumber(earlier?.measureNumber) === item.value));
      } else if (!alternative && index + 1 < rows.length) {
        const next = rows[index + 1];
        const nextNumber = validMeasureNumber(next?.measureNumber);
        if (nextNumber != null && current - nextNumber >= 20 &&
            Number.isInteger(row.sequenceIndex) && Number.isInteger(next.sequenceIndex) &&
            Math.abs(row.sequenceIndex - next.sequenceIndex) <= 2) {
          alternative = candidates.find((item) => item.value === nextNumber &&
            String(item.value).length === String(current).length &&
            item.votes >= 4 && item.votes >= bestVotes * 0.5);
        }
      }
      if (alternative) {
        row.measureNumber = alternative.value;
        row.measureSource = 'local-candidate';
        row.measureConfidence = alternative.confidence;
        row.measureVotes = alternative.votes;
        repaired += 1;
      } else if (current < 10 && rows.slice(Math.max(0, index - 2), index)
        .some((earlier) => validMeasureNumber(earlier?.measureNumber) >= 20)) {
        row.measureNumber = null;
        row.measureSource = null;
        row.measureConfidence = null;
        row.measureVotes = null;
      }
    });
    return repaired;
  }

  function refineRepeatedMeasureAlternatives(rows) {
    let repaired = 0;
    (rows || []).forEach((row, index) => {
      const current = validMeasureNumber(row?.measureNumber);
      if (current == null || row.measureSource === 'manual' || row.measureSource === 'group-sequence') return;
      const repeated = rows.slice(Math.max(0, index - 2), index)
        .some((other) => validMeasureNumber(other?.measureNumber) === current);
      if (!repeated) return;
      const candidates = normalizedCandidates({ candidates: row.measureCandidates });
      const bestVotes = Math.max(0, ...candidates.map((item) => item.votes));
      const alternative = candidates.find((item) => item.value > current &&
        item.value <= current + 12 && item.votes >= 3 &&
        item.votes >= bestVotes * 0.7 &&
        rows.slice(index + 1, index + 5).some((later) =>
          validMeasureNumber(later?.measureNumber) === item.value + 4 &&
          Number(later.measureConfidence) >= 60));
      if (!alternative) return;
      row.measureNumber = alternative.value;
      row.measureSource = 'local-sequence';
      row.measureConfidence = alternative.confidence;
      row.measureVotes = alternative.votes;
      repaired += 1;
    });
    return repaired;
  }

  function refineRepeatedUnnumberedGap(rows, comparePrintedNumbers) {
    let recovered = 0;
    if (typeof comparePrintedNumbers !== 'function') return recovered;
    for (let index = 1; index + 2 < (rows || []).length; index += 1) {
      const previous = rows[index - 1];
      const first = rows[index];
      const second = rows[index + 1];
      const next = rows[index + 2];
      const from = validMeasureNumber(previous?.measureNumber);
      const to = validMeasureNumber(next?.measureNumber);
      if (from == null || from < 10 || to !== from + 8 ||
          validMeasureNumber(first?.measureNumber) != null ||
          validMeasureNumber(second?.measureNumber) != null ||
          Number(previous?.measureConfidence) < 25 ||
          Number(next?.measureConfidence) < 25 ||
          !Number.isInteger(first?.sourceFrameIndex) ||
          !Number.isInteger(second?.sourceFrameIndex) ||
          Math.abs(first.sourceFrameIndex - second.sourceFrameIndex) > 8 ||
          !Number.isInteger(first?.sequenceIndex) ||
          !Number.isInteger(second?.sequenceIndex) ||
          Math.abs(first.sequenceIndex - second.sequenceIndex) > 3) continue;
      const candidate = normalizedCandidates({ candidates: first.measureCandidates })
        .find((item) => item.value === from + 4 && item.votes >= 2);
      const strongest = Math.max(0, ...normalizedCandidates({ candidates: first.measureCandidates })
        .map((item) => item.votes));
      const labelDistance = comparePrintedNumbers(first, second);
      if (!candidate || candidate.votes < strongest * 0.3 ||
          labelDistance == null || labelDistance > 0.23) continue;
      for (const row of [first, second]) {
        row.measureNumber = from + 4;
        row.measureSource = 'bracket-label';
        row.measureConfidence = 30;
        row.measureVotes = row === first ? candidate.votes : 0;
      }
      recovered += 2;
      index += 1;
    }
    return recovered;
  }

  function sortLocalFourMeasureInversions(rows) {
    const ordered = [...(rows || [])];
    for (let index = 1; index < ordered.length; index += 1) {
      const left = ordered[index - 1];
      const right = ordered[index];
      const leftNumber = validMeasureNumber(left?.measureNumber);
      const rightNumber = validMeasureNumber(right?.measureNumber);
      const nearby = Number.isInteger(left?.sequenceIndex) &&
        Number.isInteger(right?.sequenceIndex) &&
        Math.abs(left.sequenceIndex - right.sequenceIndex) <= 2;
      if (!nearby || leftNumber !== rightNumber + 4 ||
          Number(left?.measureConfidence) < 25 ||
          Number(right?.measureConfidence) < 25) continue;
      ordered[index - 1] = right;
      ordered[index] = left;
    }
    return ordered;
  }

  function preferSelectedImageMeasure(row, result, options = {}) {
    const current = validMeasureNumber(row?.measureNumber);
    if (current == null || current < 10 || row.measureSource === 'manual' ||
        row.measureSource === 'group-sequence' || row.isUnnumberedOpening) return false;
    const candidates = normalizedCandidates(result).sort((left, right) => right.votes - left.votes);
    const best = candidates[0];
    const runner = candidates[1];
    const minimumVotes = options.duplicateCurrent ? 5 : 6;
    if (!best || best.value === current || best.votes < minimumVotes ||
        (!options.duplicateCurrent && Number(row.measureVotes) > best.votes * 1.35) ||
        (options.lockedByNeighbors && best.votes < 8) ||
        (runner && best.votes < runner.votes * 1.5) ||
        String(best.value).length !== String(current).length) return false;
    row.measureNumber = best.value;
    row.measureSource = 'selected-image';
    row.measureConfidence = best.confidence;
    row.measureVotes = best.votes;
    return true;
  }

  function keepAfterCoverageFilter(row, coverage, minimum) {
    return !!row?.isUnnumberedOpening || !Number.isFinite(coverage) || coverage >= minimum;
  }


  function normalizedCandidates(result) {
    return (result?.candidates || [])
      .map((candidate) => ({
        value: validMeasureNumber(candidate.value),
        votes: Number(candidate.votes) || 0,
        confidence: Number(candidate.confidence) || 0,
      }))
      .filter((candidate) => candidate.value != null);
  }

  function inferSequentialPattern(results) {
    const rows = (results || []).map(normalizedCandidates);
    if (rows.length < 4) {
      return { step: null, residue: null, start: null, openingRows: 0, matched: 0, coverage: 0, reliable: false, anchors: [] };
    }
    let best = null;
    const maximumOpening = Math.min(1, rows.length - 1);
    for (let openingRows = 0; openingRows <= maximumOpening; openingRows += 1) {
      for (let step = 2; step <= 8; step += 1) {
        const starts = new Set();
        rows.forEach((candidates, index) => {
          if (index < openingRows) return;
          candidates.forEach((candidate) => {
            const start = candidate.value - (index - openingRows) * step;
            if (start >= 1 && start <= 128) starts.add(start);
          });
        });
        starts.forEach((start) => {
          let matched = 0;
          let voteScore = 0;
          let multiDigitMatches = 0;
          const anchors = [];
          rows.forEach((candidates, index) => {
            if (index < openingRows) return;
            const expected = start + (index - openingRows) * step;
            const direct = candidates
              .filter((candidate) => candidate.value === expected)
              .sort((left, right) => right.votes - left.votes)[0];
            if (!direct) return;
            matched += 1;
            voteScore += direct.votes + (expected >= 10 ? 1.4 : 0);
            if (expected >= 10) multiDigitMatches += 1;
            anchors.push(expected);
          });
          const available = Math.max(1, rows.length - openingRows);
          const coverage = matched / available;
          const score = voteScore + matched * 0.7 + (step === 4 ? 0.5 : 0) - openingRows * 0.1;
          const candidate = { step, start, openingRows, matched, multiDigitMatches, coverage, score, anchors };
          if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.coverage > best.coverage)) best = candidate;
        });
      }
    }
    if (!best) {
      return { step: null, residue: null, start: null, openingRows: 0, matched: 0, coverage: 0, reliable: false, anchors: [] };
    }
    const minimumMatches = Math.max(4, Math.ceil((rows.length - best.openingRows) * 0.35));
    const reliable = best.matched >= minimumMatches && best.multiDigitMatches >= 2 && best.coverage >= 0.35;
    return {
      ...best,
      residue: ((best.start % best.step) + best.step) % best.step,
      reliable,
    };
  }

  // A video may skip captured pages. Infer each retained page from its own
  // printed numbers; a single global row index cannot span those gaps.
  function selectCaptureGroupMeasures(rows, results, step = 4) {
    const selected = new Array((rows || []).length).fill(null);
    if (!Number.isInteger(step) || step < 2 || step > 8) step = 4;
    const groups = new Map();
    (rows || []).forEach((row, index) => {
      if (!Number.isInteger(row?.sequenceIndex) || !Number.isInteger(row?.sequenceRowIndex)) return;
      if (!groups.has(row.sequenceIndex)) groups.set(row.sequenceIndex, []);
      groups.get(row.sequenceIndex).push(index);
    });
    groups.forEach((indices) => {
      indices.sort((left, right) => rows[left].sequenceRowIndex - rows[right].sequenceRowIndex);
      let start = null;
      for (const index of indices) {
        const candidates = normalizedCandidates(results[index])
          .filter((candidate) => candidate.votes >= 5)
          .sort((left, right) => right.votes - left.votes);
        if (!candidates.length) continue;
        const possible = candidates[0].value - rows[index].sequenceRowIndex * step;
        if (possible < 1) continue;
        start = possible;
        break;
      }
      if (start == null) return;
      indices.forEach((index) => {
        const value = start + rows[index].sequenceRowIndex * step;
        const direct = normalizedCandidates(results[index])
          .filter((candidate) => candidate.value === value)
          .sort((left, right) => right.votes - left.votes)[0];
        selected[index] = direct
          ? { ...direct, inferred: false }
          : { value, votes: 0, confidence: 0, inferred: true };
      });
    });
    return selected;
  }

  function selectSequentialCandidate(result, pattern, index) {
    const candidates = normalizedCandidates(result);
    if (pattern?.reliable && pattern.step && pattern.start != null) {
      if (index < (pattern.openingRows || 0)) return null;
      const expected = pattern.start + (index - (pattern.openingRows || 0)) * pattern.step;
      const direct = candidates
        .filter((candidate) => candidate.value === expected)
        .sort((left, right) => right.votes - left.votes)[0];
      if (direct) return { ...direct, inferred: false };
      return {
        value: expected,
        votes: 0,
        confidence: Math.round(pattern.coverage * 1000) / 10,
        inferred: true,
      };
    }
    const best = candidates.sort((left, right) => right.votes - left.votes)[0];
    return best && (best.votes >= 4 || best.confidence >= 25) ? { ...best, inferred: false } : null;
  }

  return {
    validMeasureNumber,
    resetAutomaticMeasures,
    bestAlignedChainStart,
    protectUnnumberedOpening,
    keepAfterCoverageFilter,
    sameMeasureNearbyDuplicate,
    refineBracketedMeasures,
    refineDigitAndNeighborAlternatives,
    refineRepeatedMeasureAlternatives,
    refineRepeatedUnnumberedGap,
    sortLocalFourMeasureInversions,
    preferSelectedImageMeasure,
    inferSequentialPattern,
    selectSequentialCandidate,
    selectCaptureGroupMeasures,
  };
}));
