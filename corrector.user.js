// ==UserScript==
// @name           Correcteur de Phrases
// @namespace      http://violetmonkey.net/
// @version        4.6.2
// @description    Corrige automatiquement les phrases sélectionnées via LanguageTool
// @author         Matteo12SA
// @match          *://*/*
// @noframes
// @updateURL      https://raw.githubusercontent.com/MATTEO12SA/correcteur-violetmonkey/main/corrector.user.js
// @downloadURL    https://raw.githubusercontent.com/MATTEO12SA/correcteur-violetmonkey/main/corrector.user.js
// @grant          GM_xmlhttpRequest
// @connect        api.languagetoolplus.com
// @run-at         document-end
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = '__corrector_v4_pos';
  const DEBUG_STORAGE_KEY = '__corrector_debug';
  const CONFIRMATION_STORAGE_KEY = '__corrector_confirmation';
  const CORRECTION_MODE_STORAGE_KEY = '__corrector_mode';
  const NAV_EVENT = '_corrector_nav';
  const HISTORY_PATCH_FLAG = '__corrector_history_patched';
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password']);
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
    previousFocus:  null,
    lastApply:      null,   // données pour le bouton Annuler
    _selChangeTid:  null,
    _styleObserver: null,
    _pillSelectionContext: null,
    correctionCache: new Map(),
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
          this.showApplyError('Impossible de remplacer sur ce site. Utilisez "Copier".');
        }
      }, delay);
      this._applyTimeouts.add(timeoutId);
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

    getDomSelectionContext() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const rawText = sel.toString();
      if (!hasMeaningfulSelection(rawText)) return null;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return null;
      return {
        type: 'range',
        text: rawText.trim(),
        rawText,
        range: range.cloneRange(),
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
        text: rawText.trim(),
        rawText,
        el,
        start,
        end,
        rect: el.getBoundingClientRect(),
        padding: getSelectionPadding(rawText),
      };
    },

    getSelectionContext() {
      return this.getDomSelectionContext() || this.getControlSelectionContext();
    },

    getReplacementText(corrected) {
      return `${this.selectionPadding.leading}${corrected}${this.selectionPadding.trailing}`;
    },

    // ─────────────────────────────────────────────
    // Init
    // ─────────────────────────────────────────────
    init() {
      document.addEventListener('mouseup',         (e) => this.handleMouseUp(e));
      document.addEventListener('keyup',           (e) => this.handleKeyUp(e));
      document.addEventListener('selectionchange', ()  => this.handleSelectionChange());
      document.addEventListener('click',           (e) => this.handleOutsideClick(e));
      document.addEventListener('keydown',         (e) => this.handleKeyDown(e));
      window.addEventListener('beforeunload',      ()  => this.closeMenu());
      this.injectStyles();
      this.watchNavigation();
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
        if (this.styleEl && !document.contains(this.styleEl)) this.injectStyles();
      });
      this._styleObserver.observe(document.head || document.documentElement, { childList: true });
    },

    // ─────────────────────────────────────────────
    // Bulle flottante
    // ─────────────────────────────────────────────
    handleMouseUp(e) {
      if (this.menu?.contains(e.target)) return;
      if (this.pill?.contains(e.target)) return;
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
      }, 80);
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
      document.body.appendChild(pill);

      const pillRect = pill.getBoundingClientRect();
      const gap = 8;
      let x = rect.left + rect.width / 2 - pillRect.width / 2;
      let y = rect.top - pillRect.height - gap;
      if (y < 8) y = rect.bottom + gap;
      x = Math.max(8, Math.min(x, window.innerWidth - pillRect.width - 8));
      y = Math.max(8, Math.min(y, window.innerHeight - pillRect.height - 8));

      pill.style.left = `${x}px`;
      pill.style.top = `${y}px`;
      pill.style.visibility = 'visible';
      this.pill = pill;
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
      const analysis = this.analyzeSelectionText(text, host);
      return {
        host,
        mode: correctionMode,
        profile: analysis.profile,
        protectedRanges: analysis.protectedRanges,
      };
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
      const flavor = context.profile.chatLike ? 'chat' : 'prose';
      return [context.host, context.mode, flavor, text].join('||');
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
        const value = replacement && typeof replacement.value === 'string'
          ? replacement.value.replace(/\u00A0/g, ' ')
          : '';
        if (!value || seenCandidates.has(value)) continue;
        seenCandidates.add(value);
        candidates.push(value);
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

    shouldKeepMatch(matchInfo, replacementValue, context) {
      if (!matchInfo || !replacementValue) return false;

      const { offset: start, length, issueType, categoryId, ruleId, original } = matchInfo;
      const end = start + length;

      if (this.rangesOverlap(start, end, context.protectedRanges)) return false;
      if (context.mode !== 'strict') {
        if (issueType === 'style' || issueType === 'locale-violation') return false;
        if (categoryId.includes('STYLE') || categoryId.includes('REGISTER')) return false;
      }
      if (context.mode === 'chat-lite') {
        if (issueType === 'duplication' && original.trim().length <= 2) return false;
        if (issueType === 'whitespace' && !/\s{2,}/.test(original) && !/[,:;!?]/.test(replacementValue)) return false;
        if (categoryId.includes('PUNCTUATION') && replacementValue.length > original.length + 3 && !/[.!?]/.test(original)) return false;
      }
      if (context.profile.codeish && context.mode !== 'strict' && /[\\/]|(?:^|_)[A-Z0-9_]+(?:$|_)/.test(original)) return false;
      if (ruleId.includes('TYPOGRAF') && context.mode === 'chat-lite' && context.profile.chatLike) return false;
      return true;
    },

    fetchCorrection(text) {
      if (!this.menu) return;
      if (this.currentRequest) { this.currentRequest.abort(); this.currentRequest = null; }

      const correctionContext = this.createCorrectionContext(text);
      const cacheKey = this.buildCorrectionCacheKey(text, correctionContext);
      if (this.correctionCache.has(cacheKey)) {
        this.renderCorrection(text, this.correctionCache.get(cacheKey), correctionContext);
        return;
      }

      this.setLoadingState(true);

      this.currentRequest = GM_xmlhttpRequest({
        method:  'POST',
        url:     'https://api.languagetoolplus.com/v2/check',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data:    new URLSearchParams({ text, language: 'auto' }).toString(),
        timeout: 10000,

        onload: (res) => {
          this.currentRequest = null;
          if (!this.menu) return;
          this.setLoadingState(false);
          if (res.status < 200 || res.status >= 300) { this.showCorrectionError(); return; }
          try {
            const matches = JSON.parse(res.responseText).matches || [];
            if (this.correctionCache.size >= 50 && !this.correctionCache.has(cacheKey)) {
              const oldestKey = this.correctionCache.keys().next().value;
              if (oldestKey) this.correctionCache.delete(oldestKey);
            }
            this.correctionCache.set(cacheKey, matches);
            this.renderCorrection(text, matches, correctionContext);
          }
          catch (_) { this.showCorrectionError(); }
        },
        onerror: () => {
          this.currentRequest = null;
          this.setLoadingState(false);
          this.showCorrectionError();
        },
        ontimeout: () => {
          this.currentRequest = null;
          this.setLoadingState(false);
          this.showCorrectionError('Délai dépassé.');
        },
      });
    },

    setLoadingState(loading) {
      const refs = this.getMenuRefs();
      const el = refs?.correctionContent;
      if (!el) return;
      if (loading) {
        this.resetActionState();
        el.innerHTML = '<span class="corrector-spinner" aria-hidden="true"></span><span>Correction en cours\u2026</span>';
      }
    },

    showCorrectionError(msg) {
      const refs = this.getMenuRefs();
      const el = refs?.correctionContent;
      if (!el) return;
      this.resetActionState();
      const label = msg || 'Erreur : impossible de corriger.';
      el.innerHTML = '';
      const msgSpan = document.createElement('span');
      msgSpan.textContent = '\u26A0 ' + label + ' ';
      const retryBtn = document.createElement('button');
      retryBtn.className   = 'corrector-retry-btn';
      retryBtn.textContent = 'Réessayer';
      retryBtn.addEventListener('click', () => this.fetchCorrection(this.selectedText));
      el.appendChild(msgSpan);
      el.appendChild(retryBtn);
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
        s.className   = 'corrector-error';
        s.title       = m.message || '';
        s.textContent = text.slice(m.offset, m.offset + m.length);
        return s;
      }));

      // Correction
      const corrEl = refs.correctionContent;
      if (corrected === text) {
        const ok = document.createElement('span');
        ok.className   = 'corrector-ok';
        ok.textContent = '\u2713 Aucune correction nécessaire';
        corrEl.replaceChildren(ok);
      } else {
        corrEl.replaceChildren(...this.buildSpans(text, preparedMatches, (m) => {
          const s = document.createElement('span');
          s.className   = 'corrector-fix';
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
          const replacementValue = this.pickReplacement(matchInfo, text, correctionContext);
          if (!this.shouldKeepMatch(matchInfo, replacementValue, correctionContext)) return null;
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
      if (!matches.length) return text;
      let r = text;
      for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        r = r.slice(0, m.offset) + m.replacementValue + r.slice(m.offset + m.length);
      }
      return r;
    },

    // Vérifie que la range sauvegardée pointe toujours vers le bon texte dans le DOM
    isRangeValid() {
      if (!this.selectedRange) return false;
      const sc = this.selectedRange.startContainer;
      const ec = this.selectedRange.endContainer;
      if (!sc.isConnected || !ec.isConnected) return false;
      if (this.selectedRange.toString() !== this.selectedRawText) return false;
      return true;
    },

    isControlSelectionValid() {
      if (!this.selectionSource || this.selectionSource.type !== 'control') return false;
      const { el, start, end } = this.selectionSource;
      if (!el || !el.isConnected) return false;
      if (typeof el.value !== 'string') return false;
      return el.value.slice(start, end) === this.selectedRawText;
    },

    resetActionState() {
      const refs = this.getMenuRefs();
      if (!refs) return;
      this.clearApplyError();

      refs.title?.querySelectorAll('.corrector-badge').forEach((badge) => badge.remove());

      const applyBtn = refs.applyBtn;
      if (applyBtn) {
        applyBtn.disabled = true;
        delete applyBtn.dataset.corrected;
      }

      const copyBtn = refs.copyBtn;
      if (copyBtn) {
        copyBtn.style.display = 'none';
        copyBtn.textContent = 'Copier';
        delete copyBtn.dataset.text;
      }
    },

    clearApplyError() {
      const refs = this.getMenuRefs();
      if (!refs?.applyError) return;
      refs.applyError.remove();
      refs.applyError = null;
    },

    selectionMatchesWholeEditable(editableEl) {
      return normalizeComparableText(this.selectedRawText) === normalizeComparableText(editableEl.textContent || '');
    },

    restoreSavedRangeSelection() {
      if (!this.selectedRange) return false;
      const sel = window.getSelection();
      if (!sel) return false;
      const range = this.selectedRange.cloneRange();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString() === this.selectedRawText;
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

      menu.innerHTML = [
        '<div class="corrector-header" title="Maintenir pour déplacer">',
        '  <span class="corrector-title" id="corrector-title">\u270E Correcteur</span>',
        '  <div class="corrector-header-actions">',
        '    <button class="corrector-settings-btn" aria-label="Paramètres" aria-expanded="false" title="Paramètres">\u2699</button>',
        '    <button class="corrector-close-btn" aria-label="Fermer">\u2715</button>',
        '  </div>',
        '</div>',
        '<div class="corrector-settings-panel" hidden>',
        '  <label class="corrector-setting-stack">',
        '    <span>Mode de correction</span>',
        '    <select class="corrector-setting-mode">',
        '      <option value="chat-lite">Chat</option>',
        '      <option value="balanced">Équilibré</option>',
        '      <option value="strict">Strict</option>',
        '    </select>',
        '    <span class="corrector-mode-help"></span>',
        '  </label>',
        '  <label class="corrector-setting-row">',
        '    <input type="checkbox" class="corrector-setting-debug">',
        '    <span>Activer les logs de debug</span>',
        '  </label>',
        '  <button class="corrector-download-logs-btn" type="button">Télécharger les logs</button>',
        '  <div class="corrector-settings-status"></div>',
        '  <label class="corrector-setting-row">',
        '    <input type="checkbox" class="corrector-setting-confirmation">',
        '    <span>Afficher la notification après remplacement</span>',
        '  </label>',
        '</div>',
        '<div class="corrector-section">',
        '  <div class="corrector-label">Texte sélectionné</div>',
        '  <div class="corrector-original-content"></div>',
        '</div>',
        '<div class="corrector-section">',
        '  <div class="corrector-label">Correction suggérée</div>',
        '  <div class="corrector-correction-content" aria-live="polite" aria-atomic="true">',
        '    <span class="corrector-spinner" aria-hidden="true"></span>',
        '    <span>Correction en cours\u2026</span>',
        '  </div>',
        '</div>',
        '<div class="corrector-actions">',
        '  <button class="corrector-apply-btn" disabled>Appliquer</button>',
        '  <button class="corrector-copy-btn" style="display:none">Copier</button>',
        '  <button class="corrector-cancel-btn">Fermer</button>',
        '</div>',
      ].join('');

      this.cacheMenuRefs(menu);
      const refs = this.menuRefs;
      refs.originalContent.textContent = this.selectedText;
      menu.style.left = `${Math.max(0, x)}px`;
      menu.style.top = `${Math.max(0, y)}px`;

      // Boutons
      refs.applyBtn.addEventListener('click', (e) => {
        const c = e.currentTarget.dataset.corrected;
        if (c) this.applyCorrection(c);
      });
      refs.copyBtn.addEventListener('click', (e) => {
        const txt = e.currentTarget.dataset.text;
        if (!txt) return;
        const btn = e.currentTarget;
        const onCopied = () => {
          btn.textContent = '\u2713 Copié';
          setTimeout(() => { btn.textContent = 'Copier'; }, 1500);
        };
        navigator.clipboard.writeText(txt).then(onCopied).catch(() => {
          // Fallback si l'API Clipboard est refusée ou indisponible
          try {
            const ta = document.createElement('textarea');
            ta.value = txt; ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); ta.remove();
            onCopied();
          } catch (_) {}
        });
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

      document.body.appendChild(menu);
      this.menu = menu;
      this.cacheMenuRefs(menu);
      this.resetActionState();
      this.syncSettingsPanel();

      // Drag
      this.makeDraggable(menu);

      requestAnimationFrame(() => {
        this.adjustMenuPosition(menu);
        refs.cancelBtn.focus();
      });
    },

    // ─────────────────────────────────────────────
    // Drag & drop + sauvegarde position
    // ─────────────────────────────────────────────
    makeDraggable(menu) {
      const header = this.getMenuRefs()?.header || menu.querySelector('.corrector-header');
      let startX, startY, startLeft, startTop;

      const onMove = (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const newLeft = Math.max(0, Math.min(startLeft + dx, window.innerWidth  - menu.offsetWidth));
        const newTop  = Math.max(0, Math.min(startTop  + dy, window.innerHeight - menu.offsetHeight));
        menu.style.left = newLeft + 'px';
        menu.style.top  = newTop  + 'px';
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        menu.classList.remove('corrector-dragging');
        this.savePosition(parseInt(menu.style.left), parseInt(menu.style.top));
      };

      // Nettoyage si le menu est fermé pendant un drag (évite des listeners fantômes)
      menu._dragCleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };

      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.corrector-close-btn') || e.target.closest('.corrector-settings-btn')) return;
        e.preventDefault();
        startX    = e.clientX;
        startY    = e.clientY;
        startLeft = parseInt(menu.style.left) || 0;
        startTop  = parseInt(menu.style.top)  || 0;
        menu.classList.add('corrector-dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
      });
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
      const refs = this.getMenuRefs();
      const btns  = (refs?.focusableButtons || []).filter((btn) => btn.isConnected && !btn.disabled && btn.offsetParent !== null);
      const first = btns[0], last = btns[btns.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },

    adjustMenuPosition(menu) {
      const r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  menu.style.left = Math.max(0, window.innerWidth  - r.width  - 10) + 'px';
      if (r.bottom > window.innerHeight) menu.style.top  = Math.max(0, window.innerHeight - r.height - 10) + 'px';
    },

    // ─────────────────────────────────────────────
    // Remplacement du texte
    // 3 stratégies selon le type d'élément cible
    // ─────────────────────────────────────────────
    applyCorrection(corrected) {
      if (!this.selectionSource) {
        this.showApplyError('Sélection perdue. Resélectionnez le texte.');
        return;
      }

      this.clearApplyError();
      const applyToken = this.beginApplyFlow();
      const replacementText = this.getReplacementText(corrected);

      try {
        // ── Cas 1 : <input> ou <textarea> ──────────
        if (this.selectionSource.type === 'control') {
          if (!this.isControlSelectionValid()) {
            this.showApplyError('Le texte a changé depuis la sélection. Resélectionnez.');
            return;
          }
          const inputEl = this.selectionSource.el;
          const { start, end } = this.selectionSource;
          const originalValue = inputEl.value;
          inputEl.setRangeText(replacementText, start, end, 'end');
          inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
          this.lastApply = { type: 'input', el: inputEl, originalValue, start, end };
          this.closeMenu();
          inputEl.focus();
          this.showConfirmation(true);
          return;
        }

        if (!this.selectedRange) {
          this.showApplyError('Sélection perdue. Resélectionnez le texte.');
          return;
        }

        const anchor = this.selectedRange.commonAncestorContainer;
        const parent = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
        const sel    = window.getSelection();

        // ── Cas 2 : contenteditable ─────────────────
        const editableEl = parent && parent.closest('[contenteditable="true"], [contenteditable=""]');
        if (editableEl) {
          snap('A_avant_tout', editableEl);
          if (!this.isRangeValid()) {
            this.showApplyError('Le texte a changé depuis la sélection. Resélectionnez.');
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
            this.lastApply = { type: 'contenteditable' };
            editableEl.focus();
            this.closeMenu();
            snap('E_apres_closeMenu', editableEl);
            this.showConfirmation(false);
          };

          const failEditableApply = () => {
            if (!this.isApplyFlowActive(applyToken)) return;
            this.showApplyError(
              safeWholeReplace
                ? 'Impossible de remplacer sur cet éditeur. Utilisez "Copier".'
                : 'Remplacement partiel non fiable sur cet éditeur. Utilisez "Copier" ou sélectionnez tout le texte.'
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

            const execOk = document.execCommand('insertText', false, replacementText);
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
          let usedDraftFiber = false;
          if (safeWholeReplace) {
            try {
              const allKeys = Object.getOwnPropertyNames(editableEl);
              const rKey = allKeys.find(k =>
                k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
              );
              dbg('fiber: rKey=' + (rKey ? rKey.slice(0, 30) : 'null'));

              if (rKey) {
                const isES = (v) => v && typeof v === 'object' && (
                  (typeof v.getSelection === 'function' && typeof v.getCurrentContent === 'function') ||
                  (typeof v.get === 'function' && typeof v.merge === 'function' && typeof v.set === 'function')
                );

                let fiber = editableEl[rKey];
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

                if (draftProps) {
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
                    sameText &&
                    typeof sel?.merge === 'function' &&
                    typeof CS.createFromText === 'function' &&
                    typeof ES.createWithContent === 'function' &&
                    typeof ES.forceSelection === 'function'
                  ) {
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
                    usedDraftFiber = true;
                    this.scheduleApplyStep(applyToken, () => {
                      editableEl.focus();
                      finalize();
                    }, 30);
                  }
                }
              }
            } catch (e) { dbg('fiber error: ' + e.message + ' | ' + (e.stack || '').slice(0, 100)); }
          }

          if (usedDraftFiber) return;

          // ── Stratégie B : restaurer la vraie sélection puis beforeinput ────────
          editableEl.focus();
          snap('B_focus_done', editableEl);
          this.scheduleApplyStep(applyToken, () => {
            const restored = this.restoreSavedRangeSelection();
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
          this.showApplyError('Le texte a changé depuis la sélection. Resélectionnez.');
          return;
        }
        const originalText = this.selectedRange.toString();
        this.selectedRange.deleteContents();
        const textNode = document.createTextNode(replacementText);
        this.selectedRange.insertNode(textNode);

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
        this.showApplyError('Impossible de remplacer sur ce site. Utilisez "Copier".');
      }
    },

    undoLastApply() {
      if (!this.lastApply) return;
      const { type } = this.lastApply;
      try {
        if (type === 'input') {
          const { el, originalValue, start, end } = this.lastApply;
          el.value = originalValue;
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
        undoBtn.textContent = 'Annuler';
        undoBtn.addEventListener('click', () => { this.undoLastApply(); toast.remove(); });
        toast.appendChild(undoBtn);
      }

      document.body.appendChild(toast);

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
      if (this.pill && this.pill.contains(e.target)) return;
      if (this.menu && !this.menu.contains(e.target)) this.closeMenu();
    },

    handleKeyDown(e) {
      if (e.key === 'Escape') { this.hidePill(); if (this.menu) this.closeMenu(); }
    },

    closeMenu() {
      if (this.currentRequest) { this.currentRequest.abort(); this.currentRequest = null; }
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
    injectStyles() {
      const style = document.createElement('style');
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
          color: #111;
          animation: corrector-pop .15s ease-out;
          overflow: hidden;
        }

        .text-corrector-menu button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }

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
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  };

  TextCorrector.init();
})();
