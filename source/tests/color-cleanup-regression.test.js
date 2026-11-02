const assert = require('node:assert/strict');
const core = require('../core-engine.js');

function fakeCanvas(width, height, pixels) {
  const canvas = { width, height, _data: pixels || new Uint8ClampedArray(width * height * 4) };
  canvas.getContext = () => ({
    drawImage(source) { canvas._data.set(source._data); },
    getImageData() { return { data: new Uint8ClampedArray(canvas._data), width, height }; },
    putImageData(image) { canvas._data.set(image.data); },
  });
  return canvas;
}

function setPixel(canvas, x, y, rgb) {
  const i = (y * canvas.width + x) * 4;
  canvas._data.set([...rgb, 255], i);
}
function pixel(canvas, x, y) {
  const i = (y * canvas.width + x) * 4;
  return Array.from(canvas._data.slice(i, i + 4));
}

const width = 80;
const height = 24;
const source = fakeCanvas(width, height);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) setPixel(source, x, y, [250, 246, 238]);
}
for (let x = 4; x < 76; x += 1) setPixel(source, x, 12, [12, 12, 12]);
setPixel(source, 18, 11, [45, 66, 82]); // JPEG colour fringe beside the staff.
setPixel(source, 24, 12, [25, 70, 180]); // Blue-selected dark notation.
setPixel(source, 25, 11, [225, 240, 255]); // Pale blue selection background.

global.window = { DrumScopeCore: core };
global.document = { createElement: () => fakeCanvas(width, height) };
require('../core-v04.js');
const cleaned = core.cleanColorArtifacts(source);

assert.deepEqual(pixel(cleaned, 25, 11), [255, 255, 255, 255], 'pale selection background should become white');
assert.deepEqual(pixel(cleaned, 24, 12), [25, 25, 25, 255], 'selected notation should be restored from blue to dark ink');
assert.deepEqual(pixel(cleaned, 18, 11).slice(0, 3), [45, 45, 45], 'colour fringe should be desaturated in place');
assert.deepEqual(pixel(cleaned, 40, 11), [255, 255, 255, 255], 'cleanup must not smear a staff line sideways into neighbouring pixels');
assert.deepEqual(pixel(cleaned, 40, 12), [12, 12, 12, 255], 'neutral black staff lines must remain unchanged');

console.log('Color cleanup regression tests passed');

