/*
 * Translation helpers shared by the service worker and the unit tests.
 *
 * Two providers are supported:
 *   - mymemory: free, no signup. The optional `de` parameter raises the daily
 *     quota from 5k to 50k characters; it is not used to send mail.
 *   - deepseek: an OpenAI-compatible chat completion endpoint. Requires a key
 *     and is much better at financial terminology and long news bodies.
 */
(function (root) {
  'use strict';

  var MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
  var DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
  var DEFAULT_EMAIL = '101332879+Andrea01100011@users.noreply.github.com';
  var DEFAULT_MODEL = 'deepseek-chat';

  function decodeEntities(text) {
    return String(text || '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  function polish(text) {
    return String(text || '')
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

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isTranslatable(text) {
    var value = normalize(text);
    if (value.length < 3 || value.length > 800) return false;
    if (!/[A-Za-z]{2}/.test(value)) return false;
    if (/[\u4e00-\u9fff]/.test(value)) return false;
    return true;
  }

  function cacheKey(text, provider, model) {
    return (provider || 'mymemory') + '|' + (model || '') + '|' + normalize(text).slice(0, 500);
  }

  function myMemoryUrl(text, email) {
    return MYMEMORY_ENDPOINT +
      '?q=' + encodeURIComponent(normalize(text).slice(0, 500)) +
      '&langpair=' + encodeURIComponent('en|zh-CN') +
      '&de=' + encodeURIComponent(email || DEFAULT_EMAIL);
  }

  function parseMyMemory(data) {
    if (!data) return { ok: false, error: 'empty' };
    if (data.quotaFinished) return { ok: false, error: 'quota' };
    if (Number(data.responseStatus) !== 200) {
      return { ok: false, error: 'status-' + (data.responseStatus || 'unknown') };
    }
    var translated = data.responseData && data.responseData.translatedText;
    if (!translated) return { ok: false, error: 'empty' };
    translated = polish(decodeEntities(translated));
    if (!translated || /MYMEMORY WARNING/i.test(translated)) {
      return { ok: false, error: 'quota' };
    }
    return { ok: true, text: translated };
  }

  function parseDeepSeek(data) {
    var content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (!content) return { ok: false, error: 'empty' };
    var text = polish(String(content).replace(/^["“]|["”]$/g, '').trim());
    if (!text) return { ok: false, error: 'empty' };
    return { ok: true, text: text };
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 8000);
    try {
      return await fetch(url, Object.assign({}, options, {
        signal: controller.signal,
        cache: 'no-store'
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  async function translateMyMemory(text, opts) {
    opts = opts || {};
    var url = myMemoryUrl(text, opts.email);
    var lastError = 'network';
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var response = await fetchWithTimeout(url, {}, opts.timeoutMs || 8000);
        if (!response.ok) {
          lastError = response.status === 429 ? 'quota' : 'http-' + response.status;
          if (response.status >= 500 && attempt === 0) {
            await new Promise(function (r) { setTimeout(r, 350); });
            continue;
          }
          return { ok: false, error: lastError };
        }
        var data = await response.json();
        var parsed = parseMyMemory(data);
        if (!parsed.ok && parsed.error === 'quota') return { ok: false, error: 'quota' };
        if (!parsed.ok && attempt === 0 && parsed.error !== 'empty') {
          lastError = parsed.error;
          await new Promise(function (r) { setTimeout(r, 350); });
          continue;
        }
        return parsed;
      } catch (err) {
        lastError = err && err.name === 'AbortError' ? 'timeout' : 'network';
        if (attempt === 0) {
          await new Promise(function (r) { setTimeout(r, 350); });
          continue;
        }
      }
    }
    return { ok: false, error: lastError };
  }

  async function translateDeepSeek(text, opts) {
    opts = opts || {};
    if (!opts.apiKey) return { ok: false, error: 'missing-key' };
    var system = 'You are a professional financial-news translator. Translate the English ' +
      'headline or news text into concise Simplified Chinese. Keep tickers, numbers, ' +
      'percentages and abbreviations such as FOMC/CPI/NFP exactly as they are. ' +
      'Do not add explanations. Return only the translation.';
    try {
      var response = await fetchWithTimeout(DEEPSEEK_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + opts.apiKey
        },
        body: JSON.stringify({
          model: opts.model || DEFAULT_MODEL,
          temperature: 0.2,
          max_tokens: 500,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: normalize(text).slice(0, 800) }
          ]
        })
      }, opts.timeoutMs || 12000);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { ok: false, error: 'bad-key' };
        }
        if (response.status === 429) return { ok: false, error: 'rate-limit' };
        return { ok: false, error: 'http-' + response.status };
      }
      return parseDeepSeek(await response.json());
    } catch (err) {
      return { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : 'network' };
    }
  }

  async function translate(text, opts) {
    var value = normalize(text);
    if (!isTranslatable(value)) return { ok: false, error: 'not-needed' };
    opts = opts || {};
    var provider = opts.provider === 'deepseek' ? 'deepseek' : 'mymemory';
    if (provider === 'deepseek') return translateDeepSeek(value, opts);
    return translateMyMemory(value, opts);
  }

  root.FJTranslator = {
    DEFAULT_MODEL: DEFAULT_MODEL,
    DEFAULT_EMAIL: DEFAULT_EMAIL,
    normalize: normalize,
    isTranslatable: isTranslatable,
    polish: polish,
    cacheKey: cacheKey,
    myMemoryUrl: myMemoryUrl,
    parseMyMemory: parseMyMemory,
    parseDeepSeek: parseDeepSeek,
    translate: translate
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
