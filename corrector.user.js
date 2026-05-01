// ==UserScript==
// @name           Correcteur de Phrases
// @namespace      http://violetmonkey.net/
// @version        4.11.0
// @description    Corrige automatiquement les phrases sélectionnées via LanguageTool
// @author         Matteo12SA
// @match          *://*/*
// @noframes
// @updateURL      https://raw.githubusercontent.com/MATTEO12SA/correcteur-violetmonkey/main/corrector.user.js
// @downloadURL    https://raw.githubusercontent.com/MATTEO12SA/correcteur-violetmonkey/main/corrector.user.js
// @grant          GM_xmlhttpRequest
// @grant          GM_setValue
// @grant          GM_getValue
// @grant          GM_deleteValue
// @grant          GM_setClipboard
// @connect        api.languagetool.org
// @run-at         document-end
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = '__corrector_v4_pos';
  const DEBUG_STORAGE_KEY = '__corrector_debug';
  const CONFIRMATION_STORAGE_KEY = '__corrector_confirmation';
  const CORRECTION_MODE_STORAGE_KEY = '__corrector_mode';
  const UI_ROOT_ID = '__corrector_violetmonkey_root';
  const NAV_EVENT = '_corrector_nav';
  const HISTORY_PATCH_FLAG = '__corrector_history_patched';
  // 'password' volontairement exclu : envoyer un mot de passe à LanguageTool serait une fuite de credential.
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email']);
  const CORRECTION_MODES = new Set(['chat-lite', 'balanced', 'strict']);
  const DEFAULT_CORRECTION_MODE = 'balanced';
  const HOST_CHAT_REGEX = /(?:^|\.)(?:twitch|kick|discord|slack|telegram|messenger|teams|irccloud|chat)\./i;
  const WORD_TOKEN_REGEX = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;
  const LETTER_REGEX = /\p{L}/gu;
  const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const MENTION_REGEX = /@[A-Za-z0-9_]{2,}/g;
  const HASHTAG_REGEX = /#[\p{L}\p{N}_-]{2,}/gu;
  const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const SYMBOL_REGEX = /[^\s\p{L}\p{N}]/gu;
  const INLINE_CODE_REGEX = /`[^`\n]+`/g;
  const CODEISH_BRACKET_REGEX = /[`{}[\]<>]/;
  const CODEISH_COMMAND_REGEX = /(?:^|\s)(?:npm|pnpm|yarn|git|cd|ls|rm|cp|mv|sudo|npx)\b/i;
  const SENTENCE_END_REGEX = /[.!?…]\s*$/;
  const TITLE_CASE_REGEX = /^\p{Lu}[\p{Ll}]+$/u;
  const NON_LETTER_REGEX = /[^\p{L}]/gu;
  const LANGUAGETOOL_ENDPOINT = 'https://api.languagetool.org/v2/check';
  const LANGUAGETOOL_PREFERRED_VARIANTS = 'fr-FR,en-US,de-DE,pt-PT';
  const LANGUAGETOOL_TIMEOUT_MS = 12000;
  const LANGUAGETOOL_MAX_TEXT_CHARS = 20000;
  const LANGUAGETOOL_SAFE_MAX_BYTES = 19000;
  const LANGUAGETOOL_RATE_LIMIT_COOLDOWN_MS = 60000;
  const LANGUAGETOOL_ATTRIBUTION_URL = 'https://languagetool.org';
  const COPY_RESET_DELAY_MS = 1500;
  const USER_MESSAGES = {
    copyFallback: 'Copier',
    copied: '\u2713 Copié',
    loading: 'Correction en cours...',
    correctionReady: 'Correction prête.',
    noCorrection: 'Aucune correction nécessaire.',
    applyGenericFailure: 'Impossible de remplacer sur ce site. Utilisez "Copier".',
    selectionLost: 'Sélection perdue. Resélectionnez le texte.',
    selectionChanged: 'Le texte a changé depuis la sélection. Resélectionnez.',
    fieldRefusedReplacement: 'Remplacement refusé par ce champ. Utilisez "Copier".',
    staticReplacementUnconfirmed: 'Remplacement non confirmé sur cette page. Utilisez "Copier".',
    editorReplacementUnconfirmed: 'Remplacement non confirmé sur cet éditeur. Utilisez "Copier".',
    editorWholeReplaceFailure: 'Impossible de remplacer sur cet éditeur. Utilisez "Copier".',
    editorPartialReplaceFailure: 'Remplacement partiel non fiable sur cet éditeur. Utilisez "Copier" ou sélectionnez tout le texte.',
    replacementCopied: 'Remplacement impossible sur ce champ. La correction a été copiée automatiquement.',
    replacementCopyFailure: 'Remplacement impossible sur ce champ. Utilise le bouton Copier pour récupérer la correction.',
    networkError: 'Erreur réseau : impossible de joindre LanguageTool.',
    timeout: 'Délai dépassé. Réessayez avec un passage plus court.',
    invalidResponse: 'Réponse LanguageTool illisible. Réessayez plus tard.',
    copyFailure: 'Impossible de copier automatiquement. Sélectionnez le texte corrigé manuellement.',
  };

  const getUtf8ByteLength = (text) => {
    const value = String(text || '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
    let bytes = 0;
    for (const char of value) {
      const code = char.codePointAt(0);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code <= 0xffff) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  };

  const formatByteSize = (bytes) => {
    if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} Ko`;
    return `${bytes} octets`;
  };

  // Caractères Unicode dangereux dans les replacements LanguageTool :
  // U+200B-U+200F : zero-width / marks (texte invisible)
  // U+202A-U+202E : RTL/LTR overrides (peuvent inverser visuellement le texte)
  // U+2066-U+2069 : isolates bidi
  // U+FEFF : BOM
  const DANGEROUS_UNICODE_REGEX = /[​-\u200F\u202A-\u202E\u2066-\u2069﻿]/;
  const ZALGO_COMBINER_REGEX = /[̀-ͯ]{4,}/;

  const isSafeReplacement = (val) => {
    if (typeof val !== 'string') return false;
    if (DANGEROUS_UNICODE_REGEX.test(val)) return false;
    if (ZALGO_COMBINER_REGEX.test(val)) return false;
    return true;
  };

  const debounce = (fn, ms) => {
    let tid = null;
    let lastArgs = null;
    const invoke = () => {
      const args = lastArgs || [];
      tid = null;
      lastArgs = null;
      fn(...args);
    };
    const wrapper = (...args) => {
      lastArgs = args;
      clearTimeout(tid);
      tid = setTimeout(invoke, ms);
    };
    wrapper.flush = () => {
      if (!tid) return;
      clearTimeout(tid);
      invoke();
    };
    wrapper.cancel = () => { clearTimeout(tid); tid = null; lastArgs = null; };
    return wrapper;
  };

  const throttle = (fn, ms) => {
    let last = 0;
    let pending = null;
    const wrapper = (...args) => {
      const now = Date.now();
      const remaining = ms - (now - last);
      if (remaining <= 0) {
        clearTimeout(pending);
        pending = null;
        last = now;
        fn(...args);
      } else if (!pending) {
        pending = setTimeout(() => {
          last = Date.now();
          pending = null;
          fn(...args);
        }, remaining);
      }
    };
    wrapper.cancel = () => { clearTimeout(pending); pending = null; };
    return wrapper;
  };

  const PERSIST_CACHE_KEY = '__corrector_v4_cache';
  const CORRECTION_CACHE_MAX = 200;
  const CORRECTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  const hashFNV1a = (str) => {
    const source = String(str || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < source.length; i++) {
      h ^= source.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  };

  const persistCacheLoad = () => {
    if (typeof GM_getValue !== 'function') return new Map();
    try {
      const data = GM_getValue(PERSIST_CACHE_KEY, '[]');
      const arr = JSON.parse(data);
      if (!Array.isArray(arr)) return new Map();
      const now = Date.now();
      const cache = new Map();
      for (const item of arr) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [key, entry] = item;
        if (typeof key !== 'string' || !entry || typeof entry.t !== 'number') continue;
        if (now - entry.t > CORRECTION_CACHE_TTL_MS) continue;
        cache.set(key, entry);
      }
      return cache;
    } catch (_) {
      return new Map();
    }
  };

  const persistCacheSave = debounce((cache) => {
    if (typeof GM_setValue !== 'function') return;
    try {
      const arr = Array.from(cache.entries()).slice(-CORRECTION_CACHE_MAX);
      GM_setValue(PERSIST_CACHE_KEY, JSON.stringify(arr));
    } catch (_) {}
  }, 1000);

  const lruCacheGet = (cache, key) => {
    if (!cache.has(key)) return null;
    const entry = cache.get(key);
    if (Date.now() - entry.t > CORRECTION_CACHE_TTL_MS) {
      cache.delete(key);
      persistCacheSave(cache);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.v;
  };

  const lruCacheSet = (cache, key, value) => {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { v: value, t: Date.now() });
    while (cache.size > CORRECTION_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    persistCacheSave(cache);
  };

  const copyTextToClipboard = async (text) => {
    const value = String(text || '');
    if (!value) return false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch (_) {}
    }

    if (typeof GM_setClipboard === 'function') {
      try {
        GM_setClipboard(value, 'text');
        return true;
      } catch (_) {}
    }

    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    ta.remove();
    return ok;
  };

  const readStoredFlag = (key) => {
    try {
      return localStorage.getItem(key) === '1';
    } catch (_) {
      return false;
    }
  };

  const writeStoredFlag = (key, enabled) => {
    try {
      if (enabled) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch (_) {}
  };

  const readStoredValue = (key, fallback = '') => {
    try {
      const value = localStorage.getItem(key);
      return value == null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  };

  const writeStoredValue = (key, value) => {
    try {
      if (value == null || value === '') localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_) {}
  };

  const URL_DEBUG_ENABLED = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('correctorDebug') === '1';
    } catch (_) {
      return false;
    }
  })();

  let debugEnabled = URL_DEBUG_ENABLED || readStoredFlag(DEBUG_STORAGE_KEY);
  let confirmationEnabled = readStoredFlag(CONFIRMATION_STORAGE_KEY);
  const storedCorrectionMode = readStoredValue(CORRECTION_MODE_STORAGE_KEY);
  let correctionMode = CORRECTION_MODES.has(storedCorrectionMode)
    ? storedCorrectionMode
    : DEFAULT_CORRECTION_MODE;
  const _logs = [];

  const isTextControl = (el) => {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase());
  };

  const normalizeComparableText = (text) => (text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const hasMeaningfulSelection = (text) => (text || '').trim().length >= 3;

  const getSelectionPadding = (text) => {
    const value = text || '';
    const leading = (value.match(/^\s*/) || [''])[0];
    const trailing = (value.match(/\s*$/) || [''])[0];
    return { leading, trailing };
  };

  const cloneRegex = (regex) => new RegExp(regex.source, regex.flags);

  const countPatternMatches = (text, regex) => {
    const source = text || '';
    if (!source) return 0;
    const pattern = cloneRegex(regex);
    let count = 0;
    while (pattern.exec(source)) count += 1;
    return count;
  };

  const dbg = (...a) => {
    if (!debugEnabled) return;
    const line = a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    _logs.push(new Date().toISOString().slice(11, 23) + ' ' + line);
  };

  // Snapshot complet de l'état du DOM + sélection à un instant T
  const snap = (label, el) => {
    if (!debugEnabled) return;
    const sel = window.getSelection();
    const ae  = document.activeElement;
    const info = {
      label,
      activeEl:   ae ? ae.tagName + '.' + ae.className.split(' ').join('.') : 'none',
      rangeCount: sel?.rangeCount ?? 0,
      cursorOffset:    sel?.rangeCount ? sel.getRangeAt(0).startOffset : -1,
      collapsed:       sel?.rangeCount ? sel.getRangeAt(0).collapsed   : null,
      anchorNode: sel?.anchorNode?.nodeName ?? 'none',
      domText:    el ? (el.textContent ?? '').slice(0, 120) : null,
    };
    dbg(JSON.stringify(info));
  };

  // Surveille les mutations DOM sur un élément pendant N ms
  const watchMutations = (el, ms) => {
    if (!debugEnabled) return;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        dbg('MUTATION type=' + m.type +
          ' added=' + m.addedNodes.length +
          ' removed=' + m.removedNodes.length +
          ' text=' + JSON.stringify((el.textContent ?? '').slice(0, 80)));
      }
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    setTimeout(() => obs.disconnect(), ms);
  };

  // Surveille les events clavier + input sur un élément pendant N ms
  const watchKeys = (el, ms) => {
    if (!debugEnabled) return;
    const onKd = (e) => dbg('KEYDOWN key=' + JSON.stringify(e.key) +
      ' code=' + e.code +
      ' defaultPrevented=' + e.defaultPrevented +
      ' activeEl=' + document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''));
    const onInput = (e) => dbg('INPUT event inputType=' + e.inputType +
      ' data=' + JSON.stringify(e.data) +
      ' domText=' + JSON.stringify((el.textContent ?? '').slice(0, 80)));
    const onSel = () => {
      const s = window.getSelection();
      dbg('SELECTIONCHANGE offset=' + (s?.rangeCount ? s.getRangeAt(0).startOffset : -1) +
        ' collapsed=' + (s?.rangeCount ? s.getRangeAt(0).collapsed : null) +
        ' activeEl=' + document.activeElement?.tagName);
    };
    document.addEventListener('keydown',       onKd);
    el.addEventListener('input',               onInput);
    el.addEventListener('beforeinput',         onInput);
    document.addEventListener('selectionchange', onSel);
    setTimeout(() => {
      document.removeEventListener('keydown',          onKd);
      el.removeEventListener('input',                  onInput);
      el.removeEventListener('beforeinput',            onInput);
      document.removeEventListener('selectionchange',  onSel);
    }, ms);
  };

  const downloadLogs = () => {
    const content = _logs.length ? _logs.join('\n') : 'Aucun log capturé pour le moment.';
    const blob = new Blob([content], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'correcteur-debug.txt';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 0);
  };

  const TextCorrector = {
    selectedText:   '',
    selectedRawText: '',
    selectedRange:  null,
    savedInputSel:  null,   // { start, end } capturé au déclenchement pour input/textarea
    selectionPadding: { leading: '', trailing: '' },
    selectionSource: null,
    menu:           null,
    menuRefs:       null,
    pill:           null,
    currentRequest: null,
    styleEl:        null,
    uiHost:         null,
    uiRoot:         null,
    previousFocus:  null,
    lastApply:      null,   // données pour le bouton Annuler
    _selChangeTid:  null,
    _styleObserver: null,
    _pillSelectionContext: null,
    correctionCache: persistCacheLoad(),
    _contextCache: new Map(),
    _correctionRequestToken: 0,
    _languageToolCooldownUntil: 0,
    _lt_requestTimestamps: [],
    _activeApplyToken: 0,
    _applyTimeouts: new Set(),

    beginApplyFlow() {
      this.cancelPendingApplyFlow();
      this._activeApplyToken += 1;
      return this._activeApplyToken;
    },

    cancelPendingApplyFlow() {
      this._activeApplyToken += 1;
      this._applyTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
      this._applyTimeouts.clear();
    },

    isApplyFlowActive(token) {
      return token === this._activeApplyToken && !!this.menu;
    },

    scheduleApplyStep(token, callback, delay = 30) {
      const timeoutId = setTimeout(() => {
        this._applyTimeouts.delete(timeoutId);
        if (!this.isApplyFlowActive(token)) return;
        try {
          callback();
        } catch (error) {
          console.error('[Correcteur] Apply flow error:', error);
          this.showApplyError(USER_MESSAGES.applyGenericFailure);
        }
      }, delay);
      this._applyTimeouts.add(timeoutId);
    },

    abortCurrentRequest() {
      if (this.currentRequest && typeof this.currentRequest.abort === 'function') {
        this.currentRequest.abort();
      }
      this.currentRequest = null;
    },

    setDebugEnabled(enabled) {
      debugEnabled = !!enabled;
      writeStoredFlag(DEBUG_STORAGE_KEY, debugEnabled);
      if (!debugEnabled) {
        _logs.length = 0;
      } else {
        dbg('debug enabled');
      }
      this.syncSettingsPanel();
    },

    setConfirmationEnabled(enabled) {
      confirmationEnabled = !!enabled;
      writeStoredFlag(CONFIRMATION_STORAGE_KEY, confirmationEnabled);
      this.syncSettingsPanel();
    },

    setCorrectionMode(mode) {
      if (!CORRECTION_MODES.has(mode)) mode = DEFAULT_CORRECTION_MODE;
      correctionMode = mode;
      writeStoredValue(CORRECTION_MODE_STORAGE_KEY, correctionMode);
      this.syncSettingsPanel();
      if (this.menu && this.selectedText) this.fetchCorrection(this.selectedText);
    },

    getCorrectionModeDescription(mode = correctionMode) {
      if (mode === 'chat-lite') return 'Chat : garde les fautes claires, bloque les corrections trop agressives.';
      if (mode === 'strict') return 'Strict : applique presque toutes les suggestions LanguageTool.';
      return 'Équilibré : bon compromis entre corrections utiles et style naturel.';
    },

    toggleSettingsPanel(force) {
      const refs = this.getMenuRefs();
      if (!refs) return;
      const { settingsPanel: panel, settingsBtn: btn } = refs;
      if (!panel || !btn) return;
      const shouldOpen = typeof force === 'boolean' ? force : panel.hidden;
      panel.hidden = !shouldOpen;
      btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
      this.syncSettingsPanel();
    },

    syncSettingsPanel() {
      const refs = this.getMenuRefs();
      if (!refs) return;
      const {
        debugInput,
        confirmInput,
        modeInput,
        modeHelp,
        downloadLogsBtn: downloadBtn,
        settingsStatus: status,
      } = refs;

      if (debugInput) debugInput.checked = debugEnabled;
      if (confirmInput) confirmInput.checked = confirmationEnabled;
      if (modeInput) modeInput.value = correctionMode;
      if (modeHelp) modeHelp.textContent = this.getCorrectionModeDescription();
      if (downloadBtn) downloadBtn.disabled = !debugEnabled;
      if (status) {
        status.textContent = debugEnabled
          ? (_logs.length ? 'Logs actifs. Clique sur "Télécharger les logs" après avoir reproduit le bug.' : 'Logs actifs. Reproduis le bug puis télécharge le fichier.')
          : 'Logs désactivés. Active-les ici si tu veux un fichier de debug.';
      }
    },

    cacheMenuRefs(menu) {
      if (!menu) {
        this.menuRefs = null;
        return null;
      }
      this.menuRefs = {
        root: menu,
        title: menu.querySelector('.corrector-title'),
        settingsBtn: menu.querySelector('.corrector-settings-btn'),
        closeBtn: menu.querySelector('.corrector-close-btn'),
        settingsPanel: menu.querySelector('.corrector-settings-panel'),
        debugInput: menu.querySelector('.corrector-setting-debug'),
        confirmInput: menu.querySelector('.corrector-setting-confirmation'),
        modeInput: menu.querySelector('.corrector-setting-mode'),
        modeHelp: menu.querySelector('.corrector-mode-help'),
        downloadLogsBtn: menu.querySelector('.corrector-download-logs-btn'),
        settingsStatus: menu.querySelector('.corrector-settings-status'),
        originalContent: menu.querySelector('.corrector-original-content'),
        correctionContent: menu.querySelector('.corrector-correction-content'),
        applyBtn: menu.querySelector('.corrector-apply-btn'),
        copyBtn: menu.querySelector('.corrector-copy-btn'),
        cancelBtn: menu.querySelector('.corrector-cancel-btn'),
        actions: menu.querySelector('.corrector-actions'),
        header: menu.querySelector('.corrector-header'),
        applyError: menu.querySelector('.corrector-apply-error'),
      };
      this.menuRefs.focusableButtons = [
        this.menuRefs.settingsBtn,
        this.menuRefs.closeBtn,
        this.menuRefs.downloadLogsBtn,
        this.menuRefs.applyBtn,
        this.menuRefs.copyBtn,
        this.menuRefs.cancelBtn,
      ].filter(Boolean);
      return this.menuRefs;
    },

    getMenuRefs() {
      if (!this.menu) return null;
      if (this.menuRefs?.root === this.menu) return this.menuRefs;
      return this.cacheMenuRefs(this.menu);
    },

    ensureUiRoot() {
      if (this.uiHost?.isConnected && this.uiRoot) return this.uiRoot;

      let host = document.getElementById(UI_ROOT_ID);
      if (!host) {
        host = document.createElement('div');
        host.id = UI_ROOT_ID;
        host.setAttribute('data-corrector-root', '');
        host.style.cssText = [
          'all: initial',
          'display: block',
          'position: fixed',
          'inset: 0',
          'z-index: 2147483647',
          'pointer-events: none',
          'color-scheme: light dark',
        ].join(';');
        (document.body || document.documentElement).appendChild(host);
      }

      const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
      this.uiHost = host;
      this.uiRoot = root;
      if (!this.styleEl || !root.contains(this.styleEl)) this.injectStyles(root);
      return root;
    },

    isUiEvent(event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.length) {
        return path.includes(this.pill) || path.includes(this.menu) || path.includes(this.uiHost);
      }
      const target = event.target;
      return !!(
        (this.pill && this.pill.contains(target)) ||
        (this.menu && this.menu.contains(target)) ||
        (this.uiHost && this.uiHost.contains(target))
      );
    },

    getCurrentFocus() {
      return this.uiRoot?.activeElement || document.activeElement;
    },

    getFocusableElements(root = this.menu) {
      if (!root) return [];
      const selector = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
      ].join(',');
      return Array.from(root.querySelectorAll(selector))
        .filter((el) => {
          if (!(el instanceof HTMLElement)) return false;
          if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
          if (el.getAttribute('aria-disabled') === 'true') return false;
          return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        });
    },

    getDomSelectionContext() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const rawText = sel.toString();
      if (!hasMeaningfulSelection(rawText)) return null;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return null;
      const editableEl = this.getEditableRootFromNode(range.commonAncestorContainer);
      return {
        type: 'range',
        kind: editableEl ? 'contenteditable' : 'page-text',
        text: rawText.trim(),
        rawText,
        range: range.cloneRange(),
        activeElement: document.activeElement,
        editableEl,
        timestamp: Date.now(),
        rect,
        padding: getSelectionPadding(rawText),
      };
    },

    getControlSelectionContext() {
      const el = document.activeElement;
      if (!isTextControl(el)) return null;
      if (typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') return null;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (start === end) return null;
      const rawText = el.value.slice(start, end);
      if (!hasMeaningfulSelection(rawText)) return null;
      return {
        type: 'control',
        kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'input',
        text: rawText.trim(),
        rawText,
        el,
        activeElement: el,
        start,
        end,
        timestamp: Date.now(),
        rect: el.getBoundingClientRect(),
        padding: getSelectionPadding(rawText),
      };
    },

    getSelectionContext() {
      return this.getControlSelectionContext() || this.getDomSelectionContext();
    },

    getReplacementText(corrected) {
      return `${this.selectionPadding.leading}${corrected}${this.selectionPadding.trailing}`;
    },

    // ─────────────────────────────────────────────
    // Init
    // ─────────────────────────────────────────────
    init() {
      this._boundListeners = [];
      const bind = (target, evt, handler, opts) => {
        target.addEventListener(evt, handler, opts);
        this._boundListeners.push({ target, evt, handler, opts });
      };

      this._throttledScroll = throttle(() => this.handlePillScroll(), 100);

      bind(document, 'mouseup',         (e) => this.handleMouseUp(e));
      bind(document, 'keyup',           (e) => this.handleKeyUp(e));
      bind(document, 'selectionchange', ()  => this.handleSelectionChange());
      bind(document, 'click',           (e) => this.handleOutsideClick(e));
      bind(document, 'keydown',         (e) => this.handleKeyDown(e));
      bind(window,   'beforeunload',    ()  => this.destroy());
      bind(window,   'scroll',          this._throttledScroll, { passive: true, capture: true });
      bind(window,   'resize',          this._throttledScroll, { passive: true });

      this.ensureUiRoot();
      this.watchNavigation();
    },

    destroy() {
      persistCacheSave.flush?.();
      this.closeMenu();
      this.hidePill();
      this._throttledScroll?.cancel();
      for (const { target, evt, handler, opts } of (this._boundListeners || [])) {
        target.removeEventListener(evt, handler, opts);
      }
      this._boundListeners = [];
      this._styleObserver?.disconnect();
      this._styleObserver = null;
      this.abortCurrentRequest();
    },

    // ─────────────────────────────────────────────
    // Support SPA
    // ─────────────────────────────────────────────
    watchNavigation() {
      if (!history[HISTORY_PATCH_FLAG]) {
        const originalPushState = history.pushState.bind(history);
        const originalReplaceState = history.replaceState.bind(history);
        history.pushState = function (...args) {
          const result = originalPushState(...args);
          window.dispatchEvent(new Event(NAV_EVENT));
          return result;
        };
        history.replaceState = function (...args) {
          const result = originalReplaceState(...args);
          window.dispatchEvent(new Event(NAV_EVENT));
          return result;
        };
        history[HISTORY_PATCH_FLAG] = true;
        window.addEventListener('popstate', () => window.dispatchEvent(new Event(NAV_EVENT)));
      }

      window.addEventListener(NAV_EVENT, () => { this.hidePill(); this.closeMenu(); });

      if (this._styleObserver) return;
      this._styleObserver = new MutationObserver(() => {
        if (!this.uiHost || !this.uiHost.isConnected) {
          this.uiHost = null;
          this.uiRoot = null;
          this.styleEl = null;
          this.ensureUiRoot();
        }
      });
      this._styleObserver.observe(document.body || document.documentElement, { childList: true });
    },

    // ─────────────────────────────────────────────
    // Bulle flottante
    // ─────────────────────────────────────────────
    handleMouseUp(e) {
      if (this.isUiEvent(e)) return;
      setTimeout(() => this._checkSelectionAndShowPill(), 10);
    },

    // Affiche la bulle après sélection clavier (Shift+flèche, Shift+End, etc.)
    handleKeyUp(e) {
      if (!e.shiftKey) return;
      setTimeout(() => this._checkSelectionAndShowPill(), 10);
    },

    _checkSelectionAndShowPill() {
      const context = this.getSelectionContext();
      if (!context) { this.hidePill(); return; }
      this.showPill(context);
    },

    // Debounce : selectionchange se déclenche à chaque frappe sur toute la page
    handleSelectionChange() {
      clearTimeout(this._selChangeTid);
      this._selChangeTid = setTimeout(() => {
        if (!this.getSelectionContext()) this.hidePill();
      }, 40);
    },

    showPill(context) {
      this.hidePill();
      this._pillSelectionContext = context;
      const { rect } = context;
      const pill = document.createElement('button');
      pill.className = 'corrector-pill';
      pill.setAttribute('aria-label', 'Corriger le texte sélectionné');
      pill.textContent = '\u270E Corriger';
      pill.style.visibility = 'hidden';
      pill.style.left = '0px';
      pill.style.top = '0px';
      pill.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (e.button === 0) this.triggerCorrection(this._pillSelectionContext);
      });
      pill.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        this.triggerCorrection(this._pillSelectionContext);
      });
      this.ensureUiRoot().appendChild(pill);

      this.positionPill(pill, rect);
      pill.style.visibility = 'visible';
      this.pill = pill;
    },

    positionPill(pill, rect) {
      if (!pill || !rect) return;
      const pillRect = pill.getBoundingClientRect();
      const gap = 8;
      let x = rect.left + rect.width / 2 - pillRect.width / 2;
      let y = rect.top - pillRect.height - gap;
      if (y < 8) y = rect.bottom + gap;
      x = Math.max(8, Math.min(x, window.innerWidth - pillRect.width - 8));
      y = Math.max(8, Math.min(y, window.innerHeight - pillRect.height - 8));
      pill.style.left = `${x}px`;
      pill.style.top = `${y}px`;
    },

    getSelectionContextRect(context) {
      if (!context) return null;
      if (context.type === 'control') {
        const el = context.el;
        if (!el || !el.isConnected || typeof el.getBoundingClientRect !== 'function') return null;
        const rect = el.getBoundingClientRect();
        return rect && (rect.width || rect.height) ? rect : null;
      }
      if (context.range && typeof context.range.getBoundingClientRect === 'function') {
        try {
          const rect = context.range.getBoundingClientRect();
          if (rect && (rect.width || rect.height)) return rect;
        } catch (_) {}
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      try {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        return rect && (rect.width || rect.height) ? rect : null;
      } catch (_) {
        return null;
      }
    },

    handlePillScroll() {
      if (!this.pill || !this._pillSelectionContext) return;
      const rect = this.getSelectionContextRect(this._pillSelectionContext);
      if (!rect) { this.hidePill(); return; }
      if (rect.bottom < 0 || rect.top > window.innerHeight) { this.hidePill(); return; }
      this._pillSelectionContext = { ...this._pillSelectionContext, rect };
      this.positionPill(this.pill, rect);
    },

    hidePill() {
      this._pillSelectionContext = null;
      if (this.pill) { this.pill.remove(); this.pill = null; }
    },

    triggerCorrection(context = null) {
      const sourceContext = context || this.getSelectionContext() || this._pillSelectionContext;
      if (!sourceContext) return;

      const resolvedContext = {
        ...sourceContext,
        range: sourceContext.range ? sourceContext.range.cloneRange() : null,
        rect: sourceContext.rect || (sourceContext.el ? sourceContext.el.getBoundingClientRect() : null),
      };

      this.selectedText = resolvedContext.text;
      this.selectedRawText = resolvedContext.rawText;
      this.previousFocus = document.activeElement;
      this.selectedRange = resolvedContext.type === 'range' ? resolvedContext.range : null;
      this.savedInputSel = resolvedContext.type === 'control'
        ? { start: resolvedContext.start, end: resolvedContext.end }
        : null;
      this.selectionPadding = resolvedContext.padding;
      this.selectionSource = resolvedContext;

      const pillRect = this.pill ? this.pill.getBoundingClientRect() : null;
      const savedPos = this.loadPosition();

      this.hidePill();
      this.createMenu(
        savedPos ? savedPos.x : (pillRect ? pillRect.left : 80),
        savedPos ? savedPos.y : (pillRect ? pillRect.bottom + 10 : 80)
      );
      this.fetchCorrection(this.selectedText);
    },

    // ─────────────────────────────────────────────
    // API LanguageTool
    // ─────────────────────────────────────────────
    createCorrectionContext(text) {
      const host = (window.location.hostname || '').toLowerCase();
      const source = text || '';
      const language = this.detectLanguageHint() || 'auto';
      const key = `${host}||${correctionMode}||${language}||${source.length}||${hashFNV1a(source)}`;
      if (this._contextCache.has(key)) return this._contextCache.get(key);

      const analysis = this.analyzeSelectionText(text, host);
      const context = {
        host,
        mode: correctionMode,
        language,
        profile: analysis.profile,
        protectedRanges: analysis.protectedRanges,
        flavor: analysis.profile.chatLike ? 'chat' : 'prose',
      };
      if (this._contextCache.size > 32) {
        this._contextCache.delete(this._contextCache.keys().next().value);
      }
      this._contextCache.set(key, context);
      return context;
    },

    analyzeSelectionText(text, host) {
      const source = text || '';
      const urlRanges = this.collectPatternRanges(source, URL_REGEX, 'url');
      const emailRanges = this.collectPatternRanges(source, EMAIL_REGEX, 'email');
      const mentionRanges = this.collectPatternRanges(source, MENTION_REGEX, 'mention');
      const hashtagRanges = this.collectPatternRanges(source, HASHTAG_REGEX, 'hashtag');
      const codeRanges = this.collectPatternRanges(source, INLINE_CODE_REGEX, 'code');
      const hostLooksChat = HOST_CHAT_REGEX.test(host);
      const shortText = source.trim().length <= 140;
      const codeish = CODEISH_BRACKET_REGEX.test(source) || CODEISH_COMMAND_REGEX.test(source);
      const symbolCount = countPatternMatches(source, SYMBOL_REGEX);
      const emojiCount = countPatternMatches(source, EMOJI_REGEX);
      const symbolRatio = source.length ? symbolCount / source.length : 0;

      return {
        profile: {
          wordCount: countPatternMatches(source, WORD_TOKEN_REGEX),
          letterCount: countPatternMatches(source, LETTER_REGEX),
          urlCount: urlRanges.length,
          mentionCount: mentionRanges.length,
          hashtagCount: hashtagRanges.length,
          emojiCount,
          symbolRatio,
          codeish,
          chatLike: hostLooksChat || mentionRanges.length > 0 || hashtagRanges.length > 0 || emojiCount > 0 || (shortText && symbolRatio > 0.08),
        },
        protectedRanges: this.mergeProtectedRanges([
          ...urlRanges,
          ...emailRanges,
          ...mentionRanges,
          ...hashtagRanges,
          ...codeRanges,
        ]),
      };
    },

    buildCorrectionCacheKey(text, context) {
      const flavor = context.flavor || (context.profile.chatLike ? 'chat' : 'prose');
      return [context.host, context.mode, context.language || 'auto', flavor, (text || '').length, hashFNV1a(text)].join('||');
    },

    mergeProtectedRanges(ranges) {
      const sortedRanges = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
      const merged = [];
      for (const range of sortedRanges) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end) {
          last.end = Math.max(last.end, range.end);
          continue;
        }
        merged.push({ ...range });
      }
      return merged;
    },

    collectPatternRanges(text, regex, kind) {
      const source = text || '';
      if (!source) return [];
      const pattern = cloneRegex(regex);
      const ranges = [];
      let match;
      while ((match = pattern.exec(source))) {
        const value = match[0];
        if (!value) {
          pattern.lastIndex += 1;
          continue;
        }
        ranges.push({ start: match.index, end: match.index + value.length, kind });
      }
      return ranges;
    },

    rangesOverlap(start, end, ranges) {
      for (const range of ranges) {
        if (range.start >= end) break;
        if (start < range.end && end > range.start) return true;
      }
      return false;
    },

    countWords(text) {
      return countPatternMatches(text, WORD_TOKEN_REGEX);
    },

    getMatchIssueType(match) {
      return String(match?.rule?.issueType || match?.type?.typeName || '').toLowerCase();
    },

    getMatchCategoryId(match) {
      return String(match?.rule?.category?.id || '').toUpperCase();
    },

    getMatchRuleId(match) {
      return String(match?.rule?.id || '').toUpperCase();
    },

    createMatchInfo(match, text) {
      const offset = match.offset;
      const length = match.length;
      const original = text.slice(offset, offset + length);
      const originalLetters = original.replace(NON_LETTER_REGEX, '');
      return {
        match,
        offset,
        length,
        original,
        originalLetters,
        isOriginalAllCaps: originalLetters.length > 1 && originalLetters === originalLetters.toUpperCase(),
        isOriginalTitleCase: TITLE_CASE_REGEX.test(originalLetters),
        isOriginalLowerCase: originalLetters === originalLetters.toLowerCase(),
        issueType: this.getMatchIssueType(match),
        categoryId: this.getMatchCategoryId(match),
        ruleId: this.getMatchRuleId(match),
        originalWordCount: this.countWords(original),
      };
    },

    isSentenceStart(text, offset) {
      const before = (text || '').slice(0, offset).trimEnd();
      return !before || SENTENCE_END_REGEX.test(before);
    },

    upperCaseFirstLetter(text) {
      return text.replace(/\p{L}/u, (letter) => letter.toUpperCase());
    },

    lowerCaseFirstLetter(text) {
      return text.replace(/\p{L}/u, (letter) => letter.toLowerCase());
    },

    normalizeReplacementCasing(matchInfo, replacement, text) {
      const {
        originalLetters,
        isOriginalAllCaps,
        isOriginalTitleCase,
        isOriginalLowerCase,
        offset,
      } = matchInfo;
      if (!originalLetters) return replacement;
      if (isOriginalAllCaps) {
        return replacement.toUpperCase();
      }
      if (isOriginalTitleCase) {
        return this.upperCaseFirstLetter(replacement);
      }
      const replacementLetters = (replacement || '').replace(NON_LETTER_REGEX, '');
      if (
        isOriginalLowerCase &&
        !this.isSentenceStart(text, offset) &&
        TITLE_CASE_REGEX.test(replacementLetters)
      ) {
        return this.lowerCaseFirstLetter(replacement);
      }
      return replacement;
    },

    isReplacementSafe(matchInfo, replacement, replacementWordCount, context) {
      const { original, originalWordCount, issueType } = matchInfo;
      if (!replacement || replacement === original) return false;

      if (context.mode !== 'strict' && replacement.length > Math.max(original.length * 3, original.length + 24)) return false;
      if (context.mode === 'chat-lite' && replacementWordCount > Math.max(originalWordCount + 2, 4) && replacement.length > original.length + 10) return false;
      if (context.profile.chatLike && issueType === 'style') return false;
      if (context.profile.chatLike && /[A-Z]{3,}/.test(replacement) && !/[A-Z]{3,}/.test(original)) return false;
      return true;
    },

    scoreReplacementCandidate(matchInfo, replacement, replacementWordCount, context) {
      const { issueType, original, originalWordCount } = matchInfo;
      let score = 100;

      if (issueType === 'misspelling') score += 16;
      else if (issueType === 'grammar') score += 14;
      else if (issueType === 'typographical') score += 8;
      else if (issueType === 'whitespace') score += 5;
      else if (issueType === 'style') score -= 18;

      score -= Math.abs(replacement.length - original.length);
      score -= Math.max(0, replacementWordCount - originalWordCount) * (context.mode === 'chat-lite' ? 6 : 3);
      if (context.profile.chatLike && replacement.length > original.length + 8) score -= 10;
      if (replacement.includes('\n')) score -= 20;
      return score;
    },

    pickReplacement(matchInfo, text, context) {
      const { match } = matchInfo;
      const candidates = [];
      const seenCandidates = new Set();
      for (const replacement of (match.replacements || []).slice(0, 5)) {
        const raw = replacement && typeof replacement.value === 'string'
          ? replacement.value.replace(/\u00A0/g, ' ')
          : '';
        if (!raw || !isSafeReplacement(raw) || seenCandidates.has(raw)) continue;
        seenCandidates.add(raw);
        candidates.push(raw);
      }

      let best = null;
      for (const candidate of candidates) {
        const normalized = this.normalizeReplacementCasing(matchInfo, candidate, text);
        const replacementWordCount = this.countWords(normalized);
        if (!this.isReplacementSafe(matchInfo, normalized, replacementWordCount, context)) continue;
        const score = this.scoreReplacementCandidate(matchInfo, normalized, replacementWordCount, context);
        if (!best || score > best.score) best = { value: normalized, score };
      }
      return best ? best.value : null;
    },

    scorePreparedMatch(matchInfo, replacementValue, context) {
      const { issueType, categoryId, length } = matchInfo;
      let score = 40;

      if (issueType === 'misspelling') score += 50;
      else if (issueType === 'grammar') score += 44;
      else if (issueType === 'typographical') score += 34;
      else if (issueType === 'whitespace') score += 24;
      else if (issueType === 'duplication') score += 18;
      else if (issueType === 'style') score -= 20;
      else if (issueType === 'locale-violation') score -= 24;

      if (categoryId.includes('GRAMMAR')) score += 10;
      if (categoryId.includes('CASING')) score += 6;
      if (categoryId.includes('STYLE')) score -= 14;
      if (context.profile.chatLike && (issueType === 'misspelling' || issueType === 'grammar')) score += 6;
      if (context.profile.chatLike && replacementValue.length > length + 8) score -= 10;
      return score;
    },

    shouldKeepMatchInfo(matchInfo, context) {
      if (!matchInfo) return false;

      const { offset: start, length, issueType, categoryId, ruleId, original } = matchInfo;
      const end = start + length;

      if (this.rangesOverlap(start, end, context.protectedRanges)) return false;
      if (context.mode !== 'strict') {
        if (issueType === 'style' || issueType === 'locale-violation') return false;
        if (categoryId.includes('STYLE') || categoryId.includes('REGISTER')) return false;
      }
      if (context.mode === 'chat-lite') {
        if (issueType === 'duplication' && original.trim().length <= 2) return false;
      }
      if (context.profile.codeish && context.mode !== 'strict' && /[\\/]|(?:^|_)[A-Z0-9_]+(?:$|_)/.test(original)) return false;
      if (ruleId.includes('TYPOGRAF') && context.mode === 'chat-lite' && context.profile.chatLike) return false;
      return true;
    },

    shouldKeepMatchFinal(matchInfo, replacementValue, context) {
      if (!matchInfo || !replacementValue) return false;

      const { issueType, categoryId, original } = matchInfo;
      if (context.mode === 'chat-lite') {
        if (issueType === 'whitespace' && !/\s{2,}/.test(original) && !/[,:;!?]/.test(replacementValue)) return false;
        if (categoryId.includes('PUNCTUATION') && replacementValue.length > original.length + 3 && !/[.!?]/.test(original)) return false;
      }
      return true;
    },

    shouldKeepMatch(matchInfo, replacementValue, context) {
      return this.shouldKeepMatchInfo(matchInfo, context) &&
        this.shouldKeepMatchFinal(matchInfo, replacementValue, context);
    },

    getTextLimitError(text) {
      const charCount = (text || '').length;
      const byteCount = getUtf8ByteLength(text);
      if (charCount <= LANGUAGETOOL_MAX_TEXT_CHARS && byteCount <= LANGUAGETOOL_SAFE_MAX_BYTES) {
        return null;
      }
      return `Texte trop long pour l'API gratuite (${formatByteSize(byteCount)}). Sélectionnez un passage plus court.`;
    },

    getCooldownError() {
      const remainingMs = this._languageToolCooldownUntil - Date.now();
      if (remainingMs <= 0) return null;
      const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
      return `Limite LanguageTool atteinte. Réessayez dans ${remainingSeconds} s.`;
    },

    startLanguageToolCooldown() {
      this._languageToolCooldownUntil = Date.now() + LANGUAGETOOL_RATE_LIMIT_COOLDOWN_MS;
    },

    canMakeLanguageToolRequest() {
      const now = Date.now();
      this._lt_requestTimestamps = this._lt_requestTimestamps.filter(t => now - t < 60000);
      return this._lt_requestTimestamps.length < 20;
    },

    recordLanguageToolRequest() {
      this._lt_requestTimestamps.push(Date.now());
    },

    detectLanguageHint() {
      const rawLang = (document.documentElement?.lang || '').toLowerCase().replace('_', '-');
      const exactMap = {
        'en-us': 'en-US',
        'en-gb': 'en-GB',
        'en-ca': 'en-CA',
        'en-au': 'en-AU',
        'en-nz': 'en-NZ',
        'en-za': 'en-ZA',
        'de-de': 'de-DE',
        'de-at': 'de-AT',
        'de-ch': 'de-CH',
        'pt-pt': 'pt-PT',
        'pt-br': 'pt-BR',
      };
      if (exactMap[rawLang]) return exactMap[rawLang];
      const lang = rawLang.split('-')[0];
      const map = {
        fr: 'fr',
        en: 'en-US',
        de: 'de-DE',
        pt: 'pt-PT',
        es: 'es',
        it: 'it',
        nl: 'nl',
        pl: 'pl',
      };
      return map[lang] || null;
    },

    buildLanguageToolPayload(text, context) {
      const params = new URLSearchParams({
        text,
        language: context.language || this.detectLanguageHint() || 'auto',
        preferredVariants: LANGUAGETOOL_PREFERRED_VARIANTS,
        level: context.mode === 'strict' ? 'picky' : 'default',
      });

      if (context.mode === 'chat-lite') {
        params.set('disabledCategories', 'STYLE,REDUNDANCY,COLLOQUIALISMS,TYPOGRAPHY');
      } else if (context.mode === 'balanced') {
        params.set('disabledCategories', 'STYLE,REDUNDANCY');
      }
      return params.toString();
    },

    getLanguageToolErrorMessage(status) {
      if (status === 400) return 'LanguageTool a refusé la demande. Essayez une sélection plus courte ou plus simple.';
      if (status === 413) return 'Texte trop long pour LanguageTool. Sélectionnez un passage plus court.';
      if (status === 429) return this.getCooldownError() || 'Limite LanguageTool atteinte. Réessayez dans environ une minute.';
      if (status >= 500) return 'LanguageTool est indisponible pour le moment. Réessayez plus tard.';
      return `Erreur LanguageTool (${status || 'réseau'}). Réessayez plus tard.`;
    },

    fetchCorrection(text) {
      if (!this.menu) return;
      this.abortCurrentRequest();
      const requestToken = ++this._correctionRequestToken;

      const correctionContext = this.createCorrectionContext(text);
      const limitError = this.getTextLimitError(text);
      if (limitError) {
        this.showCorrectionError(limitError, { retry: false, kind: 'limit' });
        return;
      }

      const cacheKey = this.buildCorrectionCacheKey(text, correctionContext);
      const cached = lruCacheGet(this.correctionCache, cacheKey);
      if (cached) {
        this.renderCorrection(text, cached, correctionContext);
        return;
      }

      const cooldownError = this.getCooldownError();
      if (cooldownError) {
        this.showCorrectionError(cooldownError, { retry: false, kind: 'rate-limit' });
        return;
      }

      if (!this.canMakeLanguageToolRequest()) {
        this.showCorrectionError(
          'Limite locale atteinte (20 req/min). Patientez quelques secondes.',
          { retry: false, kind: 'rate-limit' }
        );
        return;
      }
      this.recordLanguageToolRequest();

      this.setLoadingState(true);

      this.currentRequest = GM_xmlhttpRequest({
        method:  'POST',
        url:     LANGUAGETOOL_ENDPOINT,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        data:    this.buildLanguageToolPayload(text, correctionContext),
        timeout: LANGUAGETOOL_TIMEOUT_MS,

        onload: (res) => {
          if (requestToken !== this._correctionRequestToken || !this.menu) return;
          this.currentRequest = null;
          this.setLoadingState(false);
          if (res.status < 200 || res.status >= 300) {
            if (res.status === 429) this.startLanguageToolCooldown();
            this.showCorrectionError(this.getLanguageToolErrorMessage(res.status), {
              retry: res.status !== 429,
              kind: res.status === 429 ? 'rate-limit' : (res.status === 413 ? 'limit' : 'error'),
            });
            return;
          }
          try {
            const ctype = (res.responseHeaders || '').toLowerCase();
            if (ctype && !ctype.includes('application/json')) {
              this.showCorrectionError(USER_MESSAGES.invalidResponse, { kind: 'error' });
              return;
            }
            const matches = JSON.parse(res.responseText).matches || [];
            lruCacheSet(this.correctionCache, cacheKey, matches);
            this.renderCorrection(text, matches, correctionContext);
          }
          catch (_) { this.showCorrectionError(USER_MESSAGES.invalidResponse, { kind: 'error' }); }
        },
        onerror: () => {
          if (requestToken !== this._correctionRequestToken || !this.menu) return;
          this.currentRequest = null;
          this.setLoadingState(false);
          this.showCorrectionError(USER_MESSAGES.networkError, { kind: 'network' });
        },
        ontimeout: () => {
          if (requestToken !== this._correctionRequestToken || !this.menu) return;
          this.currentRequest = null;
          this.setLoadingState(false);
          this.showCorrectionError(USER_MESSAGES.timeout, { kind: 'timeout' });
        },
        onabort: () => {
          if (requestToken === this._correctionRequestToken) this.currentRequest = null;
        },
      });
    },

    setLoadingState(loading) {
      const refs = this.getMenuRefs();
      const el = refs?.correctionContent;
      if (!el) return;
      if (loading) {
        this.resetActionState();
        el.dataset.correctorState = 'loading';
        el.classList.remove(
          'corrector-state-error',
          'corrector-state-success',
          'corrector-state-ready',
          'corrector-state-limit',
          'corrector-state-network',
          'corrector-state-timeout',
          'corrector-state-rate-limit'
        );
        el.classList.add('corrector-state', 'corrector-state-loading');
        const spinner = document.createElement('span');
        spinner.className = 'corrector-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = USER_MESSAGES.loading;
        el.replaceChildren(spinner, label);
      }
    },

    showCorrectionError(msg, options = {}) {
      const refs = this.getMenuRefs();
      const el = refs?.correctionContent;
      if (!el) return;
      this.resetActionState();
      const label = msg || 'Erreur : impossible de corriger.';
      const retry = options.retry !== false;
      const kind = options.kind || 'error';
      el.dataset.correctorState = kind;
      el.classList.remove(
        'corrector-state-loading',
        'corrector-state-success',
        'corrector-state-ready',
        'corrector-state-limit',
        'corrector-state-network',
        'corrector-state-timeout',
        'corrector-state-rate-limit',
        'corrector-state-error'
      );
      el.classList.add('corrector-state', 'corrector-state-error', `corrector-state-${kind}`);
      const msgSpan = document.createElement('span');
      msgSpan.className = 'corrector-state-text';
      msgSpan.textContent = '\u26A0 ' + label;
      el.replaceChildren(msgSpan);
      if (retry) {
        const retryBtn = document.createElement('button');
        retryBtn.className   = 'corrector-retry-btn';
        retryBtn.type        = 'button';
        retryBtn.textContent = 'Réessayer';
        retryBtn.addEventListener('click', () => this.fetchCorrection(this.selectedText));
        el.appendChild(retryBtn);
      }
    },

    // ─────────────────────────────────────────────
    // Rendu du diff
    // ─────────────────────────────────────────────
    renderCorrection(text, matches, correctionContext = this.createCorrectionContext(text)) {
      const refs = this.getMenuRefs();
      if (!refs) return;

      this.resetActionState();
      const preparedMatches = this.prepareMatches(text, matches, correctionContext);
      const corrected = this.applyMatches(text, preparedMatches);

      // Badge erreurs
      if (preparedMatches.length > 0) {
        const badge = document.createElement('span');
        badge.className   = 'corrector-badge';
        badge.textContent = preparedMatches.length + ' erreur' + (preparedMatches.length > 1 ? 's' : '');
        refs.title?.appendChild(badge);
      }

      // Texte original avec erreurs soulignées
      const origEl = refs.originalContent;
      origEl.replaceChildren(...this.buildSpans(text, preparedMatches, (m) => {
        const s = document.createElement('span');
        s.className   = 'corrector-error corrector-removed';
        s.setAttribute('aria-label', 'Texte signalé : ' + text.slice(m.offset, m.offset + m.length));
        s.title       = m.message || '';
        s.textContent = text.slice(m.offset, m.offset + m.length);
        return s;
      }));

      // Correction
      const corrEl = refs.correctionContent;
      corrEl.classList.remove(
        'corrector-state-loading',
        'corrector-state-error',
        'corrector-state-limit',
        'corrector-state-network',
        'corrector-state-timeout',
        'corrector-state-rate-limit'
      );
      if (corrected === text) {
        const ok = document.createElement('span');
        ok.className   = 'corrector-ok corrector-state-text';
        ok.textContent = '\u2713 ' + USER_MESSAGES.noCorrection;
        corrEl.dataset.correctorState = 'success';
        corrEl.classList.add('corrector-state', 'corrector-state-success');
        corrEl.classList.remove('corrector-state-ready');
        corrEl.replaceChildren(ok);
      } else {
        corrEl.dataset.correctorState = 'ready';
        corrEl.classList.add('corrector-state', 'corrector-state-ready');
        corrEl.classList.remove('corrector-state-success');
        corrEl.replaceChildren(...this.buildSpans(text, preparedMatches, (m) => {
          const s = document.createElement('span');
          s.className   = 'corrector-fix corrector-added';
          s.setAttribute('aria-label', 'Correction proposée : ' + m.replacementValue);
          s.textContent = m.replacementValue;
          return s;
        }));

        const applyBtn = refs.applyBtn;
        applyBtn.disabled = false;
        applyBtn.dataset.corrected = corrected;
        applyBtn.focus();

        const copyBtn = refs.copyBtn;
        copyBtn.style.display = 'inline-block';
        copyBtn.dataset.text  = corrected;
      }
    },

    prepareMatches(text, matches, correctionContext = this.createCorrectionContext(text)) {
      const candidates = (matches || [])
        .filter((match) => match && Array.isArray(match.replacements) && match.replacements.length > 0)
        .map((match) => {
          const matchInfo = this.createMatchInfo(match, text);
          if (!this.shouldKeepMatchInfo(matchInfo, correctionContext)) return null;
          const replacementValue = this.pickReplacement(matchInfo, text, correctionContext);
          if (!this.shouldKeepMatchFinal(matchInfo, replacementValue, correctionContext)) return null;
          return {
            ...matchInfo.match,
            replacementValue,
            issueType: matchInfo.issueType,
            categoryId: matchInfo.categoryId,
            ruleId: matchInfo.ruleId,
            priority: this.scorePreparedMatch(matchInfo, replacementValue, correctionContext),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.offset - b.offset || b.priority - a.priority || a.length - b.length);

      const prepared = [];
      for (const match of candidates) {
        const last = prepared[prepared.length - 1];
        if (!last || match.offset >= last.offset + last.length) {
          prepared.push(match);
          continue;
        }
        if (match.priority > last.priority || (match.priority === last.priority && match.length < last.length)) {
          prepared[prepared.length - 1] = match;
        }
      }
      return prepared;
    },

    buildSpans(text, matches, makeSpan) {
      const nodes  = [];
      let cursor   = 0;
      for (const m of matches) {
        if (m.offset > cursor) nodes.push(document.createTextNode(text.slice(cursor, m.offset)));
        nodes.push(makeSpan(m));
        cursor = m.offset + m.length;
      }
      if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)));
      return nodes;
    },

    applyMatches(text, matches) {
      if (!matches || !matches.length) return text;
      const sorted = matches.slice().sort((a, b) => a.offset - b.offset);
      const parts = [];
      let cursor = 0;
      for (const m of sorted) {
        if (m.offset < cursor) continue;
        if (m.offset > cursor) parts.push(text.slice(cursor, m.offset));
        parts.push(String(m.replacementValue ?? ''));
        cursor = m.offset + m.length;
      }
      if (cursor < text.length) parts.push(text.slice(cursor));
      return parts.join('');
    },

    // Vérifie que la range sauvegardée pointe toujours vers le bon texte dans le DOM
    isRangeValid(context = null) {
      const range = context?.range || this.selectedRange;
      const rawText = context?.rawText ?? this.selectedRawText;
      if (!range) return false;
      const sc = range.startContainer;
      const ec = range.endContainer;
      if (!sc.isConnected || !ec.isConnected) return false;
      if (range.toString() !== rawText) return false;
      return true;
    },

    isControlSelectionValid(context = null) {
      const source = context || this.selectionSource;
      if (!source || source.type !== 'control') return false;
      const { el, start, end, rawText } = source;
      if (!el || !el.isConnected) return false;
      if (typeof el.value !== 'string') return false;
      return el.value.slice(start, end) === rawText;
    },

    resetActionState() {
      const refs = this.getMenuRefs();
      if (!refs) return;
      this.clearApplyError();

      const badges = refs.title?.querySelectorAll('.corrector-badge');
      if (badges && badges.length) {
        const range = document.createRange();
        range.setStartBefore(badges[0]);
        range.setEndAfter(badges[badges.length - 1]);
        range.deleteContents();
      }

      const applyBtn = refs.applyBtn;
      if (applyBtn) {
        applyBtn.disabled = true;
        delete applyBtn.dataset.corrected;
      }

      const copyBtn = refs.copyBtn;
      if (copyBtn) {
        copyBtn.style.display = 'none';
        copyBtn.textContent = USER_MESSAGES.copyFallback;
        delete copyBtn.dataset.text;
      }
    },

    clearApplyError() {
      const refs = this.getMenuRefs();
      if (!refs?.applyError) return;
      refs.applyError.remove();
      refs.applyError = null;
    },

    selectionMatchesWholeEditable(editableEl, context = null) {
      const rawText = context?.rawText ?? this.selectedRawText;
      return normalizeComparableText(rawText) === normalizeComparableText(editableEl.textContent || '');
    },

    getEditableRootFromNode(node) {
      if (!node) return null;
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!(el instanceof HTMLElement)) return null;
      if (!el.isContentEditable) return null;
      return el.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')
        || el.closest('[contenteditable]')
        || el;
    },

    restoreSavedRangeSelection(context = null) {
      const rangeSource = context?.range || this.selectedRange;
      const rawText = context?.rawText ?? this.selectedRawText;
      if (!rangeSource) return false;
      const sel = window.getSelection();
      if (!sel) return false;
      try {
        const sc = rangeSource.startContainer;
        const ec = rangeSource.endContainer;
        if (!sc?.isConnected || !ec?.isConnected) return false;
        const range = rangeSource.cloneRange();
        sel.removeAllRanges();
        sel.addRange(range);
        return normalizeComparableText(sel.toString()) === normalizeComparableText(rawText);
      } catch (_) {
        return false;
      }
    },

    // ─────────────────────────────────────────────
    // Panneau de correction (déplaçable)
    // ─────────────────────────────────────────────
    createMenu(x, y) {
      this.closeMenu();
      const menu = document.createElement('div');
      menu.className = 'text-corrector-menu';
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-modal', 'true');
      menu.setAttribute('aria-labelledby', 'corrector-title');
      menu.setAttribute('aria-describedby', 'corrector-desc corrector-service-note');

      menu.innerHTML = [
        '<div class="corrector-header" title="Maintenir pour déplacer">',
        '  <span class="corrector-title" id="corrector-title">\u270E Correcteur</span>',
        '  <p class="corrector-sr-only" id="corrector-desc">Panneau de correction LanguageTool. Utilisez Tab pour naviguer et Échap pour fermer.</p>',
        '  <div class="corrector-header-actions">',
        '    <button class="corrector-settings-btn" type="button" aria-label="Ouvrir les paramètres" aria-expanded="false" aria-controls="corrector-settings-panel" title="Paramètres">\u2699</button>',
        '    <button class="corrector-close-btn" type="button" aria-label="Fermer le panneau">\u2715</button>',
        '  </div>',
        '</div>',
        '<div class="corrector-settings-panel" id="corrector-settings-panel" hidden>',
        '  <label class="corrector-setting-stack">',
        '    <span id="corrector-mode-label">Mode de correction</span>',
        '    <select class="corrector-setting-mode" aria-labelledby="corrector-mode-label" aria-describedby="corrector-mode-help">',
        '      <option value="chat-lite">Chat</option>',
        '      <option value="balanced">Équilibré</option>',
        '      <option value="strict">Strict</option>',
        '    </select>',
        '    <span class="corrector-mode-help" id="corrector-mode-help"></span>',
        '  </label>',
        '  <label class="corrector-setting-row">',
        '    <input type="checkbox" class="corrector-setting-debug">',
        '    <span>Activer les logs de debug</span>',
        '  </label>',
        '  <button class="corrector-download-logs-btn" type="button">Télécharger les logs</button>',
        '  <div class="corrector-settings-status" role="status" aria-live="polite"></div>',
        '  <label class="corrector-setting-row">',
        '    <input type="checkbox" class="corrector-setting-confirmation">',
        '    <span>Afficher la notification après remplacement</span>',
        '  </label>',
        '</div>',
        '<div class="corrector-section">',
        '  <div class="corrector-label" id="corrector-original-label">Texte sélectionné</div>',
        '  <div class="corrector-original-content" aria-labelledby="corrector-original-label"></div>',
        '</div>',
        '<div class="corrector-section">',
        '  <div class="corrector-label" id="corrector-correction-label">Correction suggérée</div>',
        '  <div class="corrector-correction-content corrector-state corrector-state-loading" role="status" aria-live="polite" aria-atomic="true" aria-labelledby="corrector-correction-label" data-corrector-state="loading">',
        '    <span class="corrector-spinner" aria-hidden="true"></span>',
        '    <span>' + USER_MESSAGES.loading + '</span>',
        '  </div>',
        '</div>',
        '<div class="corrector-service-note" id="corrector-service-note">',
        '  Le texte sélectionné est envoyé à <a href="' + LANGUAGETOOL_ATTRIBUTION_URL + '" target="_blank" rel="noopener noreferrer">LanguageTool</a> pour analyse.',
        '</div>',
        '<div class="corrector-actions">',
        '  <button class="corrector-apply-btn" type="button" aria-label="Appliquer la correction" disabled>Appliquer</button>',
        '  <button class="corrector-copy-btn" type="button" aria-label="Copier la correction" style="display:none">' + USER_MESSAGES.copyFallback + '</button>',
        '  <button class="corrector-cancel-btn" type="button" aria-label="Fermer le panneau">Fermer</button>',
        '</div>',
      ].join('');

      this.cacheMenuRefs(menu);
      const refs = this.menuRefs;
      refs.originalContent.textContent = this.selectedText;
      menu.style.left = `${Math.max(8, x)}px`;
      menu.style.top = `${Math.max(8, y)}px`;

      // Boutons
      refs.applyBtn.addEventListener('click', (e) => {
        const c = e.currentTarget.dataset.corrected;
        if (c) this.applyCorrection(c);
      });
      refs.copyBtn.addEventListener('click', async (e) => {
        const txt = e.currentTarget.dataset.text;
        if (!txt) return;
        const btn = e.currentTarget;
        const copied = await copyTextToClipboard(txt);
        if (!copied) {
          this.showApplyError(USER_MESSAGES.copyFailure);
          return;
        }
        btn.textContent = USER_MESSAGES.copied;
        setTimeout(() => { btn.textContent = USER_MESSAGES.copyFallback; }, COPY_RESET_DELAY_MS);
      });
      const close = () => this.closeMenu();
      refs.cancelBtn.addEventListener('click', close);
      refs.closeBtn.addEventListener('click',  close);
      refs.settingsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.toggleSettingsPanel();
      });
      refs.debugInput.addEventListener('change', (e) => {
        this.setDebugEnabled(e.currentTarget.checked);
      });
      refs.confirmInput.addEventListener('change', (e) => {
        this.setConfirmationEnabled(e.currentTarget.checked);
      });
      refs.modeInput.addEventListener('change', (e) => {
        this.setCorrectionMode(e.currentTarget.value);
      });
      refs.downloadLogsBtn.addEventListener('click', () => downloadLogs());
      menu.addEventListener('keydown', (e) => this.handleMenuKeyDown(e));

      this.ensureUiRoot().appendChild(menu);
      this.menu = menu;
      this.cacheMenuRefs(menu);
      this.resetActionState();
      this.syncSettingsPanel();

      // Drag
      this.makeDraggable(menu);

      requestAnimationFrame(() => {
        this.adjustMenuPosition(menu, true);
        refs.cancelBtn.focus();
      });
    },

    // ─────────────────────────────────────────────
    // Drag & drop + sauvegarde position
    // ─────────────────────────────────────────────
    makeDraggable(menu) {
      const header = this.getMenuRefs()?.header || menu.querySelector('.corrector-header');
      let startX, startY, startLeft, startTop;

      const getPoint = (e) => {
        if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        return { x: e.clientX, y: e.clientY };
      };

      const onMove = (e) => {
        const { x, y } = getPoint(e);
        const dx = x - startX;
        const dy = y - startY;
        const newLeft = Math.max(0, Math.min(startLeft + dx, window.innerWidth  - menu.offsetWidth));
        const newTop  = Math.max(0, Math.min(startTop  + dy, window.innerHeight - menu.offsetHeight));
        menu.style.left = newLeft + 'px';
        menu.style.top  = newTop  + 'px';
        if (e.cancelable) e.preventDefault();
      };

      const detach = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend',  onUp);
        document.removeEventListener('touchcancel', onUp);
      };

      const onUp = () => {
        detach();
        menu.classList.remove('corrector-dragging');
        this.savePosition(parseInt(menu.style.left), parseInt(menu.style.top));
      };

      // Nettoyage si le menu est fermé pendant un drag (évite des listeners fantômes)
      menu._dragCleanup = detach;

      const onStart = (e) => {
        if (e.target.closest('.corrector-close-btn') || e.target.closest('.corrector-settings-btn')) return;
        if (e.touches && e.touches.length > 1) return;
        if (e.cancelable) e.preventDefault();
        const { x, y } = getPoint(e);
        startX    = x;
        startY    = y;
        startLeft = parseInt(menu.style.left) || 0;
        startTop  = parseInt(menu.style.top)  || 0;
        menu.classList.add('corrector-dragging');
        if (e.touches) {
          document.addEventListener('touchmove', onMove, { passive: false });
          document.addEventListener('touchend',  onUp);
          document.addEventListener('touchcancel', onUp);
        } else {
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup',   onUp);
        }
      };

      header.addEventListener('mousedown', onStart);
      header.addEventListener('touchstart', onStart, { passive: false });
    },

    savePosition(x, y) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y })); } catch (_) {}
    },

    loadPosition() {
      try {
        const p = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
      } catch (_) {}
      return null;
    },

    handleMenuKeyDown(e) {
      if (e.key === 'Escape') { this.closeMenu(); return; }
      if (e.key !== 'Tab') return;
      const focusables = this.getFocusableElements(this.menu);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = this.getCurrentFocus();
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    },

    getClampedMenuPosition(menu, x, y) {
      const margin = 8;
      const width = menu.offsetWidth || 360;
      const height = menu.offsetHeight || 0;
      const maxLeft = Math.max(margin, window.innerWidth - width - margin);
      const maxTop = Math.max(margin, window.innerHeight - height - margin);
      return {
        x: Math.max(margin, Math.min(Number.isFinite(x) ? x : margin, maxLeft)),
        y: Math.max(margin, Math.min(Number.isFinite(y) ? y : margin, maxTop)),
      };
    },

    adjustMenuPosition(menu, persist = false) {
      const currentLeft = parseInt(menu.style.left, 10);
      const currentTop = parseInt(menu.style.top, 10);
      const pos = this.getClampedMenuPosition(menu, currentLeft, currentTop);
      menu.style.left = pos.x + 'px';
      menu.style.top = pos.y + 'px';
      if (persist) this.savePosition(pos.x, pos.y);
    },

    tryDraftReactWholeEditorReplacement(editableEl, replacementText, originalEditableText, applyToken, finalize, onNoChange) {
      try {
        const allKeys = Object.getOwnPropertyNames(editableEl);
        // React 16 : __reactInternalInstance$, React 17/18 : __reactFiber$ + __reactProps$.
        const rKey = allKeys.find(k =>
          k.startsWith('__reactFiber') ||
          k.startsWith('__reactInternalInstance') ||
          k.startsWith('__reactProps')
        );
        dbg('fiber: rKey=' + (rKey ? rKey.slice(0, 30) : 'null'));
        if (!rKey) return false;

        const isES = (v) => v && typeof v === 'object' && (
          (typeof v.getSelection === 'function' && typeof v.getCurrentContent === 'function') ||
          (typeof v.get === 'function' && typeof v.merge === 'function' && typeof v.set === 'function')
        );

        let fiber = editableEl[rKey];
        // Si on a attrapé __reactProps, retrouver le Fiber sibling (où vivent memoizedProps).
        if (rKey.startsWith('__reactProps')) {
          const fiberKey = allKeys.find(k => k.startsWith('__reactFiber'));
          if (!fiberKey) return false;
          fiber = editableEl[fiberKey];
        }
        let depth = 0;
        let draftProps = null;

        while (fiber && depth < 300 && !draftProps) {
          const p = fiber.memoizedProps;
          if (p && typeof p === 'object') {
            for (const k of Object.keys(p)) {
              if (isES(p[k])) {
                const onCh = typeof p.onChange === 'function' ? p.onChange
                           : typeof p.onEditorStateChange === 'function' ? p.onEditorStateChange
                           : null;
                if (onCh) {
                  dbg('fiber: editorState prop="' + k + '" at depth=' + depth);
                  draftProps = { editorState: p[k], onChange: onCh };
                  break;
                }
              }
            }
          }

          if (!draftProps) {
            const inst = fiber.stateNode;
            if (inst && typeof inst === 'object' && !(inst instanceof Element) &&
                typeof inst.getEditorKey === 'function' &&
                inst.props && isES(inst.props.editorState) &&
                typeof inst.props.onChange === 'function') {
              dbg('fiber: DraftEditor stateNode at depth=' + depth);
              draftProps = { editorState: inst.props.editorState, onChange: inst.props.onChange };
            }
          }

          if (!draftProps && depth % 50 === 0 && depth > 0) {
            const p2 = fiber.memoizedProps;
            dbg('fiber: depth=' + depth + ' hasOnChange=' + !!(p2 && typeof p2.onChange === 'function'));
          }

          if (!draftProps) { fiber = fiber.return; depth++; }
        }

        dbg('fiber: found=' + !!draftProps + ' depth=' + depth + ' fiberNull=' + !fiber);
        if (!draftProps) return false;

        const { editorState, onChange } = draftProps;
        const getContent = () => editorState.getCurrentContent
          ? editorState.getCurrentContent()
          : editorState.get('currentContent');
        const cs  = getContent();
        const sel = editorState.getSelection ? editorState.getSelection() : editorState.get('selection');
        const CS  = cs.constructor;
        const ES  = editorState.constructor;
        const plainText = typeof cs?.getPlainText === 'function' ? cs.getPlainText('\n') : null;
        const sameText = plainText !== null &&
          normalizeComparableText(plainText) === normalizeComparableText(editableEl.textContent || '');

        dbg('fiber: CS.createFromText=' + typeof CS.createFromText + ' ES.createWithContent=' + typeof ES.createWithContent);

        if (
          !sameText ||
          typeof sel?.merge !== 'function' ||
          typeof CS.createFromText !== 'function' ||
          typeof ES.createWithContent !== 'function' ||
          typeof ES.forceSelection !== 'function'
        ) {
          return false;
        }

        const newContent = CS.createFromText(replacementText);
        const lastBlk    = newContent.getLastBlock ? newContent.getLastBlock()
                         : newContent.get('blockMap').last();
        const blkKey = lastBlk.getKey ? lastBlk.getKey() : lastBlk.get('key');
        const blkLen = lastBlk.getLength ? lastBlk.getLength() : lastBlk.get('text').length;
        const newSel = sel.merge({
          anchorKey: blkKey, anchorOffset: blkLen,
          focusKey:  blkKey, focusOffset:  blkLen,
          hasFocus: true, isBackward: false,
        });
        onChange(ES.forceSelection(ES.createWithContent(newContent), newSel));
        snap('B_draft_content_replaced', editableEl);
        this.scheduleApplyStep(applyToken, () => {
          editableEl.focus();
          if ((editableEl.textContent || '') !== originalEditableText) {
            finalize();
          } else if (typeof onNoChange === 'function') {
            onNoChange();
          } else {
            this.showApplyError(USER_MESSAGES.editorReplacementUnconfirmed);
          }
        }, 80);
        return true;
      } catch (e) {
        dbg('fiber error: ' + e.message + ' | ' + (e.stack || '').slice(0, 100));
        return false;
      }
    },

    planTextControlReplacement(value, start, end, originalText, replacementText) {
      if (typeof value !== 'string') return { ok: false, reason: 'invalid-control-value' };
      if (!Number.isInteger(start) || !Number.isInteger(end)) return { ok: false, reason: 'invalid-selection-offsets' };
      if (start < 0 || end < start || end > value.length) return { ok: false, reason: 'invalid-selection-offsets' };
      if (value.slice(start, end) !== originalText) return { ok: false, reason: 'selection-changed' };
      const nextValue = value.slice(0, start) + replacementText + value.slice(end);
      const caret = start + replacementText.length;
      return { ok: true, value: nextValue, selectionStart: caret, selectionEnd: caret };
    },

    setNativeControlValue(el, value) {
      const win = el?.ownerDocument?.defaultView || window;
      const proto = el?.tagName === 'TEXTAREA'
        ? win.HTMLTextAreaElement?.prototype
        : win.HTMLInputElement?.prototype;
      const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
      if (setter) setter.call(el, value);
      else el.value = value;
    },

    dispatchReplacementBeforeInput(target, text) {
      try {
        if (typeof InputEvent !== 'function') return true;
        return target.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertReplacementText',
          data: text,
        }));
      } catch (_) {
        return true;
      }
    },

    dispatchReplacementInput(target, text) {
      try {
        if (typeof InputEvent === 'function') {
          target.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            inputType: 'insertReplacementText',
            data: text,
          }));
        } else {
          target.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch (_) {
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    },

    focusWithoutScroll(el) {
      if (!el || typeof el.focus !== 'function') return;
      try {
        el.focus({ preventScroll: true });
      } catch (_) {
        el.focus();
      }
    },

    applyControlReplacement(selectionContext, replacementText) {
      if (!this.isControlSelectionValid(selectionContext)) {
        return { ok: false, kind: selectionContext?.kind || 'control', reason: 'selection-changed' };
      }
      const inputEl = selectionContext.el;
      const { start, end, rawText } = selectionContext;
      const originalValue = inputEl.value;
      const plan = this.planTextControlReplacement(originalValue, start, end, rawText, replacementText);
      if (!plan.ok) return { ...plan, kind: selectionContext.kind || 'control' };

      this.focusWithoutScroll(inputEl);
      this.dispatchReplacementBeforeInput(inputEl, replacementText);
      this.setNativeControlValue(inputEl, plan.value);
      if (inputEl.value !== plan.value) {
        this.setNativeControlValue(inputEl, originalValue);
        return { ok: false, kind: selectionContext.kind || 'control', reason: 'field-refused-replacement' };
      }

      try {
        inputEl.setSelectionRange(plan.selectionStart, plan.selectionEnd);
      } catch (_) {}
      this.dispatchReplacementInput(inputEl, replacementText);
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));

      if (inputEl.value !== plan.value) {
        return { ok: false, kind: selectionContext.kind || 'control', reason: 'field-refused-replacement' };
      }

      return {
        ok: true,
        kind: selectionContext.kind || 'control',
        focusEl: inputEl,
        withUndo: true,
        lastApply: { type: 'input', el: inputEl, originalValue, start, end },
      };
    },

    isStaticPageTextReplacementSafe(selectionContext) {
      const range = selectionContext?.range;
      if (!range || !this.isRangeValid(selectionContext)) return false;
      const anchor = range.commonAncestorContainer;
      const el = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
      if (!(el instanceof HTMLElement)) return false;
      if (this.uiHost && (el === this.uiHost || this.uiHost.contains(el))) return false;
      if (this.getEditableRootFromNode(el)) return false;
      if (el.closest('input, textarea, select, option, script, style, noscript, [contenteditable]')) return false;
      return true;
    },

    applyStaticPageTextReplacement(selectionContext, replacementText) {
      if (!this.isStaticPageTextReplacementSafe(selectionContext)) {
        return { ok: false, kind: 'page-text', reason: 'static-range-unverified' };
      }

      const range = selectionContext.range.cloneRange();
      const originalText = range.toString();
      range.deleteContents();
      const textNode = document.createTextNode(replacementText);
      range.insertNode(textNode);
      if (!textNode.isConnected || textNode.nodeValue !== replacementText) {
        return { ok: false, kind: 'page-text', reason: 'static-replacement-unconfirmed' };
      }

      const newRange = document.createRange();
      newRange.setStartAfter(textNode);
      newRange.collapse(true);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(newRange);
      }

      return {
        ok: true,
        kind: 'page-text',
        withUndo: true,
        lastApply: {
          type: 'dom',
          textNode,
          originalText,
          parentNode: textNode.parentNode,
          nextSibling: textNode.nextSibling,
        },
      };
    },

    finishApplySuccess(result) {
      const focusEl = result?.focusEl || null;
      if (result?.lastApply) this.lastApply = result.lastApply;
      this.closeMenu();
      this.focusWithoutScroll(focusEl);
      this.showConfirmation(result?.withUndo !== false);
    },

    getApplyFailureMessage(result) {
      const reason = result?.reason || '';
      if (reason === 'selection-changed') return USER_MESSAGES.selectionChanged;
      if (reason === 'selection-lost') return USER_MESSAGES.selectionLost;
      if (reason === 'field-refused-replacement') return USER_MESSAGES.fieldRefusedReplacement;
      if (reason === 'static-replacement-unconfirmed' || reason === 'static-range-unverified') {
        return USER_MESSAGES.staticReplacementUnconfirmed;
      }
      if (reason === 'editor-partial-replacement-unconfirmed') return USER_MESSAGES.editorPartialReplaceFailure;
      if (reason === 'editor-replacement-unconfirmed') return USER_MESSAGES.editorReplacementUnconfirmed;
      if (reason === 'editor-whole-replacement-failed') return USER_MESSAGES.editorWholeReplaceFailure;
      return USER_MESSAGES.applyGenericFailure;
    },

    async handleApplyFailure(message, correctedText) {
      const refs = this.getMenuRefs();
      if (refs?.copyBtn && correctedText) {
        refs.copyBtn.dataset.text = correctedText;
        refs.copyBtn.style.display = 'inline-block';
      }
      const copied = await copyTextToClipboard(correctedText);
      const fallbackMessage = copied
        ? USER_MESSAGES.replacementCopied
        : USER_MESSAGES.replacementCopyFailure;
      this.showApplyError(fallbackMessage || message || USER_MESSAGES.applyGenericFailure);
    },

    applyCorrectionToSelection(correctedText, selectionContext, applyToken) {
      const replacementText = this.getReplacementText(correctedText);
      if (!selectionContext) {
        return { handled: true, ok: false, kind: 'unknown', reason: 'selection-lost' };
      }

      if (selectionContext.type === 'control') {
        return {
          handled: true,
          ...this.applyControlReplacement(selectionContext, replacementText),
        };
      }

      const range = selectionContext.range || this.selectedRange;
      if (!range) {
        return { handled: true, ok: false, kind: 'unknown', reason: 'selection-lost' };
      }

      const anchor = range.commonAncestorContainer;
      const parent = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
      const editableEl = this.getEditableRootFromNode(parent);
      if (editableEl) {
        return {
          handled: false,
          ok: false,
          kind: 'contenteditable',
          replacementText,
          editableEl,
          applyToken,
        };
      }

      return {
        handled: true,
        ...this.applyStaticPageTextReplacement(selectionContext, replacementText),
      };
    },

    // ─────────────────────────────────────────────
    // Remplacement du texte
    // 3 stratégies selon le type d'élément cible
    // ─────────────────────────────────────────────
    applyCorrection(corrected) {
      if (!this.selectionSource) {
        void this.handleApplyFailure(USER_MESSAGES.selectionLost, corrected);
        return;
      }

      this.clearApplyError();
      const applyToken = this.beginApplyFlow();

      try {
        const result = this.applyCorrectionToSelection(corrected, this.selectionSource, applyToken);
        const replacementText = result.replacementText || this.getReplacementText(corrected);
        if (result.handled) {
          if (result.ok) this.finishApplySuccess(result);
          else void this.handleApplyFailure(this.getApplyFailureMessage(result), corrected);
          return;
        }

        if (!this.selectedRange) {
          void this.handleApplyFailure(USER_MESSAGES.selectionLost, corrected);
          return;
        }

        const anchor = this.selectedRange.commonAncestorContainer;
        const parent = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
        const sel    = window.getSelection();

        // ── Cas 2 : contenteditable ─────────────────
        const editableEl = this.getEditableRootFromNode(parent);
        if (editableEl) {
          snap('A_avant_tout', editableEl);
          if (!this.isRangeValid()) {
            void this.handleApplyFailure(USER_MESSAGES.selectionChanged, corrected);
            return;
          }
          if (debugEnabled) {
            watchMutations(editableEl, 8000);
            watchKeys(editableEl, 8000);
          }

          const originalEditableText = editableEl.textContent || '';
          const safeWholeReplace = this.selectionMatchesWholeEditable(editableEl);

          const finalize = () => {
            if (!this.isApplyFlowActive(applyToken)) return;
            this.finishApplySuccess({
              lastApply: { type: 'contenteditable' },
              focusEl: editableEl,
              withUndo: false,
            });
            snap('E_apres_closeMenu', editableEl);
          };

          const failEditableApply = () => {
            if (!this.isApplyFlowActive(applyToken)) return;
            void this.handleApplyFailure(
              safeWholeReplace
                ? USER_MESSAGES.editorWholeReplaceFailure
                : USER_MESSAGES.editorPartialReplaceFailure,
              corrected
            );
          };

          const performEditableInsert = (prefix, onNoChange) => {
            const finishAttempt = (label) => {
              this.scheduleApplyStep(applyToken, () => {
                snap(label, editableEl);
                if ((editableEl.textContent || '') !== originalEditableText) {
                  finalize();
                } else if (typeof onNoChange === 'function') {
                  onNoChange();
                } else {
                  failEditableApply();
                }
              }, 30);
            };

            snap(`${prefix}_avant_beforeinput`, editableEl);
            let beforeInputHandled = false;
            try {
              const beforeEvt = new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: replacementText,
              });
              beforeInputHandled = !editableEl.dispatchEvent(beforeEvt);
              snap(`${prefix}_beforeinput_handled=${beforeInputHandled}`, editableEl);
            } catch (err) {
              dbg(`${prefix} beforeinput error: ${err.message}`);
            }

            if (beforeInputHandled) {
              finishAttempt(`${prefix}_apres_beforeinput`);
              return;
            }

            const insertViaRange = (txt) => {
              try {
                const sel = window.getSelection();
                if (!sel || sel.rangeCount === 0) return false;
                const range = sel.getRangeAt(0);
                range.deleteContents();
                const node = document.createTextNode(txt);
                range.insertNode(node);
                range.setStartAfter(node);
                range.setEndAfter(node);
                sel.removeAllRanges();
                sel.addRange(range);
                editableEl.dispatchEvent(new InputEvent('input', {
                  bubbles: true,
                  cancelable: false,
                  inputType: 'insertText',
                  data: txt,
                }));
                return true;
              } catch (_) {
                return false;
              }
            };

            let execOk = insertViaRange(replacementText);
            if (!execOk && typeof document.execCommand === 'function') {
              try { execOk = document.execCommand('insertText', false, replacementText); } catch (_) {}
            }
            snap(`${prefix}_exec_ok=${execOk}`, editableEl);
            if (execOk) {
              finishAttempt(`${prefix}_apres_exec`);
              return;
            }

            try {
              const dt = new DataTransfer();
              dt.setData('text/plain', replacementText);
              const pasteEvt = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: dt,
              });
              const pasteHandled = !editableEl.dispatchEvent(pasteEvt);
              snap(`${prefix}_paste_handled=${pasteHandled}`, editableEl);
            } catch (err) {
              dbg(`${prefix} paste error: ${err.message}`);
            }

            finishAttempt(`${prefix}_apres_fallbacks`);
          };

          const runWholeEditorFallback = () => {
            if (!safeWholeReplace) {
              failEditableApply();
              return;
            }
            editableEl.focus();
            snap('C_focus_full', editableEl);
            this.scheduleApplyStep(applyToken, () => {
              document.execCommand('selectAll');
              snap('C_selectAll_full', editableEl);
              this.scheduleApplyStep(applyToken, () => performEditableInsert('C_full'), 25);
            }, 30);
          };

          // ── Stratégie A : fiber React → remplacement direct du ContentState ──
          if (
            safeWholeReplace &&
            this.tryDraftReactWholeEditorReplacement(
              editableEl,
              replacementText,
              originalEditableText,
              applyToken,
              finalize,
              runWholeEditorFallback
            )
          ) {
            return;
          }

          // ── Stratégie B : restaurer la vraie sélection puis beforeinput ────────
          editableEl.focus();
          snap('B_focus_done', editableEl);
          this.scheduleApplyStep(applyToken, () => {
            const restored = this.restoreSavedRangeSelection(this.selectionSource);
            snap('B2_restore_selection=' + restored, editableEl);
            if (!restored) {
              runWholeEditorFallback();
              return;
            }
            this.scheduleApplyStep(applyToken, () => {
              performEditableInsert('B_selection', safeWholeReplace ? runWholeEditorFallback : null);
            }, 25);
          }, 30);
          return;
        }

        // ── Cas 3 : DOM statique (span, p, div…) ───
        if (!this.isRangeValid()) {
          this.showApplyError(USER_MESSAGES.selectionChanged);
          return;
        }
        const originalText = this.selectedRange.toString();
        this.selectedRange.deleteContents();
        const textNode = document.createTextNode(replacementText);
        this.selectedRange.insertNode(textNode);
        if (!textNode.isConnected || textNode.nodeValue !== replacementText) {
          this.showApplyError(USER_MESSAGES.staticReplacementUnconfirmed);
          return;
        }

        const newRange = document.createRange();
        newRange.setStartAfter(textNode);
        newRange.collapse(true);
        if (sel) { sel.removeAllRanges(); sel.addRange(newRange); }

        this.lastApply = {
          type: 'dom', textNode, originalText,
          parentNode: textNode.parentNode, nextSibling: textNode.nextSibling,
        };
        this.closeMenu();
        this.showConfirmation(true);

      } catch (err) {
        console.error('[Correcteur]', err);
        void this.handleApplyFailure(USER_MESSAGES.applyGenericFailure, corrected);
      }
    },

    undoLastApply() {
      if (!this.lastApply) return;
      const { type } = this.lastApply;
      try {
        if (type === 'input') {
          const { el, originalValue, start, end } = this.lastApply;
          this.setNativeControlValue(el, originalValue);
          el.setSelectionRange(start, end);
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.focus();
        } else if (type === 'dom') {
          const { textNode, originalText, parentNode, nextSibling } = this.lastApply;
          const original = document.createTextNode(originalText);
          if (textNode.parentNode) {
            textNode.parentNode.replaceChild(original, textNode);
          } else if (parentNode) {
            parentNode.insertBefore(original, nextSibling || null);
          }
        }
      } catch (err) {
        console.error('[Correcteur] Undo échoué :', err);
      }
      this.lastApply = null;
    },

    // Affiche une erreur inline dans le panneau (sans le fermer)
    showApplyError(msg) {
      const refs = this.getMenuRefs();
      if (!refs) return;
      let errEl = refs.applyError;
      if (!errEl) {
        errEl = document.createElement('div');
        errEl.className = 'corrector-apply-error';
        const actions = refs.actions;
        actions.parentNode.insertBefore(errEl, actions);
        refs.applyError = errEl;
      }
      errEl.textContent = '\u26A0\uFE0F ' + msg;
      if (refs.copyBtn?.dataset.text) refs.copyBtn.style.display = 'inline-block';
    },

    showConfirmation(withUndo) {
      if (!confirmationEnabled) return;
      const toast = document.createElement('div');
      toast.className = 'corrector-toast';
      toast.setAttribute('role', 'status');

      const msgSpan = document.createElement('span');
      msgSpan.textContent = '\u2713 Correction appliquée';
      toast.appendChild(msgSpan);

      if (withUndo) {
        const undoBtn = document.createElement('button');
        undoBtn.className   = 'corrector-toast-undo';
        undoBtn.type        = 'button';
        undoBtn.setAttribute('aria-label', 'Annuler le remplacement');
        undoBtn.textContent = 'Annuler';
        undoBtn.addEventListener('click', () => { this.undoLastApply(); toast.remove(); });
        toast.appendChild(undoBtn);
      }

      this.ensureUiRoot().appendChild(toast);

      let fadeTimer = setTimeout(() => {
        toast.classList.add('corrector-toast-fade');
        setTimeout(() => toast.remove(), 400);
      }, 3000);

      // Pause le fade si la souris survole (pour laisser le temps de cliquer "Annuler")
      toast.addEventListener('mouseenter', () => clearTimeout(fadeTimer));
      toast.addEventListener('mouseleave', () => {
        fadeTimer = setTimeout(() => {
          toast.classList.add('corrector-toast-fade');
          setTimeout(() => toast.remove(), 400);
        }, 1200);
      });
    },

    // ─────────────────────────────────────────────
    // Événements globaux
    // ─────────────────────────────────────────────
    handleOutsideClick(e) {
      if (this.isUiEvent(e)) return;
      if (this.menu) this.closeMenu();
    },

    handleKeyDown(e) {
      if (e.key === 'Escape') { this.hidePill(); if (this.menu) this.closeMenu(); }
    },

    closeMenu() {
      this._correctionRequestToken += 1;
      this.abortCurrentRequest();
      this.cancelPendingApplyFlow();
      if (this.menu) {
        if (typeof this.menu._dragCleanup === 'function') this.menu._dragCleanup();
        this.menu.remove();
        this.menu = null;
        this.menuRefs = null;
        if (this.previousFocus && typeof this.previousFocus.focus === 'function') this.previousFocus.focus();
        this.previousFocus = null;
        this.selectedText = '';
        this.selectedRawText = '';
        this.selectedRange = null;
        this.savedInputSel = null;
        this.selectionPadding = { leading: '', trailing: '' };
        this.selectionSource = null;
      }
    },

    // ─────────────────────────────────────────────
    // Styles CSS
    // ─────────────────────────────────────────────
    injectStyles(root = this.uiRoot) {
      if (!root) return;
      if (this.styleEl?.isConnected) this.styleEl.remove();
      root.getElementById?.('corrector-shadow-styles')?.remove();
      const style = document.createElement('style');
      style.id = 'corrector-shadow-styles';
      this.styleEl = style;
      style.textContent = `
        @keyframes corrector-pop  { from{opacity:0;transform:scale(.93) translateY(-6px)} to{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes corrector-spin { to{transform:rotate(360deg)} }

        /* ── Bulle ── */
        .corrector-pill {
          position: fixed;
          z-index: 2147483647;
          background: #18181b;
          color: #fff;
          border: none;
          border-radius: 999px;
          padding: 5px 14px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          box-shadow: 0 4px 16px rgba(0,0,0,.35);
          animation: corrector-pop .14s ease-out;
          white-space: nowrap;
          transition: background .15s, transform .1s;
          user-select: none;
        }
        .corrector-pill:hover  { background: #2563eb; transform: translateY(-1px); }
        .corrector-pill:active { transform: translateY(0); }
        .corrector-pill:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
        .corrector-pill::after {
          content: '';
          position: absolute;
          bottom: -5px; left: 50%;
          transform: translateX(-50%);
          border: 5px solid transparent;
          border-top-color: #18181b;
          border-bottom: none;
        }
        .corrector-pill:hover::after { border-top-color: #2563eb; }

        /* ── Panneau ── */
        .text-corrector-menu {
          position: fixed;
          background: #fff;
          border: 1.5px solid #d1d5db;
          border-radius: 12px;
          padding: 0;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          font-size: 13px;
          box-shadow: 0 10px 30px rgba(0,0,0,.15);
          width: 360px;
          max-width: calc(100vw - 16px);
          max-height: calc(100vh - 16px);
          color: #111;
          animation: corrector-pop .15s ease-out;
          overflow: auto;
        }

        .text-corrector-menu .corrector-apply-btn:focus-visible,
        .text-corrector-menu .corrector-cancel-btn:focus-visible,
        .text-corrector-menu .corrector-copy-btn:focus-visible,
        .text-corrector-menu .corrector-retry-btn:focus-visible,
        .text-corrector-menu .corrector-close-btn:focus-visible,
        .text-corrector-menu .corrector-settings-btn:focus-visible,
        .text-corrector-menu .corrector-toast-undo:focus-visible,
        .text-corrector-menu .corrector-download-logs-btn:focus-visible {
          outline: 2px solid #2563eb;
          outline-offset: 2px;
          border-radius: 6px;
        }

        /* Header = poignée de drag */
        .corrector-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 8px;
          background: #f9fafb;
          border-bottom: 1px solid #e5e7eb;
          cursor: grab;
          user-select: none;
        }
        .corrector-dragging .corrector-header { cursor: grabbing; }
        .corrector-header { touch-action: none; }
        .corrector-title {
          font-weight: 700;
          font-size: 13px;
          color: #1d4ed8;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .corrector-header-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .corrector-badge {
          font-size: 11px;
          background: #ef4444;
          color: #fff;
          border-radius: 999px;
          padding: 1px 7px;
          font-weight: 600;
        }
        .corrector-settings-btn,
        .corrector-close-btn {
          background: none; border: none; cursor: pointer;
          font-size: 15px; color: #9ca3af; border-radius: 6px;
          padding: 2px 6px; line-height: 1;
          transition: background .15s, color .15s;
        }
        .corrector-settings-btn:hover,
        .corrector-close-btn:hover { background: #f3f4f6; color: #374151; }

        .corrector-settings-panel {
          padding: 10px 14px 12px;
          background: #fff7ed;
          border-bottom: 1px solid #fed7aa;
          display: grid;
          gap: 10px;
        }
        .corrector-settings-panel[hidden] { display: none; }
        .corrector-setting-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: #7c2d12;
        }
        .corrector-setting-stack {
          display: grid;
          gap: 6px;
          font-size: 12px;
          color: #7c2d12;
        }
        .corrector-setting-row input { margin: 0; }
        .corrector-setting-mode {
          cursor: pointer;
          border: 1px solid #fdba74;
          border-radius: 6px;
          background: #fff;
          color: #7c2d12;
          padding: 6px 8px;
          font-size: 12px;
          font-weight: 600;
        }
        .corrector-mode-help {
          font-size: 11px;
          line-height: 1.4;
          color: #9a3412;
        }
        .corrector-settings-status {
          font-size: 11px;
          line-height: 1.4;
          color: #9a3412;
        }
        .corrector-download-logs-btn {
          cursor: pointer;
          padding: 6px 10px;
          border: 1px solid #f59e0b;
          background: #fff;
          color: #b45309;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 600;
          justify-self: start;
          transition: background .15s, color .15s, border-color .15s;
        }
        .corrector-download-logs-btn:hover:not(:disabled) {
          background: #f59e0b;
          color: #fff;
        }
        .corrector-download-logs-btn:disabled {
          cursor: default;
          opacity: .55;
        }

        .corrector-section { padding: 10px 14px 0; }
        .corrector-label {
          font-size: 10px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .06em; color: #9ca3af; margin-bottom: 5px;
        }

        /* Zones texte */
        .corrector-original-content,
        .corrector-correction-content {
          border-radius: 7px;
          padding: 8px 10px;
          max-height: 90px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
          line-height: 1.6;
          font-size: 13px;
        }
        .corrector-original-content {
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          color: #6b7280;
          font-style: italic;
        }
        .corrector-correction-content {
          background: #eff6ff;
          border: 1px solid #bfdbfe;
          color: #1e40af;
          min-height: 38px;
        }

        /* Spinner inline */
        .corrector-spinner {
          display: inline-block;
          width: 12px; height: 12px;
          border: 2px solid #bfdbfe;
          border-top-color: #1d4ed8;
          border-radius: 50%;
          animation: corrector-spin .7s linear infinite;
          vertical-align: middle;
          margin-right: 6px;
        }

        /* Diff highlights */
        .corrector-error {
          background: #fee2e2; color: #b91c1c;
          border-radius: 3px;
          text-decoration: underline wavy #ef4444;
          padding: 0 2px; cursor: help;
        }
        .corrector-fix {
          background: #dcfce7; color: #15803d;
          border-radius: 3px; font-weight: 700; padding: 0 2px;
        }
        .corrector-ok { color: #15803d; font-weight: 600; }

        /* Bouton réessayer dans la zone correction */
        .corrector-retry-btn {
          cursor: pointer; padding: 2px 10px; border: none;
          background: #2563eb; color: #fff; border-radius: 4px;
          font-size: 12px; font-weight: 600; vertical-align: middle;
          transition: background .15s;
        }
        .corrector-retry-btn:hover { background: #1d4ed8; }

        .corrector-service-note {
          padding: 8px 14px 0;
          font-size: 11px;
          line-height: 1.4;
          color: #6b7280;
        }
        .corrector-service-note a {
          color: #2563eb;
          text-decoration: underline;
          text-underline-offset: 2px;
        }

        /* Actions */
        .corrector-actions {
          display: flex; gap: 8px;
          padding: 10px 14px 12px;
          align-items: center;
          border-top: 1px solid #f3f4f6;
          margin-top: 10px;
        }
        .corrector-apply-btn {
          cursor: pointer; padding: 6px 16px; border: none;
          background: #2563eb; color: #fff; border-radius: 6px;
          font-size: 13px; font-weight: 600;
          transition: background .15s, transform .1s;
        }
        .corrector-apply-btn:hover:not(:disabled)  { background: #1d4ed8; transform: translateY(-1px); }
        .corrector-apply-btn:active:not(:disabled) { transform: translateY(0); }
        .corrector-apply-btn:disabled { background: #d1d5db; color: #9ca3af; cursor: default; }

        .corrector-copy-btn {
          cursor: pointer; padding: 6px 14px;
          border: 1.5px solid #16a34a; background: transparent;
          color: #16a34a; border-radius: 6px; font-size: 13px;
          transition: background .15s, color .15s;
        }
        .corrector-copy-btn:hover { background: #16a34a; color: #fff; }

        .corrector-cancel-btn {
          cursor: pointer; padding: 6px 14px;
          border: 1.5px solid #e5e7eb; background: #f9fafb;
          color: #374151; border-radius: 6px; font-size: 13px;
          transition: background .15s; margin-left: auto;
        }
        .corrector-cancel-btn:hover { background: #f3f4f6; }

        /* Dark mode */
        @media (prefers-color-scheme: dark) {
          .text-corrector-menu          { background:#18181b; border-color:#3f3f46; color:#f4f4f5; }
          .corrector-header             { background:#27272a; border-color:#3f3f46; }
          .corrector-title              { color:#60a5fa; }
          .corrector-settings-btn,
          .corrector-close-btn          { color:#71717a; }
          .corrector-settings-btn:hover,
          .corrector-close-btn:hover    { background:#3f3f46; color:#f4f4f5; }
          .corrector-settings-panel     { background:#2b2116; border-color:#713f12; }
          .corrector-setting-row,
          .corrector-setting-stack      { color:#fdba74; }
          .corrector-setting-mode       { background:#18181b; border-color:#f59e0b; color:#fbbf24; }
          .corrector-mode-help,
          .corrector-settings-status    { color:#fb923c; }
          .corrector-download-logs-btn  { background:#18181b; border-color:#f59e0b; color:#fbbf24; }
          .corrector-download-logs-btn:hover:not(:disabled) { background:#f59e0b; color:#18181b; }
          .corrector-label              { color:#71717a; }
          .corrector-original-content   { background:#27272a; border-color:#3f3f46; color:#a1a1aa; }
          .corrector-correction-content { background:#1e3a5f; border-color:#1d4ed8; color:#93c5fd; }
          .corrector-service-note       { color:#a1a1aa; }
          .corrector-service-note a     { color:#93c5fd; }
          .corrector-cancel-btn         { background:#27272a; border-color:#3f3f46; color:#d4d4d8; }
          .corrector-cancel-btn:hover   { background:#3f3f46; }
          .corrector-actions            { border-color:#3f3f46; }
        }

        /* Erreur inline appliquer */
        .corrector-apply-error {
          margin: 0 14px 8px;
          padding: 7px 10px;
          background: #fef2f2;
          border: 1px solid #fecaca;
          border-radius: 6px;
          font-size: 12px;
          color: #b91c1c;
          line-height: 1.4;
        }

        /* Toast */
        .corrector-toast {
          position: fixed; bottom: 24px; right: 24px;
          background: #16a34a; color: #fff;
          padding: 10px 16px; border-radius: 8px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          font-size: 13px; font-weight: 600;
          z-index: 2147483647;
          box-shadow: 0 4px 14px rgba(0,0,0,.2);
          display: flex; align-items: center; gap: 10px;
          transition: opacity .4s, transform .4s;
          animation: corrector-pop .2s ease-out;
        }
        .corrector-toast-fade { opacity: 0; transform: translateY(8px); }
        .corrector-toast-undo {
          background: rgba(255,255,255,.25); border: none; color: #fff;
          padding: 2px 10px; border-radius: 4px; cursor: pointer;
          font-size: 12px; font-weight: 700;
          transition: background .15s;
        }
        .corrector-toast-undo:hover { background: rgba(255,255,255,.4); }

        @media (prefers-color-scheme: dark) {
          .corrector-toast { background: #15803d; }
        }

        @media (max-width: 420px) {
          .text-corrector-menu {
            width: calc(100vw - 16px);
            left: 8px !important;
            right: auto;
          }
          .corrector-original-content,
          .corrector-correction-content {
            max-height: 120px;
          }
          .corrector-actions {
            flex-wrap: wrap;
          }
          .corrector-apply-btn,
          .corrector-copy-btn,
          .corrector-cancel-btn {
            flex: 1 1 110px;
            text-align: center;
          }
          .corrector-cancel-btn {
            margin-left: 0;
          }
        }

        /* UI v4.8 isolated Shadow DOM polish */
        :host {
          all: initial;
          color-scheme: light dark;
          --tc-font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          --tc-surface: #ffffff;
          --tc-surface-muted: #f6f7f9;
          --tc-text: #171717;
          --tc-muted: #5f6673;
          --tc-soft: #eef1f5;
          --tc-border: #d9dee7;
          --tc-accent: #1f6feb;
          --tc-accent-strong: #174ea6;
          --tc-accent-soft: #e8f1ff;
          --tc-success: #17803d;
          --tc-success-soft: #e8f7ee;
          --tc-danger: #b42318;
          --tc-danger-soft: #fff0ee;
          --tc-warning: #a15c07;
          --tc-warning-soft: #fff7e8;
          --tc-shadow: 0 18px 48px rgba(15, 23, 42, .18), 0 2px 8px rgba(15, 23, 42, .08);
          --tc-radius: 8px;
          font-family: var(--tc-font);
        }
        *,
        *::before,
        *::after {
          box-sizing: border-box;
          letter-spacing: 0;
        }
        .corrector-pill,
        .text-corrector-menu,
        .corrector-toast {
          pointer-events: auto;
          font-family: var(--tc-font);
        }
        .corrector-sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        .corrector-pill {
          min-height: 36px;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          z-index: 1;
          background: #16181d;
          border: 1px solid rgba(255, 255, 255, .12);
          padding: 7px 13px;
          font-size: 12px;
          font-weight: 700;
          line-height: 1;
          box-shadow: 0 10px 26px rgba(0, 0, 0, .26);
          transition: background .15s ease, transform .12s ease, box-shadow .15s ease;
        }
        .corrector-pill::after { display: none; }
        .corrector-pill:hover {
          background: var(--tc-accent);
          box-shadow: 0 14px 30px rgba(31, 111, 235, .28);
        }
        .corrector-pill:focus-visible,
        .text-corrector-menu button:focus-visible,
        .text-corrector-menu select:focus-visible,
        .text-corrector-menu input:focus-visible,
        .corrector-toast button:focus-visible {
          outline: 3px solid rgba(31, 111, 235, .45);
          outline-offset: 2px;
          box-shadow: 0 0 0 1px var(--tc-accent);
        }
        .text-corrector-menu {
          z-index: 1;
          width: min(390px, calc(100vw - 16px));
          background: var(--tc-surface);
          color: var(--tc-text);
          border: 1px solid var(--tc-border);
          border-radius: var(--tc-radius);
          box-shadow: var(--tc-shadow);
          line-height: 1.45;
        }
        .corrector-header {
          min-height: 44px;
          padding: 10px 12px;
          background: var(--tc-surface-muted);
          border-bottom: 1px solid var(--tc-border);
        }
        .corrector-title {
          min-width: 0;
          color: var(--tc-accent-strong);
          font-weight: 800;
        }
        .corrector-badge {
          background: var(--tc-danger);
          padding: 2px 7px;
          font-weight: 700;
        }
        .corrector-settings-btn,
        .corrector-close-btn {
          width: 30px;
          height: 30px;
          display: inline-grid;
          place-items: center;
          border: 1px solid transparent;
          border-radius: 7px;
          color: var(--tc-muted);
        }
        .corrector-settings-btn:hover,
        .corrector-close-btn:hover {
          background: var(--tc-soft);
          color: var(--tc-text);
          border-color: var(--tc-border);
        }
        .corrector-settings-panel {
          padding: 12px;
          background: var(--tc-warning-soft);
          border-bottom: 1px solid #f0c26b;
        }
        .corrector-setting-row,
        .corrector-setting-stack {
          color: #6f3a04;
        }
        .corrector-setting-mode {
          border: 1px solid #d88922;
          border-radius: 7px;
          color: #5d3204;
          font-weight: 700;
        }
        .corrector-mode-help,
        .corrector-settings-status {
          color: #794606;
        }
        .corrector-download-logs-btn {
          border: 1px solid #c77712;
          border-radius: 7px;
          color: #7a4204;
          font-weight: 700;
        }
        .corrector-download-logs-btn:hover:not(:disabled) {
          background: #c77712;
        }
        .corrector-section {
          padding: 11px 12px 0;
        }
        .corrector-label {
          margin-bottom: 6px;
          color: var(--tc-muted);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0;
        }
        .corrector-original-content,
        .corrector-correction-content {
          border-radius: 7px;
          padding: 9px 10px;
          max-height: 104px;
          line-height: 1.55;
          scrollbar-width: thin;
        }
        .corrector-original-content {
          background: var(--tc-surface-muted);
          border-color: var(--tc-border);
          color: var(--tc-muted);
        }
        .corrector-correction-content {
          min-height: 42px;
          background: var(--tc-accent-soft);
          border-color: #bdd7ff;
          color: #124284;
        }
        .corrector-state-loading,
        .corrector-state-error,
        .corrector-state-success {
          display: flex;
          align-items: flex-start;
          gap: 8px;
        }
        .corrector-state-ready {
          display: block;
        }
        .corrector-state-error {
          background: var(--tc-danger-soft);
          border-color: #f3b2aa;
          color: var(--tc-danger);
        }
        .corrector-state-limit,
        .corrector-state-rate-limit,
        .corrector-state-timeout {
          background: var(--tc-warning-soft);
          border-color: #e8b95d;
          color: var(--tc-warning);
        }
        .corrector-state-network {
          background: #f2f4f8;
          border-color: #c9d2df;
          color: #334155;
        }
        .corrector-state-success {
          background: var(--tc-success-soft);
          border-color: #9bd8ad;
          color: var(--tc-success);
        }
        .corrector-state-text {
          flex: 1 1 auto;
          min-width: 0;
        }
        .corrector-spinner {
          flex: 0 0 auto;
          width: 14px;
          height: 14px;
          margin: 2px 0 0;
          border-color: #bdd7ff;
          border-top-color: var(--tc-accent);
        }
        .corrector-error {
          background: #ffe1de;
          color: var(--tc-danger);
          border: 1px solid #f3b2aa;
          border-radius: 4px;
          text-decoration: underline wavy #d92d20;
          text-decoration-thickness: 1px;
          padding: 0 3px;
        }
        .corrector-fix {
          background: #dff7e7;
          color: #0f6c35;
          border: 1px solid #93d8a8;
          border-radius: 4px;
          font-weight: 800;
          padding: 0 3px;
        }
        .corrector-removed,
        .corrector-added {
          box-decoration-break: clone;
          -webkit-box-decoration-break: clone;
        }
        .corrector-ok {
          color: var(--tc-success);
          font-weight: 800;
        }
        .corrector-retry-btn {
          flex: 0 0 auto;
          padding: 4px 10px;
          border: 1px solid var(--tc-accent);
          background: var(--tc-accent);
          border-radius: 6px;
          font-weight: 800;
        }
        .corrector-retry-btn:hover {
          background: var(--tc-accent-strong);
          border-color: var(--tc-accent-strong);
        }
        .corrector-service-note {
          padding: 9px 12px 0;
          color: var(--tc-muted);
        }
        .corrector-service-note a {
          color: var(--tc-accent);
        }
        .corrector-actions {
          padding: 12px;
          border-top: 1px solid var(--tc-soft);
          margin-top: 11px;
        }
        .corrector-apply-btn,
        .corrector-copy-btn,
        .corrector-cancel-btn {
          min-height: 34px;
          border-radius: 7px;
          font-weight: 800;
          line-height: 1;
        }
        .corrector-apply-btn {
          padding: 8px 15px;
          border: 1px solid var(--tc-accent);
          background: var(--tc-accent);
        }
        .corrector-apply-btn:hover:not(:disabled) {
          background: var(--tc-accent-strong);
          border-color: var(--tc-accent-strong);
        }
        .corrector-apply-btn:disabled {
          background: var(--tc-soft);
          border-color: var(--tc-border);
          color: #89909d;
        }
        .corrector-copy-btn {
          padding: 8px 13px;
          border: 1px solid var(--tc-success);
          color: var(--tc-success);
        }
        .corrector-copy-btn:hover {
          background: var(--tc-success);
          color: #ffffff;
        }
        .corrector-cancel-btn {
          padding: 8px 13px;
          border: 1px solid var(--tc-border);
          background: var(--tc-surface-muted);
          color: var(--tc-text);
        }
        .corrector-cancel-btn:hover { background: var(--tc-soft); }
        .corrector-apply-error {
          margin: 0 12px 8px;
          padding: 8px 10px;
          background: var(--tc-danger-soft);
          border: 1px solid #f3b2aa;
          border-radius: 7px;
          color: var(--tc-danger);
        }
        .corrector-toast {
          right: 16px;
          bottom: 16px;
          z-index: 1;
          max-width: calc(100vw - 32px);
          padding: 10px 13px;
          border-radius: var(--tc-radius);
          background: var(--tc-success);
          font-weight: 800;
          box-shadow: var(--tc-shadow);
          transition: opacity .25s ease, transform .25s ease;
        }
        .corrector-toast-undo {
          border: 1px solid rgba(255, 255, 255, .48);
          background: rgba(255, 255, 255, .18);
          padding: 5px 10px;
          border-radius: 6px;
          font-weight: 800;
        }
        .corrector-toast-undo:hover {
          background: rgba(255, 255, 255, .32);
        }
        @media (max-width: 420px) {
          .corrector-pill {
            max-width: calc(100vw - 16px);
            min-height: 38px;
            padding-inline: 12px;
          }
          .corrector-pill::after { display: none; }
        }
        @media (prefers-color-scheme: dark) {
          :host {
            --tc-surface: #171a1f;
            --tc-surface-muted: #20242b;
            --tc-text: #f5f7fb;
            --tc-muted: #aab3c2;
            --tc-soft: #2a3039;
            --tc-border: #394250;
            --tc-accent: #6aa7ff;
            --tc-accent-strong: #9bc2ff;
            --tc-accent-soft: #182f52;
            --tc-success: #55c27a;
            --tc-success-soft: #173822;
            --tc-danger: #ff8a80;
            --tc-danger-soft: #401f1d;
            --tc-warning: #f5b95f;
            --tc-warning-soft: #3b2a11;
            --tc-shadow: 0 18px 52px rgba(0, 0, 0, .42), 0 2px 10px rgba(0, 0, 0, .26);
          }
          .corrector-pill {
            background: #f5f7fb;
            color: #141820;
            border-color: rgba(20, 24, 32, .15);
          }
          .corrector-pill:hover {
            background: var(--tc-accent);
            color: #08111f;
          }
          .corrector-title { color: var(--tc-accent-strong); }
          .corrector-settings-panel { border-color: #7a5520; }
          .corrector-setting-row,
          .corrector-setting-stack,
          .corrector-mode-help,
          .corrector-settings-status { color: #f6c77b; }
          .corrector-setting-mode,
          .corrector-download-logs-btn {
            background: #171a1f;
            border-color: #b7791f;
            color: #f6c77b;
          }
          .corrector-download-logs-btn:hover:not(:disabled) {
            background: #d89225;
            color: #171a1f;
          }
          .corrector-correction-content {
            border-color: #3569a8;
            color: #c7ddff;
          }
          .corrector-state-error { border-color: #7a3833; }
          .corrector-state-limit,
          .corrector-state-rate-limit,
          .corrector-state-timeout { border-color: #7a5520; }
          .corrector-state-network {
            background: #20242b;
            border-color: #394250;
            color: #d5dbe7;
          }
          .corrector-state-success { border-color: #2c7542; }
          .corrector-original-content { color: #bec6d4; }
          .corrector-error {
            background: #4a2320;
            border-color: #8d4038;
            color: #ffb2aa;
          }
          .corrector-fix {
            background: #193d27;
            border-color: #39804d;
            color: #9ee6b6;
          }
          .corrector-service-note a { color: #9bc2ff; }
          .corrector-apply-btn:disabled {
            color: #8791a1;
            background: #2a3039;
            border-color: #394250;
          }
          .corrector-cancel-btn {
            background: #20242b;
            color: #f5f7fb;
          }
          .corrector-cancel-btn:hover { background: #2a3039; }
          .corrector-apply-error { border-color: #7a3833; }
        }
        @media (prefers-reduced-motion: reduce) {
          .corrector-pill,
          .text-corrector-menu,
          .corrector-toast,
          .corrector-spinner {
            animation: none;
            transition: none;
          }
        }
      `;
      root.appendChild(style);
    }
  };

  TextCorrector.init();
})();
