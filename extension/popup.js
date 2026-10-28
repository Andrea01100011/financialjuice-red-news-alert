'use strict';

const DEFAULTS = {
  enabled: true,
  sound: true,
  systemNotification: true,
  showStatus: true,
  language: 'auto',
  keywords: []
};

const I18N = window.FJI18N;
const $ = (id) => document.getElementById(id);
const FJ_PATTERN = /^https?:\/\/(www\.)?financialjuice\.com\//i;

let settings = Object.assign({}, DEFAULTS);
let activeTab = null;
let saveTimer = null;

function normalize(raw) {
  raw = raw || {};
  let keywords = raw.keywords;
  if (typeof keywords === 'string') keywords = keywords.split(/[,，\n]+/);
  if (!Array.isArray(keywords)) keywords = [];

  let language = raw.language;
  if (language !== 'en' && language !== 'zh') language = 'auto';

  return {
    enabled: raw.enabled !== false,
    sound: raw.sound !== false,
    systemNotification: raw.systemNotification !== false,
    showStatus: raw.showStatus !== false,
    language: language,
    keywords: keywords.map((k) => String(k).trim()).filter(Boolean)
  };
}

function lang() {
  return I18N.resolve(settings.language);
}

function tr(key, vars) {
  return I18N.t(lang(), key, vars);
}

function applyTranslations() {
  const l = lang();
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = tr(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = tr(el.getAttribute('data-i18n-placeholder'));
  });

  const selector = $('language');
  const languageLabel = tr('language');
  selector.title = languageLabel;
  selector.setAttribute('aria-label', languageLabel);
  document.title = tr('extName');
}

function updateKeywordHelp() {
  const hasKeywords = settings.keywords.length > 0;
  $('keywordHelp').textContent = tr(hasKeywords ? 'keywordHelpFiltered' : 'keywordHelpAll');
}

function render() {
  applyTranslations();
  $('language').value = settings.language;
  $('enabled').checked = settings.enabled;
  $('sound').checked = settings.sound;
  $('systemNotification').checked = settings.systemNotification;
  $('showStatus').checked = settings.showStatus;
  $('keywords').value = settings.keywords.join(', ');
  updateKeywordHelp();
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set({ fjSettings: settings });
  }, 120);
}

function readForm() {
  const previousLanguage = settings.language;
  settings = normalize({
    enabled: $('enabled').checked,
    sound: $('sound').checked,
    systemNotification: $('systemNotification').checked,
    showStatus: $('showStatus').checked,
    language: $('language').value,
    keywords: $('keywords').value
  });
  applyTranslations();
  $('language').value = settings.language;
  updateKeywordHelp();
  save();

  if (previousLanguage !== settings.language) {
    $('status').textContent = tr('checking');
    refreshLastAlert();
    refreshStatus();
  }
}

['enabled', 'sound', 'systemNotification', 'showStatus', 'language'].forEach((id) => {
  $(id).addEventListener('change', readForm);
});
$('keywords').addEventListener('input', readForm);

function setStatus(text, state) {
  $('status').textContent = text;
  $('led').className = 'led' + (state ? ' ' + state : '');
}

function formatTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(lang() === 'zh' ? 'zh-CN' : 'en-US', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch (err) {
    return '—';
  }
}

async function refreshStatus() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs && tabs[0];

  if (!activeTab || !FJ_PATTERN.test(activeTab.url || '')) {
    setStatus(tr('openFirst'), 'off');
    $('test').disabled = true;
    return;
  }

  $('test').disabled = false;
  try {
    const result = await chrome.tabs.sendMessage(activeTab.id, { type: 'FJ_GET_STATUS' });
    if (result && result.ok) {
      const bits = [
        result.enabled ? tr('monitoring') : tr('paused'),
        tr('scanned', { n: result.items })
      ];
      if (result.alerts) bits.push(tr('alerts', { n: result.alerts }));
      setStatus(bits.join(' · '), result.enabled ? (result.alerts ? 'hot' : '') : 'off');
    }
  } catch (err) {
    setStatus(tr('notConnected'), 'off');
  }
}

async function refreshLastAlert() {
  const data = await chrome.storage.local.get(['lastAlert', 'alertCount']);
  const last = data && data.lastAlert;
  if (last && last.headline) {
    $('last').textContent = last.headline;
    $('lastTime').textContent = formatTime(last.at);
  } else {
    $('last').textContent = tr('noAlerts');
    $('lastTime').textContent = '—';
  }
}

$('test').addEventListener('click', async () => {
  if (!activeTab || !FJ_PATTERN.test(activeTab.url || '')) return;
  $('test').disabled = true;
  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: 'FJ_TEST' });
    setStatus(tr('testSent'), 'hot');
    setTimeout(() => { $('test').disabled = false; refreshStatus(); }, 2200);
  } catch (err) {
    setStatus(tr('testFailed'), 'off');
    $('test').disabled = false;
  }
});

$('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.financialjuice.com/home' });
});

chrome.storage.sync.get('fjSettings', (data) => {
  settings = normalize(data && data.fjSettings);
  render();
  $('status').textContent = tr('checking');
  refreshLastAlert();
  refreshStatus();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.lastAlert || changes.alertCount)) {
    refreshLastAlert();
  }
  if (area === 'sync' && changes.fjSettings) {
    settings = normalize(changes.fjSettings.newValue);
    render();
    refreshStatus();
  }
});
