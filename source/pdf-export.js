(function attachDrumScopePdf(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DrumScopePdf = factory(root.DrumScopeCore);
  }
}(typeof self !== 'undefined' ? self : this, function createPdf(core) {
  'use strict';

  function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.96) {
    return new Promise((resolve, reject) => {
      if (!canvas || typeof canvas.toBlob !== 'function') {
        reject(new Error('当前浏览器无法生成图片'));
        return;
      }

      canvas.toBlob(
        (blob) => blob
          ? resolve(blob)
          : reject(new Error('图片编码失败')),
        type,
        quality
      );
    });
  }

  function detectStaffSpan(row, staffTop, staffBottom) {
    const canvas = row?.canvas;
    if (!canvas || typeof canvas.getContext !== 'function' || !canvas.width || !canvas.height) {
      return null;
    }
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const lineYs = Array.from({ length: 5 }, (_, index) => Math.round(
        staffTop + (staffBottom - staffTop) * index / 4
      ));
      const active = new Array(canvas.width).fill(false);
      for (let x = 0; x < canvas.width; x += 1) {
        let darkLines = 0;
        lineYs.forEach((lineY) => {
          let dark = false;
          for (let offset = -1; offset <= 1 && !dark; offset += 1) {
            const y = Math.max(0, Math.min(canvas.height - 1, lineY + offset));
            const pixel = (y * canvas.width + x) * 4;
            const luminance = pixels[pixel] * .299 + pixels[pixel + 1] * .587 + pixels[pixel + 2] * .114;
            dark = pixels[pixel + 3] > 40 && luminance < 210;
          }
          if (dark) darkLines += 1;
        });
        active[x] = darkLines >= 3;
      }

      let best = null;
      let runStart = -1;
      let lastActive = -1;
      for (let x = 0; x <= active.length; x += 1) {
        if (x < active.length && active[x]) {
          if (runStart < 0) runStart = x;
          lastActive = x;
        } else if (runStart >= 0 && (x - lastActive > 2 || x === active.length)) {
          const run = { start: runStart, end: lastActive };
          if (!best || run.end - run.start > best.end - best.start) best = run;
          runStart = -1;
          lastActive = -1;
        }
      }
      if (best && best.end - best.start >= canvas.width * .25) return best;
    } catch (_error) {
      // Fall back to conservative in-image anchors when pixel access is unavailable.
    }
    return null;
  }

  function drawStaffBridge(context, left, right, staffTop, staffBottom) {
    const spacing = (staffBottom - staffTop) / 4;
    context.save();
    context.strokeStyle = '#303030';
    context.lineWidth = Math.max(.75, spacing * .12);
    for (let index = 0; index < 5; index += 1) {
      const y = staffTop + spacing * index;
      context.beginPath();
      context.moveTo(left - 1, y);
      context.lineTo(right + 1, y);
      context.stroke();
    }
    context.restore();
  }

  function drawRepeatGlyph(context, patchLeft, staffTop, staffBottom, side) {
    const spacing = Math.max(2, (staffBottom - staffTop) / 4);
    const center = (staffTop + staffBottom) / 2;
    const thickWidth = Math.max(2.4, spacing * .55);
    const thinWidth = Math.max(1, spacing * .18);
    const isStart = side === 'start';
    const thickX = patchLeft + spacing * (isStart ? .68 : 3.48);
    const thinX = patchLeft + spacing * (isStart ? 1.72 : 2.42);
    const dotX = patchLeft + spacing * (isStart ? 3.16 : 1.03);
    const top = staffTop - spacing * .14;
    const height = staffBottom - staffTop + spacing * .28;

    context.save();
    context.fillStyle = '#111111';
    context.fillRect(thinX - thinWidth / 2, top, thinWidth, height);
    context.fillRect(thickX - thickWidth / 2, top, thickWidth, height);
    [center - spacing * .5, center + spacing * .5].forEach((dotY) => {
      context.beginPath();
      context.arc(dotX, dotY, Math.max(1.25, spacing * .24), 0, Math.PI * 2);
      context.fill();
    });
    context.restore();
  }

  function makeWhiteCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return { canvas, context };
  }

  // Repeat signs are inserted as new image strips. This keeps the original
  // percussion clef and musical content intact instead of painting over them.
  function composeRepeatRowCanvas(row, repeatMark) {
    if (!row?.canvas || typeof document === 'undefined') return row?.canvas;
    const includeStart = repeatMark === 'start' || repeatMark === 'both';
    const includeEnd = repeatMark === 'end' || repeatMark === 'both';
    if (!includeStart && !includeEnd) return row.canvas;

    const naturalHeight = Math.max(1, Number(row.canvas.height) || 1);
    const staffTop = Number.isFinite(row.staffTop) ? row.staffTop : naturalHeight * .4;
    const staffBottom = Number.isFinite(row.staffBottom) ? row.staffBottom : naturalHeight * .68;
    const spacing = Math.max(2, (staffBottom - staffTop) / 4);
    const originalSpan = detectStaffSpan(row, staffTop, staffBottom) || {
      start: Number(row.canvas.width) * .06,
      end: Number(row.canvas.width) * .94,
    };

    let working = row.canvas;
    let width = Number(working.width);
    const staffStart = originalSpan.start;
    let staffEnd = originalSpan.end;

    if (includeStart) {
      // Cut immediately after the percussion clef, insert a clean staff strip,
      // then stitch the notes back on the right.
      const cut = Math.max(1, Math.min(width - 1, staffStart + spacing * 3.25));
      const insertWidth = spacing * 4.15;
      const target = makeWhiteCanvas(width + insertWidth, naturalHeight);
      target.context.drawImage(working, 0, 0, cut, naturalHeight, 0, 0, cut, naturalHeight);
      target.context.drawImage(
        working,
        cut,
        0,
        width - cut,
        naturalHeight,
        cut + insertWidth,
        0,
        width - cut,
        naturalHeight
      );
      drawStaffBridge(target.context, cut, cut + insertWidth, staffTop, staffBottom);
      drawRepeatGlyph(target.context, cut, staffTop, staffBottom, 'start');
      working = target.canvas;
      width = working.width;
      staffEnd += insertWidth;
    }

    if (includeEnd) {
      // Replace the old terminal barline with a clean end-repeat strip.
      const removeHalfWidth = Math.max(1.25, spacing * .48);
      const cutLeft = Math.max(1, Math.min(width - 2, staffEnd - removeHalfWidth));
      const cutRight = Math.max(cutLeft + 1, Math.min(width - 1, staffEnd + removeHalfWidth));
      const insertWidth = spacing * 4.15;
      const targetWidth = width - (cutRight - cutLeft) + insertWidth;
      const target = makeWhiteCanvas(targetWidth, naturalHeight);
      target.context.drawImage(working, 0, 0, cutLeft, naturalHeight, 0, 0, cutLeft, naturalHeight);
      target.context.drawImage(
        working,
        cutRight,
        0,
        width - cutRight,
        naturalHeight,
        cutLeft + insertWidth,
        0,
        width - cutRight,
        naturalHeight
      );
      drawStaffBridge(target.context, cutLeft, cutLeft + insertWidth, staffTop, staffBottom);
      drawRepeatGlyph(target.context, cutLeft, staffTop, staffBottom, 'end');
      working = target.canvas;
    }

    // Reuse the existing row cleanup after stitching so the source image and
    // inserted strip are normalized to the same pure-white paper background.
    if (core && typeof core.cleanColorArtifacts === 'function') {
      return core.cleanColorArtifacts(working, { whitenBackground: true });
    }
    return working;
  }

  function drawRepeatCount(context, item, row, renderedRow, repeatCount) {
    const count = Math.round(Number(repeatCount));
    if (!Number.isFinite(count) || count < 2) return;
    const naturalWidth = Math.max(1, Number(renderedRow?.width) || Number(row?.canvas?.width) || 1);
    const naturalHeight = Math.max(1, Number(renderedRow?.height) || Number(row?.canvas?.height) || 1);
    const staffTop = Number.isFinite(row?.staffTop) ? row.staffTop : naturalHeight * .4;
    const staffBottom = Number.isFinite(row?.staffBottom) ? row.staffBottom : naturalHeight * .68;
    const span = detectStaffSpan({ canvas: renderedRow }, staffTop, staffBottom) || {
      start: naturalWidth * .06,
      end: naturalWidth * .94,
    };
    const ratioX = item.width / naturalWidth;
    const ratioY = item.height / naturalHeight;
    const spacing = Math.max(3, (staffBottom - staffTop) * ratioY / 4);
    const x = item.x + span.end * ratioX;
    const preferredY = item.y + staffBottom * ratioY + spacing * 2.35;
    const y = Math.min(item.y + item.height - 3, preferredY);
    context.save();
    context.fillStyle = '#171717';
    context.font = `700 ${Math.max(13, Math.min(22, spacing * 1.55))}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    context.textAlign = 'right';
    context.textBaseline = 'bottom';
    context.fillText(`×${count}`, x, y);
    context.restore();
  }

  function renderPageCanvases(rows, title, options = {}) {
    const scale = options.scale || 1;
    const pageWidth = options.pageWidth || 1240;
    const pageHeight = options.pageHeight || 1754;
    const requestedTitleSize = Number(options.titleSize);
    const titleSize = Math.max(24, Math.min(72, Number.isFinite(requestedTitleSize) ? requestedTitleSize : 42));
    const header = options.header == null ? Math.max(82, titleSize + 50) : options.header;

    const layout = core.paginateRows(rows, {
      ...options,
      pageWidth,
      pageHeight,
      header,
      rowGap: options.rowGap == null ? 18 : options.rowGap,
      scoreScale: options.scoreScale || 1
    });

    if (typeof document === 'undefined') {
      return { canvases: [], layout };
    }

    const canvases = layout.map((page, pageIndex) => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(pageWidth * scale);
      canvas.height = Math.round(pageHeight * scale);

      const context = canvas.getContext('2d');

      context.save();
      context.scale(scale, scale);

      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, pageWidth, pageHeight);

      if (pageIndex === 0 && title) {
        context.fillStyle = '#171717';
        context.font = `700 ${titleSize}px "Microsoft YaHei", "Segoe UI", sans-serif`;
        context.textAlign = 'center';
        context.fillText(title, pageWidth / 2, page.marginY + Math.round(titleSize * 0.9));
      }

      const tempo = Number(options.tempo);
      if (pageIndex === 0 && Number.isFinite(tempo) && tempo >= 30 && tempo <= 300 && page.items.length) {
        const firstItem = page.items[0];
        context.save();
        context.fillStyle = '#252525';
        context.font = '600 18px "Segoe UI Symbol", "Microsoft YaHei", sans-serif';
        context.textAlign = 'left';
        context.fillText(`♩ = ${Math.round(tempo)}`, firstItem.x + 16, firstItem.y - 4);
        context.restore();
      }

      page.items.forEach((item, itemIndex) => {
        const row = item.row;
        if (row && row.canvas) {
          const marker = String(row.sectionMarker || '').trim().slice(0, 12);
          if (marker) {
            const hasTempo = pageIndex === 0 && itemIndex === 0 && Number.isFinite(tempo) && tempo >= 30 && tempo <= 300;
            const markerWidth = Math.max(34, Math.min(190, 18 + Array.from(marker).length * 15));
            const markerHeight = 34;
            const markerLeft = item.x + (hasTempo ? 112 : 14);
            const markerTop = item.y - 38;
            context.save();
            context.fillStyle = '#ffffff';
            context.fillRect(markerLeft, markerTop, markerWidth, markerHeight);
            context.strokeStyle = '#202020';
            context.lineWidth = 2;
            context.strokeRect(markerLeft, markerTop, markerWidth, markerHeight);
            context.fillStyle = '#171717';
            context.font = '700 21px "Segoe UI", "Microsoft YaHei", sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(marker, markerLeft + markerWidth / 2, markerTop + markerHeight / 2 + 1);
            context.restore();
          }
          const repeatMark = String(row.repeatMark || 'none');
          const renderedRow = composeRepeatRowCanvas(row, repeatMark);
          context.drawImage(
            renderedRow,
            item.x,
            item.y,
            item.width,
            item.height
          );
          drawRepeatCount(context, item, row, renderedRow, row.repeatCount);
        }
      });

      context.fillStyle = '#888888';
      context.font = '16px monospace';
      context.textAlign = 'center';
      context.fillText(
        `${pageIndex + 1} / ${layout.length}`,
        pageWidth / 2,
        pageHeight - 34
      );

      context.restore();
      return canvas;
    });

    return { canvases, layout };
  }

  function concat(...arrays) {
    const length = arrays.reduce(
      (sum, item) => sum + item.length,
      0
    );

    const result = new Uint8Array(length);
    let offset = 0;

    arrays.forEach((item) => {
      result.set(item, offset);
      offset += item.length;
    });

    return result;
  }

  async function canvasesToPdf(canvases, options = {}) {
    if (!canvases || !canvases.length) {
      throw new Error('没有可以写入 PDF 的页面');
    }

    const type = options.type || 'image/jpeg';
    const quality = options.quality == null ? 0.97 : options.quality;
    const images = [];

    for (const canvas of canvases) {
      const blob = await canvasToBlob(canvas, type, quality);

      images.push({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        width: canvas.width,
        height: canvas.height
      });
    }

    const objectCount = 2 + images.length * 3;
    const objects = new Array(objectCount + 1);
    const encoder = new TextEncoder();
    const ascii = (value) => encoder.encode(value);

    objects[1] = ascii(
      '<< /Type /Catalog /Pages 2 0 R >>'
    );

    const kids = images
      .map((_, index) => `${3 + index * 3} 0 R`)
      .join(' ');

    objects[2] = ascii(
      `<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>`
    );

    images.forEach((image, index) => {
      const pageId = 3 + index * 3;
      const imageId = pageId + 1;
      const contentId = pageId + 2;

      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const imageFilter = type === 'image/png'
        ? '/FlateDecode'
        : '/DCTDecode';

      objects[pageId] = ascii(
        `<< /Type /Page /Parent 2 0 R ` +
        `/MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`
      );

      objects[imageId] = concat(
        ascii(
          `<< /Type /XObject /Subtype /Image ` +
          `/Width ${image.width} /Height ${image.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
          `/Filter ${imageFilter} /Length ${image.bytes.length} >>\n` +
          `stream\n`
        ),
        image.bytes,
        ascii('\nendstream')
      );

      const command = ascii(
        `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`
      );

      objects[contentId] = concat(
        ascii(
          `<< /Length ${command.length} >>\nstream\n`
        ),
        command,
        ascii('\nendstream')
      );
    });

    const header = concat(
      ascii('%PDF-1.4\n%'),
      new Uint8Array([226, 227, 207, 211]),
      ascii('\n')
    );

    const chunks = [header];
    const offsets = new Array(objectCount + 1).fill(0);
    let position = header.length;

    for (let id = 1; id <= objectCount; id += 1) {
      const object = concat(
        ascii(`${id} 0 obj\n`),
        objects[id],
        ascii('\nendobj\n')
      );

      offsets[id] = position;
      chunks.push(object);
      position += object.length;
    }

    const xrefPosition = position;

    let xref =
      `xref\n0 ${objectCount + 1}\n` +
      `0000000000 65535 f \n`;

    for (let id = 1; id <= objectCount; id += 1) {
      xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }

    chunks.push(
      ascii(xref),
      ascii(
        `trailer\n` +
        `<< /Size ${objectCount + 1} /Root 1 0 R >>\n` +
        `startxref\n${xrefPosition}\n%%EOF`
      )
    );

    return new Blob(chunks, {
      type: 'application/pdf'
    });
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  return {
    canvasToBlob,
    renderPageCanvases,
    canvasesToPdf,
    download
  };
}));
