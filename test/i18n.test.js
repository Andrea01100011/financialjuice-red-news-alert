'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const sandbox = { console };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('extension/i18n.js', 'utf8'), sandbox);

const { en, zh } = sandbox.FJI18N.messages;
const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();
assert.deepStrictEqual(zhKeys, enKeys, 'English and Chinese dictionaries must have the same keys');

for (const key of enKeys) {
  assert.strictEqual(typeof en[key], 'string', `en.${key} must be a string`);
  assert.ok(en[key].length > 0, `en.${key} must not be empty`);
  assert.strictEqual(typeof zh[key], 'string', `zh.${key} must be a string`);
  assert.ok(zh[key].length > 0, `zh.${key} must not be empty`);
}

const html = fs.readFileSync('extension/popup.html', 'utf8');
const htmlKeys = new Set();
for (const match of html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)) {
  htmlKeys.add(match[1]);
}
for (const key of htmlKeys) {
  assert.ok(en[key] != null, `popup.html uses missing key: ${key}`);
}

const sources = ['extension/content.js', 'extension/popup.js', 'extension/background.js']
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

const usedKeys = new Set(htmlKeys);
for (const match of sources.matchAll(/tr\('([^']+)'/g)) usedKeys.add(match[1]);
for (const match of sources.matchAll(/I18N\.t\([^,]+,\s*'([^']+)'/g)) usedKeys.add(match[1]);
usedKeys.add('keywordHelpFiltered');
usedKeys.add('keywordHelpAll');

for (const key of usedKeys) {
  assert.ok(en[key] != null && zh[key] != null, `UI uses missing key: ${key}`);
}

for (const key of enKeys) {
  if (key === 'languageZh') continue;
  assert.ok(!/[\u4e00-\u9fff]/.test(en[key]), `English string contains Chinese: ${key}`);
}

console.log(`i18n ok: ${enKeys.length} keys, ${usedKeys.size} UI keys checked`);
