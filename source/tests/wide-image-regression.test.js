const assert = require('node:assert/strict');

const core = require('../core-engine.js');

function fakeCanvas(width = 1, height = 1) {
  const calls = [];
  const context = {
    calls,
    drawImage(...args) { calls.push(args); },
    getImageData() {
      return { data: new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4), width: this.canvas.width, height: this.canvas.height };
    },
    putImageData() {},
  };
  const canvas = {
    width,
    height,
    getContext() {
      context.canvas = canvas;
      return context;
    },
  };
  return canvas;
}

global.window = { DrumScopeCore: core };
global.document = { createElement: () => fakeCanvas() };
require('../core-v04.js');

const source = fakeCanvas(2400, 1200);
const cleaned = core.cleanColorArtifacts(source);
assert.equal(cleaned.width, 2400);
assert.equal(cleaned.height, 1200);
assert.equal(cleaned.getContext().calls.length, 1, 'wide output must be painted by a full-size drawImage');
assert.equal(cleaned.getContext().calls[0][0], source);
assert.deepEqual(cleaned.getContext().calls[0].slice(1), [0, 0]);

console.log('Wide image cleanup regression tests passed');


