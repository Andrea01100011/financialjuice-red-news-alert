'use strict';

importScripts('i18n.js', 'translator.js');

const I18N = self.FJI18N;
const TR = self.FJTranslator;

const DEFAULT_SETTINGS = {
  enabled: true,
  sound: true,
  systemNotification: true,
  showStatus: true,
  translate: false,
  pageTranslate: false,
  provider: 'mymemory',
  apiKey: '',
  model: 'deepseek-chat',
  language: 'auto',
  keywords: []
};

const ICON = 'icons/icon128.png';
const FJ_URL = 'https://www.financialjuice.com/home';
const CACHE_LIMIT = 600;
const translationCache = new Map();
let cacheLoaded = false;
let cachePromise = null;
let cacheSaveTimer = null;
let offscreenCreating = null;
let badgeTimer = null;
let lastTranslateError = null;
let lastStatusKey = '';

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('fjSettings', async (data) => {
      const settings = Object.assign({}, DEFAULT_SETTINGS, data && data.fjSettings);
      try {
        const local = await chrome.storage.local.get('fjApiKey');
        if (local && local.fjApiKey) settings.apiKey = local.fjApiKey;
      } catch (err) { /* keep the empty default */ }
      resolve(settings);
    });
  });
}

async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    try {
      if (await chrome.offscreen.hasDocument()) return true;
    } catch (err) { /* fall through */ }
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return true;
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play a short alert sound when red news appears'
  });
  try {
    await offscreenCreating;
    return true;
  } catch (err) {
    // The document may already exist from a previous service-worker run.
    return false;
  } finally {
    offscreenCreating = null;
  }
}

async function playSound() {
  const ok = await ensureOffscreen();
  if (!ok) return;
  try {
    await chrome.runtime.sendMessage({ type: 'FJ_PLAY_SOUND', target: 'offscreen' });
  } catch (err) { /* offscreen can be unavailable in some Chrome builds */ }
}

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

async function loadTranslationCache() {
  if (cacheLoaded) return;
  if (!cachePromise) {
    cachePromise = (async () => {
      try {
        const stored = await chrome.storage.local.get('fjTranslationCache');
        const data = stored && stored.fjTranslationCache;
        if (data && typeof data === 'object') {
          Object.entries(data).slice(-CACHE_LIMIT).forEach(([key, value]) => {
            if (typeof value === 'string' && value) translationCache.set(key, value);
          });
        }
      } catch (err) { /* ignore a broken cache */ }
      cacheLoaded = true;
    })();
  }
  await cachePromise;
}

function scheduleCacheSave() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    try {
      chrome.storage.local.set({ fjTranslationCache: Object.fromEntries(translationCache) });
    } catch (err) { /* storage may be unavailable */ }
  }, 800);
}

async function setTranslateStatus(status) {
  const key = status.ok + '|' + status.provider + '|' + (status.error || '');
  if (key === lastStatusKey) return;
  lastStatusKey = key;
  try { await chrome.storage.local.set({ lastTranslateStatus: status }); } catch (err) { /* ignore */ }
}

async function translateToChinese(text, settings) {
  const source = TR.normalize(text);
  if (!TR.isTranslatable(source)) return null;

  const provider = settings.provider === 'deepseek' ? 'deepseek' : 'mymemory';
  const model = settings.model || TR.DEFAULT_MODEL;
  const key = TR.cacheKey(source, provider, model);

  await loadTranslationCache();
  if (translationCache.has(key)) return translationCache.get(key);

  const result = await TR.translate(source, {
    provider,
    apiKey: settings.apiKey,
    model,
    timeoutMs: provider === 'deepseek' ? 12000 : 8000
  });

  if (!result.ok) {
    lastTranslateError = result.error || 'unknown';
    await setTranslateStatus({ ok: false, provider, error: lastTranslateError, at: Date.now() });
    return null;
  }

  lastTranslateError = null;
  if (translationCache.size >= CACHE_LIMIT) {
    translationCache.delete(translationCache.keys().next().value);
  }
  translationCache.set(key, result.text);
  scheduleCacheSave();
  await setTranslateStatus({ ok: true, provider, at: Date.now() });
  return result.text;
}

function notificationOptions(payload, lang) {
  const translated = payload.translatedHeadline;
  const headline = truncate(translated || payload.headline, 220);
  const original = translated ? truncate(payload.headline, 70) : '';
  const time = payload.time ? String(payload.time) : '';
  const tr = (key, vars) => I18N.t(lang, key, vars);
  const contextParts = [];
  if (time) contextParts.push(time);
  if (original) contextParts.push(original);
  contextParts.push(tr('notificationContextNoTime'));

  return {
    type: 'basic',
    iconUrl: ICON,
    title: tr('notificationTitle'),
    message: headline,
    contextMessage: contextParts.join(' · '),
    priority: 2,
    requireInteraction: false,
    silent: true
  };
}

