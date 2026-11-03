'use strict';

importScripts('i18n.js');

const I18N = self.FJI18N;

const DEFAULT_SETTINGS = {
  enabled: true,
  sound: true,
  systemNotification: true,
  showStatus: true,
  translate: false,
  language: 'auto',
  keywords: []
};

const ICON = 'icons/icon128.png';
const FJ_URL = 'https://www.financialjuice.com/home';
const TRANSLATE_ENDPOINT = 'https://api.mymemory.translated.net/get';
const TRANSLATE_TIMEOUT_MS = 6000;
const translationCache = new Map();
let offscreenCreating = null;
let badgeTimer = null;

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('fjSettings', (data) => {
      resolve(Object.assign({}, DEFAULT_SETTINGS, data && data.fjSettings));
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

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function polishTranslation(text) {
  return text
    .replace(/^突破[：:]\s*/, '突发：')
    .replace(/联邦公开市场委员会/g, 'FOMC')
    .replace(/消费者价格指数/g, 'CPI')
    .replace(/生产者价格指数/g, 'PPI')
    .replace(/国内生产总值/g, 'GDP')
    .replace(/FOMC(?=[\u4e00-\u9fff])/g, 'FOMC ')
    .replace(/\s+([，。；：！？])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function translateToChinese(text) {
  const source = String(text || '').trim().slice(0, 500);
  if (!source || /[\u4e00-\u9fff]/.test(source)) return null;
  if (translationCache.has(source)) return translationCache.get(source);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
  try {
    const url = TRANSLATE_ENDPOINT +
      '?q=' + encodeURIComponent(source) +
      '&langpair=' + encodeURIComponent('en|zh-CN');
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || Number(data.responseStatus) !== 200 || data.quotaFinished) return null;

    let translated = data.responseData && data.responseData.translatedText;
    if (!translated || /MYMEMORY WARNING/i.test(translated)) return null;
    translated = polishTranslation(decodeEntities(String(translated)));
    if (!translated) return null;

    if (translationCache.size >= 200) {
      translationCache.delete(translationCache.keys().next().value);
    }
    translationCache.set(source, translated);
    return translated;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    ? translateToChinese(payload.headline)
    : Promise.resolve(null);

  const wantsNotify = payload.systemNotification !== false && settings.systemNotification !== false;
  let notificationId = null;
  if (wantsNotify) notificationId = notify(enriched, lang);
  flashBadge();

  const wantsSound = payload.sound !== false && settings.sound !== false;
  if (wantsSound) await playSound();

  const translatedHeadline = await translationPromise;
  if (translatedHeadline) {
    enriched.translatedHeadline = translatedHeadline;
    if (notificationId) updateNotification(notificationId, enriched, lang);
  }
  await rememberAlert(enriched);

  return { ok: true, translatedHeadline: translatedHeadline };
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
