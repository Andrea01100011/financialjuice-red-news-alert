'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function load(fetchImpl) {
  const sandbox = {
    console,
    fetch: fetchImpl || (() => Promise.reject(new Error('no network in unit test'))),
    AbortController,
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('extension/translator.js', 'utf8'), sandbox);
  return sandbox.FJTranslator;
}

const T = load();

assert.strictEqual(T.isTranslatable('US CPI MoM 0.4% vs 0.3% expected'), true);
assert.strictEqual(T.isTranslatable('美国 CPI 同比 3.2%'), false);
assert.strictEqual(T.isTranslatable('12345'), false);
assert.strictEqual(T.isTranslatable('ab'), false);

const url = T.myMemoryUrl('US CPI MoM 0.4% vs 0.3% expected');
assert.ok(url.includes('langpair=en%7Czh-CN'), 'language pair is encoded');
assert.ok(url.includes('de='), 'contact parameter raises the daily quota');
assert.ok(url.includes('US%20CPI'), 'text is URL encoded');

const ok = T.parseMyMemory({
  responseStatus: 200,
  responseData: { translatedText: '联邦公开市场委员会发布紧急声明' }
});
assert.strictEqual(JSON.stringify(ok), JSON.stringify({ ok: true, text: 'FOMC 发布紧急声明' }));

const quota = T.parseMyMemory({ responseStatus: 200, quotaFinished: true });
assert.strictEqual(JSON.stringify(quota), JSON.stringify({ ok: false, error: 'quota' }));

const warning = T.parseMyMemory({
  responseStatus: 200,
  responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' }
});
assert.strictEqual(warning.error, 'quota');

const ds = T.parseDeepSeek({
  choices: [{ message: { content: '“美国CPI环比0.4%，预期0.3%”' } }]
});
assert.strictEqual(JSON.stringify(ds), JSON.stringify({ ok: true, text: '美国CPI环比0.4%，预期0.3%' }));

(async () => {
  const calls = [];
  const fakeFetch = (u) => {
    calls.push(u);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        responseStatus: 200,
        responseData: { translatedText: '美国消费者物价指数环比上涨0.4%' }
      })
    });
  };
  const live = load(fakeFetch);
  const result = await live.translate('US CPI MoM 0.4% expected');
  assert.strictEqual(result.ok, true);
  assert.ok(result.text.includes('CPI') || result.text.includes('消费者'));
  assert.strictEqual(calls.length, 1);

  const missing = await load(fakeFetch).translate('hello world', { provider: 'deepseek' });
  assert.strictEqual(missing.error, 'missing-key');

  console.log('translator tests passed');
})();
