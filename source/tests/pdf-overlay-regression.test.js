const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const textCalls = [];
const alignStack = [];
let currentAlign = 'start';
let currentFont = '';
let imageDraws = 0;
let markerBoxes = 0;
let repeatBars = 0;
let repeatDots = 0;
const repeatBarXs = [];
const context = {
  save() { alignStack.push(currentAlign); },
  restore() { currentAlign = alignStack.pop() ?? currentAlign; },
  scale() {},
  fillRect(_x, _y, width, height) {
    if (width <= 8 && height >= 18) { repeatBars += 1; repeatBarXs.push(_x); }
  },
  beginPath() {},
  moveTo() {},
  lineTo() {},
  stroke() {},
  arc() { repeatDots += 1; },
  fill() {},
  strokeRect() { markerBoxes += 1; },
  drawImage() { imageDraws += 1; },
  fillText(text, x, y) { textCalls.push({ text: String(text), x, y, align: currentAlign, font: currentFont }); },
  set fillStyle(_value) {}, set strokeStyle(_value) {}, set lineWidth(_value) {},
  set font(value) { currentFont = value; },
  set textAlign(value) { currentAlign = value; }, set textBaseline(_value) {},
};
const document = {
  createElement(name) {
    assert.equal(name, 'canvas');
    return { width: 0, height: 0, getContext: () => context };
  },
};
const core = {
  paginateRows(rows) {
    return [{
      marginX: 50,
      marginY: 50,
      items: [{ row: rows[0], x: 70, y: 100, width: 900, height: 120 }],
    }];
  },
};
const self = { DrumScopeCore: core };
vm.runInNewContext(
  fs.readFileSync(require.resolve('../pdf-export.js'), 'utf8'),
  { self, document, Blob, URL, TextEncoder, Uint8Array, setTimeout }
);
self.DrumScopePdf.renderPageCanvases([
  { measureNumber: 37, sectionMarker: 'B', repeatMark: 'both', repeatCount: 3, staffTop: 40, staffBottom: 80, canvas: { width: 900, height: 120 } },
], '测试谱名', { scale: 1, tempo: 96, titleSize: 54 });
assert.equal(imageDraws, 5, '首尾反复记号应各经过一次图片切片拼接，并正常绘制谱行');
assert.deepEqual(
  textCalls.map((call) => call.text),
  ['测试谱名', '♩ = 96', 'B', '×3', '1 / 1'],
  '应绘制标题、速度、段落、右下角反复次数和页码，反复线不得作为文字输出'
);
assert.equal(markerBoxes, 1, '段落标识必须绘制为方框');
assert.equal(repeatBars, 4, '首尾反复记号应各绘制一粗一细两条小节线');
assert.equal(repeatDots, 4, '首尾反复记号应各绘制上下两个圆点');
assert.ok(Math.min(...repeatBarXs) > 0, 'start repeat barline must sit inside the stitched strip');
assert.ok(Math.max(...repeatBarXs) < 950, 'end repeat barline must sit inside the stitched strip');
assert.ok(Math.max(...repeatBarXs) - Math.min(...repeatBarXs) > 700, 'repeat signs must stay at opposite staff ends');
assert.deepEqual(
  { x: textCalls[0].x, align: textCalls[0].align },
  { x: 620, align: 'center' },
  '谱名必须在页面顶部居中'
);
assert.deepEqual(
  { x: textCalls[1].x, y: textCalls[1].y, align: textCalls[1].align },
  { x: 86, y: 96, align: 'left' },
  '速度标记必须贴近第一行谱面左上方'
);
assert.match(textCalls[0].font, /54px/, '标题大小必须传递到页面绘制');
console.log('PDF title, tempo, and measure overlay regression tests passed');

