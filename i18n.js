/**
 * Idarah - language switcher (14 Indian languages).
 * i18n.js
 *
 * How it works: the screens are written in English. This file watches the page and swaps any
 * English text it finds in the chosen language's list (locales/xx.js). A list is loaded only when
 * that language is chosen. Text that is not in a list simply stays in English.
 * Urdu and Kashmiri turn the page right-to-left.
 */
(function () {
  'use strict';
  const KEY = 'idarah_lang';
  // code -> native name, English name, direction
  const META = {
    en: ['English', 'English', 'ltr'], hi: ['हिन्दी', 'Hindi', 'ltr'], ur: ['اردو', 'Urdu', 'rtl'],
    bn: ['বাংলা', 'Bengali', 'ltr'], gu: ['ગુજરાતી', 'Gujarati', 'ltr'], ks: ['کٲشُر', 'Kashmiri', 'rtl'],
    ml: ['മലയാളം', 'Malayalam', 'ltr'], ta: ['தமிழ்', 'Tamil', 'ltr'], te: ['తెలుగు', 'Telugu', 'ltr'],
    kn: ['ಕನ್ನಡ', 'Kannada', 'ltr'], mr: ['मराठी', 'Marathi', 'ltr'], as: ['অসমীয়া', 'Assamese', 'ltr'],
    or: ['ଓଡ଼ିଆ', 'Odia', 'ltr'], pa: ['ਪੰਜਾਬੀ', 'Punjabi', 'ltr']
  };
  const LANGS = {};
  Object.keys(META).forEach(k => { LANGS[k] = META[k][0] + (k === 'en' ? '' : ' (' + META[k][1] + ')'); });
  window.I18N_DICT = window.I18N_DICT || {};

  let lang = 'en';
  try { const s = localStorage.getItem(KEY); if (LANGS[s]) lang = s; } catch (e) { /* private mode: fine */ }

  const dict = () => window.I18N_DICT[lang] || null;
  const textRecs = new WeakMap();           // text node -> { orig, shown }
  const ATTRS = ['placeholder', 'aria-label', 'title'];

  // Lines with {} in the word list are patterns, e.g. "Step {} of {}" - the {} parts are carried over.
  const compiled = {};
  function patternsFor(l) {
    if (compiled[l]) return compiled[l];
    const d = window.I18N_DICT[l] || {};
    compiled[l] = Object.keys(d).filter(k => k.indexOf('{}') !== -1).map(k => {
      const re = new RegExp('^' + k.split('{}').map(x => x.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')).join('([\\s\\S]+?)') + '$');
      return { re: re, out: d[k] };
    });
    return compiled[l];
  }
  function lookup(core) {
    const d = dict();
    if (d[core] !== undefined && core.indexOf('{}') === -1) return d[core];
    const ps = patternsFor(lang);
    for (let i = 0; i < ps.length; i++) {
      const m = ps[i].re.exec(core);
      if (m) { let n = 0; return ps[i].out.replace(/\{\}/g, () => translate(m[++n] || '')); }
    }
    return undefined;
  }
  // "🚪 Log out" -> keep the leading emoji/symbols, look up only the words
  function translate(s) {
    const d = dict();
    if (!d || !s) return s;
    const m = /^([^A-Za-z0-9]*)([\s\S]*?)(\s*)$/.exec(s);
    if (!m || !m[2]) return s;
    const hit = lookup(m[2]);
    return hit === undefined ? s : m[1] + hit + m[3];
  }
  function t(s) { return translate(s); }

  function doText(node) {
    if (node.parentNode && node.parentNode.closest && node.parentNode.closest('.pf-lang')) return; // language names stay as they are
    const cur = node.nodeValue;
    const rec = textRecs.get(node);
    const orig = rec && cur === rec.shown ? rec.orig : cur;   // app changed the text itself -> new original
    const shown = lang === 'en' ? orig : translate(orig);
    if (shown !== cur) node.nodeValue = shown;
    textRecs.set(node, { orig: orig, shown: shown });
  }
  function doAttrs(el) {
    ATTRS.forEach(a => {
      if (!el.hasAttribute || !el.hasAttribute(a)) return;
      const cur = el.getAttribute(a);
      const store = '__i18n_' + a;
      const rec = el[store];
      const orig = rec && cur === rec.shown ? rec.orig : cur;
      const shown = lang === 'en' ? orig : translate(orig);
      if (shown !== cur) el.setAttribute(a, shown);
      el[store] = { orig: orig, shown: shown };
    });
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    if (root.tagName === 'SCRIPT' || root.tagName === 'STYLE') return;
    doAttrs(root);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) { if (n.parentNode && n.parentNode.tagName !== 'SCRIPT' && n.parentNode.tagName !== 'STYLE') doText(n); }
      else doAttrs(n);
    }
  }

  function setDir() {
    const h = document.documentElement;
    h.setAttribute('lang', lang);
    h.setAttribute('dir', META[lang][2]);
  }

  // Load locales/<code>.js only when needed. A missing or failed file just means English text.
  function loadDict(l) {
    if (l === 'en' || window.I18N_DICT[l]) return Promise.resolve();
    return new Promise(resolve => {
      const sc = document.createElement('script');
      sc.src = 'locales/' + l + '.js';
      sc.onload = sc.onerror = () => resolve();
      document.head.appendChild(sc);
    });
  }

  let loadSeq = 0;
  function setLang(l, opts) {
    if (!LANGS[l]) return Promise.resolve();
    const seq = ++loadSeq;
    return loadDict(l).then(() => {
      if (seq !== loadSeq) return;               // user picked another language meanwhile
      lang = l;
      try { localStorage.setItem(KEY, l); } catch (e) { /* ignore */ }
      setDir();
      walk(document.body);
      document.querySelectorAll('select.pf-lang').forEach(s => { s.value = l; });
      if (!(opts && opts.silent)) listeners.forEach(f => { try { f(l); } catch (e) { /* ignore */ } });
    });
  }
  // The app can listen for a language change (to save it on the user's profile).
  const listeners = [];
  function onChange(f) { listeners.push(f); }

  function selectHtml() {
    return '<select class="form-control pf-lang" aria-label="Language" title="Language">' +
      Object.keys(LANGS).map(k => '<option value="' + k + '"' + (k === lang ? ' selected' : '') + '>' + LANGS[k] + '</option>').join('') +
      '</select>';
  }

  document.addEventListener('change', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('pf-lang')) setLang(e.target.value);
  });

  let pending = false;
  const queue = [];
  const obs = new MutationObserver((muts) => {
    muts.forEach(m => {
      if (m.type === 'characterData') queue.push(m.target);
      else if (m.type === 'attributes') queue.push(m.target);
      else m.addedNodes.forEach(n => queue.push(n));
    });
    if (pending) return;
    pending = true;
    Promise.resolve().then(() => {
      pending = false;
      const items = queue.splice(0, queue.length);
      obs.disconnect();
      try { items.forEach(n => { if (n.nodeType === 1 || n.nodeType === 3) { if (document.body.contains(n)) walk(n); } }); }
      finally { start(); }
    });
  });
  function start() {
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  window.I18N = { get lang() { return lang; }, LANGS: LANGS, t: t, setLang: setLang, onChange: onChange, selectHtml: selectHtml };

  function init() { setDir(); start(); loadDict(lang).then(() => walk(document.body)); }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
