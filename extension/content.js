/*
 * FinancialJuice red-news watcher.
 *
 * The site inserts each headline as:
 *   <div class="headline-item" data-headlineid="...">
 *     <div class="feedWrap active ..."> ... </div>
 *   </div>
 * Breaking headlines get .feedWrap.active, which is painted red by the site.
 */
(function () {
  'use strict';

  if (window.__fjRedNewsAlertLoaded) return;
  window.__fjRedNewsAlertLoaded = true;

  var D = window.FJDetector;
  if (!D) return;

  var DEFAULT_SETTINGS = {
    enabled: true,
    sound: true,
    systemNotification: true,
    showStatus: true,
    keywords: []
  };

  var WARMUP_MS = 6500;
  var PENDING_TTL_MS = 90000;
  var QUEUE_GAP_MS = 1600;
  var BULK_INSERT_THRESHOLD = 4;

  var settings = Object.assign({}, DEFAULT_SETTINGS);
  var enabled = true;
  var bootAt = Date.now();
  var seen = new Set();
  var pending = new Map();
  var queue = [];
  var processing = false;
  var observer = null;
  var scanTimer = null;
  var alertCount = 0;
  var lastAlert = null;
  var shadow = null;
  var host = null;
  var bannerEl = null;
  var flashEl = null;
  var headlineEl = null;
  var metaEl = null;
  var pillEl = null;
  var bannerTimer = null;
  var pillTimer = null;

  function normalizeSettings(raw) {
    raw = raw || {};
    var keywords = raw.keywords;
    if (typeof keywords === 'string') {
      keywords = keywords.split(/[,，\n]+/);
    }
    if (!Array.isArray(keywords)) keywords = [];
    keywords = keywords.map(function (k) { return String(k).trim(); }).filter(Boolean);
    return {
      enabled: raw.enabled !== false,
      sound: raw.sound !== false,
      systemNotification: raw.systemNotification !== false,
      showStatus: raw.showStatus !== false,
      keywords: keywords
    };
  }

  function loadSettings() {
    try {
      chrome.storage.sync.get('fjSettings', function (data) {
        if (chrome.runtime.lastError) return;
        settings = normalizeSettings(data && data.fjSettings);
        enabled = settings.enabled;
        if (enabled) baseline();
        updatePill();
      });
    } catch (err) { /* extension context may be reloading */ }
  }

  function allItems() {
    return Array.prototype.slice.call(document.querySelectorAll('.headline-item'));
  }

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    if (!el.getClientRects().length) return false;
    try {
      var style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        style.opacity !== '0';
    } catch (err) {
      return true;
    }
  }

  function baseline() {
    allItems().forEach(function (el) {
      var id = D.itemId(el);
      if (id) seen.add(id);
    });
    pending.clear();
  }


  function onMutations(mutations) {
    var relevant = false;
    var addedItems = 0;

    mutations.forEach(function (m) {
      if (m.type === 'attributes') {
        if (m.target && m.target.closest && m.target.closest('.headline-item')) {
          relevant = true;
        }
        return;
      }

      if (m.target && m.target.closest && m.target.closest('.headline-item')) {
        relevant = true;
      }

      Array.prototype.forEach.call(m.addedNodes, function (node) {
        if (!node || node.nodeType !== 1) return;
        if (node.matches && node.matches('.headline-item')) {
          addedItems += 1;
          relevant = true;
        } else if (node.querySelectorAll) {
          var found = node.querySelectorAll('.headline-item');
          if (found.length) {
            addedItems += found.length;
            relevant = true;
          }
        }
      });
    });

    if (!relevant) return;

    // Switching feed tabs / restoring history inserts a whole batch. Do not
    // treat old red headlines as new breaking news.
    if (addedItems >= BULK_INSERT_THRESHOLD) {
      allItems().forEach(function (el) {
        var id = D.itemId(el);
        if (id) seen.add(id);
      });
      pending.clear();
      return;
    }

    scheduleScan(70);
  }

  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  function scan() {
    if (!enabled) return;

    var now = Date.now();
    var warmup = now - bootAt < WARMUP_MS;

    allItems().forEach(function (el) {
      var id = D.itemId(el);
      if (!id || seen.has(id)) return;
      if (!isVisible(el)) return;

      if (!D.isRedItem(el)) {
        if (!pending.has(id)) pending.set(id, now);
        return;
      }

      if (warmup) {
        seen.add(id);
        pending.delete(id);
        return;
      }

      var headline = D.headlineOf(el);
      if (!headline) {
        if (!pending.has(id)) pending.set(id, now);
        return;
      }

      seen.add(id);
      pending.delete(id);

      if (!matchesKeywords(headline)) return;

      enqueue({
        id: id,
        headline: headline,
        time: D.timeOf(el),
        url: 'https://www.financialjuice.com/home',
        detectedAt: now
      });
    });

    pending.forEach(function (at, id) {
      if (now - at > PENDING_TTL_MS) {
        pending.delete(id);
        seen.add(id);
      }
    });
  }

  function matchesKeywords(headline) {
    if (!settings.keywords.length) return true;
    var haystack = headline.toLowerCase();
    return settings.keywords.some(function (k) {
      return haystack.indexOf(k.toLowerCase()) !== -1;
    });
  }

  function enqueue(alert) {
    if (!alert || !alert.id) return;
    if (queue.some(function (a) { return a.id === alert.id; })) return;
    queue.push(alert);
    pumpQueue();
  }

  function pumpQueue() {
    if (!enabled) {
      queue.length = 0;
      processing = false;
      return;
    }
    if (processing) return;
    var alert = queue.shift();
    if (!alert) return;

    processing = true;
    fireAlert(alert);
    setTimeout(function () {
      processing = false;
      pumpQueue();
    }, QUEUE_GAP_MS);
  }

  function fireAlert(alert) {
    alertCount += 1;
    lastAlert = alert;
    showBanner(alert);
    updatePill();

    try {
      chrome.runtime.sendMessage({
        type: 'FJ_ALERT',
        payload: {
          id: alert.id,
          headline: alert.headline,
          time: alert.time,
          url: alert.url,
          sound: settings.sound,
          systemNotification: settings.systemNotification
        }
      }, function () {
        // Reading lastError prevents an unchecked-error warning after reload.
        void chrome.runtime.lastError;
      });
    } catch (err) {
      playFallbackSound();
    }
  }

  function playFallbackSound() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var now = ctx.currentTime;
      [0, 0.22, 0.44].forEach(function (offset, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = i === 2 ? 1320 : 880;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.28, now + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.18);
      });
      setTimeout(function () { ctx.close && ctx.close(); }, 1200);
    } catch (err) { /* audio may be blocked until the page is interacted with */ }
  }

  function ensureUi() {
    if (host && host.isConnected && shadow) return;

    host = document.createElement('div');
    host.id = 'fj-red-news-alert-root';
    host.setAttribute('data-fj-extension', '1');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = [
      '<style>',
      ':host{all:initial}',
      '.flash{position:fixed;inset:0;pointer-events:none;opacity:0;',
      'background:radial-gradient(circle at 50% 0%,rgba(220,38,38,.42),rgba(220,38,38,0) 62%);}',
      '.flash.on{animation:fjflash 1.25s ease-out 2;}',
      '@keyframes fjflash{0%{opacity:0}18%{opacity:1}100%{opacity:0}}',
      '.banner{position:fixed;top:18px;left:50%;width:min(760px,92vw);',
      'transform:translate(-50%,-28px);opacity:0;pointer-events:none;',
      'transition:opacity .22s ease,transform .22s ease;',
      'background:linear-gradient(135deg,#b80101 0%,#d90429 55%,#9f0000 100%);',
      'color:#fff;border:1px solid rgba(255,255,255,.28);border-radius:14px;',
      'box-shadow:0 18px 50px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.06) inset;',
      'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;',
      'overflow:hidden;',
      '}',
      '.banner.show{opacity:1;transform:translate(-50%,0);pointer-events:auto;}',
      '.banner .bar{height:4px;background:rgba(255,255,255,.22)}',
      '.banner .body{padding:14px 18px 15px;display:flex;gap:14px;align-items:flex-start}',
      '.banner .icon{flex:0 0 auto;width:34px;height:34px;border-radius:50%;',
      'background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;',
      'font-size:19px;line-height:1;margin-top:1px;animation:fjpulse 1.2s ease-in-out infinite;}',
      '@keyframes fjpulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}',
      '.banner .grow{flex:1;min-width:0}',
      '.banner .kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;',
      'font-weight:700;opacity:.86;margin-bottom:5px;display:flex;gap:8px;align-items:center}',
      '.banner .kicker .dot{width:6px;height:6px;border-radius:50%;background:#fff;',
      'box-shadow:0 0 0 4px rgba(255,255,255,.16)}',
      '.banner .headline{font-size:17px;line-height:1.45;font-weight:650;',
      'letter-spacing:.005em;word-break:break-word;max-height:5.1em;overflow:hidden;',
      'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}',
      '.banner .meta{margin-top:8px;font-size:12px;opacity:.78;display:flex;gap:12px;align-items:center}',
      '.banner .meta a{color:#fff;text-decoration:underline;text-underline-offset:2px;font-weight:600}',
      '.banner .close{flex:0 0 auto;background:rgba(255,255,255,.14);border:0;color:#fff;',
      'width:28px;height:28px;border-radius:50%;font-size:17px;line-height:28px;cursor:pointer;',
      'padding:0;font-family:inherit}',
      '.banner .close:hover{background:rgba(255,255,255,.26)}',
      '.pill{position:fixed;right:18px;bottom:18px;pointer-events:auto;',
      'background:rgba(15,23,42,.92);color:#e5e7eb;border:1px solid rgba(148,163,184,.28);',
      'border-radius:999px;padding:7px 12px;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,',
      '"SF Pro Text","Helvetica Neue",Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.28);',
      'display:flex;align-items:center;gap:7px;opacity:.66;transition:opacity .2s ease;',
      'max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.pill:hover{opacity:1}',
      '.pill .led{width:7px;height:7px;border-radius:50%;background:#22c55e;',
      'box-shadow:0 0 0 3px rgba(34,197,94,.14);flex:0 0 auto}',
      '.pill.off .led{background:#94a3b8;box-shadow:0 0 0 3px rgba(148,163,184,.14)}',
      '.pill.hot .led{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.18)}',
      '</style>',
      '<div class="flash"></div>',
      '<div class="banner" role="alert" aria-live="assertive">',
      '  <div class="bar"></div>',
      '  <div class="body">',
      '    <div class="icon">!</div>',
      '    <div class="grow">',
      '      <div class="kicker"><span class="dot"></span><span>RED NEWS · FinancialJuice</span></div>',
      '      <div class="headline"></div>',
      '      <div class="meta"><span class="time"></span><a href="https://www.financialjuice.com/home" target="_blank" rel="noreferrer">查看原文</a></div>',
      '    </div>',
      '    <button class="close" type="button" aria-label="关闭">×</button>',
      '  </div>',
      '</div>',
      '<div class="pill" role="status"><span class="led"></span><span class="text">FJ 红色新闻监控</span></div>'
    ].join('');

    bannerEl = shadow.querySelector('.banner');
    flashEl = shadow.querySelector('.flash');
    headlineEl = shadow.querySelector('.headline');
    metaEl = shadow.querySelector('.meta .time');
    pillEl = shadow.querySelector('.pill');

    shadow.querySelector('.banner .close').addEventListener('click', function () {
      hideBanner();
    });

    updatePill();
  }

  function showBanner(alert) {
    ensureUi();
    host.setAttribute('data-fj-last-alert', alert.headline || '');
    host.setAttribute('data-fj-alerts', String(alertCount));
    headlineEl.textContent = alert.headline;
    metaEl.textContent = alert.time || '刚刚';
    bannerEl.classList.add('show');
    flashEl.classList.remove('on');
    void flashEl.offsetWidth;
    flashEl.classList.add('on');

    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 15000);
  }

  function hideBanner() {
    if (bannerEl) bannerEl.classList.remove('show');
  }

  function updatePill() {
    if (!settings.showStatus) {
      if (pillEl) pillEl.style.display = 'none';
      return;
    }
    ensureUi();
    if (!pillEl) return;
    pillEl.style.display = 'flex';
    pillEl.classList.toggle('off', !enabled);
    pillEl.classList.toggle('hot', enabled && alertCount > 0);
    if (host) {
      host.setAttribute('data-fj-status', enabled ? 'on' : 'off');
      host.setAttribute('data-fj-keywords', settings.keywords.join('|'));
    }
    var text = !enabled
      ? 'FJ 监控已暂停'
      : 'FJ 监控中' + (alertCount ? ' · 红色 ' + alertCount : '');
    var label = pillEl.querySelector('.text');
    if (label) label.textContent = text;

    clearTimeout(pillTimer);
    pillEl.style.opacity = '1';
    pillTimer = setTimeout(function () {
      if (pillEl) pillEl.style.opacity = '';
    }, 4200);
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  function onSettingsChanged(next) {
    var wasEnabled = enabled;
    settings = normalizeSettings(next);
    enabled = settings.enabled;
    if (!wasEnabled && enabled) baseline();
    updatePill();
    if (enabled) scheduleScan(50);
  }

  // Clicking an item adds .active on the site; that is selection, not news.
  document.addEventListener('click', function (event) {
    var item = event.target && event.target.closest
      ? event.target.closest('.headline-item')
      : null;
    if (!item) return;
    var id = D.itemId(item);
    if (id) {
      seen.add(id);
      pending.delete(id);
    }
  }, true);

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'sync' && changes.fjSettings) {
        onSettingsChanged(changes.fjSettings.newValue);
      }
    });
  } catch (err) { /* ignore */ }

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || !msg.type) return;
      if (msg.type === 'FJ_GET_STATUS') {
        sendResponse({
          ok: true,
          enabled: enabled,
          alerts: alertCount,
          seen: seen.size,
          items: allItems().length,
          feed: Boolean(document.querySelector('#mainFeed')),
          lastAlert: lastAlert,
          url: location.href
        });
        return;
      }
      if (msg.type === 'FJ_TEST') {
        var alert = {
          id: 'test-' + Date.now(),
          headline: '测试告警：红色新闻监控已生效',
          time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          url: 'https://www.financialjuice.com/home',
          detectedAt: Date.now()
        };
        enqueue(alert);
        sendResponse({ ok: true });
      }
    });
  } catch (err) { /* ignore */ }

  loadSettings();
  startObserver();
  baseline();
  setInterval(scan, 30000);
  setTimeout(function () { updatePill(); }, 600);
  setTimeout(scan, WARMUP_MS + 300);
})();
