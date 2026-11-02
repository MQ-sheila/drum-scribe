(function attachDrumScopeCore(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DrumScopeCore = factory();
}(typeof self !== 'undefined' ? self : this, function createCore() {
  'use strict';

  const DEFAULTS = Object.freeze({
    mode: 'auto',
    sourceInk: 'dark',
    dedupeStrength: 0.72,
    rowGap: 18,
    scoreScale: 1,
    titleSize: 42,
    cropTop: 0,
    cropBottom: 0,
    removeColorArtifacts: true,
    minCompleteness: 0.62,
    maxLookback: 16,
  });

  const DIGITS = {
    0: ['111', '101', '101', '101', '111'],
    1: ['010', '110', '010', '010', '111'],
    2: ['110', '001', '010', '100', '111'],
    3: ['110', '001', '010', '001', '110'],
    4: ['101', '101', '111', '001', '001'],
    5: ['111', '100', '110', '001', '110'],
    6: ['011', '100', '111', '101', '111'],
    7: ['111', '001', '010', '010', '010'],
    8: ['111', '101', '111', '101', '111'],
    9: ['111', '101', '111', '001', '110'],
  };

  function isSingleLineCapture(mode, sequences) {
    if (mode === 'single') return true;
    return Array.isArray(sequences) && sequences.length > 0 &&
      sequences.every((sequence) => (sequence?.rows || sequence || []).length <= 1);
  }

  function normalizeReviewState(row, options = {}) {
    const singleCapture = options.singleCapture === true;
    const minCompleteness = Number.isFinite(options.minCompleteness)
      ? options.minCompleteness
      : 0.62;
    const edgePartial = row?.status === 'top-partial' ||
      row?.status === 'bottom-partial' ||
      row?.status === 'both-partial';
    const status = singleCapture && edgePartial ? 'complete' : row?.status;
    const completeness = singleCapture && edgePartial
      ? Math.max(0.96, Number(row?.completeness) || 0)
      : row?.completeness;
    const included = row?.included !== false && (
      singleCapture || (
        !edgePartial &&
        (completeness == null || completeness >= minCompleteness)
      )
    );
    return { status, completeness, included };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function average(values) {
    if (!values || !values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function median(values) {
    if (!values || !values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function lerp(left, right, amount) {
    return left + (right - left) * amount;
  }

  function canvasFromCanvas(source, sx, sy, sw, sh) {
    if (typeof document === 'undefined') return null;
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(sw));
    output.height = Math.max(1, Math.round(sh));
    output.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, output.width, output.height);
    return output;
  }

  function imageDataForCanvas(source, maxWidth) {
    if (!source || typeof document === 'undefined') return null;
    const width = source.width || source.videoWidth;
    const height = source.height || source.videoHeight;
    if (!width || !height) return null;
    const targetWidth = Math.max(1, Math.min(maxWidth || width, width));
    const targetHeight = Math.max(1, Math.round(height * targetWidth / width));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, targetWidth, targetHeight);
    return context.getImageData(0, 0, targetWidth, targetHeight);
  }

  function pixelGray(data, index) {
    return (data[index] * 3 + data[index + 1] * 6 + data[index + 2]) / 10;
  }

  function pixelSaturation(data, index) {
    return Math.max(data[index], data[index + 1], data[index + 2]) - Math.min(data[index], data[index + 1], data[index + 2]);
  }

  function colorStats(imageData, options = {}) {
    if (!imageData) return { colorRatio: 0, verticalColor: 0, horizontalColor: 0, cursorPenalty: 0, horizontalPenalty: 0 };
    const { data, width, height } = imageData;
    const colorThreshold = options.colorThreshold == null ? 38 : options.colorThreshold;
    const rowColor = new Uint32Array(height);
    const columnColor = new Uint32Array(width);
    let colorful = 0;
    let pixels = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const saturation = pixelSaturation(data, index);
        const brightness = pixelGray(data, index);
        const colorfulPixel = saturation >= colorThreshold && brightness >= 48;
        if (colorfulPixel) {
          colorful += 1;
          rowColor[y] += 1;
          columnColor[x] += 1;
        }
        pixels += 1;
      }
    }
    const maxColumn = width ? Math.max(...columnColor) / height : 0;
    const maxRow = height ? Math.max(...rowColor) / width : 0;
    const verticalColor = clamp(maxColumn, 0, 1);
    const horizontalColor = clamp(maxRow, 0, 1);
    return {
      colorRatio: colorful / Math.max(pixels, 1),
      verticalColor,
      horizontalColor,
      cursorPenalty: clamp(verticalColor * 2.9, 0, 1),
      horizontalPenalty: clamp(horizontalColor * 2.2, 0, 1),
      rowColor,
      columnColor,
    };
  }

  function neutralLuminance(data, index) {
    // Saturated UI overlays should not become part of a structural signature.
    const saturation = pixelSaturation(data, index);
    if (saturation > 42) return 255;
    return pixelGray(data, index);
  }

  function structuralSignature(source, options = {}) {
    if (!source) return null;
    const targetWidth = options.width || 96;
    const targetHeight = options.height || 32;
    const imageData = source.data && source.width ? source : imageDataForCanvas(source, options.maxWidth || 720);
    if (!imageData) return null;
    const { data, width, height } = imageData;
    const bits = new Uint8Array(targetWidth * targetHeight);
    const rows = new Uint8Array(targetHeight);
    const columns = new Uint8Array(targetWidth);
    const sourceValues = new Float32Array(targetWidth * targetHeight);
    let total = 0;
    for (let y = 0; y < targetHeight; y += 1) {
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceX = Math.min(width - 1, Math.floor((x + .5) * width / targetWidth));
        const sourceY = Math.min(height - 1, Math.floor((y + .5) * height / targetHeight));
        const value = neutralLuminance(data, (sourceY * width + sourceX) * 4);
        sourceValues[y * targetWidth + x] = value;
        total += value;
      }
    }
    const threshold = clamp(total / Math.max(sourceValues.length, 1) - 24, 96, 218);
    for (let y = 0; y < targetHeight; y += 1) {
      let rowDark = 0;
      for (let x = 0; x < targetWidth; x += 1) {
        const index = y * targetWidth + x;
        const dark = sourceValues[index] < threshold ? 1 : 0;
        bits[index] = dark;
        rowDark += dark;
        columns[x] += dark;
      }
      rows[y] = rowDark;
    }
    return { bits, rows, columns, width: targetWidth, height: targetHeight, threshold };
  }

  function signatureDistance(left, right) {
    if (!left || !right) return 1;
    if (typeof left === 'number' && typeof right === 'number') return Math.min(1, Math.abs(left - right) / 255);
    if (left.bits && right.bits) {
      const length = Math.min(left.bits.length, right.bits.length);
      let different = 0;
      for (let index = 0; index < length; index += 1) if (left.bits[index] !== right.bits[index]) different += 1;
      const bitDistance = different / Math.max(length, 1);
      const rowLength = Math.min(left.rows?.length || 0, right.rows?.length || 0);
      let rowDistance = 0;
      for (let index = 0; index < rowLength; index += 1) rowDistance += Math.abs(left.rows[index] - right.rows[index]) / Math.max(left.width, right.width, 1);
      const columnLength = Math.min(left.columns?.length || 0, right.columns?.length || 0);
      let columnDistance = 0;
      for (let index = 0; index < columnLength; index += 1) columnDistance += Math.abs(left.columns[index] - right.columns[index]) / Math.max(left.height, right.height, 1);
      return clamp(bitDistance * .56 + (rowDistance / Math.max(rowLength, 1)) * .25 + (columnDistance / Math.max(columnLength, 1)) * .19, 0, 1);
    }
    if (left.length && right.length) {
      const length = Math.min(left.length, right.length);
      let total = 0;
      for (let index = 0; index < length; index += 1) total += Math.abs(left[index] - right[index]) / 255;
      return total / Math.max(length, 1);
    }
    return 1;
  }

  function sharpness(source) {
    const imageData = source?.data && source.width ? source : imageDataForCanvas(source, 320);
    if (!imageData) return 0;
    const { data, width, height } = imageData;
    let total = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = (y * width + x) * 4;
        const current = pixelGray(data, index);
        const horizontal = Math.abs(current - pixelGray(data, index - 4));
        const vertical = Math.abs(current - pixelGray(data, index - width * 4));
        total += horizontal + vertical;
        count += 2;
      }
    }
    return clamp(total / Math.max(count, 1) / 96, 0, 1);
  }

  function frameQuality(source) {
    const imageData = source?.data && source.width ? source : imageDataForCanvas(source, 320);
    if (!imageData) return { score: 0, sharpness: 0, cursorPenalty: 0, horizontalPenalty: 0, colorRatio: 0 };
    const colors = colorStats(imageData);
    const crisp = sharpness(imageData);
    const score = crisp * .72 + clamp(1 - colors.colorRatio * 2, 0, 1) * .28
      - colors.cursorPenalty * .78 - colors.horizontalPenalty * .34;
    return {
      score,
      sharpness: crisp,
      cursorPenalty: colors.cursorPenalty,
      horizontalPenalty: colors.horizontalPenalty,
      colorRatio: colors.colorRatio,
      verticalColor: colors.verticalColor,
      horizontalColor: colors.horizontalColor,
    };
  }

  function chooseBestCandidate(candidates) {
    if (!candidates || !candidates.length) return null;
    return candidates.reduce((best, candidate) => {
      if (!best) return candidate;
      const bestComplete = best.status === 'complete';
      const currentComplete = candidate.status === 'complete';
      if (bestComplete !== currentComplete) return currentComplete ? candidate : best;
      const bestTop = Number(best.sourceBounds?.top);
      const currentTop = Number(candidate.sourceBounds?.top);
      if (bestComplete && Number.isFinite(bestTop) && Number.isFinite(currentTop) &&
          bestTop !== currentTop) return currentTop < bestTop ? candidate : best;
      const bestQuality = best.quality || frameQuality(best.canvas || best);
      const currentQuality = candidate.quality || frameQuality(candidate.canvas || candidate);
      return currentQuality.score > bestQuality.score ? candidate : best;
    }, null);
  }

  function groupStableFrames(frames, options = {}) {
    const threshold = options.threshold == null ? .14 : options.threshold;
    const maxGap = options.maxGap == null ? 900 : options.maxGap;
    const normalized = (frames || []).map((frame, index) => ({
      canvas: frame.canvas || frame,
      timestamp: frame.timestamp == null ? index * 140 : frame.timestamp,
      index,
    }));
    if (!normalized.length) return [];
    const groups = [];
    let group = [normalized[0]];
    let previous = structuralSignature(normalized[0].canvas);
    for (const item of normalized.slice(1)) {
      const current = structuralSignature(item.canvas);
      const distance = signatureDistance(previous, current);
      const gap = item.timestamp - group[group.length - 1].timestamp;
      if (distance <= threshold && gap <= maxGap) group.push(item);
      else {
        groups.push(group);
        group = [item];
      }
      previous = current;
    }
    groups.push(group);
    return groups.map((items, groupIndex) => ({
      index: groupIndex,
      items,
      stable: items.length >= 2,
      best: chooseBestCandidate(items.map((item) => ({ ...item, quality: frameQuality(item.canvas) }))),
    }));
  }

  function lineProfile(source, options = {}) {
    const imageData = source?.data && source.width ? source : imageDataForCanvas(source, options.maxWidth || 760);
    if (!imageData) return null;
    const { data, width, height } = imageData;
    const profile = new Float32Array(height);
    const sampleStep = Math.max(1, Math.floor(width / (options.samples || 620)));
    for (let y = 0; y < height; y += 1) {
      let dark = 0;
      let count = 0;
      for (let x = 0; x < width; x += sampleStep) {
        const index = (y * width + x) * 4;
        const saturation = pixelSaturation(data, index);
        const gray = saturation > 55 ? 255 : pixelGray(data, index);
        if (gray < (options.darkThreshold == null ? 172 : options.darkThreshold)) dark += 1;
        count += 1;
      }
      profile[y] = dark / Math.max(count, 1);
    }
    const smooth = new Float32Array(height);
    for (let y = 0; y < height; y += 1) smooth[y] = average([profile[Math.max(0, y - 1)], profile[y], profile[Math.min(height - 1, y + 1)]]);
    return { profile: smooth, width, height, imageData };
  }

  function detectStaffSystems(source, options = {}) {
    const profileData = lineProfile(source, options);
    if (!profileData) return [];
    const { profile, height } = profileData;
    const strongest = Math.max(...profile);
    if (!strongest) return [];
    const minimumLine = Math.max(.16, strongest * (options.lineSupport || .36));
    const maxSpacing = Math.max(6, Math.min(42, Math.floor(height / 14)));
    const systems = [];
    for (let spacing = 3; spacing <= maxSpacing; spacing += 1) {
      for (let first = 0; first + spacing * 4 < height; first += 1) {
        const lines = [0, 1, 2, 3, 4].map((line) => {
          const center = first + line * spacing;
          let value = 0;
          for (let offset = -1; offset <= 1; offset += 1) value = Math.max(value, profile[clamp(center + offset, 0, height - 1)] || 0);
          return value;
        });
        const supported = lines.filter((value) => value >= minimumLine).length;
        const spread = Math.max(...lines) - Math.min(...lines);
        const score = average(lines) + supported * .055 - spread * .08;
        if (supported >= 4 && score > Math.max(.14, strongest * .42)) systems.push({ lines: [0, 1, 2, 3, 4].map((line) => first + line * spacing), spacing, score, supported });
      }
    }
    systems.sort((left, right) => left.spacing - right.spacing || right.score - left.score);
    const selected = [];
    for (const system of systems) {
      const center = system.lines[2];
      const duplicate = selected.some((other) => Math.abs(other.lines[2] - center) < Math.max(system.spacing, other.spacing) * 3.4);
      if (!duplicate) selected.push(system);
    }
    return selected.sort((left, right) => left.lines[0] - right.lines[0]);
  }

  function candidateCompleteness(system, imageHeight, previous, next) {
    const spacing = system.spacing;
    const firstLine = system.lines[0];
    const lastLine = system.lines[4];
    const topMargin = previous ? firstLine - previous.lines[4] : firstLine;
    const bottomMargin = next ? next.lines[0] - lastLine : imageHeight - lastLine;
    const lineSupport = system.supported / 5;
    const topContext = clamp(topMargin / (spacing * 3.25), 0, 1);
    const bottomContext = clamp(bottomMargin / (spacing * 3.25), 0, 1);
    const completeness = lineSupport * .58 + ((topContext + bottomContext) / 2) * .42;
    let status = 'complete';
    if (topContext < .62) status = 'top-partial';
    if (bottomContext < .62) status = status === 'top-partial' ? 'both-partial' : 'bottom-partial';
    return { completeness, status, topMargin, bottomMargin };
  }

  function singleRowBounds(system, imageHeight) {
    if (!system) return { top: 0, bottom: imageHeight };
    const topPadding = Math.max(14, Math.round(system.spacing * 6.8));
    const bottomPadding = Math.max(10, Math.round(system.spacing * 4.8));
    return {
      top: Math.max(0, system.lines[0] - topPadding),
      bottom: Math.min(imageHeight, system.lines[4] + bottomPadding),
    };
  }

  function cleanColorArtifacts(source, options = {}) {
    if (!source || typeof document === 'undefined') return source;
    const imageData = imageDataForCanvas(source, Math.min(1200, source.width));
    if (!imageData) return source;
    const { data, width, height } = imageData;
    const stats = colorStats(imageData, options);
    const verticalLimit = options.verticalLimit == null ? .06 : options.verticalLimit;
    const horizontalLimit = options.horizontalLimit == null ? .06 : options.horizontalLimit;
    const output = new ImageData(new Uint8ClampedArray(data), width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const colored = pixelSaturation(data, index) >= (options.colorThreshold == null ? 38 : options.colorThreshold);
        const elongated = stats.columnColor[x] / height >= verticalLimit || stats.rowColor[y] / width >= horizontalLimit;
        if (!colored || !elongated) continue;
        const neighbours = [];
        for (let offset = -2; offset <= 2; offset += 1) {
          if (offset === 0) continue;
          const horizontal = x + offset;
          const vertical = y + offset;
          if (horizontal >= 0 && horizontal < width) neighbours.push(pixelGray(data, (y * width + horizontal) * 4));
          if (vertical >= 0 && vertical < height) neighbours.push(pixelGray(data, (vertical * width + x) * 4));
        }
        const gray = Math.round(median(neighbours));
        output.data[index] = gray;
        output.data[index + 1] = gray;
        output.data[index + 2] = gray;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    context.putImageData(output, 0, 0);
    return canvas;
  }

  function detectMeasureNumber(source, options = {}) {
    if (!source || typeof document === 'undefined') return { value: null, text: '', confidence: 0, box: null, reason: 'canvas-unavailable' };
    const imageData = imageDataForCanvas(source, Math.min(900, source.width));
    if (!imageData) return { value: null, text: '', confidence: 0, box: null, reason: 'image-unavailable' };
    const { data, width, height } = imageData;
    const regionWidth = Math.max(30, Math.round(width * (options.regionWidth || .25)));
    const regionHeight = Math.max(18, Math.round(height * (options.regionHeight || .32)));
    const threshold = options.darkThreshold || 155;
    const mask = new Uint8Array(regionWidth * regionHeight);
    for (let y = 0; y < regionHeight; y += 1) {
      for (let x = 0; x < regionWidth; x += 1) {
        const sourceX = Math.min(width - 1, Math.round(x * width / regionWidth));
        const sourceY = Math.min(height - 1, Math.round(y * height / regionHeight));
        const index = (sourceY * width + sourceX) * 4;
        mask[y * regionWidth + x] = pixelSaturation(data, index) > 52 ? 0 : pixelGray(data, index) < threshold ? 1 : 0;
      }
    }
    const columns = new Uint16Array(regionWidth);
    const rows = new Uint16Array(regionHeight);
    for (let y = 0; y < regionHeight; y += 1) for (let x = 0; x < regionWidth; x += 1) {
      if (!mask[y * regionWidth + x]) continue;
      columns[x] += 1;
      rows[y] += 1;
    }
    const minInk = Math.max(1, Math.round(regionHeight * .04));
    const components = [];
    let start = null;
    for (let x = 0; x < regionWidth; x += 1) {
      if (columns[x] >= minInk) {
        if (start == null) start = x;
      } else if (start != null) {
        components.push([start, x]);
        start = null;
      }
    }
    if (start != null) components.push([start, regionWidth]);
    const useful = components.filter(([left, right]) => right - left >= 2 && right - left <= regionWidth * .42);
    const digits = [];
    let confidence = 0;
    for (const [left, right] of useful.slice(0, 4)) {
      let top = regionHeight; let bottom = 0;
      for (let y = 0; y < regionHeight; y += 1) for (let x = left; x < right; x += 1) if (mask[y * regionWidth + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y + 1); }
      if (bottom - top < 3) continue;
      const pixels = [];
      for (let gy = 0; gy < 5; gy += 1) {
        let line = '';
        for (let gx = 0; gx < 3; gx += 1) {
          const x = Math.min(right - 1, left + Math.floor((gx + .5) * (right - left) / 3));
          const y = Math.min(bottom - 1, top + Math.floor((gy + .5) * (bottom - top) / 5));
          line += mask[y * regionWidth + x] ? '1' : '0';
        }
        pixels.push(line);
      }
      let bestDigit = null; let bestDistance = Infinity;
      Object.entries(DIGITS).forEach(([digit, template]) => {
        let distance = 0;
        for (let y = 0; y < 5; y += 1) for (let x = 0; x < 3; x += 1) if (pixels[y][x] !== template[y][x]) distance += 1;
        if (distance < bestDistance) { bestDistance = distance; bestDigit = digit; }
      });
      if (bestDigit != null && bestDistance <= 7) {
        digits.push(bestDigit);
        confidence += 1 - bestDistance / 15;
      }
    }
    const text = digits.join('');
    const number = text && Number.isFinite(Number(text)) ? Number(text) : null;
    const normalizedConfidence = digits.length ? clamp(confidence / digits.length, 0, 1) * clamp(digits.length / Math.max(useful.length, 1), 0, 1) : 0;
    return { value: number, text, confidence: normalizedConfidence, box: useful.length ? { left: useful[0][0], right: useful[useful.length - 1][1], top: 0, bottom: regionHeight } : null, reason: number == null ? 'no-confident-digits' : 'template-estimate' };
  }

  function extractStaffRows(source, options = {}) {
    const mode = options.mode || 'auto';
    const systems = detectStaffSystems(source, options);
    const width = source?.width || 0;
    const height = source?.height || 0;
    if (!width || !height) return [];
    const ratio = height / Math.max(width, 1);
    const single = mode === 'single' || (mode === 'auto' && (ratio < .38 || systems.length <= 1));
    if (!systems.length) {
      const canvas = cleanColorArtifacts(source, options);
      return [{ canvas, baseCanvas: canvas, sourceCanvas: source, system: null, status: 'unknown', completeness: .35, confidence: .25, measure: detectMeasureNumber(canvas), quality: frameQuality(canvas), candidates: [] }];
    }
    if (single) {
      const system = systems[Math.floor(systems.length / 2)];
      const bounds = singleRowBounds(system, height);
      const raw = canvasFromCanvas(source, 0, bounds.top, width, bounds.bottom - bounds.top);
      const canvas = options.removeColorArtifacts === false ? raw : cleanColorArtifacts(raw, options);
      const completeness = candidateCompleteness(system, height, null, null);
      const measure = detectMeasureNumber(canvas, options);
      return [{ canvas, baseCanvas: canvas, sourceCanvas: source, sourceBounds: bounds, system, status: completeness.status, completeness: Math.max(completeness.completeness, .72), confidence: clamp(system.score, 0, 1), measure, quality: frameQuality(canvas), candidates: [] }];
    }
    return systems.map((system, index) => {
      const previous = systems[index - 1];
      const next = systems[index + 1];
      const completeness = candidateCompleteness(system, height, previous, next);
      const topPadding = Math.max(14, Math.round(system.spacing * 6.8));
      const bottomPadding = Math.max(10, Math.round(system.spacing * 4.8));
      const top = Math.max(0, system.lines[0] - topPadding);
      const bottom = Math.min(height, system.lines[4] + bottomPadding);
      const raw = canvasFromCanvas(source, 0, top, width, bottom - top);
      const canvas = options.removeColorArtifacts === false ? raw : cleanColorArtifacts(raw, options);
      const measure = detectMeasureNumber(canvas, options);
      return {
        canvas,
        baseCanvas: canvas,
        sourceCanvas: source,
        sourceBounds: { top, bottom },
        system,
        rowIndex: index,
        status: completeness.status,
        completeness: clamp(completeness.completeness, 0, 1),
        confidence: clamp(system.score, 0, 1),
        measure,
        quality: frameQuality(canvas),
        candidates: [],
      };
    });
  }

  function rowMeasure(row) {
    const raw =
      row?.measureNumber ??
      row?.measure?.value ??
      row?.measure?.number;
  
    // 没有小节号时必须返回 null，不能让 Number(null) 变成 0
    if (raw == null) return null;
  
    const text = String(raw).trim();
  
    // 只接受正整数小节号
    if (!/^\d{1,4}$/.test(text)) return null;
  
    const number = Number(text);
  
    if (!Number.isInteger(number) || number < 1 || number > 9999) {
      return null;
    }
  
    return number;
  }

  function rowMatchDistance(left, right) {
    if (!left || !right) return 1;
    const leftMeasure = rowMeasure(left);
    const rightMeasure = rowMeasure(right);
    const structure = signatureDistance(left.signature || left.sig, right.signature || right.sig);
    if (leftMeasure != null && rightMeasure != null && leftMeasure === rightMeasure) return structure * .55;
    if (leftMeasure != null && rightMeasure != null && Math.abs(leftMeasure - rightMeasure) > 2) return Math.min(1, structure + .35);
    return structure;
  }

  function findBestOverlap(collected, incoming, options = {}) {
    const maximum = Math.min(collected.length, incoming.length, options.maxOverlap || 10);
    const threshold = options.threshold == null ? .31 : options.threshold;
    let best = { size: 0, score: 1 };
    for (let size = maximum; size >= 1; size -= 1) {
      const distances = [];
      for (let index = 0; index < size; index += 1) distances.push(rowMatchDistance(collected[collected.length - size + index], incoming[index]));
      const score = average(distances);
      if (score <= threshold && Math.max(...distances) <= Math.min(.58, threshold + .2)) return { size, score };
      if (score < best.score) best = { size, score };
    }
    return best.score <= threshold * .82 ? best : { size: 0, score: best.score };
  }

  function sameSequence(left, right, options = {}) {
    if (!left.length || left.length !== right.length) return false;
    const threshold = options.threshold == null ? .19 : options.threshold;
    return left.every((row, index) => rowMatchDistance(row, right[index]) <= threshold);
  }

  function mergeRowSequences(sequences, options = {}) {
    const result = [];
    const warnings = [];
    const pages = sequences || [];
    pages.forEach((sequence, sequenceIndex) => {
      const incoming = (sequence.rows || sequence || []).filter(Boolean).map((row, rowIndex) => ({ ...row, sequenceIndex, sequenceRowIndex: rowIndex }));
      if (!incoming.length) return;
      if (!result.length) {
        result.push(...incoming);
        return;
      }
      if (sameSequence(result.slice(Math.max(0, result.length - incoming.length)), incoming, { threshold: .19 })) {
        warnings.push({ type: 'duplicate-page', sequenceIndex, message: '检测到重复画面，已合并' });
        return;
      }
      const overlap = findBestOverlap(result, incoming, {
        maxOverlap: options.maxOverlap || 10,
        threshold: options.threshold == null ? (.36 - (options.dedupeStrength || .72) * .07) : options.threshold,
      });
      if (!overlap.size) {
        warnings.push({ type: 'gap', sequenceIndex, message: '相邻画面没有可靠重叠，可能漏拍，请在预览中检查' });
        result.push(...incoming);
      } else {
        const overlapped = result.slice(result.length - overlap.size);
        incoming.slice(0, overlap.size).forEach((row, index) => {
          const existing = overlapped[index];
          const candidates = [...(existing.candidates || []), ...(row.candidates || []), existing, row].filter(Boolean);
          existing.candidates = uniqueCandidates(candidates);
          const best = chooseBestCandidate(existing.candidates);
          if (best && best.canvas) {
            Object.assign(existing, best);
            existing.candidates = uniqueCandidates(candidates);
          }
          if (rowMeasure(existing) == null && rowMeasure(row) != null) existing.measureNumber = rowMeasure(row);
          existing.sequenceIndex = Math.min(existing.sequenceIndex ?? sequenceIndex, sequenceIndex);
        });
        result.push(...incoming.slice(overlap.size));
      }
    });
    return { rows: result, warnings };
  }

  function uniqueCandidates(candidates) {
    const result = [];
    candidates.forEach((candidate) => {
      if (!candidate) return;
      const duplicate = result.some((other) => other.canvas && candidate.canvas && signatureDistance(structuralSignature(other.canvas), structuralSignature(candidate.canvas)) < .08);
      if (!duplicate) result.push(candidate);
    });
    return result.slice(0, 8);
  }

  function dedupeRows(rows, options = {}) {
    const lookback = options.lookback || 16;
    const threshold = options.threshold == null ? (.27 - (options.strength || .72) * .06) : options.threshold;
    const output = [];
    const duplicates = [];
    (rows || []).forEach((row) => {
      const signature = row.signature || row.sig || (row.canvas ? structuralSignature(row.canvas) : null);
      row.signature = signature;
      let match = null;
      for (let index = output.length - 1; index >= Math.max(0, output.length - lookback); index -= 1) {
        const candidate = output[index];
        if (rowMeasure(row) != null && rowMeasure(candidate) != null && rowMeasure(row) !== rowMeasure(candidate)) continue;
        if (rowMatchDistance(row, candidate) <= threshold) { match = candidate; break; }
      }
      if (!match) output.push(row);
      else {
        match.candidates = uniqueCandidates([...(match.candidates || []), ...(row.candidates || []), match, row]);
        const best = chooseBestCandidate(match.candidates);
        if (best && best.quality?.score > (match.quality?.score || -Infinity)) Object.assign(match, best);
        duplicates.push({ kept: match, removed: row });
      }
    });
    return { rows: output, duplicates };
  }

  function composeNormalizedCrop(existing, next) {
    const parent = existing || { x: 0, y: 0, width: 1, height: 1 };
    const child = next || { x: 0, y: 0, width: 1, height: 1 };
    const x = clamp(Number(parent.x) + clamp(Number(child.x), 0, 1) * Number(parent.width), 0, 1);
    const y = clamp(Number(parent.y) + clamp(Number(child.y), 0, 1) * Number(parent.height), 0, 1);
    const width = clamp(clamp(Number(child.width), 0, 1) * Number(parent.width), 0, 1 - x);
    const height = clamp(clamp(Number(child.height), 0, 1) * Number(parent.height), 0, 1 - y);
    return { x, y, width, height };
  }

  function resolveRowCropBounds(sourceHeight, topPercent = 0, bottomPercent = 0, baseBounds = null) {
    const height = Math.max(1, Math.round(Number(sourceHeight) || 1));
    const baseTop = baseBounds && Number.isFinite(Number(baseBounds.top))
      ? clamp(Math.round(Number(baseBounds.top)), 0, height - 1)
      : 0;
    const baseBottom = baseBounds && Number.isFinite(Number(baseBounds.bottom))
      ? clamp(Math.round(Number(baseBounds.bottom)), baseTop + 1, height)
      : height;
    const baseHeight = Math.max(1, baseBottom - baseTop);
    const top = clamp(baseTop + Math.round(baseHeight * Number(topPercent || 0) / 100), 0, height - 1);
    const bottom = clamp(baseBottom - Math.round(baseHeight * Number(bottomPercent || 0) / 100), top + 1, height);
    return { top, bottom, height: bottom - top, baseTop, baseBottom };
  }

  function recoverChromaticStaffPeaks(peaks, ink, white, chroma) {
    const result = [...(peaks || [])];
    let start = -1;
    const finish = (end) => {
      if (start < 0) return;
      if (end - start + 1 <= 9) {
        const y = Math.round((start + end) / 2);
        const left = [...result].reverse().find((peak) => peak.y < y);
        const right = result.find((peak) => peak.y > y);
        const leftGap = left ? y - left.y : Infinity;
        const rightGap = right ? right.y - y : Infinity;
        // A playback cursor alone cannot create a staff: require a missing
        // middle line between two existing peaks at nearly equal distances.
        if (leftGap >= 2 && rightGap >= 2 && leftGap <= 18 &&
            Math.abs(leftGap - rightGap) <= 2 &&
            !result.some((peak) => Math.abs(peak.y - y) <= 2)) {
          result.push({ y, support: ink[y], white: white[y], chromatic: true });
        }
      }
      start = -1;
    };
    for (let y = 0; y < chroma.length; y += 1) {
      const covered = chroma[y] >= 0.24 && ink[y] >= 0.12 &&
        ink[y] + white[y] + chroma[y] >= 0.64;
      if (covered) {
        if (start < 0) start = y;
      } else finish(y - 1);
    }
    finish(chroma.length - 1);
    return result.sort((left, right) => left.y - right.y);
  }

  function adjustRowCrop(source, topPercent = 0, bottomPercent = 0, baseBounds = null) {
    if (!source || typeof document === 'undefined') return source;
    const bounds = resolveRowCropBounds(source.height, topPercent, bottomPercent, baseBounds);
    return canvasFromCanvas(source, 0, bounds.top, source.width, bounds.height);
  }

  function orderRows(rows, options = {}) {
    const copy = [...(rows || [])];
    if (!options.useMeasure) return copy;
    return copy.map((row, index) => ({ row, index })).sort((left, right) => {
      const lm = rowMeasure(left.row); const rm = rowMeasure(right.row);
      if (lm == null || rm == null) return left.index - right.index;
      return lm - rm || left.index - right.index;
    }).map((item) => item.row);
  }

  function paginateRows(rows, options = {}) {
    const pageWidth = options.pageWidth || 1240;
    const pageHeight = options.pageHeight || 1754;
    const marginX = options.marginX == null ? 72 : options.marginX;
    const marginY = options.marginY == null ? 64 : options.marginY;
    const header = options.header == null ? 68 : options.header;
    const footer = options.footer == null ? 42 : options.footer;
    const gap = options.rowGap == null ? 18 : options.rowGap;
    const maxRowHeight = options.maxRowHeight || 330;
    const contentWidth = pageWidth - marginX * 2;
    const contentTop = marginY + header;
    const contentBottom = pageHeight - marginY - footer;
    const usableHeight = contentBottom - contentTop;
    const normalized = (rows || []).filter((row) => row && row.canvas).map((row) => {
      const canvas = row.canvas;
      const markerSpace = String(row.sectionMarker || '').trim() ? 42 : 0;
      const imageHeight = Math.min(Math.max(1, maxRowHeight - markerSpace), contentWidth * canvas.height / Math.max(canvas.width, 1));
      const naturalHeight = imageHeight + markerSpace;
      return { row, naturalHeight, imageHeight, markerSpace };
    });
    const pages = [];
    let current = []; let used = 0;
    normalized.forEach((item) => {
      const required = item.naturalHeight + (current.length ? gap : 0);
      if (current.length && used + required > usableHeight) {
        pages.push(current);
        current = [];
        used = 0;
      }
      current.push(item);
      used += item.naturalHeight + (current.length > 1 ? gap : 0);
    });
    if (current.length) pages.push(current);
    // A very short final page is usually the result of one row crossing the
    // boundary. Move it back when the preceding page still has room.
    if (pages.length > 1) {
      const last = pages[pages.length - 1];
      const previous = pages[pages.length - 2];
      const lastHeight = last.reduce((sum, item, index) => sum + item.naturalHeight + (index ? gap : 0), 0);
      const previousHeight = previous.reduce((sum, item, index) => sum + item.naturalHeight + (index ? gap : 0), 0);
      if (lastHeight < usableHeight * .32 && previousHeight + gap + last[0].naturalHeight <= usableHeight) {
        previous.push(last.shift());
        if (!last.length) pages.pop();
      }
    }
    return pages.map((page, pageIndex) => {
      const totalHeight = page.reduce((sum, item, index) => sum + item.naturalHeight + (index ? gap : 0), 0);
      let cursor = contentTop + Math.max(0, (usableHeight - totalHeight) / 2);
      const items = page.map((item) => {
        const scale = Math.min(contentWidth / item.row.canvas.width, item.imageHeight / item.row.canvas.height) * (options.scoreScale || 1);
        const width = Math.min(contentWidth, item.row.canvas.width * scale);
        const height = item.row.canvas.height * width / item.row.canvas.width;
        const x = marginX + (contentWidth - width) / 2;
        const y = cursor + item.markerSpace;
        cursor += item.naturalHeight + gap;
        return { row: item.row, x, y, width, height, markerSpace: item.markerSpace };
      });
      return { pageIndex, items, pageWidth, pageHeight, marginX, marginY, header, footer, contentTop, contentBottom };
    });
  }

  function suggestCaptureRegion(source) {
    const profileData = lineProfile(source, { maxWidth: 480, samples: 300, darkThreshold: 178 });
    if (!profileData) return null;
    const { profile, width, height } = profileData;
    const active = profile.map((value) => value > .018);
    let first = active.findIndex(Boolean);
    let last = active.length - 1 - [...active].reverse().findIndex(Boolean);
    if (first < 0 || last < first) return { x: 0, y: 0, width: source.width, height: source.height };
    const pad = Math.max(10, Math.round((last - first + 1) * .08));
    const scale = source.width / width;
    return {
      x: 0,
      y: clamp((first - pad) * scale, 0, source.height),
      width: source.width,
      height: clamp((last - first + 1 + pad * 2) * scale, 80, source.height),
    };
  }

  return {
    DEFAULTS,
    DIGITS,
    isSingleLineCapture,
    normalizeReviewState,
    clamp,
    average,
    median,
    colorStats,
    structuralSignature,
    signatureDistance,
    sharpness,
    frameQuality,
    chooseBestCandidate,
    groupStableFrames,
    lineProfile,
    detectStaffSystems,
    candidateCompleteness,
    cleanColorArtifacts,
    detectMeasureNumber,
    extractStaffRows,
    rowMeasure,
    rowMatchDistance,
    findBestOverlap,
    mergeRowSequences,
    dedupeRows,
    composeNormalizedCrop,
    adjustRowCrop,
    resolveRowCropBounds,
    recoverChromaticStaffPeaks,
    orderRows,
    paginateRows,
    suggestCaptureRegion,
  };
}));


