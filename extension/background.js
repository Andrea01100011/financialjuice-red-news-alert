'use strict';

const DEFAULT_SETTINGS = {
  enabled: true,
  sound: true,
  systemNotification: true,
  showStatus: true,
  keywords: []
};

const ICON = 'icons/icon128.png';
const FJ_URL = 'https://www.financialjuice.com/home';
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

function notify(payload) {
  const headline = truncate(payload.headline, 220);
  const time = payload.time ? String(payload.time) : '';
  chrome.notifications.create(
    'fj-red-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    {
      type: 'basic',
      iconUrl: ICON,
      title: '🔴 FinancialJuice 红色新闻',
      message: headline,
      contextMessage: time ? time + ' · 点击打开 FinancialJuice' : '点击打开 FinancialJuice',
      priority: 2,
      requireInteraction: false,
      silent: true
    }
  );
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
      headline: payload.headline,
      time: payload.time || '',
      at: Date.now()
    },
    alertCount: count
  });
}

async function handleAlert(payload) {
  const settings = await getSettings();
  if (settings.enabled === false) return;

  const wantsNotify = payload.systemNotification !== false && settings.systemNotification !== false;
  if (wantsNotify) notify(payload);
  flashBadge();
  await rememberAlert(payload);

  const wantsSound = payload.sound !== false && settings.sound !== false;
  if (wantsSound) await playSound();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'FJ_ALERT') {
    handleAlert(msg.payload || {}).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (msg.type === 'FJ_TEST') {
    handleAlert({
      headline: '测试告警：红色新闻监控已生效',
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }).then(
      () => sendResponse({ ok: true }),
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
