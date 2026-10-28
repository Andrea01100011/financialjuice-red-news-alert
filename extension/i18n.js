/*
 * Shared UI strings for the extension. Kept dependency-free so it can be used
 * by the popup, content script, and service worker.
 */
(function (root) {
  'use strict';

  var MESSAGES = {
    en: {
      extName: 'FJ Red News Alert',
      checking: 'Checking…',
      openFirst: 'Open financialjuice.com/home first',
      monitoring: 'Monitoring',
      paused: 'Paused',
      scanned: '{n} scanned',
      alerts: '{n} alerts',
      notConnected: 'Page not connected. Reload FinancialJuice.',
      testSent: 'Test alert sent · check the page banner',
      testFailed: 'Test failed. Reload the page and try again.',

      enableMonitoring: 'Enable monitoring',
      enableMonitoringDesc: 'Only while FinancialJuice is open',
      soundAlert: 'Sound alert',
      soundAlertDesc: 'Three-tone chime for red headlines',
      systemNotification: 'System notification',
      systemNotificationDesc: 'macOS Notification Center banner',
      pageStatus: 'Page status pill',
      pageStatusDesc: 'Monitoring state and red count, bottom right',
      keywordFilter: 'Keyword filter',
      optional: 'optional',
      keywordPlaceholder: 'NQ, gold, FOMC, CPI; blank = all red news',
      keywordHelpFiltered: 'Only matching red headlines trigger an alert.',
      keywordHelpAll: 'Blank alerts on every new red headline.',

      testAlert: 'Test alert',
      openSite: 'Open FinancialJuice',
      latestAlert: 'Latest alert',
      noAlerts: 'No red headlines captured yet',
      footer: 'Red headline → sound + system notification + page banner',

      language: 'Language',
      languageAuto: 'Auto',
      languageEn: 'EN',
      languageZh: '中文',

      redNewsKicker: 'RED NEWS · FinancialJuice',
      viewSource: 'Open FinancialJuice',
      close: 'Close',
      pillMonitoring: 'FJ monitoring',
      pillPaused: 'FJ monitoring paused',
      pillRed: 'red {n}',
      testHeadline: 'Test alert: red-news monitoring is active',
      justNow: 'just now',

      notificationTitle: '🔴 FinancialJuice red news',
      notificationContext: '{time} · Click to open FinancialJuice',
      notificationContextNoTime: 'Click to open FinancialJuice'
    },
    zh: {
      extName: 'FJ 红色新闻告警',
      checking: '检查中…',
      openFirst: '请先打开 financialjuice.com/home',
      monitoring: '监控中',
      paused: '已暂停',
      scanned: '已扫描 {n} 条',
      alerts: '已告警 {n} 条',
      notConnected: '页面尚未连接，请刷新 FinancialJuice 页面',
      testSent: '测试告警已发送 · 查看页面横幅',
      testFailed: '测试失败，请刷新页面后重试',

      enableMonitoring: '启用监控',
      enableMonitoringDesc: '仅在 FinancialJuice 页面打开时工作',
      soundAlert: '声音提醒',
      soundAlertDesc: '出现红色新闻时播放三声提示音',
      systemNotification: '系统通知',
      systemNotificationDesc: '通过 macOS 通知中心弹出横幅',
      pageStatus: '页面状态角标',
      pageStatusDesc: '右下角显示监控状态和红色新闻计数',
      keywordFilter: '关键词过滤',
      optional: '可选',
      keywordPlaceholder: 'NQ, 黄金, FOMC, CPI；留空 = 全部红色新闻',
      keywordHelpFiltered: '只有标题包含这些关键词的红色新闻才会告警。',
      keywordHelpAll: '留空时，任何新出现的红色新闻都会告警。',

      testAlert: '测试告警',
      openSite: '打开 FinancialJuice',
      latestAlert: '最近一条',
      noAlerts: '还没有捕获到红色新闻',
      footer: '出现红色新闻 → 声音 + 系统通知 + 页面红色横幅',

      language: '语言',
      languageAuto: '自动',
      languageEn: 'EN',
      languageZh: '中文',

      redNewsKicker: '红色新闻 · FinancialJuice',
      viewSource: '打开 FinancialJuice',
      close: '关闭',
      pillMonitoring: 'FJ 监控中',
      pillPaused: 'FJ 监控已暂停',
      pillRed: '红色 {n}',
      testHeadline: '测试告警：红色新闻监控已生效',
      justNow: '刚刚',

      notificationTitle: '🔴 FinancialJuice 红色新闻',
      notificationContext: '{time} · 点击打开 FinancialJuice',
      notificationContextNoTime: '点击打开 FinancialJuice'
    }
  };

  function detect() {
    try {
      var lang = (root.chrome && root.chrome.i18n && root.chrome.i18n.getUILanguage)
        ? root.chrome.i18n.getUILanguage()
        : '';
      if (!lang && typeof root.navigator !== 'undefined') {
        lang = root.navigator.language || '';
      }
      return /^zh/i.test(lang) ? 'zh' : 'en';
    } catch (err) {
      return 'en';
    }
  }

  function resolve(preference) {
    if (preference === 'en' || preference === 'zh') return preference;
    return detect();
  }

  function t(lang, key, vars) {
    var table = MESSAGES[lang] || MESSAGES.en;
    var text = table[key];
    if (text == null) text = MESSAGES.en[key];
    if (text == null) return key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      });
    }
    return text;
  }

  root.FJI18N = {
    messages: MESSAGES,
    detect: detect,
    resolve: resolve,
    t: t
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
