from playwright.sync_api import sync_playwright
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, 'extension')
MOCK = 'file://' + os.path.join(ROOT, 'test', 'mock.html')

INIT = r'''
window.__fjTest = { listeners: [], settingsListeners: [] };
window.chrome = {
  storage: {
    onChanged: { addListener: function (fn) { window.__fjTest.settingsListeners.push(fn); } },
    sync: {
      get: function (key, cb) {
        cb({ fjSettings: { enabled: true, pageTranslate: true, translate: true,
          sound: false, systemNotification: false, showStatus: false, language: 'en', keywords: [] } });
      }
    },
    local: { get: function (k, cb) { cb({}); }, set: function () {} }
  },
  runtime: {
    lastError: null,
    sendMessage: function (msg, cb) {
      if (msg.type === 'FJ_TRANSLATE_TEXT') {
        if (cb) cb({ ok: true, text: '中文：' + msg.text, error: null });
      } else if (cb) cb({ ok: true });
    },
    onMessage: { addListener: function (fn) { window.__fjTest.listeners.push(fn); } }
  }
};
'''

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width":900,"height":700})
    errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.add_init_script(INIT)
    pg.goto(MOCK)
    for f in ['i18n.js','translator.js','detector.js','content.js']:
        pg.add_script_tag(path=os.path.join(EXT, f))
    pg.wait_for_timeout(2600)
    blocks = pg.locator('.fj-page-tr')
    n = blocks.count()
    print('translation blocks:', n)
    assert n >= 4, f'expected at least 4 translated blocks, got {n}'
    texts = [blocks.nth(i).inner_text() for i in range(min(n, 4))]
    print('blocks:', texts)
    assert all(t.startswith('中文：') for t in texts), texts
    # The detector must still see the original English headline.
    h = pg.evaluate("FJDetector.headlineOf(document.querySelector('.headline-item'))")
    print('headlineOf:', h)
    assert '中文' not in h and 'Normal white news item' in h, h
    # Turning the setting off removes every injected block.
    pg.evaluate("""() => {
      const s = window.__fjTest.settingsListeners[0];
      s({ fjSettings: { newValue: { enabled: true, pageTranslate: false, translate: true,
        sound: false, systemNotification: false, showStatus: false, language: 'en', keywords: [] } } }, 'sync');
    }""")
    pg.wait_for_timeout(400)
    left = pg.locator('.fj-page-tr').count()
    print('blocks after off:', left)
    assert left == 0, left
    print('page translation tests passed')
    assert not errors, errors
    b.close()
