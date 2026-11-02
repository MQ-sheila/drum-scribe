(() => {
  'use strict';
  const core = window.DrumScopeCore;

  function cropStaff(row, height, staffOffset) {
    const source = row.sourceCanvas || row.canvas;
    if (!source?.width || !source?.height) return null;
    const staffY = Number.isFinite(row.sourceStaffTop) ? row.sourceStaffTop
      : Number.isFinite(row.sourceBounds?.top) && Number.isFinite(row.staffTop)
        ? row.sourceBounds.top + row.staffTop : row.staffTop;
    if (!Number.isFinite(staffY)) return null;
    const top = Math.round(staffY - staffOffset);
    const from = Math.max(0, top);
    const to = Math.min(source.height, top + height);
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, height);
    if (to > from) context.drawImage(source, 0, from, source.width, to - from,
      0, from - top, canvas.width, to - from);
    return canvas;
  }

  function horizontalStaffEvidence(source, staffTop, spacing) {
    if (!source?.width || !Number.isFinite(staffTop) ||
        !Number.isFinite(spacing)) return false;
    const context = source.getContext('2d', { willReadFrequently: true });
    const width = source.width;
    let supported = 0;
    for (let line = 0; line < 5; line += 1) {
      const center = Math.round(staffTop + line * spacing);
      let strongest = 0;
      for (let y = Math.max(0, center - 3);
        y <= Math.min(source.height - 1, center + 3); y += 1) {
        const pixels = context.getImageData(0, y, width, 1).data;
        let dark = 0;
        for (let x = 0; x < width; x += 4) {
          const offset = x * 4;
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          if (Math.max(red, green, blue) - Math.min(red, green, blue) < 48 &&
              (red * 3 + green * 6 + blue) / 10 < 175) dark += 1;
        }
        strongest = Math.max(strongest, dark);
      }
      if (strongest >= width / 4 * 0.55) supported += 1;
    }
    return supported >= 4;
  }

  function extractHorizontalCaptureRow(source, options = {}, prior = null) {
    const systems = core.detectStaffSystems(source, options) || [];
    let system = systems.reduce((best, item) =>
      !best || item.score > best.score ? item : best, null);
    if (prior && horizontalStaffEvidence(source,
      prior.sourceStaffTop, prior.staffSpacing) &&
      (!system || system.score < 0.5 ||
        Math.abs(system.lines[0] - prior.sourceStaffTop) > 0.5 ||
        Math.abs(system.spacing - prior.staffSpacing) > 0.5)) {
      system = { lines: [0, 1, 2, 3, 4].map((line) =>
        prior.sourceStaffTop + line * prior.staffSpacing),
      spacing: prior.staffSpacing, score: 0.9, supported: 5 };
    }
    if (!system || system.score < 0.5) return [];
    const spacing = system.spacing;
    const top = Math.max(0, Math.round(system.lines[0] - spacing * 7));
    const bottom = Math.min(source.height,
      Math.round(system.lines[4] + spacing * 5));
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = bottom - top;
    canvas.getContext('2d').drawImage(source,
      0, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return [{ canvas, baseCanvas: canvas, sourceCanvas: source,
      sourceInk: options.sourceInk || 'dark',
      sourceBounds: { top, bottom }, sourceStaffTop: system.lines[0],
      sourceStaffBottom: system.lines[4], staffTop: system.lines[0] - top,
      staffBottom: system.lines[4] - top, staffSpacing: spacing,
      system, status: 'complete', completeness: 0.96,
      quality: core.frameQuality(canvas), candidates: [] }];
  }

  function inkSample(canvas, staffOffset, spacing, options = {}) {
    // Keep native horizontal pixels. Downscaling makes a 95 px movement land
    // between sample columns and can falsely match a repeated drum pattern.
    const width = Math.min(1600, canvas.width);
    // The top of a horizontal capture is often blank. Match the notation
    // around the staff, including notes that are incomplete at frame edges.
    const top = Math.max(0, Math.min(canvas.height - 1,
      Math.round(staffOffset - spacing * 4)));
    const height = Math.min(96, canvas.height - top);
    const reduced = document.createElement('canvas');
    reduced.width = width;
    reduced.height = height;
    const context = reduced.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, 0, top, width, height, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const bits = new Uint8Array(width * height);
    const tinted = new Uint16Array(width);
    for (let index = 0; index < bits.length; index += 1) {
      const offset = index * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      // A blue playback cursor masks the notes underneath it. Exclude its
      // columns from overlap matching instead of treating them as new music.
      if ((blue > red + 10 && blue > green + 3) ||
          (green > red + 18 && green > blue + 4)) tinted[index % width] += 1;
      bits[index] = Math.max(red, green, blue) - Math.min(red, green, blue) < 48 &&
        (red * 3 + green * 6 + blue) / 10 <
        (options.lightOverlay ? 95 : 175) ? 1 : 0;
    }
    const maskedColumns = new Uint8Array(width);
    for (let x = 0; x < width; x += 1) {
      if (tinted[x] >= Math.max(3, height * 0.12)) maskedColumns[x] = 1;
    }
    return { bits, maskedColumns, width, height };
  }

  function neutralizePlaybackCursor(canvas, maskedColumns) {
    if (!maskedColumns) return;
    const expandedMask = new Uint8Array(canvas.width);
    for (let x = 0; x < Math.min(canvas.width, maskedColumns.length); x += 1) {
      if (!maskedColumns[x]) continue;
      for (let xx = Math.max(0, x - 8);
        xx <= Math.min(canvas.width - 1, x + 8); xx += 1) expandedMask[xx] = 1;
    }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = image.data;
    const backgroundSamples = [
      pixels[(canvas.height - 1) * canvas.width * 4],
      pixels[((canvas.height - 1) * canvas.width + canvas.width - 1) * 4],
      pixels[0], pixels[(canvas.width - 1) * 4],
    ].sort((a, b) => a - b);
    const background = (backgroundSamples[1] + backgroundSamples[2]) / 2;
    let changed = false;
    for (let x = 0; x < canvas.width; x += 1) {
      if (!expandedMask[x]) continue;
      const tintedBackground = [];
      for (let y = 0; y < canvas.height; y += 1) {
        const index = (y * canvas.width + x) * 4;
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        if (red > 150 && blue >= red + 4 && blue >= green + 2) {
          tintedBackground.push(red);
        }
      }
      tintedBackground.sort((a, b) => a - b);
      const tintBase = tintedBackground.length
        ? tintedBackground[Math.floor(tintedBackground.length / 2)] : background;
      const correction = background / Math.max(1, tintBase);
      for (let y = 0; y < canvas.height; y += 1) {
        const index = (y * canvas.width + x) * 4;
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        const blueTint = blue >= red + 4 && blue >= green + 2;
        const greenTint = green > red + 14 && green > blue + 3;
        if (!blueTint && !greenTint) continue;
        const neutral = greenTint && red < 160 ? Math.max(0, red - 30)
          : Math.min(background, Math.max(0, Math.round(red * correction)));
        pixels[index] = neutral;
        pixels[index + 1] = neutral;
        pixels[index + 2] = neutral;
        changed = true;
      }
    }
    if (changed) context.putImageData(image, 0, 0);
  }

  // Positive shift means the score moved left and new notation appeared on the right.
  function matchHorizontalScroll(previous, current, expectedShift = null, options = {}) {
    if (!previous || !current || previous.width !== current.width ||
        previous.height !== current.height) return null;
    const { width, height } = previous;
    const usable = new Uint8Array(height);
    for (let y = 2; y < height - 2; y += 2) {
      let first = 0;
      let second = 0;
      for (let x = 0; x < width; x += 2) {
        first += previous.bits[y * width + x];
        second += current.bits[y * width + x];
      }
      usable[y] = first < width * 0.34 && second < width * 0.34 ? 1 : 0;
    }
    const lightOverlay = options.lightOverlay === true;
    const score = (shift, step) => {
      let different = 0;
      let ink = 0;
      // Video movement behind white notation contaminates the right half of
      // many captures. Compare the clean left part of the score in that mode.
      const end = Math.min(width - shift - 3,
        lightOverlay ? Math.round(width * 0.44) : width);
      for (let y = 2; y < height - 2; y += step) {
        if (!usable[y]) continue;
        const base = y * width;
        for (let x = 3; x < end; x += step) {
          if (previous.maskedColumns?.[x + shift] ||
              current.maskedColumns?.[x]) continue;
          const a = previous.bits[base + x + shift];
          const b = current.bits[base + x];
          different += a ^ b;
          ink += a | b;
        }
      }
      if (ink < Math.max(8, end * 0.04 / step)) return Infinity;
      const motionPenalty = expectedShift == null ? 0
        : Math.abs(shift - expectedShift) / width * 0.07;
      return different / ink + shift / width * 0.045 + motionPenalty;
    };
    // Video sampling can advance by almost a full screen. Keep a small but
    // useful overlap instead of treating every large movement as a new line.
    const maximum = Math.floor(width * (lightOverlay ? 0.35 : 0.94));
    const coarse = [];
    if (expectedShift != null) {
      const radius = Math.max(24, Math.round(expectedShift * 0.4));
      for (let shift = Math.max(0, Math.round(expectedShift) - radius);
        shift <= Math.min(maximum, Math.round(expectedShift) + radius); shift += 1) {
        coarse.push({ shift, value: score(shift, 4) });
      }
    }
    const localBest = coarse.reduce((best, item) =>
      item.value < best.value ? item : best,
    { shift: 0, value: Infinity });
    if (lightOverlay || localBest.value > 0.15) {
      coarse.length = 0;
      for (let shift = 0; shift <= maximum; shift += 1) {
        coarse.push({ shift, value: score(shift, 4) });
      }
    }
    coarse.sort((a, b) => a.value - b.value || a.shift - b.shift);
    let best = { shift: 0, value: Infinity };
    const seeds = coarse.slice(0, 6);
    if (lightOverlay && expectedShift != null) {
      const radius = Math.max(24, Math.round(expectedShift * 0.4));
      const near = coarse.filter((item) =>
        Math.abs(item.shift - expectedShift) <= radius).slice(0, 3);
      // A repeating drum rhythm can make a different measure look slightly
      // better than the real overlap. Preserve the measured scroll speed when
      // its visual score is close to the global best.
      if (near.length && near[0].value <= coarse[0].value + 0.11) {
        seeds.splice(0, seeds.length, ...near);
      }
    }
    if (expectedShift != null) seeds.push({ shift: Math.round(expectedShift) });
    for (const candidate of seeds) {
      for (let shift = Math.max(0, candidate.shift - 4);
        shift <= Math.min(maximum, candidate.shift + 4); shift += 1) {
        const value = score(shift, 2);
        if (value < best.value - 0.002 ||
            (Math.abs(value - best.value) <= 0.002 && shift < best.shift)) {
          best = { shift, value };
        }
      }
    }
    const confidenceLimit = lightOverlay
      ? (expectedShift == null ? 0.55 : 0.82)
      : best.shift > width * 0.68 ? 0.22 : 0.35;
    if (best.value <= confidenceLimit) return best;
    if (lightOverlay) return null;
    // A static opening can jump suddenly to the next score strip. The old
    // motion estimate must not veto a strong visual overlap after that jump.
    return expectedShift == null ? null
      : matchHorizontalScroll(previous, current, null, options);
  }

  function drawHorizontalPieces(stream, context, start, end) {
    stream.pieces.forEach((piece) => {
      const left = Math.max(start, piece.left);
      const right = Math.min(end, piece.left + piece.width);
      if (right > left) context.drawImage(piece.canvas,
        piece.sourceX + left - piece.left, 0, right - left, stream.height,
        left - start, 0, right - left, stream.height);
    });
  }

  function justificationSpacers(source, stream, extraWidth, preserveLeft = 0) {
    const spacing = stream.staffSpacing;
    const staffTop = stream.staffOffset;
    const uniform = !!stream.layoutWidth;
    const wanted = Math.ceil(extraWidth /
      (uniform ? Math.max(12, spacing * 1.2) : Math.max(18, spacing * 2.4)));
    const count = Math.min(wanted,
      Math.floor(source.width / (uniform
        ? Math.max(12, spacing * 1.5) : Math.max(24, spacing * 4))));
    if (count < 2) return [];
    const context = source.getContext('2d', { willReadFrequently: true });
    const pixels = context.getImageData(0, 0, source.width, source.height).data;
    const staffLine = (y) => [0, 1, 2, 3, 4].some((line) =>
      Math.abs(y - (staffTop + line * spacing)) <= 3);
    const dark = (x, y) => {
      const offset = (y * source.width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      return Math.max(red, green, blue) - Math.min(red, green, blue) < 48 &&
        (red * 3 + green * 6 + blue) / 10 < 150;
    };
    const clearColumn = (x) => {
      // Staff lines and a long, level beam may be lengthened safely. Stems,
      // noteheads, lyrics, accents and slurs must retain their source pixels.
      for (let probe = x - (uniform ? 1 : 3);
        probe <= x + (uniform ? 1 : 3); probe += 1) {
        if (probe < 0 || probe >= source.width) return false;
        const lineInk = [0, 0, 0, 0, 0];
        let darkRun = 0;
        const top = uniform ? Math.max(2, Math.floor(staffTop - spacing * 3)) : 2;
        const bottom = uniform ? Math.min(source.height - 2,
          Math.ceil(staffTop + spacing * 6)) : source.height - 2;
        for (let y = top; y < bottom; y += 1) {
          if (!dark(probe, y)) { darkRun = 0; continue; }
          darkRun += 1;
          if (staffLine(y)) {
            const line = Math.round((y - staffTop) / spacing);
            lineInk[line] += 1;
            if (lineInk[line] > 4) return false;
          } else if (darkRun > 6 || probe < 6 ||
              probe >= source.width - 6 ||
              (uniform && y >= staffTop - spacing * 1.2 &&
                y <= staffTop + spacing * 5.5) ||
              (!uniform && (!dark(probe - 6, y) || !dark(probe + 6, y))) ||
              (uniform && y < staffTop - spacing * 1.2 &&
                (!dark(probe - 6, y) || !dark(probe + 6, y)))) return false;
        }
      }
      return true;
    };
    const spacers = [];
    const radius = Math.max(8, Math.floor(source.width / (count + 1) *
      (uniform ? .5 : .36)));
    for (let i = 0; i < count; i += 1) {
      const target = source.width * (i + 1) / (count + 1);
      let bestX = -1;
      let bestScore = Infinity;
      for (let x = Math.max(Math.ceil(spacing * 3), Math.round(target - radius));
        x <= Math.min(source.width - Math.ceil(spacing * 3),
          Math.round(target + radius)); x += 1) {
        if (x < preserveLeft) continue;
        if (spacers.length && x - spacers[spacers.length - 1] <
          spacing * (uniform ? 1.5 : 3)) continue;
        if (!clearColumn(x)) continue;
        const score = Math.abs(x - target);
        if (score < bestScore) {
          bestScore = score;
          bestX = x;
        }
      }
      if (bestX >= 0) spacers.push(bestX);
    }
    return spacers;
  }

  function compactHorizontalNotes(source, stream, targetWidth) {
    const remove = source.width - targetWidth;
    if (remove <= 0 || remove > source.width * .11) return null;
    const pixels = source.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, source.width, source.height).data;
    const dark = (x, y) => {
      const offset = (y * source.width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      return Math.max(red, green, blue) - Math.min(red, green, blue) < 48 &&
        (red * 3 + green * 6 + blue) / 10 < 150;
    };
    const spacing = stream.staffSpacing;
    const candidates = [];
    for (let x = Math.ceil(spacing * 3); x < source.width - spacing * 3; x += 1) {
      let verticalInk = 0;
      let run = 0;
      let safe = true;
      for (let y = 2; y < source.height - 2; y += 1) {
        if (!dark(x, y)) { run = 0; continue; }
        verticalInk += 1;
        run += 1;
        const staffLine = [0, 1, 2, 3, 4].some((line) =>
          Math.abs(y - (stream.staffOffset + line * spacing)) <= 3);
        if (run > 5 || verticalInk > 20 ||
            (!staffLine && (!dark(x - 5, y) || !dark(x + 5, y)))) {
          safe = false;
          break;
        }
      }
      if (safe) candidates.push(x);
    }
    if (candidates.length < remove * 2) return null;
    const selected = [];
    for (let i = 0; i < remove; i += 1) {
      const x = candidates[Math.floor((i + .5) * candidates.length / remove)];
      if (selected.length && x - selected[selected.length - 1] < 2) return null;
      selected.push(x);
    }
    const result = document.createElement('canvas');
    result.width = targetWidth;
    result.height = source.height;
    const context = result.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, result.width, result.height);
    let from = 0;
    let to = 0;
    for (const x of selected) {
      const width = x - from;
      if (width) context.drawImage(source, from, 0, width, source.height,
        to, 0, width, source.height);
      to += width;
      from = x + 1;
    }
    if (from < source.width) context.drawImage(source, from, 0,
      source.width - from, source.height, to, 0,
      source.width - from, source.height);
    return result;
  }

  function horizontalRowPrefix(stream, start) {
    return start > 0 && start !== stream.firstStart
      ? Math.max(40, Math.round(stream.staffSpacing * 4.5)) : 0;
  }

  function decorateHorizontalRow(canvas, stream, start, end) {
    const spacing = stream.staffSpacing;
    const prefix = horizontalRowPrefix(stream, start);
    const decorated = document.createElement('canvas');
    decorated.width = canvas.width + prefix;
    decorated.height = canvas.height;
    const context = decorated.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, decorated.width, decorated.height);
    context.drawImage(canvas, prefix, 0);
    const pixels = canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const lineYs = Array.from({ length: 5 }, (_, line) => {
      const expected = stream.staffOffset + line * spacing;
      let bestY = Math.round(expected);
      let bestInk = -1;
      for (let y = Math.max(0, Math.round(expected - 5));
        y <= Math.min(canvas.height - 1, Math.round(expected + 5)); y += 1) {
        let ink = 0;
        for (let x = 0; x < Math.min(canvas.width, 300); x += 3) {
          const offset = (y * canvas.width + x) * 4;
          if (pixels[offset] < 150) ink += 1;
        }
        if (ink > bestInk) { bestInk = ink; bestY = y; }
      }
      return bestY;
    });
    context.fillStyle = '#171717';
    if (prefix) {
      for (const y of lineYs) context.fillRect(3, y, prefix + 1, 1);
      const clefTop = lineYs[0] + spacing * .7;
      const clefHeight = lineYs[4] - lineYs[0] - spacing * 1.4;
      context.fillRect(Math.round(prefix * .32), Math.round(clefTop),
        Math.max(3, Math.round(spacing * .28)), Math.round(clefHeight));
      context.fillRect(Math.round(prefix * .50), Math.round(clefTop),
        Math.max(3, Math.round(spacing * .28)), Math.round(clefHeight));
      context.fillRect(prefix - 1, lineYs[0], 1, lineYs[4] - lineYs[0] + 1);
    }
    if (stream.barlineCuts?.some((x) => Math.abs(x - end) <= spacing * .75) ||
        stream.sectionBreakEnds?.some((x) => Math.abs(x - end) <= 1)) {
      let lastInk = canvas.width - 1;
      while (lastInk > 0) {
        const offset = (lineYs[2] * canvas.width + lastInk) * 4;
        if (pixels[offset] < 150) break;
        lastInk -= 1;
      }
      const boundary = Math.min(decorated.width - 2, prefix + lastInk + 3);
      for (const y of lineYs) context.fillRect(prefix + lastInk, y,
        boundary - prefix - lastInk + 1, 1);
      context.fillRect(boundary, lineYs[0], 2,
        lineYs[4] - lineYs[0] + 1);
    }
    return decorated;
  }

  function extendHorizontalTail(context, natural, stream, end,
      contentEnd, targetWidth) {
    if (contentEnd >= targetWidth) return;
    const spacing = stream.staffSpacing;
    const boundary = stream.barlineCuts?.some((cut) =>
      Math.abs(cut - end) <= spacing * .75) ||
      stream.sectionBreakEnds?.some((cut) => Math.abs(cut - end) <= 1);
    const strip = boundary ? Math.min(4, natural.width) : 0;
    const from = contentEnd - strip;
    context.fillStyle = '#fff';
    context.fillRect(from, 0, targetWidth - from, natural.height);
    context.fillStyle = '#171717';
    for (let line = 0; line < 5; line += 1) {
      const y = Math.round(stream.staffOffset + line * spacing);
      context.fillRect(from, y, targetWidth - from - strip, 1);
    }
    if (strip) context.drawImage(natural, natural.width - strip, 0,
      strip, natural.height, targetWidth - strip, 0,
      strip, natural.height);
  }

  function justifyHorizontalMeasures(natural, stream, start, end, targetWidth) {
    const spacing = stream.staffSpacing;
    const boundaries = [start, ...(stream.barlineCuts || []).filter((cut) =>
      cut > start + spacing * 3 && cut < end - spacing * 3), end];
    const measureCount = boundaries.length - 1;
    if (targetWidth <= natural.width) return null;
    const totalExtra = targetWidth - natural.width;
    if (totalExtra <= 0) return null;
    const result = document.createElement('canvas');
    result.width = natural.width + totalExtra;
    result.height = natural.height;
    const output = result.getContext('2d');
    output.fillStyle = '#fff';
    output.fillRect(0, 0, result.width, result.height);
    const each = Math.floor(totalExtra / measureCount);
    let destination = 0;
    for (let index = 0; index < measureCount; index += 1) {
      const left = boundaries[index] - start;
      const width = boundaries[index + 1] - boundaries[index];
      const extra = each + (index < totalExtra % measureCount ? 1 : 0);
      const part = document.createElement('canvas');
      part.width = width;
      part.height = natural.height;
      part.getContext('2d').drawImage(natural, left, 0, width,
        natural.height, 0, 0, width, natural.height);
      const justified = document.createElement('canvas');
      justified.width = width + extra;
      justified.height = natural.height;
      const context = justified.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, justified.width, justified.height);
      const preserve = index === 0 && start === stream.firstStart
        ? spacing * 7 : spacing * 3;
      const spacers = extra > 0
        ? balancedMeasureSpacers(part, stream, extra, preserve) : [];
      const distributed = extra;
      let sourceX = 0;
      let targetX = 0;
      spacers.forEach((split, spacerIndex) => {
        const blockWidth = split - sourceX;
        if (blockWidth) context.drawImage(part, sourceX, 0,
          blockWidth, part.height, targetX, 0,
          blockWidth, part.height);
        targetX += blockWidth;
        const insertion = Math.floor(distributed / spacers.length) +
          (spacerIndex < distributed % spacers.length ? 1 : 0);
        context.drawImage(part, split, 0, 1, part.height,
          targetX, 0, insertion, part.height);
        targetX += insertion;
        sourceX = split;
      });
      context.drawImage(part, sourceX, 0, part.width - sourceX,
        part.height, targetX, 0, part.width - sourceX, part.height);
      const contentEnd = targetX + part.width - sourceX;
      if (contentEnd < justified.width) {
        extendHorizontalTail(context, part, stream, boundaries[index + 1],
          contentEnd, justified.width);
      }
      output.drawImage(justified, destination, 0);
      destination += justified.width;
    }
    return result;
  }

  function balancedMeasureSpacers(source, stream, extra, preserve) {
    const spacing = stream.staffSpacing;
    const first = Math.max(3, Math.round(preserve));
    const last = source.width - 4;
    const length = last - first;
    if (length < 8) return [];
    const minimumGap = Math.max(8, Math.round(spacing * 1.2));
    const count = Math.max(1, Math.min(
      Math.ceil(extra / Math.max(16, spacing * 1.8)),
      Math.floor(length / minimumGap)));
    const pixels = source.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, source.width, source.height).data;
    const top = Math.max(0, Math.round(stream.staffOffset - spacing * 3));
    const bottom = Math.min(source.height - 1,
      Math.round(stream.staffOffset + spacing * 6));
    const scores = new Uint16Array(source.width);
    for (let x = first; x <= last; x += 1) {
      let score = 0;
      for (let y = top; y <= bottom; y += 1) {
        if ([0, 1, 2, 3, 4].some((line) =>
          Math.abs(y - stream.staffOffset - line * spacing) <= 1)) continue;
        const offset = (y * source.width + x) * 4;
        if ((pixels[offset] * 3 + pixels[offset + 1] * 6 +
            pixels[offset + 2]) / 10 < 110) score += 1;
      }
      scores[x] = score;
    }
    const positions = [];
    const interval = length / (count + 1);
    for (let index = 1; index <= count; index += 1) {
      const target = first + interval * index;
      const low = Math.max(first, Math.round(target - interval * .38),
        (positions[positions.length - 1] || first - minimumGap) + minimumGap);
      const high = Math.min(last, Math.round(target + interval * .38));
      let best = -1;
      let bestScore = Infinity;
      for (let x = low; x <= high; x += 1) {
        const score = scores[x] + Math.abs(x - target) * .08;
        if (score < bestScore) { best = x; bestScore = score; }
      }
      if (best >= 0) positions.push(best);
    }
    return positions;
  }

  function renderHorizontalRange(stream, start, end, raw = false) {
    const naturalWidth = Math.max(1, end - start);
    const natural = document.createElement('canvas');
    natural.width = naturalWidth;
    natural.height = stream.height;
    const naturalContext = natural.getContext('2d');
    naturalContext.fillStyle = '#fff';
    naturalContext.fillRect(0, 0, natural.width, natural.height);
    drawHorizontalPieces(stream, naturalContext, start, end);
    if (raw) return natural;
    const finish = (canvas) => {
      const decorated = decorateHorizontalRow(canvas, stream, start, end);
      return core.binarizeNotation(decorated,
        stream.sourceInk === 'light-overlay' ? 80 : 160);
    };
    const sectionEnd = stream.sectionRowEnds?.some((cut) =>
      Math.abs(cut - end) <= 1);
    const availableWidth = stream.layoutWidth
      ? Math.max(1, stream.layoutWidth - horizontalRowPrefix(stream, start))
      : 0;
    // A nearly full section-ending row still benefits from even spacing.
    // Leave only clearly short endings at their natural width.
    const justify = !!stream.layoutWidth &&
      (!sectionEnd || naturalWidth > availableWidth * 2 / 3);
    const bodyWidth = stream.layoutWidth && justify
      ? availableWidth
      : (stream.layoutWidth ? naturalWidth : stream.targetWidth);
    const compacted = naturalWidth > bodyWidth
      ? compactHorizontalNotes(natural, stream, bodyWidth) : null;
    if (compacted) return finish(compacted);
    if (stream.layoutWidth && bodyWidth > naturalWidth && justify) {
      const justified = justifyHorizontalMeasures(natural, stream,
        start, end, bodyWidth);
      if (justified) return finish(justified);
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(bodyWidth, naturalWidth);
    canvas.height = stream.height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const extraWidth = canvas.width - naturalWidth;
    const spacers = extraWidth > 0 && naturalWidth >= canvas.width * 0.52
      ? justificationSpacers(natural, stream, extraWidth,
        start === (stream.firstStart || 0) ? naturalWidth * .38 : 0) : [];
    if (!spacers.length) {
      context.drawImage(natural, 0, 0);
      if (stream.layoutWidth && extraWidth > 0) {
        extendHorizontalTail(context, natural, stream, end, naturalWidth,
          canvas.width);
      }
      return finish(canvas);
    }
    // Stretch only low-ink columns, distributing the change across the row.
    // Noteheads and stems keep their source pixels and aspect ratio.
    const spare = stream.layoutWidth ? Math.min(extraWidth,
      spacers.length * 28) : Math.min(extraWidth,
      spacers.length * Math.round(stream.staffSpacing * 3));
    const each = Math.floor(spare / spacers.length);
    let sourceX = 0;
    let destinationX = 0;
    spacers.forEach((split, index) => {
      const width = split - sourceX;
      context.drawImage(natural, sourceX, 0, width, natural.height,
        destinationX, 0, width, natural.height);
      destinationX += width;
      const insertion = each + (index < spare % spacers.length ? 1 : 0);
      context.drawImage(natural, split, 0, 1, natural.height,
        destinationX, 0, insertion, natural.height);
      destinationX += insertion;
      sourceX = split;
    });
    context.drawImage(natural, sourceX, 0, natural.width - sourceX,
      natural.height, destinationX, 0,
      natural.width - sourceX, natural.height);
    if (stream.layoutWidth && spare < extraWidth) {
      extendHorizontalTail(context, natural, stream, end,
        destinationX + natural.width - sourceX, canvas.width);
    }
    return finish(canvas);
  }

  function safeOverlapSeam(previous, current, overlap, staffOffset, spacing,
      previousSample, currentSample) {
    if (overlap < 12) return Math.floor(overlap / 2);
    const left = previous.getContext('2d', { willReadFrequently: true })
      .getImageData(previous.width - overlap, 0, overlap, previous.height).data;
    const right = current.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, overlap, current.height).data;
    let best = Math.floor(overlap / 2);
    let bestScore = Infinity;
    const from = Math.max(3, Math.floor(overlap * 0.12));
    const to = Math.min(overlap - 3, Math.ceil(overlap * 0.88));
    for (let x = from; x <= to; x += 1) {
      const coveredNear = (mask, center) => {
        if (!mask) return false;
        for (let offset = -10; offset <= 10; offset += 1) {
          if (mask[center + offset]) return true;
        }
        return false;
      };
      if (coveredNear(previousSample?.maskedColumns,
        previous.width - overlap + x) ||
          coveredNear(currentSample?.maskedColumns, x)) continue;
      let ink = 0;
      for (let y = 2; y < previous.height - 2; y += 2) {
        if ([0, 1, 2, 3, 4].some((line) =>
          Math.abs(y - (staffOffset + line * spacing)) <= 1)) continue;
        const offset = (y * overlap + x) * 4;
        for (const data of [left, right]) {
          const red = data[offset];
          const green = data[offset + 1];
          const blue = data[offset + 2];
          if (Math.max(red, green, blue) - Math.min(red, green, blue) < 48 &&
              (red * 3 + green * 6 + blue) / 10 < 170) ink += 1;
        }
      }
      const score = ink + Math.abs(x - overlap / 2) * 0.002;
      if (score < bestScore) { bestScore = score; best = x; }
    }
    return best;
  }

  function restoreCursorCoveredColumns(pieces, streamWidth, overlap,
      current, currentSample) {
    const overlapStart = streamWidth - overlap;
    for (const piece of pieces) {
      if (!piece.maskedColumns) continue;
      const from = Math.max(piece.left, overlapStart);
      const to = Math.min(piece.left + piece.width, streamWidth);
      if (to <= from) continue;
      const context = piece.canvas.getContext('2d');
      for (let globalX = from; globalX < to; globalX += 1) {
        const sourceX = globalX - overlapStart;
        const targetX = globalX - piece.left + piece.sourceX;
        if (!piece.maskedColumns[targetX] ||
            currentSample.maskedColumns?.[sourceX]) continue;
        context.drawImage(current, sourceX, 0, 1, current.height,
          targetX, 0, 1, piece.canvas.height);
        piece.maskedColumns[targetX] = 0;
      }
    }
  }

  function restoreNewStripFromPrevious(pieces, strip, seam, overlap,
      streamWidth, currentSample) {
    const context = strip.getContext('2d');
    const mask = currentSample.maskedColumns?.slice(seam);
    if (!mask) return null;
    for (let x = seam; x < overlap; x += 1) {
      if (!mask[x - seam]) continue;
      const globalX = streamWidth - overlap + x;
      const piece = pieces.find((item) => item.left <= globalX &&
        globalX < item.left + item.width &&
        !item.maskedColumns?.[globalX - item.left + item.sourceX]);
      if (!piece) continue;
      const sourceX = globalX - piece.left + piece.sourceX;
      context.drawImage(piece.canvas, sourceX, 0, 1, piece.canvas.height,
        x - seam, 0, 1, strip.height);
      mask[x - seam] = 0;
    }
    return mask;
  }

  function detectBarlineCuts(stream, staffOffset, spacing) {
    const cuts = [];
    const first = Math.max(0, staffOffset + 2);
    const last = Math.min(stream.height - 1, staffOffset + spacing * 4 - 2);
    for (let start = 0; start < stream.width; start += 512) {
      const end = Math.min(stream.width, start + 512);
      const canvas = document.createElement('canvas');
      canvas.width = end - start;
      canvas.height = stream.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      drawHorizontalPieces(stream, context, start, end);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let x = 1; x < canvas.width - 1; x += 1) {
        let dark = 0;
        for (let y = first; y <= last; y += 1) {
          const offset = (y * canvas.width + x) * 4;
          const red = data[offset];
          const green = data[offset + 1];
          const blue = data[offset + 2];
          if (Math.max(red, green, blue) - Math.min(red, green, blue) < 48 &&
              (red * 3 + green * 6 + blue) / 10 < 155) dark += 1;
        }
        if (dark / Math.max(1, last - first + 1) < 0.94) continue;
        // A bass-note stem can cross nearly the whole staff. A true barline
        // stops at the staff, whereas that stem continues up into its beam.
        let aboveInk = 0;
        for (let y = Math.max(0, Math.round(staffOffset - spacing * 3.5));
          y < Math.max(0, Math.round(staffOffset - spacing * .5)); y += 1) {
          const offset = (y * canvas.width + x) * 4;
          if (data[offset] < 155 &&
              Math.max(data[offset], data[offset + 1], data[offset + 2]) -
              Math.min(data[offset], data[offset + 1], data[offset + 2]) < 48) aboveInk += 1;
        }
        if (aboveInk > spacing * 1.25) continue;
        // A note stem can also span the staff without reaching the beam above.
        // Its notehead widens the ink to one side of the stem; a barline stays
        // narrow between staff lines. Ignore staff lines while probing sides.
        const radius = Math.max(5, Math.round(spacing * .45));
        const sideThreshold = Math.max(3, Math.round(spacing * .2));
        let headRows = 0;
        const headBottom = Math.min(stream.height - 1,
          Math.round(staffOffset + spacing * 4.35));
        for (let y = Math.max(0, Math.round(staffOffset + spacing * .3));
          y <= headBottom; y += 1) {
          if (Array.from({ length: 5 }, (_, line) =>
            staffOffset + line * spacing).some((line) => Math.abs(y - line) <= 2)) continue;
          let left = 0;
          let right = 0;
          for (let delta = 3; delta <= radius; delta += 1) {
            for (const [side, count] of [[-1, 0], [1, 1]]) {
              const near = x + side * delta;
              if (near < 0 || near >= canvas.width) continue;
              const at = (y * canvas.width + near) * 4;
              if (Math.max(data[at], data[at + 1], data[at + 2]) -
                  Math.min(data[at], data[at + 1], data[at + 2]) < 48 &&
                  (data[at] * 3 + data[at + 1] * 6 + data[at + 2]) / 10 < 155) {
                if (count === 0) left += 1;
                else right += 1;
              }
            }
          }
          if (Math.max(left, right) >= sideThreshold) headRows += 1;
          if (headRows >= 5) break;
        }
        if (headRows >= 5) continue;
        const cut = start + x + 2;
        if (!cuts.length || cut - cuts[cuts.length - 1] > spacing) cuts.push(cut);
      }
    }
    return cuts;
  }

  function noteBearingMeasures(stream, staffOffset, spacing) {
    const points = [0, ...stream.barlineCuts, stream.width];
    const measures = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const start = points[i];
      const end = points[i + 1];
      if (end - start < spacing * 10) continue;
      const canvas = document.createElement('canvas');
      canvas.width = end - start;
      canvas.height = stream.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      drawHorizontalPieces(stream, context, start, end);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      const first = Math.max(0, Math.round(staffOffset - spacing * 4));
      const last = Math.min(canvas.height, Math.round(staffOffset + spacing * 6));
      for (let y = first; y < last; y += 2) {
        if ([0, 1, 2, 3, 4].some((line) =>
          Math.abs(y - (staffOffset + line * spacing)) <= 3)) continue;
        for (let x = 0; x < canvas.width; x += 2) {
          const offset = (y * canvas.width + x) * 4;
          if (pixels[offset] < 150 &&
              Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) -
              Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 48) ink += 1;
        }
      }
      if (ink * 4 / (end - start) > 8) measures.push((start + end) / 2);
    }
    return measures;
  }

  // Only a complete, dark rectangular marker above the staff is trusted as a
  // section start. Ordinary text, tempo marks, and note stems stay untouched.
  function detectBoxedSections(stream, staffOffset, spacing) {
    const found = [];
    const step = 512;
    const overlap = Math.max(120, spacing * 10);
    for (let start = 0; start < stream.width; start += step) {
      const end = Math.min(stream.width, start + step + overlap);
      const probe = document.createElement('canvas');
      probe.width = end - start;
      probe.height = Math.min(stream.height, Math.max(1, staffOffset - spacing));
      const context = probe.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, probe.width, probe.height);
      drawHorizontalPieces(stream, context, start, end);
      const data = context.getImageData(0, 0, probe.width, probe.height).data;
      const dark = (x, y) => {
        const offset = (y * probe.width + x) * 4;
        return (data[offset] * 3 + data[offset + 1] * 6 + data[offset + 2]) / 10 < 135 &&
          Math.max(data[offset], data[offset + 1], data[offset + 2]) -
          Math.min(data[offset], data[offset + 1], data[offset + 2]) < 48;
      };
      for (let y = 2; y < probe.height - spacing * 2; y += 1) {
        for (let x = 2; x < probe.width - spacing * 2; x += 1) {
          if (!dark(x, y) || dark(x - 1, y)) continue;
          let right = x;
          while (right < probe.width - 2 && dark(right, y)) right += 1;
          const width = right - x;
          if (width < spacing * 2 || width > spacing * 4.6) continue;
          for (let bottom = y + spacing * 2; bottom < Math.min(probe.height - 1, y + spacing * 6); bottom += 1) {
            const height = bottom - y;
            if (height < spacing * 2.4 || height > spacing * 4.8 ||
                Math.abs(width - height) > spacing * 1.4) continue;
            let bottomInk = 0;
            let leftInk = 0;
            let rightInk = 0;
            for (let xx = x; xx < right; xx += 2) bottomInk += dark(xx, bottom) ? 1 : 0;
            for (let yy = y; yy <= bottom; yy += 2) {
              leftInk += dark(x, yy) || dark(x + 1, yy) ? 1 : 0;
              rightInk += dark(right - 1, yy) || dark(right, yy) ? 1 : 0;
            }
            if (bottomInk >= width * .35 &&
                leftInk >= (bottom - y) * .35 && rightInk >= (bottom - y) * .35) {
              // A boxed section letter ends above the staff. Beamed notes
              // often form a similar rectangle, but their stems continue
              // below its lower edge.
              let belowInk = 0;
              let belowSamples = 0;
              for (let yy = bottom + 3;
                yy < Math.min(probe.height, bottom + spacing * 1.5); yy += 2) {
                for (let xx = x + 2; xx < right - 2; xx += 2) {
                  belowInk += dark(xx, yy) ? 1 : 0;
                  belowSamples += 1;
                }
              }
              if (belowSamples && belowInk / belowSamples > .04) continue;
              const globalX = start + x;
              if (globalX > spacing * 3 && !found.some((value) => Math.abs(value - globalX) < spacing * 6)) {
                found.push(globalX);
              }
              break;
            }
          }
          x = right;
        }
      }
    }
    return found.sort((a, b) => a - b);
  }

  // Called only by the explicit horizontal mode. Each capture contributes only
  // its newly exposed right strip; stationary frames contribute no extra row.
  function hasLightScoreBackground(canvas) {
    const data = canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let light = 0;
    let total = 0;
    for (let y = 4; y < canvas.height - 4; y += 8) {
      for (let x = 4; x < canvas.width - 4; x += 8) {
        const offset = (y * canvas.width + x) * 4;
        if (data[offset] > 215 && data[offset + 1] > 215 &&
            data[offset + 2] > 215) light += 1;
        total += 1;
      }
    }
    return light / Math.max(1, total) > .25;
  }

  function horizontalStitchLimits(overlap) {
    return {
      min: Math.max(3, Math.floor(overlap * .12)),
      max: Math.min(overlap - 3, Math.ceil(overlap * .88)),
    };
  }

  function fuseLightOverlayStream(stream, resolvedRows = null) {
    if (stream.frames.length < 3 ||
        (stream.sourceInk || stream.frames[0].row.sourceInk) !== 'light-overlay') return;
    const sourcePieces = stream.pieces;
    const outputPieces = [];
    const cache = new Map();
    const height = stream.height;
    for (let left = 0; left < stream.width; left += 512) {
      const right = Math.min(stream.width, left + 512);
      const width = right - left;
      const output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      const context = output.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      drawHorizontalPieces({ pieces: sourcePieces, height }, context, left, right);
      const primary = context.getImageData(0, 0, width, height);
      const sums = new Int32Array((width + 1) * (height + 1));
      for (let y = 0; y < height; y += 1) {
        let rowInk = 0;
        const staffLine = [0, 1, 2, 3, 4].some((line) =>
          Math.abs(y - stream.staffOffset - line * stream.staffSpacing) <= 1);
        for (let x = 0; x < width; x += 1) {
          if (!staffLine && primary.data[(y * width + x) * 4] < 80)
            rowInk += 1;
          sums[(y + 1) * (width + 1) + x + 1] =
            sums[y * (width + 1) + x + 1] + rowInk;
        }
      }
      const broadArtifact = (x, y) => {
        const x1 = Math.max(0, x - 8);
        const x2 = Math.min(width, x + 9);
        const y1 = Math.max(0, y - 8);
        const y2 = Math.min(height, y + 9);
        const ink = sums[y2 * (width + 1) + x2] -
          sums[y1 * (width + 1) + x2] -
          sums[y2 * (width + 1) + x1] +
          sums[y1 * (width + 1) + x1];
        return ink > (x2 - x1) * (y2 - y1) * .4;
      };
      const selectedMasks = new Uint8Array(width);
      for (const piece of sourcePieces) {
        const from = Math.max(left, piece.left);
        const to = Math.min(right, piece.left + piece.width);
        for (let x = from; x < to; x += 1) {
          selectedMasks[x - left] = piece.maskedColumns?.[
            piece.sourceX + x - piece.left] ? 1 : 0;
        }
      }
      const visible = [];
      for (const plan of stream.frames) {
        const row = resolvedRows?.get(plan) || plan.row;
        const frameWidth = row.sourceCanvas?.width || row.canvas?.width || 0;
        const from = Math.max(left, plan.frameStart);
        const to = Math.min(right, plan.frameStart + frameWidth);
        if (to <= from) continue;
        let canvas = cache.get(plan);
        if (!canvas) {
          canvas = cropStaff(row, height, stream.staffOffset);
          if (!canvas) continue;
          cache.set(plan, canvas);
        }
        visible.push({ from, to, sourceX: from - plan.frameStart,
          mask: plan.maskedColumns,
          data: canvas.getContext('2d', { willReadFrequently: true })
            .getImageData(from - plan.frameStart, 0, to - from, height).data });
      }
      const samples = [];
      for (let x = left; x < right; x += 1) {
        const available = visible.filter((item) => x >= item.from && x < item.to &&
          !item.mask?.[item.sourceX + x - item.from]);
        if (available.length < 3 && !selectedMasks[x - left]) continue;
        for (let y = 0; y < height; y += 1) {
          samples.length = 0;
          for (const item of available) {
            const sourceOffset = (y * (item.to - item.from) + x - item.from) * 4;
            samples.push(item.data[sourceOffset]);
          }
          if (!samples.length) continue;
          samples.sort((a, b) => a - b);
          // The score stays fixed in score coordinates while video artifacts
          // move behind it. Prefer a brighter consensus to reject transient
          // dark patches without erasing ink present in most frames.
          const consensus = samples[Math.floor((samples.length - 1) * .75)];
          const offset = (y * width + x - left) * 4;
          const notationBand = y >= stream.staffOffset - stream.staffSpacing * 3 &&
            y <= stream.staffOffset + stream.staffSpacing * 5.5;
          if ((samples.length >= 3 && consensus > primary.data[offset] + 20 &&
              (!notationBand || broadArtifact(x - left, y))) ||
              selectedMasks[x - left]) {
            primary.data[offset] = consensus;
            primary.data[offset + 1] = consensus;
            primary.data[offset + 2] = consensus;
          }
        }
      }
      context.putImageData(primary, 0, 0);
      outputPieces.push({ canvas: output, left, sourceX: 0, width });
      for (const [plan] of cache) {
        const row = resolvedRows?.get(plan) || plan.row;
        const frameWidth = row.sourceCanvas?.width || row.canvas?.width || 0;
        if (plan.frameStart + frameWidth <= right) cache.delete(plan);
      }
    }
    stream.pieces = outputPieces;
  }

  // Rebuild from the saved source frames, never from an already cropped strip.
  // This lets a moved seam recover notes that the automatic seam hid.
  async function rebuildHorizontalPieces(stream, resolveFrame) {
    const frames = stream.frames || [];
    if (!frames.length) return false;
    const pieces = [];
    const resolvedRows = new Map();
    let streamWidth = 0;
    let previous = null;
    for (const frame of frames) {
      const row = resolveFrame ? await resolveFrame(frame) : frame.row;
      resolvedRows.set(frame, row);
      const canvas = cropStaff(row, stream.height, stream.staffOffset);
      if (!canvas) return false;
      const mask = frame.maskedColumns;
      neutralizePlaybackCursor(canvas, mask);
      if (!previous) {
        pieces.push({ canvas, left: 0, sourceX: 0, width: canvas.width,
          maskedColumns: mask?.slice() });
        streamWidth = canvas.width;
        frame.frameStart = 0;
        frame.seamGlobal = null;
      } else {
        const overlap = canvas.width - frame.shift;
        if (overlap < 7 || overlap >= canvas.width) return false;
        const limits = horizontalStitchLimits(overlap);
        const seam = Math.max(limits.min, Math.min(limits.max, frame.seam));
        frame.seam = seam;
        frame.overlap = overlap;
        frame.frameStart = streamWidth - overlap;
        frame.seamGlobal = frame.frameStart + seam;
        restoreCursorCoveredColumns(pieces, streamWidth, overlap,
          canvas, { maskedColumns: mask });
        const strip = document.createElement('canvas');
        strip.width = canvas.width - seam;
        strip.height = stream.height;
        strip.getContext('2d').drawImage(canvas,
          seam, 0, strip.width, strip.height, 0, 0, strip.width, strip.height);
        const stripMask = restoreNewStripFromPrevious(pieces, strip, seam,
          overlap, streamWidth, { maskedColumns: mask });
        while (pieces.length && pieces[pieces.length - 1].left >= frame.seamGlobal) {
          pieces.pop();
        }
        if (pieces.length) {
          const last = pieces[pieces.length - 1];
          last.width = Math.min(last.width, frame.seamGlobal - last.left);
        }
        pieces.push({ canvas: strip, left: frame.seamGlobal, sourceX: 0,
          width: strip.width, maskedColumns: stripMask });
        streamWidth = frame.seamGlobal + strip.width;
      }
      previous = canvas;
    }
    stream.pieces = pieces;
    stream.width = streamWidth;
    fuseLightOverlayStream(stream, resolvedRows);
    return true;
  }

  async function adjustHorizontalStitch(stream, frameIndex, value, resolveFrame) {
    const frame = stream?.frames?.[frameIndex];
    if (!frame || !Number.isFinite(frame.overlap) || !Number.isFinite(value)) return false;
    const limits = horizontalStitchLimits(frame.overlap);
    if (limits.max <= limits.min) return false;
    const seam = Math.max(limits.min, Math.min(limits.max, Math.round(value)));
    if (seam === frame.seam) return true;
    const old = frame.seam;
    frame.seam = seam;
    let rebuilt = false;
    try {
      rebuilt = await rebuildHorizontalPieces(stream, resolveFrame);
    } catch (error) {
      frame.seam = old;
      throw error;
    }
    if (!rebuilt) {
      frame.seam = old;
      await rebuildHorizontalPieces(stream, resolveFrame);
      return false;
    }
    stream.barlineCuts = detectBarlineCuts(stream, stream.staffOffset,
      stream.staffSpacing);
    stream.noteMeasures = noteBearingMeasures(stream, stream.staffOffset,
      stream.staffSpacing);
    return true;
  }

  async function horizontalStitchPreview(stream, frameIndex, resolveFrame) {
    const frame = stream?.frames?.[frameIndex];
    const before = stream?.frames?.[frameIndex - 1];
    if (!frame || !before || !Number.isFinite(frame.overlap)) return null;
    const previousRow = resolveFrame ? await resolveFrame(before) : before.row;
    const previous = cropStaff(previousRow, stream.height, stream.staffOffset);
    const currentRow = resolveFrame ? await resolveFrame(frame) : frame.row;
    const current = cropStaff(currentRow, stream.height, stream.staffOffset);
    if (!previous || !current) return null;
    const width = Math.min(frame.overlap, previous.width, current.width);
    const left = document.createElement('canvas');
    const right = document.createElement('canvas');
    left.width = right.width = width;
    left.height = right.height = stream.height;
    left.getContext('2d').drawImage(previous,
      previous.width - width, 0, width, stream.height,
      0, 0, width, stream.height);
    right.getContext('2d').drawImage(current,
      0, 0, width, stream.height, 0, 0, width, stream.height);
    return { previous: left, current: right };
  }

  function mergeHorizontalSequences(sequences) {
    const captures = (sequences || []).map((sequence) =>
      (sequence.rows || [])[0]).filter(Boolean);
    if (!captures.length) return { rows: [], removedDuplicates: 0 };
    const spacing = Math.max(2, Math.round(captures[0].staffSpacing || 6));
    const staffOffset = spacing * 7;
    const height = spacing * 17;
    const streams = [];
    let pieces = [];
    let framePlans = [];
    let previous = null;
    let previousSamples = null;
    let lastShift = null;
    let streamWidth = 0;
    let removedDuplicates = 0;
    let unaligned = 0;
    const finish = () => {
      if (pieces.length) streams.push({ pieces, width: streamWidth,
        frames: framePlans });
      pieces = [];
      framePlans = [];
      streamWidth = 0;
    };
    captures.forEach((row) => {
      const canvas = cropStaff(row, height, staffOffset);
      if (!canvas || !hasLightScoreBackground(canvas)) return;
      // The extracted row carries the detector's fractional staff position.
      // Sampling a separately rounded display crop can move a sparse overlap
      // by one pixel and reject an otherwise valid screenshot recovery.
      const lightOverlay = row.sourceInk === 'light-overlay';
      const samples = {
        row: row.canvas ? inkSample(row.canvas,
          row.staffTop, row.staffSpacing, { lightOverlay }) : null,
        crop: inkSample(canvas, staffOffset, spacing, { lightOverlay }),
      };
      let sample = samples.row || samples.crop;
      let previousSample = previousSamples?.row || previousSamples?.crop;
      let match = null;
      if (previous && previous.width === canvas.width) {
        for (const kind of ['row', 'crop']) {
          const before = previousSamples?.[kind];
          const after = samples[kind];
          if (!before || !after) continue;
          const candidate = matchHorizontalScroll(before, after, lastShift,
            { lightOverlay });
          if (candidate && !match) {
            match = candidate;
            sample = after;
            previousSample = before;
          }
        }
      }
      neutralizePlaybackCursor(canvas, sample.maskedColumns);
      if (!previous || !match) {
        if (previous) unaligned += 1;
        finish();
        lastShift = null;
        pieces.push({ canvas, left: 0, sourceX: 0, width: canvas.width,
          maskedColumns: sample.maskedColumns });
        framePlans.push({ row, shift: 0, seam: null,
          maskedColumns: sample.maskedColumns?.slice(), frameStart: 0,
          seamGlobal: null });
        streamWidth = canvas.width;
      } else {
        const shift = Math.round(match.shift * canvas.width / sample.width);
        if (shift >= 3) {
          lastShift = match.shift;
          const overlap = canvas.width - shift;
          restoreCursorCoveredColumns(pieces, streamWidth, overlap,
            canvas, sample);
          const seam = safeOverlapSeam(previous, canvas, overlap,
            staffOffset, spacing, previousSample, sample);
          const seamGlobal = streamWidth - overlap + seam;
          const strip = document.createElement('canvas');
          strip.width = canvas.width - seam;
          strip.height = height;
          strip.getContext('2d').drawImage(canvas,
            seam, 0, strip.width, height, 0, 0, strip.width, height);
          const stripMask = restoreNewStripFromPrevious(pieces,
            strip, seam, overlap, streamWidth, sample);
          while (pieces.length && pieces[pieces.length - 1].left >= seamGlobal) {
            pieces.pop();
          }
          if (pieces.length) {
            const last = pieces[pieces.length - 1];
            last.width = Math.min(last.width, seamGlobal - last.left);
          }
          pieces.push({ canvas: strip, left: seamGlobal,
            sourceX: 0, width: strip.width,
            maskedColumns: stripMask });
          framePlans.push({ row, shift, seam, autoSeam: seam, overlap,
            matchScore: match.value,
            maskedColumns: sample.maskedColumns?.slice(),
            frameStart: streamWidth - overlap, seamGlobal });
          streamWidth = seamGlobal + strip.width;
        } else removedDuplicates += 1;
      }
      previous = canvas;
      previousSamples = samples;
    });
    finish();

    const rows = [];
    const staffLines = Array.from({ length: 5 }, (_, i) => staffOffset + i * spacing);
    streams.forEach((stream) => {
      const targetWidth = stream.pieces[0].canvas.width;
      stream.height = height;
      stream.targetWidth = targetWidth;
      stream.staffOffset = staffOffset;
      stream.staffSpacing = spacing;
      stream.sourceInk = stream.frames[0]?.row.sourceInk || 'dark';
      fuseLightOverlayStream(stream);
      stream.sectionMarkers = detectBoxedSections(stream, staffOffset, spacing);
      stream.barlineCuts = detectBarlineCuts(stream, staffOffset, spacing);
      stream.noteMeasures = noteBearingMeasures(stream, staffOffset, spacing);
    });
    const fourWidths = [];
    streams.forEach((stream) => {
      const boundaries = [0, ...stream.barlineCuts, stream.width];
      for (let index = 0; index + 4 < boundaries.length; index += 1) {
        const left = boundaries[index];
        const right = boundaries[index + 4];
        const sounding = stream.noteMeasures.filter((center) =>
          center >= left && center < right).length;
        if (sounding >= 3) fourWidths.push(right - left);
      }
    });
    fourWidths.sort((a, b) => a - b);
    const typicalFourWidth = fourWidths.length
      ? fourWidths[Math.floor((fourWidths.length - 1) * .5)] : null;
    streams.forEach((stream) => {
      const targetWidth = stream.targetWidth;
      const seam = (start, nominalEnd) => {
        if (nominalEnd >= stream.width) return stream.width;
        const low = Math.max(start + 1, Math.round(nominalEnd - targetWidth * 0.25));
        const probe = document.createElement('canvas');
        probe.width = nominalEnd - low;
        probe.height = height;
        const context = probe.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#fff';
        context.fillRect(0, 0, probe.width, height);
        // Draw just the seam region; no panorama-sized canvas is allocated.
        drawHorizontalPieces(stream, context, low, nominalEnd);
        const data = context.getImageData(0, 0, probe.width, height).data;
        const staffFirst = Math.max(0, staffOffset + 2);
        const staffLast = Math.min(height - 1, staffOffset + spacing * 4 - 2);
        let barlineCut = null;
        for (let x = 2; x < probe.width - 3; x += 1) {
          let dark = 0;
          let total = 0;
          for (let y = staffFirst; y <= staffLast; y += 1) {
            const offset = (y * probe.width + x) * 4;
            const red = data[offset];
            const green = data[offset + 1];
            const blue = data[offset + 2];
            if (Math.max(red, green, blue) - Math.min(red, green, blue) < 48 &&
                (red * 3 + green * 6 + blue) / 10 < 155) dark += 1;
            total += 1;
          }
          // A barline crosses the entire staff; ordinary note stems usually do not.
          if (dark / Math.max(1, total) >= 0.94) barlineCut = low + x + 2;
        }
        if (barlineCut != null) return Math.min(nominalEnd, barlineCut);
        let best = nominalEnd;
        let bestScore = Infinity;
        const fallbackStart = Math.max(0, probe.width - Math.round(targetWidth * 0.12));
        for (let x = fallbackStart; x < probe.width; x += 1) {
          let dark = 0;
          for (let y = 0; y < height; y += 2) {
            const staffLine = staffLines.some((line) => Math.abs(line - y) <= 1);
            if (staffLine) continue;
            const offset = (y * probe.width + x) * 4;
            if ((data[offset] * 3 + data[offset + 1] * 6 + data[offset + 2]) / 10 < 160) dark += 1;
          }
          const value = dark + (probe.width - x) * 0.015;
          if (value < bestScore) {
            bestScore = value;
            best = low + x;
          }
        }
        return best;
      };
      const fourMeasureLayout = stream.barlineCuts.length >= 3 &&
        stream.noteMeasures.length >= 3;
      const sectionStarts = stream.sectionMarkers
        .map((x) => Math.max(0, x - Math.max(3, Math.round(spacing * .3))));
      // A boxed label is printed just left of its measure's barline. Keep the
      // label with the new row, and close the preceding row at the cropped
      // boundary when the real barline is immediately to the label's right.
      stream.sectionBreakEnds = sectionStarts.filter((edge) =>
        stream.barlineCuts.some((barline) =>
          barline > edge && barline - edge <= spacing * 3));
      const forcedEnds = [...sectionStarts, stream.width];
      if (fourMeasureLayout) {
        stream.layoutWidth = Math.max(targetWidth,
          Math.round((typicalFourWidth || targetWidth) +
            Math.max(40, spacing * 4.5)));
      }
      const planCuts = (start, finish) => {
        const notesBetween = (left, right) => stream.noteMeasures.filter((center) =>
          center >= left && center < right).length;
        let points = [...stream.barlineCuts.filter((x) =>
          x > start + spacing * 6 && x < finish - spacing * 6), finish];
        if (fourMeasureLayout) {
          // Dense notation can hide a barline from the detector. Keep a very
          // wide unconfirmed span visible by splitting at a low-ink seam.
          const room = stream.layoutWidth - horizontalRowPrefix(stream, start);
          const repaired = [];
          let left = start;
          for (const right of points) {
            while (right - left > room * 1.08) {
              const nominal = Math.min(right - spacing * 6,
                left + Math.round(room * .9));
              const cut = Math.max(left + spacing * 6,
                Math.min(right - spacing * 6, seam(left, nominal)));
              if (cut <= left || cut >= right) break;
              repaired.push(cut);
              left = cut;
            }
            repaired.push(right);
            left = right;
          }
          points = repaired;
          const boundaries = [start, ...points];
          const plans = Array(boundaries.length).fill(null);
          plans[boundaries.length - 1] = { cost: 0, next: -1 };
          const sectionDensity = notesBetween(start, finish) /
            Math.max(1, finish - start);
          for (let i = boundaries.length - 2; i >= 0; i -= 1) {
            const room = stream.layoutWidth -
              horizontalRowPrefix(stream, boundaries[i]);
            for (let j = i + 1; j < boundaries.length; j += 1) {
              const width = boundaries[j] - boundaries[i];
              const notes = notesBetween(boundaries[i], boundaries[j]);
              if (width > room * 1.08 && j > i + 1) break;
              if (notes > 5 || !plans[j]) continue;
              const last = j === boundaries.length - 1;
              const widthError = (width - room) / room;
              const densityError = (notes / Math.max(1, width) -
                sectionDensity) * room;
              // Short rest measures are allowed to share a row. Sounding rows
              // aim for 3-5 measures with a similar density across the section.
              const noteError = notes && notes < 3 ? 3 - notes :
                Math.max(0, notes - 4);
              const cost = 1 +
                widthError * widthError * (last ? .25 : 1.8) +
                noteError * noteError * (last ? .08 : .35) +
                densityError * densityError * .08 + plans[j].cost;
              if (!plans[i] || cost < plans[i].cost)
                plans[i] = { cost, next: j };
            }
          }
          if (plans[0]) {
            const cuts = [];
            for (let i = 0; i < boundaries.length - 1;) {
              i = plans[i].next;
              cuts.push(boundaries[i]);
            }
            return cuts;
          }
          // An unmatched or unusually wide bar still needs a visible row.
          const first = points[0] || finish;
          return first >= finish ? [finish] :
            [first, ...planCuts(first, finish)];
        }
        const maximumWidth = Math.round(targetWidth * 1.1);
        const measureGaps = stream.noteMeasures.slice(1).map((center, index) =>
          center - stream.noteMeasures[index]).sort((a, b) => a - b);
        const typicalGap = measureGaps.length
          ? measureGaps[Math.floor(measureGaps.length / 2)] : targetWidth / 4;
        const idealWidth = Math.max(targetWidth, typicalGap * 4);
        if (finish - start <= maximumWidth && notesBetween(start, finish) <= 4) {
          return [finish];
        }
        const candidates = [start, ...points];
        const plans = Array(candidates.length).fill(null);
        plans[candidates.length - 1] = { lines: 0, raggedness: 0, next: -1 };
        for (let i = candidates.length - 2; i >= 0; i -= 1) {
          for (let j = i + 1; j < candidates.length &&
            candidates[j] - candidates[i] <= maximumWidth; j += 1) {
            if (!plans[j]) continue;
            const width = candidates[j] - candidates[i];
            const notes = notesBetween(candidates[i], candidates[j]);
            if (notes > 4) continue;
            const proposal = { lines: plans[j].lines + 1,
              raggedness: plans[j].raggedness +
                Math.pow((idealWidth - width) / idealWidth, 2) +
                Math.pow(notes - 4, 2) * (j === candidates.length - 1 ? .08 : 4),
              next: j };
            if (!plans[i] || proposal.lines < plans[i].lines ||
                (proposal.lines === plans[i].lines &&
                  proposal.raggedness < plans[i].raggedness)) plans[i] = proposal;
          }
        }
        if (plans[0]) {
          const cuts = [];
          for (let i = 0; i < candidates.length - 1;) {
            i = plans[i].next;
            cuts.push(candidates[i]);
          }
          return cuts;
        }
        // An unusually wide measure has no confirmed barline within one row.
        // Keep it visible and flag the split rather than silently losing it.
        const fallback = Math.max(start + 1, Math.min(finish - 1,
          seam(start, start + targetWidth)));
        return [fallback, ...planCuts(fallback, finish)];
      };
      let start = 0;
      if (stream.sourceInk === 'light-overlay') {
        // At the beginning of an overlay video the staff may still be entering
        // the screen. Trim the empty video area before planning four measures.
        const probeWidth = Math.min(stream.width, targetWidth);
        const probe = document.createElement('canvas');
        probe.width = probeWidth;
        probe.height = height;
        const probeContext = probe.getContext('2d', { willReadFrequently: true });
        probeContext.fillStyle = '#fff';
        probeContext.fillRect(0, 0, probeWidth, height);
        drawHorizontalPieces(stream, probeContext, 0, probeWidth);
        const pixels = probeContext.getImageData(0, 0, probeWidth, height).data;
        let run = 0;
        const required = Math.max(12, Math.round(spacing * 1.5));
        for (let x = 0; x < probeWidth; x += 1) {
          let lines = 0;
          for (let line = 0; line < 5; line += 1) {
            const y = Math.round(staffOffset + line * spacing);
            let dark = false;
            for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
              if (pixels[(yy * probeWidth + x) * 4] < 165) dark = true;
            }
            if (dark) lines += 1;
          }
          run = lines >= 4 ? run + 1 : 0;
          if (run >= required) {
            start = Math.max(0, x - run - Math.round(spacing * 2));
            break;
          }
        }
      }
      stream.firstStart = start;
      stream.sectionRowEnds = forcedEnds;
      const plannedRanges = [];
      for (const nextSection of forcedEnds) {
        if (nextSection <= start + spacing * 3) continue;
        for (const end of planCuts(start, nextSection)) {
          plannedRanges.push({ start, end });
          start = end;
        }
      }
      // The common width comes from the majority of four-measure spans, not
      // the widest outlier. Dense rows may use three measures instead.
      for (const { start, end } of plannedRanges) {
        const canvas = renderHorizontalRange(stream, start, end);
        const candidate = { canvas, baseCanvas: canvas,
          staffTop: staffOffset, staffBottom: staffOffset + spacing * 4,
          staffSpacing: spacing, status: 'complete', completeness: 0.96,
          quality: core.frameQuality(canvas) };
        rows.push({ ...candidate, candidates: [candidate],
          sequenceIndex: rows.length, sequenceRowIndex: 0,
          horizontalStart: start, horizontalEnd: end,
          horizontalSource: stream,
          autoSectionStart: sectionStarts.some((x) => Math.abs(x - start) <= spacing * 3) });
      }
    });
    const warnings = unaligned ? [{
      type: 'horizontal-unmatched',
      count: unaligned,
      message: `横向画面有 ${unaligned} 处无法可靠对齐；已按时间保留画面，可能有缺谱，请逐行检查`,
    }] : [];
    return { rows, removedDuplicates, unaligned, warnings };
  }

  core.matchHorizontalScroll = matchHorizontalScroll;
  core.horizontalCaptureSample = inkSample;
  core.extractHorizontalCaptureRow = extractHorizontalCaptureRow;
  core.horizontalStaffEvidence = horizontalStaffEvidence;
  core.mergeHorizontalSequences = mergeHorizontalSequences;
  core.renderHorizontalRange = renderHorizontalRange;
  core.detectHorizontalBarlineCuts = detectBarlineCuts;
  core.detectBoxedSections = detectBoxedSections;
  core.adjustHorizontalStitch = adjustHorizontalStitch;
  core.horizontalStitchLimits = horizontalStitchLimits;
  core.horizontalStitchPreview = horizontalStitchPreview;
})();