function notify(payload, lang) {
  const id = 'fj-red-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  chrome.notifications.create(id, notificationOptions(payload, lang));
  return id;
}

function updateNotification(id, payload, lang) {
  try {
    chrome.notifications.update(id, notificationOptions(payload, lang), function () {
      void chrome.runtime.lastError;
    });
  } catch (err) { /* the notification may have been dismissed */ }
}

function flashBadge() {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#d90429' });
    chrome.action.setBadgeText({ text: '!' });
  } catch (err) { /* ignore */ }
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    try { chrome.action.setBadgeText({ text: '' }); } catch (err) { /* ignore */ }
  }, 60000);
}

async function rememberAlert(payload) {
  const stored = await chrome.storage.local.get(['lastAlert', 'alertCount']);
  const count = Number(stored.alertCount || 0) + 1;
  await chrome.storage.local.set({
    lastAlert: {
      headline: payload.translatedHeadline || payload.headline,
      original: payload.translatedHeadline ? payload.headline : '',
      translated: Boolean(payload.translatedHeadline),
      time: payload.time || '',
      at: Date.now()
    },
    alertCount: count
  });
}

async function handleAlert(payload) {
  const settings = await getSettings();
  if (settings.enabled === false) return { ok: false, disabled: true };

  const lang = I18N.resolve(payload.language || settings.language);
  const enriched = Object.assign({}, payload);
  const wantsTranslate = settings.translate === true && payload.translate !== false;
  const translationPromise = wantsTranslate
    ? translateToChinese(payload.headline, settings)
    : Promise.resolve(null);

  flashBadge();
  const wantsSound = payload.sound !== false && settings.sound !== false;
  if (wantsSound) void playSound();

  // Give fast providers a short head start so the first notification is already
  // Chinese. If the provider is slow, show English immediately and update it.
  let translatedHeadline = null;
  if (wantsTranslate) {
    const waitMs = settings.provider === 'deepseek' ? 2500 : 1800;
    translatedHeadline = await Promise.race([
      translationPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), waitMs))
    ]);
  }

  const wantsNotify = payload.systemNotification !== false && settings.systemNotification !== false;
  let notificationId = null;
  if (translatedHeadline) enriched.translatedHeadline = translatedHeadline;
  if (wantsNotify) notificationId = notify(enriched, lang);

  if (wantsTranslate && !translatedHeadline) {
    const later = await translationPromise;
    if (later) {
      enriched.translatedHeadline = later;
      if (notificationId) updateNotification(notificationId, enriched, lang);
    }
  }
  await rememberAlert(enriched);

  return {
    ok: true,
    translatedHeadline: enriched.translatedHeadline || null,
    translateError: enriched.translatedHeadline ? null : lastTranslateError
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'FJ_ALERT') {
    handleAlert(msg.payload || {}).then(
      (result) => sendResponse(result || { ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (msg.type === 'FJ_TRANSLATE_TEXT') {
    getSettings().then((settings) => translateToChinese(msg.text || '', settings)).then(
      (translated) => sendResponse({
        ok: Boolean(translated),
        text: translated || '',
        error: translated ? null : lastTranslateError
      }),
      (err) => sendResponse({ ok: false, text: '', error: String(err && err.message || err) })
    );
    return true;
  }

  if (msg.type === 'FJ_TRANSLATE_TEST') {
    getSettings().then(async (settings) => {
      const provider = settings.provider === 'deepseek' ? 'deepseek' : 'mymemory';
      const started = Date.now();
      const result = await TR.translate('US CPI MoM 0.4% vs 0.3% expected', {
        provider,
        apiKey: settings.apiKey,
        model: settings.model || TR.DEFAULT_MODEL,
        timeoutMs: provider === 'deepseek' ? 12000 : 8000
      });
      const payload = {
        ok: Boolean(result.ok),
        text: result.text || '',
        error: result.ok ? null : (result.error || 'unknown'),
        provider,
        latency: Date.now() - started
      };
      await setTranslateStatus({ ok: payload.ok, provider, error: payload.error, at: Date.now() });
      sendResponse(payload);
    }).catch((err) => sendResponse({
      ok: false, error: String(err && err.message || err), provider: 'unknown', latency: 0
    }));
    return true;
  }

  if (msg.type === 'FJ_TEST') {
    getSettings().then((settings) => {
      const lang = I18N.resolve(settings.language);
      return handleAlert({
        headline: I18N.t(lang, 'testHeadline'),
        time: new Date().toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false }),
        language: settings.language
      });
    }).then(
      (result) => sendResponse(result || { ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  return undefined;
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  try {
    chrome.notifications.clear(notificationId);
    chrome.action.setBadgeText({ text: '' });
  } catch (err) { /* ignore */ }
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://www.financialjuice.com/*', 'https://financialjuice.com/*']
    });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
      return;
    }
  } catch (err) { /* ignore and open a new tab */ }
  chrome.tabs.create({ url: FJ_URL });
});
