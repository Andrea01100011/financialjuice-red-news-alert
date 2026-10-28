'use strict';

const DEFAULTS = {
  enabled: true,
  sound: true,
  systemNotification: true,
  showStatus: true,
  keywords: []
};

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
  return {
    enabled: raw.enabled !== false,
    sound: raw.sound !== false,
    systemNotification: raw.systemNotification !== false,
    showStatus: raw.showStatus !== false,
    keywords: keywords.map((k) => String(k).trim()).filter(Boolean)
  };
}

function render() {
  $('enabled').checked = settings.enabled;
  $('sound').checked = settings.sound;
  $('systemNotification').checked = settings.systemNotification;
  $('showStatus').checked = settings.showStatus;
  $('keywords').value = settings.keywords.join(', ');

  const hasKeywords = settings.keywords.length > 0;
  $('keywordHelp').textContent = hasKeywords
    ? '只有标题包含这些关键词的红色新闻才会告警。'
    : '留空时，任何新出现的红色新闻都会告警。';
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set({ fjSettings: settings });
  }, 120);
}

function readForm() {
  settings = normalize({
    enabled: $('enabled').checked,
    sound: $('sound').checked,
    systemNotification: $('systemNotification').checked,
    showStatus: $('showStatus').checked,
    keywords: $('keywords').value
  });
  render();
  save();
}

['enabled', 'sound', 'systemNotification', 'showStatus'].forEach((id) => {
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
    return new Date(ts).toLocaleString('zh-CN', {
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
    setStatus('请先打开 financialjuice.com/home', 'off');
    $('test').disabled = true;
    return;
  }

  $('test').disabled = false;
  try {
    const result = await chrome.tabs.sendMessage(activeTab.id, { type: 'FJ_GET_STATUS' });
    if (result && result.ok) {
      const bits = [];
      bits.push(result.enabled ? '监控中' : '已暂停');
      bits.push('已扫描 ' + result.items + ' 条');
      if (result.alerts) bits.push('已告警 ' + result.alerts + ' 条');
      setStatus(bits.join(' · '), result.enabled ? (result.alerts ? 'hot' : '') : 'off');
    }
  } catch (err) {
    setStatus('页面尚未连接，请刷新 FinancialJuice 页面', 'off');
  }
}

async function refreshLastAlert() {
  const data = await chrome.storage.local.get(['lastAlert', 'alertCount']);
  const last = data && data.lastAlert;
  if (last && last.headline) {
    $('last').textContent = last.headline;
    $('lastTime').textContent = formatTime(last.at);
  } else {
    $('last').textContent = '还没有捕获到红色新闻';
    $('lastTime').textContent = '—';
  }
}

$('test').addEventListener('click', async () => {
  if (!activeTab || !FJ_PATTERN.test(activeTab.url || '')) return;
  $('test').disabled = true;
  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: 'FJ_TEST' });
    setStatus('测试告警已发送 · 查看页面横幅', 'hot');
    setTimeout(() => { $('test').disabled = false; refreshStatus(); }, 2200);
  } catch (err) {
    setStatus('测试失败，请刷新页面后重试', 'off');
    $('test').disabled = false;
  }
});

$('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.financialjuice.com/home' });
});

chrome.storage.sync.get('fjSettings', (data) => {
  settings = normalize(data && data.fjSettings);
  render();
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
  }
});
