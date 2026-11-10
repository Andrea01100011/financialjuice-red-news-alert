'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function makeHarness(fetchImpl, settingsOverride) {
  const created = [];
  const updated = [];
  const local = {};
  let listener = null;

  const settings = Object.assign({
    enabled: true,
    sound: false,
    systemNotification: true,
    showStatus: false,
    translate: true,
    pageTranslate: false,
    provider: 'mymemory',
    apiKey: '',
    model: 'deepseek-chat',
    language: 'en',
    keywords: []
  }, settingsOverride || {});

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: fetchImpl,
    Date,
    Math,
    JSON,
    Promise,
    Object,
    String,
    Number,
    Array,
    Boolean
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  sandbox.importScripts = (...files) => {
    for (const f of files) {
      vm.runInContext(fs.readFileSync('extension/' + f, 'utf8'), sandbox, { filename: f });
    }
  };

  sandbox.chrome = {
    storage: {
      sync: {
        get(key, cb) { cb({ fjSettings: settings }); }
      },
      local: {
        get(key, cb) {
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) if (local[k] !== undefined) out[k] = local[k];
          if (typeof cb === 'function') cb(out);
          return Promise.resolve(out);
        },
        set(obj) { Object.assign(local, obj); return Promise.resolve(); }
      }
    },
    notifications: {
      create(id, opts) { created.push(opts); return id; },
      update(id, opts) { updated.push(opts); },
      clear() {},
      onClicked: { addListener() {} }
    },
    action: {
      setBadgeBackgroundColor() {},
      setBadgeText() {}
    },
    offscreen: {
      hasDocument: () => Promise.resolve(false),
      createDocument: () => Promise.reject(new Error('no offscreen in test'))
    },
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: () => Promise.resolve()
    },
    tabs: { query: () => Promise.resolve([]), update() {}, create() {} },
    windows: { update() {} }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), sandbox, { filename: 'background.js' });
  assert.ok(listener, 'background should register a message listener');

  return {
    created,
    updated,
    local,
    send(msg) {
      return new Promise((resolve) => {
        const keepOpen = listener(msg, {}, resolve);
        if (!keepOpen) resolve(undefined);
      });
    }
  };
}

function myMemoryResponse(text, delay) {
  return new Promise((resolve) => setTimeout(() => resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      responseStatus: 200,
      responseData: { translatedText: text }
    })
  }), delay || 0));
}

(async () => {
  // Fast provider: the first notification is already Chinese.
  const fast = makeHarness(() => myMemoryResponse('美国CPI环比0.4%，预期0.3%'));
  const result = await fast.send({
    type: 'FJ_ALERT',
    payload: { headline: 'US CPI MoM 0.4% vs 0.3% expected', time: '09:30' }
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.translatedHeadline, '美国CPI环比0.4%，预期0.3%');
  assert.strictEqual(fast.created.length, 1);
  assert.strictEqual(fast.created[0].message, '美国CPI环比0.4%，预期0.3%');
  assert.ok(fast.local.lastAlert.translated, 'last alert should remember the translation');

  // Slow provider: English first, then the notification is updated in place.
  const slow = makeHarness(() => myMemoryResponse('FOMC 发布紧急声明', 3000));
  const result2 = await slow.send({
    type: 'FJ_ALERT',
    payload: { headline: 'FOMC emergency statement released', time: '10:00' }
  });
  assert.strictEqual(result2.translatedHeadline, 'FOMC 发布紧急声明');
  assert.strictEqual(slow.created.length, 1);
  assert.strictEqual(slow.created[0].message, 'FOMC emergency statement released');
  assert.strictEqual(slow.updated.length, 1);
  assert.strictEqual(slow.updated[0].message, 'FOMC 发布紧急声明');

  // Quota failures are surfaced to the caller instead of failing silently.
  const quota = makeHarness(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ responseStatus: 200, quotaFinished: true })
  }));
  const result3 = await quota.send({
    type: 'FJ_ALERT',
    payload: { headline: 'Quota test headline' }
  });
  assert.strictEqual(result3.translatedHeadline, null);
  assert.strictEqual(result3.translateError, 'quota');

  console.log('background translation tests passed');
  process.exit(0);
})();
