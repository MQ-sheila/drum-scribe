const assert = require('node:assert/strict');

global.window = { DrumScopeCore: {} };
require('../core-horizontal.js');
const { matchHorizontalScroll } = window.DrumScopeCore;

const width = 320;
const height = 64;
const worldWidth = 800;
const world = new Uint8Array(worldWidth * height);
for (let y = 18; y <= 42; y += 6) {
  for (let x = 0; x < worldWidth; x += 1) world[y * worldWidth + x] = 1;
}
for (let note = 0; note < 70; note += 1) {
  const x = 8 + note * 11 + note % 4;
  const y = 9 + (note * 17) % 39;
  for (let yy = y; yy < Math.min(height - 2, y + 5); yy += 1) {
    for (let xx = x; xx < Math.min(worldWidth, x + 3); xx += 1) {
      world[yy * worldWidth + xx] = 1;
    }
  }
}
const frame = (start) => {
  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    bits.set(world.subarray(y * worldWidth + start,
      y * worldWidth + start + width), y * width);
  }
  return { bits, width, height };
};

assert.equal(matchHorizontalScroll(frame(0), frame(0)).shift, 0);
assert.equal(matchHorizontalScroll(frame(0), frame(37)).shift, 37);
assert.equal(matchHorizontalScroll(frame(37), frame(91)).shift, 54);
assert.equal(matchHorizontalScroll(frame(91), frame(400)), null,
  'a jump with no reliable overlap starts another strip');

console.log('horizontal scroll matching passed');
