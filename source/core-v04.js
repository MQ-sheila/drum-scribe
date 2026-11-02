(function installDrumScopeCoreV04() {
  'use strict';
  if (typeof window === 'undefined' || !window.DrumScopeCore) return;
  const core = window.DrumScopeCore;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const median = (items) => {
    if (!items.length) return 0;
    const sorted = [...items].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const partial = (row) => /partial/.test(row?.status || '');

  function crop(source, top, bottom) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = Math.max(1, Math.round(bottom - top));
    canvas.getContext('2d').drawImage(
      source, 0, top, source.width, canvas.height,
      0, 0, canvas.width, canvas.height
    );
    return canvas;
  }

  // Convert light notation over moving video to the same white-paper/dark-ink
  // representation used by staff detection, overlap matching and PDF export.
  // Keep grayscale edges so thin staff lines are not broken by hard binarizing.
  function normalizeLightNotation(source) {
    if (!source || typeof document === 'undefined') return source;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = image.data;
    for (let offset = 0; offset < data.length; offset += 4) {
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (red > 130 && red > green + 65 && red > blue + 65) {
        // Keep the cursor identifiable until the overlap stage can restore
        // the notation underneath it from another frame.
        data[offset] = 225;
        data[offset + 1] = 242;
        data[offset + 2] = 255;
        data[offset + 3] = 255;
        continue;
      }
      const minimum = Math.min(red, green, blue);
      const saturation = Math.max(red, green, blue) - minimum;
      // Neutral white notation is bright in every channel. Most colourful
      // video becomes paper white; the cursor above keeps a temporary mask.
      // The horizontal staff is alpha-blended into the video and is often
      // only mid-gray, even when noteheads themselves are almost pure white.
      const brightness = clamp((minimum - 88) / 120, 0, 1);
      const neutrality = clamp((76 - saturation) / 50, 0, 1);
      const ink = brightness * neutrality;
      const paper = Math.round(255 * (1 - ink));
      data[offset] = paper;
      data[offset + 1] = paper;
      data[offset + 2] = paper;
      data[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  function binarizeNotation(source, threshold = 80) {
    if (!source || typeof document === 'undefined') return source;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = image.data;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const gray = (pixels[offset] * 3 + pixels[offset + 1] * 6 + pixels[offset + 2]) / 10;
      const value = gray < threshold ? 0 : 255;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  // The previous implementation processed a 1200px thumbnail and put those
  // pixels into a full-width canvas, leaving the right side empty.
  function cleanColorArtifacts(source, options = {}) {
    if (!source || typeof document === 'undefined') return source;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = image;
    const colorThreshold = options.colorThreshold == null ? 12 : Math.max(8, Number(options.colorThreshold) || 12);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        if (maximum - minimum < colorThreshold) continue;

        const brightness = (red * 3 + green * 6 + blue) / 10;
        const blueSelection = blue - red >= 22 && green - red >= 14 && blue >= green - 4;
        let restored;
        if (blueSelection) {
          // Blue/cyan selection overlays retain the original ink coverage in
          // their red channel. A pale selected background becomes white while
          // selected notes and long rests return to their original darkness.
          restored = red >= 205 ? 255 : red;
        } else {
          // Remove hue in place. Never borrow pixels from the same staff row:
          // doing that spreads the five staff lines through JPEG colour fringes
          // and creates the severe ghosting seen in video captures.
          restored = brightness >= 182 && minimum >= 105
            ? 255
            : Math.round(brightness);
        }
        data[offset] = restored;
        data[offset + 1] = restored;
        data[offset + 2] = restored;
        data[offset + 3] = 255;
      }
    }
    // Normalize only near-background pixels. Dark notation and its
    // anti-aliased edges remain byte-for-byte unchanged, so whitening the
    // video tint does not blur or thin the score.
    if (options.whitenBackground !== false) {
      const samples = [];
      const stepX = Math.max(1, Math.floor(width / 180));
      const stepY = Math.max(1, Math.floor(height / 90));
      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          const nearEdge = y < height * 0.18 || y > height * 0.82 || x < width * 0.06 || x > width * 0.94;
          if (!nearEdge) continue;
          const offset = (y * width + x) * 4;
          const maximum = Math.max(data[offset], data[offset + 1], data[offset + 2]);
          const minimum = Math.min(data[offset], data[offset + 1], data[offset + 2]);
          const gray = (data[offset] * 3 + data[offset + 1] * 6 + data[offset + 2]) / 10;
          if (maximum - minimum <= 32 && gray >= 165) samples.push(gray);
        }
      }
      const background = samples.length ? median(samples) : 255;
      const whiteThreshold = clamp(background - 11, 205, 245);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const maximum = Math.max(data[offset], data[offset + 1], data[offset + 2]);
          const minimum = Math.min(data[offset], data[offset + 1], data[offset + 2]);
          const gray = (data[offset] * 3 + data[offset + 1] * 6 + data[offset + 2]) / 10;
          if (maximum - minimum <= 32 && gray >= whiteThreshold) {
            data[offset] = 255;
            data[offset + 1] = 255;
            data[offset + 2] = 255;
            data[offset + 3] = 255;
          }
        }
      }
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  function cleanOpeningRestPlaceholder(source, options = {}) {
    if (!source || typeof document === 'undefined') return source;
    const staffTop = Number(options.staffTop);
    const staffBottom = Number(options.staffBottom);
    if (!Number.isFinite(staffTop) || !Number.isFinite(staffBottom) || staffBottom <= staffTop) return source;

    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = image.data;
    const spacing = Math.max(2, (staffBottom - staffTop) / 4);
    const lineYs = Array.from({ length: 5 }, (_, index) => staffTop + spacing * index);

    // Locate the solid horizontal body of a multi-measure rest. Ordinary staff
    // lines are nearly full width and are deliberately rejected here.
    let best = null;
    const top = Math.max(0, Math.floor(staffTop - spacing * .7));
    const bottom = Math.min(canvas.height - 1, Math.ceil(staffBottom + spacing * .7));
    for (let y = top; y <= bottom; y += 1) {
      let runStart = -1;
      for (let x = 0; x <= canvas.width; x += 1) {
        let dark = false;
        if (x < canvas.width) {
          const offset = (y * canvas.width + x) * 4;
          const gray = (pixels[offset] * 3 + pixels[offset + 1] * 6 + pixels[offset + 2]) / 10;
          dark = gray < 112;
        }
        if (dark && runStart < 0) runStart = x;
        if ((!dark || x === canvas.width) && runStart >= 0) {
          const runEnd = x - 1;
          const length = runEnd - runStart + 1;
          const longEnough = length >= Math.max(spacing * 10, canvas.width * .18);
          const notStaffLine = length <= canvas.width * .78;
          if (longEnough && notStaffLine && (!best || length > best.length)) {
            best = { start: runStart, end: runEnd, y, length };
          }
          runStart = -1;
        }
      }
    }
    if (!best) return source;
    // A rest that begins near the clef/time signature is normal notation, not
    // the later grey placeholder pattern this helper was made to remove.
    if (best.start < Math.max(spacing * 10, canvas.width * .22)) return source;

    // The unwanted cursor is a tiny grey mark immediately before the rest.
    // Limit all editing to that narrow gap; never touch the rest body itself.
    const clearLeft = Math.max(0, Math.round(best.start - spacing * 7.2));
    const clearRight = Math.max(clearLeft + 1, Math.round(best.start - spacing * .75));
    const clearTop = Math.max(0, Math.round(staffTop - spacing * 1.25));
    const clearBottom = Math.min(canvas.height, Math.round(staffBottom + spacing * 1.25));
    if (clearRight <= clearLeft || clearBottom <= clearTop) return source;

    // Do nothing unless the gap actually contains a light-grey non-staff mark.
    // This guard keeps normal opening symbols and rests completely unchanged.
    let greyInk = 0;
    for (let y = clearTop; y < clearBottom; y += 1) {
      const onStaff = lineYs.some((lineY) => Math.abs(y - lineY) <= Math.max(1, spacing * .22));
      if (onStaff) continue;
      for (let x = clearLeft; x < clearRight; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        const gray = (pixels[offset] * 3 + pixels[offset + 1] * 6 + pixels[offset + 2]) / 10;
        if (gray >= 112 && gray < 242) greyInk += 1;
      }
    }
    if (greyInk < Math.max(3, Math.round(spacing * .7))) return source;

    // Find a clean one-pixel staff sample to the left, then repeat only that
    // small vertical slice across the cursor. The rest and the rest count are
    // outside this rectangle and therefore cannot be erased.
    let sampleX = Math.max(0, clearLeft - Math.round(spacing * 1.5));
    let sampleScore = Infinity;
    const searchLeft = Math.max(0, clearLeft - Math.round(spacing * 5));
    const searchRight = Math.max(searchLeft, clearLeft - Math.round(spacing * .5));
    for (let x = searchLeft; x <= searchRight; x += 1) {
      let ink = 0;
      for (let y = clearTop; y < clearBottom; y += 1) {
        if (lineYs.some((lineY) => Math.abs(y - lineY) <= Math.max(1, spacing * .22))) continue;
        const offset = (y * canvas.width + x) * 4;
        const gray = (pixels[offset] * 3 + pixels[offset + 1] * 6 + pixels[offset + 2]) / 10;
        if (gray < 220) ink += 1;
      }
      if (ink < sampleScore) {
        sampleScore = ink;
        sampleX = x;
      }
    }

    const strip = document.createElement('canvas');
    strip.width = 1;
    strip.height = clearBottom - clearTop;
    strip.getContext('2d').drawImage(
      canvas,
      sampleX, clearTop, 1, clearBottom - clearTop,
      0, 0, 1, clearBottom - clearTop
    );
    context.drawImage(
      strip,
      0, 0, 1, strip.height,
      clearLeft, clearTop, clearRight - clearLeft, clearBottom - clearTop
    );
    return canvas;
  }

  function detectBandsAtResolution(source, options = {}) {
    if (!source || !source.width || !source.height || typeof document === 'undefined') return [];

    const requestedWidth = Math.max(320, Number(options.detectionWidth) || 1000);
    const targetWidth = Math.min(requestedWidth, source.width);
    const scale = source.width / targetWidth;
    const targetHeight = Math.max(1, Math.round(source.height / scale));
    const sample = document.createElement('canvas');
    sample.width = targetWidth;
    sample.height = targetHeight;
    const context = sample.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, targetWidth, targetHeight);
    const image = context.getImageData(0, 0, targetWidth, targetHeight);
    const ink = new Float32Array(targetHeight);
    const white = new Float32Array(targetHeight);
    const chroma = new Float32Array(targetHeight);
    let whitePixels = 0;

    for (let y = 0; y < targetHeight; y += 1) {
      let dark = 0;
      let pale = 0;
      let coloured = 0;
      for (let x = 0; x < targetWidth; x += 1) {
        const offset = (y * targetWidth + x) * 4;
        const red = image.data[offset];
        const green = image.data[offset + 1];
        const blue = image.data[offset + 2];
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const saturation = maximum - minimum;
        const gray = (red * 3 + green * 6 + blue) / 10;
        if (saturation < 58 && gray < 184) dark += 1;
        if (saturation >= 58 && gray < 230) coloured += 1;
        if (saturation < 34 && gray > 220) {
          pale += 1;
          whitePixels += 1;
        }
      }
      ink[y] = dark / targetWidth;
      white[y] = pale / targetWidth;
      chroma[y] = coloured / targetWidth;
    }

    // Reject a crop that contains only the performance video.
    if (whitePixels / Math.max(1, targetWidth * targetHeight) < 0.17) return [];

    const peakRows = [];
    let runStart = -1;
    const finishRun = (runEnd) => {
      if (runStart < 0) return;
      let best = runStart;
      for (let y = runStart + 1; y <= runEnd; y += 1) {
        if (ink[y] > ink[best]) best = y;
      }
      peakRows.push({ y: best, support: ink[best], white: white[best] });
      runStart = -1;
    };

    for (let y = 0; y < targetHeight; y += 1) {
      const local = (ink[Math.max(0, y - 2)] + ink[Math.max(0, y - 1)] +
        ink[y] + ink[Math.min(targetHeight - 1, y + 1)] +
        ink[Math.min(targetHeight - 1, y + 2)]) / 5;
      const lineLike = ink[y] >= Math.max(0.105, local * 1.16) &&
        ink[y] + white[y] >= 0.64;
      if (lineLike) {
        if (runStart < 0) runStart = y;
      } else {
        finishRun(y - 1);
      }
    }
    finishRun(targetHeight - 1);
    peakRows.splice(0, peakRows.length, ...core.recoverChromaticStaffPeaks(peakRows, ink, white, chroma));
    if (peakRows.length < 5) return [];

    const candidates = [];
    const narrowSingleRow = targetHeight / Math.max(1, targetWidth) < 0.24;
    const maximumSpacing = narrowSingleRow
      ? Math.max(12, Math.min(32, Math.round(targetHeight / 5)))
      : Math.max(7, Math.min(28, Math.round(targetHeight / 14)));
    for (let firstIndex = 0; firstIndex < peakRows.length; firstIndex += 1) {
      const first = peakRows[firstIndex];
      for (let secondIndex = firstIndex + 1; secondIndex < peakRows.length; secondIndex += 1) {
        const spacing = peakRows[secondIndex].y - first.y;
        // Video players often show a full score at only 700-1200 px wide, where
        // adjacent staff lines can be just 2-4 sampled pixels apart.
        if (spacing < Math.max(2, targetWidth / 600)) continue;
        if (spacing > maximumSpacing) break;
        const matched = [first, peakRows[secondIndex]];
        let totalError = 0;
        let previousIndex = secondIndex;
        for (let line = 2; line < 5; line += 1) {
          const target = first.y + spacing * line;
          let bestIndex = -1;
          let bestError = Infinity;
          let bestRank = Infinity;
          for (let candidateIndex = previousIndex + 1; candidateIndex < peakRows.length; candidateIndex += 1) {
            const error = Math.abs(peakRows[candidateIndex].y - target);
            // A faint accent near a staff line can be one pixel closer than
            // the actual dark line. Prefer the strongly supported peak.
            const rank = error - peakRows[candidateIndex].support * 2.3;
            if (rank < bestRank) {
              bestRank = rank;
              bestError = error;
              bestIndex = candidateIndex;
            }
            if (peakRows[candidateIndex].y > target + Math.max(2, spacing * 0.24)) break;
          }
          const spacingTolerance = narrowSingleRow
            ? Math.max(4.5, spacing * 0.38)
            : Math.max(4.5, spacing * 0.38);
          if (bestIndex < 0 || bestError > spacingTolerance) break;
          matched.push(peakRows[bestIndex]);
          totalError += bestError;
          previousIndex = bestIndex;
        }
        if (matched.length !== 5) continue;
        const supports = matched.map((item) => item.support);
        const minimumSupport = Math.min(...supports);
        const averageSupport = supports.reduce((sum, value) => sum + value, 0) / 5;
        const regularity = 1 - totalError / Math.max(1, spacing * 4);
        const score = averageSupport * 0.62 + minimumSupport * 0.28 + regularity * 0.10;
        candidates.push({
          lines: matched.map((item) => item.y * scale),
          spacing: spacing * scale,
          supported: 5,
          score,
        });
      }
    }

    candidates.sort((left, right) => right.score - left.score);
    const selected = [];
    for (const candidate of candidates) {
      const center = candidate.lines[2];
      const overlaps = selected.some((other) =>
        // One staff can yield several almost-identical five-line combinations
        // because stems and beams create extra horizontal peaks. Treat every
        // centre within roughly one staff plus its immediate context as the
        // same system.
        Math.abs(other.lines[2] - center) < Math.max(other.spacing, candidate.spacing) * 6.0
      );
      if (!overlaps) selected.push(candidate);
    }
    const sortedSpacings = selected.map((item) => item.spacing).sort((a, b) => a - b);
    const typicalSpacing = sortedSpacings[Math.floor((sortedSpacings.length - 1) / 2)] || 0;
    const consistent = selected.length < 2 ? selected : selected.filter((item) =>
      item.spacing >= typicalSpacing * 0.78 && item.spacing <= typicalSpacing * 1.35
    );
    return consistent
      .map((system) => ({
        ...system,
        bandTop: system.lines[0],
        bandBottom: system.lines[4],
        center: system.lines[2],
      }))
      .sort((left, right) => left.center - right.center);
  }

  // Thin one-pixel staff lines can vanish at one downsampling phase. Run the
  // proven 1000px detector first, then add a higher-resolution pass only when
  // a multi-row video frame contains fewer than four systems. Merging by staff
  // centre recovers edge systems without duplicating ordinary rows.
  function bands(source, options = {}) {
    const standard = detectBandsAtResolution(source, { ...options, detectionWidth: 1000 });
    const multiRowFrame = source && source.width > 1100 && source.height / source.width > 0.38;
    if (!multiRowFrame || standard.length >= 4) return standard;
    const detailed = detectBandsAtResolution(source, { ...options, detectionWidth: 1400 });
    const ranked = [...standard, ...detailed].sort((left, right) => right.score - left.score);
    const merged = [];
    for (const system of ranked) {
      const duplicate = merged.some((other) =>
        Math.abs(other.center - system.center) < Math.max(other.spacing, system.spacing) * 5.2
      );
      if (!duplicate) merged.push(system);
    }
    return merged.sort((left, right) => left.center - right.center);
  }
  function validMeasure(_measure) {
    // The source image already contains the printed number. Keep the field
    // empty unless the user enters it; a wrong number is worse than no label.
    return null;
  }

  function horizontalInkCoverage(source) {
    if (!source || !source.width || !source.height) return null;
    const width = Math.min(800, source.width);
    const height = Math.max(1, Math.round(source.height * width / source.width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const minimumInk = Math.max(2, Math.round(height * 0.022));
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      let dark = 0;
      for (let y = 0; y < height; y += 1) {
        const offset = (y * width + x) * 4;
        const maximum = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
        const minimum = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
        const gray = (pixels[offset] * 3 + pixels[offset + 1] * 6 + pixels[offset + 2]) / 10;
        if (maximum - minimum < 60 && gray < 185) dark += 1;
      }
      if (dark >= minimumInk) {
        if (first < 0) first = x;
        last = x;
      }
    }
    return first < 0 ? 0 : (last - first + 1) / width;
  }

  function makeRow(source, band, top, bottom, status, index, options, displayBounds = null) {
    const raw = crop(source, top, bottom);
    const rawQuality = core.frameQuality(raw);
    const canvas = options.removeColorArtifacts === false
      ? raw
      : cleanColorArtifacts(raw, options);
    const measure = core.__baseMeasureDetector(canvas, {
      ...options, regionWidth: 0.18, regionHeight: 0.45, darkThreshold: 178,
    });
    const measureNumber = validMeasure(measure);
    return {
      canvas,
      // Keep an immutable, unprocessed crop. Preview-only settings must always
      // rebuild from this source instead of repeatedly filtering a filtered image.
      baseCanvas: raw,
      sourceCanvas: source,
      // Recognition and de-duplication use the compact raw crop above. Preview
      // can safely recover farther into the original frame for tempo text and
      // other annotations without changing the image used to match rows.
      analysisBounds: { top, bottom },
      sourceBounds: { top, bottom },
      displayBounds: displayBounds || { top, bottom },
      sourceStaffTop: band.bandTop,
      sourceStaffBottom: band.bandBottom,
      analysisStaffTop: band.bandTop - top,
      analysisStaffBottom: band.bandBottom - top,
      system: band,
      staffTop: band.bandTop - top,
      staffBottom: band.bandBottom - top,
      staffSpacing: band.spacing,
      horizontalCoverage: horizontalInkCoverage(raw),
      rowIndex: index,
      status,
      completeness: status === 'complete' ? 0.96 : 0.52,
      confidence: clamp(band.score, 0, 1),
      measure: measureNumber == null
        ? { value: null, text: '', confidence: 0, reason: 'not-reliable' }
        : measure,
      measureNumber,
      measureSource: measureNumber == null ? null : 'detected',
      quality: rawQuality,
      candidates: [],
    };
  }

  function plausibleRow(row) {
    if (!row?.canvas || !row.system) return false;
    const ratio = row.canvas.height / Math.max(1, row.canvas.width);
    if (ratio > 0.22 || ratio < 0.025) return false;
    if (!Number.isFinite(row.staffSpacing) || row.staffSpacing < 2) return false;
    if (row.staffSpacing > row.canvas.width * 0.025) return false;
    const topRoom = row.staffTop / row.staffSpacing;
    const bottomRoom = (row.canvas.height - row.staffBottom) / row.staffSpacing;
    if (partial(row)) {
      // Edge rows are useful overlap candidates. Keep them in the review data
      // (they remain excluded by default) so a later complete frame can replace
      // them instead of silently losing the first or last system.
      return topRoom >= -0.05 && bottomRoom >= -0.05 && Math.max(topRoom, bottomRoom) >= 2.0;
    }
    return topRoom >= 2.2 && bottomRoom >= 2.0;
  }


  function staffRowSourceBounds(found, sourceHeight, minimumBounds = []) {
    return (found || []).map((band, index) => {
      const spacing = Math.max(1, Number(band.spacing) || 1);
      const previous = found[index - 1];
      const next = found[index + 1];
      // Tempo text, tuplet numbers and circled sticking marks can sit much
      // farther from the staff than ordinary notes. Use the free space between
      // adjacent systems before clipping it, so annotations survive without
      // pulling a neighbouring staff into the same row.
      const desiredTop = band.bandTop - spacing * 10;
      const desiredBottom = band.bandBottom + spacing * 7;
      const sharedTop = previous
        ? previous.bandBottom + (band.bandTop - previous.bandBottom) * .5
        : 0;
      const sharedBottom = next
        ? band.bandBottom + (next.bandTop - band.bandBottom) * .5
        : sourceHeight;
      const expandedTop = Math.round(Math.max(desiredTop, sharedTop));
      const expandedBottom = Math.round(Math.min(desiredBottom, sharedBottom));
      const minimum = minimumBounds[index];
      return {
        top: minimum ? Math.min(expandedTop, minimum.top) : expandedTop,
        bottom: minimum ? Math.max(expandedBottom, minimum.bottom) : expandedBottom,
      };
    });
  }

  function extractRows(source, options = {}) {
    const found = bands(source, options);
    if (!found.length) return [];
    // Capture mode never changes the selected rectangle. During processing,
    // auto mode keeps every detected system; only an explicit single-row mode
    // may collapse the frame to one row.
    const single = options.mode === 'single';
    const bounds = found.map((band) => ({
      top: Math.round(band.bandTop - band.spacing * 6.8),
      bottom: Math.round(band.bandBottom + band.spacing * 4.8),
    }));
    const displayBounds = staffRowSourceBounds(found, source.height, bounds);
    if (single) {
      const ranked = found.map((band, index) => ({
        index,
        rank: band.score - Math.abs(band.center / source.height - 0.5) * 0.16,
      })).sort((left, right) => right.rank - left.rank);
      for (const item of ranked) {
        const i = item.index;
        const row = makeRow(
          source, found[i], clamp(bounds[i].top, 0, source.height - 1),
          clamp(bounds[i].bottom, 1, source.height), 'complete', 0, options,
          displayBounds[i]
        );
        if (plausibleRow(row)) return [row];
      }
      return [];
    }
    return found.map((band, i) => {
      // Extra annotation headroom is optional. Keep completeness based on the
      // original staff safety margin so preserving a tempo mark cannot turn a
      // previously complete first or last row into an excluded partial row.
      const topPartial = band.bandTop - band.spacing * 4.5 < 0;
      const bottomPartial = band.bandBottom + band.spacing * 4.35 > source.height;
      const status = topPartial && bottomPartial ? 'both-partial'
        : topPartial ? 'top-partial' : bottomPartial ? 'bottom-partial' : 'complete';
      return makeRow(
        source, band, clamp(bounds[i].top, 0, source.height - 1),
        clamp(bounds[i].bottom, 1, source.height), status, i, options,
        displayBounds[i]
      );
    }).filter(plausibleRow);
  }

  function fingerprint(row) {
    if (row.__v04Fingerprint) return row.__v04Fingerprint;
    if (!row.canvas) return null;
    const width = 192;
    const height = 56;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    const rowBands = bands(row.canvas, {});
    const detected = rowBands[0];
    const staffTop = Number.isFinite(row.staffTop) ? row.staffTop : detected?.bandTop;
    const staffBottom = Number.isFinite(row.staffBottom) ? row.staffBottom : detected?.bandBottom;
    const staffSpacing = Number.isFinite(row.staffSpacing) ? row.staffSpacing : detected?.spacing;
    if (Number.isFinite(staffTop) && Number.isFinite(staffBottom)) {
      const padding = Math.max(12, Math.round((staffSpacing || 5) * 4.5));
      const sourceTop = Math.max(0, staffTop - padding);
      const sourceBottom = Math.min(row.canvas.height, staffBottom + padding);
      context.drawImage(
        row.canvas, 0, sourceTop, row.canvas.width, Math.max(1, sourceBottom - sourceTop),
        0, 0, width, height
      );
    } else {
      context.drawImage(row.canvas, 0, 0, width, height);
    }
    const image = context.getImageData(0, 0, width, height);
    const values = new Float32Array(width * height);
    let mean = 0;
    for (let i = 0; i < values.length; i += 1) {
      const p = i * 4;
      const max = Math.max(image.data[p], image.data[p + 1], image.data[p + 2]);
      const min = Math.min(image.data[p], image.data[p + 1], image.data[p + 2]);
      values[i] = max - min > 48 ? 255
        : (image.data[p] * 3 + image.data[p + 1] * 6 + image.data[p + 2]) / 10;
      mean += values[i];
    }
    const threshold = clamp(mean / values.length - 22, 115, 218);
    const bits = new Uint8Array(values.length);
    const columnInk = new Uint16Array(width);
    let ink = 0;
    for (let i = 0; i < values.length; i += 1) {
      bits[i] = values[i] < threshold ? 1 : 0;
      ink += bits[i];
      if (bits[i]) columnInk[i % width] += 1;
    }
    const high = [...columnInk].filter((count) => count >= height * 0.085).length / width;
    return row.__v04Fingerprint = { bits, width, height, ink: ink / bits.length, high };
  }

  function visualDistance(left, right) {
    const a = fingerprint(left);
    const b = fingerprint(right);
    if (!a || !b) return 1;
    let best = 1;
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        let intersection = 0;
        let inkA = 0;
        let inkB = 0;
        for (let y = 1; y < a.height - 1; y += 1) {
          const by = y + dy;
          if (by < 0 || by >= b.height) continue;
          for (let x = 2; x < a.width - 2; x += 1) {
            const bx = x + dx;
            if (bx < 0 || bx >= b.width) continue;
            const av = a.bits[y * a.width + x];
            const bv = b.bits[by * b.width + bx];
            inkA += av;
            inkB += bv;
            intersection += av && bv ? 1 : 0;
          }
        }
        best = Math.min(best, 1 - (2 * intersection / Math.max(1, inkA + inkB)));
      }
    }
    return clamp(best, 0, 1);
  }

  function measureOf(row) {
    const raw = row?.measureNumber ?? row?.measure?.value;
    if (raw == null || String(raw).trim() === '') return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 9999 ? value : null;
  }

  function feature(row) {
    if (row.__v04Feature) return row.__v04Feature;
    const source = row.canvas;
    if (!source) return { high: 0, ink: 0 };
    const width = Math.min(320, source.width);
    const height = Math.max(1, Math.round(source.height * width / source.width));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    let ink = 0;
    let high = 0;
    for (let x = 0; x < width; x += 1) {
      let columnInk = 0;
      for (let y = 0; y < height; y += 1) {
        const offset = (y * width + x) * 4;
        const max = Math.max(data[offset], data[offset + 1], data[offset + 2]);
        const min = Math.min(data[offset], data[offset + 1], data[offset + 2]);
        const gray = (data[offset] * 3 + data[offset + 1] * 6 + data[offset + 2]) / 10;
        if (max - min < 45 && gray < 180) {
          columnInk += 1;
          ink += 1;
        }
      }
      if (columnInk >= height * 0.085) high += 1;
    }
    const anchorCanvas = document.createElement('canvas');
    anchorCanvas.width = Math.max(24, Math.round(source.width * 0.14));
    anchorCanvas.height = source.height;
    anchorCanvas.getContext('2d').drawImage(
      source, 0, 0, anchorCanvas.width, source.height,
      0, 0, anchorCanvas.width, source.height
    );
    return row.__v04Feature = {
      high: high / width,
      ink: ink / (width * height),
      anchor: core.structuralSignature(anchorCanvas, { width: 48, height: 32, maxWidth: 180 }),
    };
  }

  function digitSignature(row) {
    if (row.__v04DigitSignature) return row.__v04DigitSignature;
    const source = row.canvas;
    const width = Math.min(100, source?.width || 0);
    const height = Math.min(38, source?.height || 0);
    if (!source || !width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, width, height, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    const bits = new Uint8Array(width * height);
    let ink = 0;
    for (let y = 7; y < height - 1; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const max = Math.max(data[offset], data[offset + 1], data[offset + 2]);
        const min = Math.min(data[offset], data[offset + 1], data[offset + 2]);
        const gray = (data[offset] * 3 + data[offset + 1] * 6 + data[offset + 2]) / 10;
        const dark = max - min < 42 && gray < 185;
        bits[y * width + x] = dark ? 1 : 0;
        ink += dark ? 1 : 0;
      }
    }
    return row.__v04DigitSignature = { bits, width, height, ink };
  }

  function digitDistance(left, right) {
    const a = digitSignature(left);
    const b = digitSignature(right);
    if (!a || !b || a.ink < 5 || b.ink < 5) return null;
    let best = 1;
    for (let dy = -6; dy <= 6; dy += 1) {
      for (let dx = -25; dx <= 25; dx += 1) {
        let intersection = 0;
        let inkA = 0;
        let inkB = 0;
        for (let y = 7; y < Math.min(a.height, b.height) - 1; y += 1) {
          const by = y + dy;
          if (by < 7 || by >= b.height - 1) continue;
          for (let x = 0; x < a.width; x += 1) {
            const bx = x + dx;
            if (bx < 0 || bx >= b.width) continue;
            const av = a.bits[y * a.width + x];
            const bv = b.bits[by * b.width + bx];
            inkA += av;
            inkB += bv;
            intersection += av && bv ? 1 : 0;
          }
        }
        if (inkA >= 5 && inkB >= 5) {
          best = Math.min(best, 1 - (2 * intersection / Math.max(1, inkA + inkB)));
        }
      }
    }
    return best;
  }

  function numberLabelPatch(row) {
    const source = row?.baseCanvas || row?.canvas;
    if (!source || source.width < 160 || row?.status !== 'complete' ||
        !Number.isFinite(row.staffTop) || !Number.isFinite(row.staffSpacing)) return null;
    if (row.__v04NumberLabelPatch?.source === source) return row.__v04NumberLabelPatch;
    const spacing = row.staffSpacing;
    const left = Math.max(0, Math.round(spacing * 2));
    const right = Math.min(source.width, Math.round(spacing * 8));
    const top = Math.max(0, Math.round(row.staffTop - spacing * 4.5));
    const bottom = Math.min(source.height, Math.round(row.staffTop - spacing * .5));
    if (right - left < 12 || bottom - top < 12) return null;
    const canvas = document.createElement('canvas');
    canvas.width = right - left;
    canvas.height = bottom - top;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, left, top, canvas.width, canvas.height,
      0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const bits = new Uint8Array(canvas.width * canvas.height);
    let ink = 0;
    for (let index = 0; index < bits.length; index += 1) {
      const offset = index * 4;
      const maximum = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      const minimum = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      const gray = (pixels[offset] * 3 + pixels[offset + 1] * 6 + pixels[offset + 2]) / 10;
      if (maximum - minimum < 55 && gray < 185) { bits[index] = 1; ink += 1; }
    }
    if (ink < 8 || ink > bits.length * .22) return null;
    return row.__v04NumberLabelPatch = {
      source, bits, ink, width: canvas.width, height: canvas.height,
    };
  }

  function numberLabelDistance(left, right) {
    const a = numberLabelPatch(left);
    const b = numberLabelPatch(right);
    if (!a || !b || Math.abs(a.width - b.width) > 3 ||
        Math.abs(a.height - b.height) > 3) return null;
    let best = 1;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        let intersection = 0;
        for (let y = 0; y < a.height; y += 1) {
          const by = y + dy;
          if (by < 0 || by >= b.height) continue;
          for (let x = 0; x < a.width; x += 1) {
            const bx = x + dx;
            if (bx >= 0 && bx < b.width && a.bits[y * a.width + x] &&
                b.bits[by * b.width + bx]) intersection += 1;
          }
        }
        best = Math.min(best, 1 - 2 * intersection / (a.ink + b.ink));
      }
    }
    return best;
  }

  function distance(left, right) {
    const leftFeature = feature(left);
    const rightFeature = feature(right);
    const leftSignature = left.signature || core.structuralSignature(left.canvas);
    const rightSignature = right.signature || core.structuralSignature(right.canvas);
    const shape = core.signatureDistance(leftSignature, rightSignature);
    const anchor = core.signatureDistance(leftFeature.anchor, rightFeature.anchor);
    const whole = visualDistance(left, right);
    const digits = digitDistance(left, right);
    let visual = digits == null
      ? clamp(whole * 0.82 + shape * 0.18, 0, 1)
      : clamp(digits * 0.78 + whole * 0.22, 0, 1);
    const lm = measureOf(left);
    const rm = measureOf(right);
    if (lm != null && rm != null) visual = lm === rm ? visual * 0.58 : Math.max(0.42, visual);
    const printedNumberDistance = numberLabelDistance(left, right);
    if (printedNumberDistance != null && printedNumberDistance > 0.31) {
      visual = Math.max(0.42, visual);
    }
    return visual;
  }

  function alignment(collected, incoming) {
    const maximum = Math.min(collected.length, incoming.length, 10);
    for (let size = maximum; size >= 1; size -= 1) {
      const values = [];
      for (let i = 0; i < size; i += 1) {
        values.push(distance(collected[collected.length - size + i], incoming[i]));
      }
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      const maximumDistance = Math.max(...values);
      const reliable = size >= 3
        ? average <= 0.18 && maximumDistance <= 0.26
        : size === 2
          ? average <= 0.24 && maximumDistance <= 0.28
          : (() => {
            const left = collected[collected.length - 1];
            const right = incoming[0];
            const leftMeasure = measureOf(left);
            const rightMeasure = measureOf(right);
            const sameMeasure = leftMeasure != null && rightMeasure != null && leftMeasure === rightMeasure;
            const labelDistance = numberLabelDistance(left, right);
            const samePrintedLabel = labelDistance != null && labelDistance <= 0.18;
            return maximumDistance <= 0.13 && (sameMeasure || samePrintedLabel || maximumDistance <= 0.025);
          })();
      if (reliable) {
        return {
          offset: collected.length - size,
          count: size,
          score: average,
          rank: size - average,
        };
      }
    }
    return null;
  }

  function mergeCandidate(existing, incoming) {
    const candidates = [
      ...(existing.candidates || []), ...(incoming.candidates || []), existing, incoming,
    ].filter(Boolean);
    const unique = [];
    candidates.forEach((candidate) => {
      if (!unique.some((other) => distance(other, candidate) <= 0.025)) unique.push(candidate);
    });
    const best = core.chooseBestCandidate(unique) || existing;
    const sequenceIndex = existing.sequenceIndex;
    const wasComplete = !partial(existing) || !partial(incoming);
    const completeness = Math.max(existing.completeness || 0, incoming.completeness || 0);
    Object.assign(existing, best);
    existing.sequenceIndex = sequenceIndex;
    if (wasComplete) existing.status = 'complete';
    existing.completeness = completeness;
    existing.candidates = unique.slice(0, 8);
  }

  // A vertically scrolling score revisits each staff in several consecutive
  // frames. Match its physical position before comparing the music: repeated
  // grooves can look identical even when they belong to different measures.
  function mergeScrollingSequences(sequences) {
    const groups = (sequences || []).map((sequence) =>
      (sequence.rows || sequence || []).filter(Boolean));
    if (groups.length < 3) return null;
    const staffY = (row) => Number.isFinite(row.sourceStaffTop)
      ? row.sourceStaffTop
      : Number.isFinite(row.sourceBounds?.top) && Number.isFinite(row.staffTop)
        ? row.sourceBounds.top + row.staffTop
        : null;
    const completeY = (rows) => rows.filter((row) => !partial(row))
      .map(staffY).filter(Number.isFinite).sort((a, b) => a - b);
    const positions = groups.map(completeY);
    const spacings = positions.flatMap((values) => values.slice(1)
      .map((value, index) => value - values[index]).filter((value) => value > 15));
    if (spacings.length < 3) return null;
    const spacing = median(spacings);
    const shiftTolerance = Math.max(3, spacing * 0.07);
    const offsets = [0];
    for (let index = 1; index < positions.length; index += 1) {
      const previous = positions[index - 1];
      const current = positions[index];
      // A capture group can change because of a cursor or an overlay while
      // the score itself remains stationary. Treat that as zero scroll only
      // when at least two score rows match visually at the same height.
      const stationaryMatches = groups[index - 1].filter((oldRow) => !partial(oldRow))
        .filter((oldRow) => groups[index].some((newRow) =>
          !partial(newRow) && Math.abs(staffY(oldRow) - staffY(newRow)) <= shiftTolerance &&
          distance(oldRow, newRow) <= 0.25)).length;
      if (stationaryMatches >= 2 &&
          stationaryMatches >= Math.min(previous.length, current.length) * 0.55) {
        offsets.push(offsets[index - 1]);
        continue;
      }
      const differences = previous.flatMap((oldY) => current.map((newY) => oldY - newY))
        .filter((value) => value > 2 && value < spacing * 0.95);
      let best = [];
      differences.forEach((value) => {
        const matching = differences.filter((other) => Math.abs(other - value) <= shiftTolerance);
        if (matching.length > best.length) best = matching;
      });
      if (best.length < 2 || best.length < Math.min(previous.length, current.length) * 0.55) return null;
      offsets.push(offsets[index - 1] + median(best));
    }
    const tolerance = Math.max(6, spacing * 0.18);
    const located = [];
    groups.forEach((rows, sequenceIndex) => rows.forEach((row, sequenceRowIndex) => {
      const y = staffY(row);
      if (y == null || partial(row)) return;
      located.push({ row, sequenceIndex, sequenceRowIndex, y: y + offsets[sequenceIndex] });
    }));
    located.sort((a, b) => a.y - b.y);
    const clusters = [];
    located.forEach((item) => {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(item.y - median(last.map((entry) => entry.y))) <= tolerance) last.push(item);
      else clusters.push([item]);
    });
    const rows = clusters.map((cluster) => {
      const choices = cluster.flatMap((entry) =>
        (entry.row.candidates?.length ? entry.row.candidates : [entry.row])
          .map((candidate) => ({ candidate, entry })));
      choices.sort((left, right) => {
        const score = ({ candidate, entry }) => {
          const headroom = Number.isFinite(candidate.sourceStaffTop) &&
            Number.isFinite(candidate.sourceBounds?.top)
            ? (candidate.sourceStaffTop - candidate.sourceBounds.top) /
              Math.max(1, candidate.staffSpacing || 6) : 0;
          return (partial(candidate) ? -100 : 0) +
            Math.min(8, headroom) * 3 -
            (candidate.quality?.cursorPenalty || 0) * 12 -
            entry.y * 0.0001;
        };
        return score(right) - score(left);
      });
      const unique = [];
      choices.forEach(({ candidate }) => {
        const canvas = candidate.canvas || candidate.baseCanvas;
        if (!canvas || !unique.some((other) => (other.canvas || other.baseCanvas) === canvas)) {
          unique.push(candidate);
        }
      });
      const best = choices[0];
      return {
        ...best.candidate,
        sequenceIndex: best.entry.sequenceIndex,
        sequenceRowIndex: best.entry.sequenceRowIndex,
        status: 'complete',
        candidates: unique.slice(0, 8),
      };
    });
    return { rows, removedDuplicates: located.length - rows.length, scrollOffsets: offsets };
  }

  function notationClarity(candidate) {
    if (Number.isFinite(candidate.__v04Clarity)) return candidate.__v04Clarity;
    const canvas = candidate.baseCanvas || candidate.canvas;
    if (!canvas?.getContext) return 0;
    const pixels = canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const step = Math.max(1, Math.round(canvas.width / 800));
    let dark = 0;
    let grey = 0;
    for (let y = Math.round(canvas.height * 0.10); y < canvas.height * 0.90; y += step) {
      for (let x = Math.round(canvas.width * 0.02); x < canvas.width * 0.98; x += step) {
        const offset = (y * canvas.width + x) * 4;
        const value = (pixels[offset] * 3 + pixels[offset + 1] * 6 + pixels[offset + 2]) / 10;
        if (value < 80) dark += 1;
        else if (value < 205) grey += 1;
      }
    }
    return candidate.__v04Clarity = dark / Math.max(1, dark + grey);
  }

  function capturedInkDistance(left, right) {
    const a = left.sourceCanvas;
    const b = right.sourceCanvas;
    if (!a?.width || !b?.width || Math.abs(a.width - b.width) > a.width * 0.02 ||
        Math.abs(a.height - b.height) > a.height * 0.02) return 1;
    const width = Math.min(800, a.width);
    const height = Math.max(1, Math.round(a.height * width / a.width));
    const sample = (source) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(source, 0, 0, width, height);
      return context.getImageData(0, 0, width, height).data;
    };
    const one = sample(a);
    const two = sample(b);
    let changed = 0;
    let total = 0;
    for (let y = Math.round(height * 0.12); y < height * 0.80; y += 1) {
      for (let x = Math.round(width * 0.01); x < width * 0.99; x += 1) {
        const offset = (y * width + x) * 4;
        const grayOne = (one[offset] * 3 + one[offset + 1] * 6 + one[offset + 2]) / 10;
        const grayTwo = (two[offset] * 3 + two[offset + 1] * 6 + two[offset + 2]) / 10;
        if ((grayOne < 180) !== (grayTwo < 180)) changed += 1;
        total += 1;
      }
    }
    return changed / Math.max(1, total);
  }

  function mergeAdjacentCaptureRows(sequences) {
    const groups = sequences || [];
    const all = groups.flatMap((sequence) => sequence.rows || []);
    if (groups.length < 3 || all.length < 3 || all.length / groups.length > 1.3 ||
        all.filter((row) => row.sourceCanvas?.height / row.sourceCanvas?.width < 0.30).length < all.length * 0.75) {
      return null;
    }
    // A visually similar neighboring frame may show the next distinct score
    // line. Keep each group's own image and candidates in capture order.
    return { rows: all, removedDuplicates: 0 };
  }

  function mergeSequences(sequences) {
    const result = [];
    let uncertain = 0;
    let removedDuplicates = 0;
    const deferredPartials = [];
    (sequences || []).forEach((sequence, sequenceIndex) => {
      const all = (sequence.rows || sequence || []).filter(Boolean).map((row, rowIndex) => ({
        ...row, sequenceIndex, sequenceRowIndex: rowIndex,
      }));
      const complete = all.filter((row) => !partial(row));
      deferredPartials.push(...all.filter((row) => partial(row)));
      const incoming = complete.length ? complete : all;
      if (!incoming.length) return;
      if (!result.length) {
        result.push(...incoming);
        return;
      }
      const match = alignment(result, incoming);
      if (match) {
        incoming.forEach((row, i) => {
          const target = i + match.offset;
          if (target >= 0 && target < result.length && distance(result[target], row) <= 0.31) {
            mergeCandidate(result[target], row);
            removedDuplicates += 1;
          } else if (target >= result.length) {
            result.push(row);
          }
        });
        return;
      }
      uncertain += 1;
      incoming.forEach((row) => {
        const duplicate = result.slice(-24).find(
          (old) => old.sequenceIndex !== sequenceIndex && distance(old, row) <= 0.065
        );
        if (duplicate) {
          mergeCandidate(duplicate, row);
          removedDuplicates += 1;
        } else result.push(row);
      });
    });
    deferredPartials.forEach((row) => {
      let best = null;
      let bestDistance = 1;
      result.forEach((candidate) => {
        const digits = digitDistance(candidate, row);
        const value = digits == null ? distance(candidate, row) : digits;
        if (value < bestDistance) { best = candidate; bestDistance = value; }
      });
      if (best && bestDistance <= 0.23) {
        mergeCandidate(best, row);
        removedDuplicates += 1;
      }
    });
    const warnings = uncertain ? [{
      type: 'gap-summary',
      count: uncertain,
      message: '有 ' + uncertain + ' 次滚动没有足够重叠；已去除明确重复，并按时间保留其余完整行',
    }] : [];
    return { rows: result, warnings, removedDuplicates };
  }

  function dedupeRows(rows) {
    const output = [];
    const duplicates = [];
    (rows || []).forEach((row) => {
      const match = output.slice(-24).find((candidate) => {
        if (candidate.sequenceIndex === row.sequenceIndex) return false;
        const lm = measureOf(candidate);
        const rm = measureOf(row);
        if (lm != null && rm != null && lm !== rm) return false;
        return distance(candidate, row) <= 0.06;
      });
      if (!match) output.push(row);
      else {
        mergeCandidate(match, row);
        duplicates.push({ kept: match, removed: row });
      }
    });
    return { rows: output, duplicates };
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

  function candidateCanvas(candidate) {
    if (!candidate) return null;
    return candidate.candidateCanvas || candidate.canvas || candidate.baseCanvas || null;
  }

  function selectedCandidateIndex(row, candidates) {
    const list = Array.isArray(candidates) && candidates.length ? candidates : [row];
    const active = row?.baseCanvas || row?.canvas || null;
    const matched = list.findIndex((candidate) => candidateCanvas(candidate) === active ||
      candidate?.baseCanvas === active);
    if (matched >= 0) return matched;
    const explicit = Number(row?.selectedCandidateIndex);
    return Number.isInteger(explicit) && explicit >= 0 && explicit < list.length
      ? explicit : 0;
  }

  function paginateRows(rows, options = {}) {
    const pageWidth = options.pageWidth || 1240;
    const pageHeight = options.pageHeight || 1754;
    const marginX = options.marginX == null ? 72 : options.marginX;
    const marginY = options.marginY == null ? 64 : options.marginY;
    const header = options.header == null ? 68 : options.header;
    const footer = options.footer == null ? 42 : options.footer;
    const gap = options.rowGap == null ? 18 : options.rowGap;
    const scoreScale = clamp(options.scoreScale || 1, 0.55, 1.25);
    const maxRowHeight = options.maxRowHeight || 330;
    const contentWidth = pageWidth - marginX * 2;
    const contentTop = marginY + header;
    const contentBottom = pageHeight - marginY - footer;
    const usableHeight = contentBottom - contentTop;
    const horizontalWidths = (rows || [])
      .filter((row) => row?.horizontalSource && row?.canvas)
      .map((row) => row.canvas.width)
      .sort((a, b) => a - b);
    const horizontalLayoutWidths = (rows || [])
      .filter((row) => row?.horizontalSource?.layoutWidth)
      .map((row) => row.horizontalSource.layoutWidth)
      .sort((a, b) => a - b);
    const horizontalReferenceWidth = horizontalWidths.length
      ? Math.max(horizontalWidths[Math.floor((horizontalWidths.length - 1) / 2)],
        horizontalLayoutWidths[Math.floor((horizontalLayoutWidths.length - 1) / 2)] || 0)
      : 0;
    const items = (rows || []).filter((row) => row?.canvas).map((row) => {
      // Use the A4 width almost fully at 125% while keeping the whole row
      // visible. Values above that would crop notation off the page.
      const maximumWidth = pageWidth - 8;
      let width = contentWidth * scoreScale *
        (row.horizontalSource ? 1 : 0.9);
      width = Math.min(maximumWidth, Math.max(contentWidth * 0.55, width));
      if (row.horizontalSource && horizontalReferenceWidth) {
        width *= row.canvas.width / horizontalReferenceWidth;
        width = Math.min(maximumWidth, width);
      }
      let height = row.canvas.height * width / Math.max(1, row.canvas.width);
      if (height > maxRowHeight) {
        width *= maxRowHeight / height;
        height = maxRowHeight;
      }
      const markerSpace = String(row.sectionMarker || '').trim() ? 42 : 0;
      return { row, width, height, markerSpace };
    });
    const grouped = [];
    let page = [];
    let used = 0;
    items.forEach((item) => {
      const needed = item.height + item.markerSpace + (page.length ? gap : 0);
      if (page.length && used + needed > usableHeight) {
        grouped.push(page);
        page = [];
        used = 0;
      }
      page.push(item);
      used += item.height + item.markerSpace + (page.length > 1 ? gap : 0);
    });
    if (page.length) grouped.push(page);
    return grouped.map((pageItems, pageIndex) => {
      const rowHeight = pageItems.reduce((sum, item) => sum + item.height + item.markerSpace, 0);
      const placedGap = gap;
      let y = contentTop;
      const placed = pageItems.map((item) => {
        const x = item.row.horizontalSource
          ? marginX : marginX + (contentWidth - item.width) / 2;
        const imageY = y + item.markerSpace;
        const placedItem = { row: item.row, x, y: imageY, width: item.width, height: item.height, markerSpace: item.markerSpace };
        y += item.height + item.markerSpace + placedGap;
        return placedItem;
      });
      return { pageIndex, items: placed, pageWidth, pageHeight, marginX, marginY, header, footer, contentTop, contentBottom };
    });
  }

  core.__baseMeasureDetector = core.detectMeasureNumber;
  core.cleanColorArtifacts = cleanColorArtifacts;
  core.normalizeLightNotation = normalizeLightNotation;
  core.binarizeNotation = binarizeNotation;
  core.cleanOpeningRestPlaceholder = cleanOpeningRestPlaceholder;
  core.detectStaffSystems = bands;
  core.staffRowSourceBounds = staffRowSourceBounds;
  core.extractStaffRows = extractRows;
  core.rowMeasure = measureOf;
  core.rowMatchDistance = distance;
  core.numberLabelDistance = numberLabelDistance;
  core.mergeRowSequences = mergeSequences;
  core.mergeScrollingSequences = mergeScrollingSequences;
  core.mergeAdjacentCaptureRows = mergeAdjacentCaptureRows;
  core.dedupeRows = dedupeRows;
  core.normalizeReviewState = normalizeReviewState;
  core.candidateCanvas = candidateCanvas;
  core.selectedCandidateIndex = selectedCandidateIndex;
  core.paginateRows = paginateRows;
}());













