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

  var I18N = window.FJI18N;
  var lang = 'en';

  function tr(key, vars) {
    return I18N ? I18N.t(lang, key, vars) : key;
  }

  var DEFAULT_SETTINGS = {
    enabled: true,
    sound: true,
    systemNotification: true,
    showStatus: true,
    translate: false,
    pageTranslate: false,
    language: 'auto',
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
  var originalEl = null;
  var currentAlert = null;
  var metaEl = null;
  var pillEl = null;
  var kickerEl = null;
  var linkEl = null;
  var closeEl = null;
  var bannerTimer = null;
  var pillTimer = null;
  var pageQueue = [];
  var pageBusy = 0;
  var pageTimer = null;

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
      translate: raw.translate === true,
      pageTranslate: raw.pageTranslate === true,
      language: (raw.language === 'en' || raw.language === 'zh') ? raw.language : 'auto',
      keywords: keywords
    };
  }

  function loadSettings() {
    try {
      chrome.storage.sync.get('fjSettings', function (data) {
        if (chrome.runtime.lastError) return;
        settings = normalizeSettings(data && data.fjSettings);
        lang = I18N ? I18N.resolve(settings.language) : 'en';
        enabled = settings.enabled;
        if (enabled) baseline();
        if (shadow) applyUiLanguage(); else updatePill();
        schedulePageTranslate(250);
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
      if (m.target && m.target.closest && m.target.closest('.fj-page-tr')) return;
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
    schedulePageTranslate(180);
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
          systemNotification: settings.systemNotification,
          language: settings.language
        }
      }, function (response) {
        // Reading lastError prevents an unchecked-error warning after reload.
        void chrome.runtime.lastError;
        if (response && response.translatedHeadline) {
          applyTranslation(alert.id, response.translatedHeadline);
        }
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
      '.banner .original{display:none;font-size:12px;line-height:1.45;opacity:.78;',
      'margin-top:5px;word-break:break-word;max-height:2.9em;overflow:hidden;',
      '-webkit-line-clamp:2;-webkit-box-orient:vertical}',
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
      '      <div class="kicker"><span class="dot"></span><span class="kicker-text">RED NEWS · FinancialJuice</span></div>',
      '      <div class="headline"></div>',
      '      <div class="original"></div>',
      '      <div class="meta"><span class="time"></span><a href="https://www.financialjuice.com/home" target="_blank" rel="noreferrer">Open FinancialJuice</a></div>',
      '    </div>',
      '    <button class="close" type="button" aria-label="Close">×</button>',
      '  </div>',
      '</div>',
      '<div class="pill" role="status"><span class="led"></span><span class="text">FJ monitoring</span></div>'
    ].join('');

    bannerEl = shadow.querySelector('.banner');
    flashEl = shadow.querySelector('.flash');
    headlineEl = shadow.querySelector('.headline');
    originalEl = shadow.querySelector('.original');
    metaEl = shadow.querySelector('.meta .time');
    pillEl = shadow.querySelector('.pill');
    kickerEl = shadow.querySelector('.kicker-text');
    linkEl = shadow.querySelector('.meta a');
    closeEl = shadow.querySelector('.banner .close');

    closeEl.addEventListener('click', function () {
      hideBanner();
    });

    applyUiLanguage();
  }

  function applyUiLanguage() {
    if (!shadow) return;
    if (kickerEl) kickerEl.textContent = tr('redNewsKicker');
    if (linkEl) linkEl.textContent = tr('viewSource');
    if (closeEl) {
      closeEl.setAttribute('aria-label', tr('close'));
      closeEl.title = tr('close');
    }
    updatePill();
  }

  function showBanner(alert) {
    ensureUi();
    currentAlert = alert;
    host.setAttribute('data-fj-last-alert', alert.headline || '');
    host.setAttribute('data-fj-alerts', String(alertCount));
    if (alert.translatedHeadline) {
      headlineEl.textContent = alert.translatedHeadline;
      originalEl.textContent = alert.headline;
      originalEl.style.display = '-webkit-box';
    } else {
      headlineEl.textContent = alert.headline;
      originalEl.textContent = '';
      originalEl.style.display = 'none';
    }
    metaEl.textContent = alert.time || tr('justNow');
    bannerEl.classList.add('show');
    flashEl.classList.remove('on');
    void flashEl.offsetWidth;
    flashEl.classList.add('on');

    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 15000);
  }

  function applyTranslation(id, translated) {
    if (!translated || !currentAlert || currentAlert.id !== id) return;
    currentAlert.translatedHeadline = translated;
    headlineEl.textContent = translated;
    originalEl.textContent = currentAlert.headline;
    originalEl.style.display = '-webkit-box';
    lastAlert = currentAlert;
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
      ? tr('pillPaused')
      : tr('pillMonitoring') + (alertCount ? ' · ' + tr('pillRed', { n: alertCount }) : '');
    var label = pillEl.querySelector('.text');
    if (label) label.textContent = text;

    clearTimeout(pillTimer);
    pillEl.style.opacity = '1';
    pillTimer = setTimeout(function () {
      if (pillEl) pillEl.style.opacity = '';
    }, 4200);
  }

  /* ---------------------------------------------------------- page translation */
  var PAGE_QUEUE_GAP_MS = 420;
  var PAGE_TR_STYLE_ID = 'fj-page-tr-style';

  function ensurePageTranslationStyle() {
    if (document.getElementById(PAGE_TR_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = PAGE_TR_STYLE_ID;
    style.textContent =
      '.fj-page-tr{margin:6px 10px 11px;padding:7px 11px;border-left:2px solid rgba(225,29,72,.8);' +
      'border-radius:0 7px 7px 0;background:rgba(255,255,255,.055);' +
      'box-shadow:inset 0 0 0 1px rgba(148,163,184,.12);color:inherit;opacity:.9;' +
      'font:12.5px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif;' +
      'letter-spacing:.1px;white-space:normal;word-break:break-word}' +
      '.fj-page-tr[data-pending="1"]{opacity:.5}' +
      '.fj-page-tr[data-kind="body"]{font-size:12px;opacity:.8;margin-top:-6px}';
    (document.head || document.documentElement).appendChild(style);
  }

  function clearPageTranslations() {
    pageQueue.length = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.fj-page-tr'), function (el) {
      el.remove();
    });
  }

  function queuePageBlock(item, sourceEl, text, kind) {
    var T = window.FJTranslator;
    if (!T || !T.isTranslatable(text)) return;
    var anchor = sourceEl.closest('.feedWrap') || item;
    var block = item.querySelector('.fj-page-tr[data-kind="' + kind + '"]');
    if (!block) {
      block = document.createElement('div');
      block.className = 'fj-page-tr';
      block.dataset.kind = kind;
      if (anchor && anchor.parentElement) anchor.insertAdjacentElement('afterend', block);
      else item.appendChild(block);
    }
    // Both title and body blocks are after .feedWrap; keep the title first.
    if (kind === 'body') {
      var titleBlock = item.querySelector('.fj-page-tr[data-kind="title"]');
      if (titleBlock && titleBlock.nextSibling !== block && block.previousElementSibling !== titleBlock) {
        titleBlock.insertAdjacentElement('afterend', block);
      }
    }
    if (block.dataset.src === text) return;
    block.dataset.src = text;
    block.dataset.pending = '1';
    block.textContent = '翻译中…';
    pageQueue.push({ block: block, text: text });
    pumpPageQueue();
  }

  function translateOneItem(item) {
    if (!settings.pageTranslate || !item || !item.isConnected) return;

    var title = item.querySelector('.headline-title, .headline-title-nolink');
    var titleText = '';
    if (title) {
      titleText = String(title.innerText || title.textContent || '')
        .replace(/\s+/g, ' ').trim();
      queuePageBlock(item, title, titleText, 'title');
    }

    var content = item.querySelector('.headline-content');
    if (content && (!title || !title.contains(content))) {
      var bodyText = String(content.innerText || content.textContent || '')
        .replace(/\s+/g, ' ').trim();
      if (bodyText && bodyText !== titleText) {
        queuePageBlock(item, content, bodyText, 'body');
      }
    }
  }

  function pumpPageQueue() {
    if (!settings.pageTranslate) {
      pageQueue.length = 0;
      return;
    }
    if (pageBusy >= 2) return;
    var job = pageQueue.shift();
    if (!job) return;
    if (!job.block || !job.block.isConnected) {
      pumpPageQueue();
      return;
    }
    pageBusy += 1;
    try {
      chrome.runtime.sendMessage({ type: 'FJ_TRANSLATE_TEXT', text: job.text }, function (res) {
        void chrome.runtime.lastError;
        pageBusy = Math.max(0, pageBusy - 1);
        if (job.block && job.block.isConnected) {
          delete job.block.dataset.pending;
          if (res && res.ok && res.text) {
            job.block.textContent = res.text;
            job.block.title = job.text;
          } else {
            job.block.remove();
          }
        }
        setTimeout(pumpPageQueue, PAGE_QUEUE_GAP_MS);
      });
    } catch (err) {
      pageBusy = Math.max(0, pageBusy - 1);
      if (job.block) job.block.remove();
    }
  }

  function translateWholePage() {
    if (!settings.pageTranslate) {
      clearPageTranslations();
      return;
    }
    ensurePageTranslationStyle();
    allItems().forEach(translateOneItem);
  }

  function schedulePageTranslate(delay) {
    clearTimeout(pageTimer);
    pageTimer = setTimeout(translateWholePage, delay || 150);
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
    lang = I18N ? I18N.resolve(settings.language) : 'en';
    enabled = settings.enabled;
    if (!wasEnabled && enabled) baseline();
    if (shadow) applyUiLanguage(); else updatePill();
    if (enabled) scheduleScan(50);
    schedulePageTranslate(80);
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
          headline: tr('testHeadline'),
          time: new Date().toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false }),
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
  schedulePageTranslate(700);
  baseline();
  setInterval(scan, 30000);
  setTimeout(function () { updatePill(); }, 600);
  setTimeout(scan, WARMUP_MS + 300);
})();
