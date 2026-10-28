/*
 * Pure detection helpers. Kept free of chrome.* APIs so they can be unit tested.
 */
(function (root) {
  'use strict';

  function parseColor(value) {
    if (!value) return null;
    var v = String(value).trim().toLowerCase();
    if (v === 'transparent' || v === 'rgba(0, 0, 0, 0)') return null;
    var m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    m = v.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) {
        h = h.split('').map(function (c) { return c + c; }).join('');
      }
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
      };
    }
    return null;
  }

  function isRedColor(c) {
    if (!c) return false;
    return c.r >= 120 && c.g <= 95 && c.b <= 95 &&
      (c.g + c.b) <= 110 && (c.r - Math.max(c.g, c.b)) >= 70;
  }

  function classesOf(el) {
    if (!el) return [];
    var raw = el.className;
    if (typeof raw !== 'string') raw = el.getAttribute ? (el.getAttribute('class') || '') : '';
    return raw.split(/\s+/).filter(Boolean);
  }

  function feedWrap(item) {
    return (item && item.querySelector && item.querySelector('.feedWrap')) || item;
  }

  /*
   * FinancialJuice marks breaking headlines with .feedWrap.active (red) and
   * critical ones with .active-critical. The computed background is checked as
   * a fallback so theme or markup changes do not silently break detection.
   */
  function isRedItem(item, win) {
    if (!item) return false;
    var wrap = feedWrap(item);
    var cls = classesOf(wrap);
    if (cls.indexOf('comm-news') !== -1) return false; // blue company news
    if (cls.indexOf('active-critical') !== -1) return true;
    if (cls.indexOf('active') !== -1) return true;
    try {
      var style = (win || root).getComputedStyle(wrap);
      if (isRedColor(parseColor(style.backgroundColor))) return true;
      if (isRedColor(parseColor(style.background))) return true;
    } catch (err) { /* ignore */ }
    return false;
  }

  function headlineOf(item) {
    if (!item) return '';
    var el = item.querySelector(
      '.headline-title a, .headline-title, .headline-title-nolink, .headline-content'
    );
    var text = el ? (el.innerText || el.textContent || '') : (item.innerText || '');
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function timeOf(item) {
    if (!item) return '';
    var el = item.querySelector('.time');
    return el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function itemId(item) {
    if (!item) return '';
    var id = item.getAttribute &&
      (item.getAttribute('data-headlineid') || item.getAttribute('data-id'));
    if (id) return String(id);
    var text = headlineOf(item);
    return text ? 'h:' + text.slice(0, 120) : '';
  }

  root.FJDetector = {
    parseColor: parseColor,
    isRedColor: isRedColor,
    isRedItem: isRedItem,
    headlineOf: headlineOf,
    timeOf: timeOf,
    itemId: itemId,
    classesOf: classesOf,
    feedWrap: feedWrap
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
