'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('extension/detector.js', 'utf8'), sandbox);
const D = sandbox.FJDetector;

class MockWrap {
  constructor(cls, bg) {
    this.className = cls;
    this.bg = bg;
  }
  getAttribute(name) { return name === 'class' ? this.className : null; }
}

class MockItem {
  constructor(id, cls, bg, headline) {
    this.id = id;
    this.wrap = new MockWrap(cls, bg);
    this.headline = headline;
  }
  querySelector(sel) {
    if (sel === '.feedWrap') return this.wrap;
    if (sel === '.headline-title a' || sel === '.headline-title' ||
        sel === '.headline-title-nolink' || sel === '.headline-content') {
      return { innerText: this.headline };
    }
    if (sel === '.time') return { innerText: '10:42' };
    return null;
  }
  getAttribute(name) { return name === 'data-headlineid' ? String(this.id) : null; }
  get innerText() { return this.headline; }
}

const win = {
  getComputedStyle(el) { return { backgroundColor: el.bg, background: el.bg }; }
};

const cases = [
  ['active red class', new MockItem(1, 'media feedWrap active', 'rgb(255, 255, 255)', 'x'), true],
  ['critical red class', new MockItem(2, 'feedWrap active-critical', 'rgba(0, 0, 0, 0)', 'x'), true],
  ['company news blue', new MockItem(3, 'feedWrap comm-news active', 'rgb(0, 110, 173)', 'x'), false],
  ['plain white', new MockItem(4, 'media feedWrap', 'rgb(255, 255, 255)', 'x'), false],
  ['inline red', new MockItem(5, 'media feedWrap', 'rgb(199, 0, 25)', 'x'), true],
  ['orange is not red', new MockItem(6, 'media feedWrap', 'rgb(228, 87, 53)', 'x'), false],
  ['dark red', new MockItem(7, 'media feedWrap', '#b70000', 'x'), true]
];

for (const [name, item, expected] of cases) {
  const actual = D.isRedItem(item, win);
  assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`);
  console.log(`ok  ${name} -> ${actual}`);
}

assert.strictEqual(D.parseColor('#b80101').r, 184);
assert.strictEqual(D.parseColor('rgba(184, 1, 1, 0.9)').g, 1);
assert.strictEqual(D.itemId(new MockItem(99, '', '', '')), '99');
assert.strictEqual(D.headlineOf(new MockItem(1, '', '', 'Hello  world')), 'Hello world');
console.log('all detector tests passed');
