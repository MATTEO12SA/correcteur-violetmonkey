// ==UserScript==
// @name           Correcteur de Phrases
// @namespace      http://violetmonkey.net/
// @version        4.5.1
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
  const NAV_EVENT = '_corrector_nav';
  const HISTORY_PATCH_FLAG = '__corrector_history_patched';
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password']);

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

    toggleSettingsPanel(force) {
      if (!this.menu) return;
      const panel = this.menu.querySelector('.corrector-settings-panel');
      const btn = this.menu.querySelector('.corrector-settings-btn');
      if (!panel || !btn) return;
      const shouldOpen = typeof force === 'boolean' ? force : panel.hidden;
      panel.hidden = !shouldOpen;
      btn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
      this.syncSettingsPanel();
    },

    syncSettingsPanel() {
      if (!this.menu) return;
      const panel = this.menu.querySelector('.corrector-settings-panel');
      if (!panel) return;

      const debugInput = panel.querySelector('.corrector-setting-debug');
      const confirmInput = panel.querySelector('.corrector-setting-confirmation');
      const downloadBtn = panel.querySelector('.corrector-download-logs-btn');
      const status = panel.querySelector('.corrector-settings-status');

      if (debugInput) debugInput.checked = debugEnabled;
      if (confirmInput) confirmInput.checked = confirmationEnabled;
      if (downloadBtn) downloadBtn.disabled = !debugEnabled;
      if (status) {
        status.textContent = debugEnabled
          ? (_logs.length ? 'Logs actifs. Clique sur "Télécharger les logs" après avoir reproduit le bug.' : 'Logs actifs. Reproduis le bug puis télécharge le fichier.')
          : 'Logs désactivés. Active-les ici si tu veux un fichier de debug.';
      }
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
    fetchCorrection(text) {
      if (!this.menu) return;
      if (this.currentRequest) { this.currentRequest.abort(); this.currentRequest = null; }

      const cacheKey = text;
      if (this.correctionCache.has(cacheKey)) {
        this.renderCorrection(text, this.correctionCache.get(cacheKey));
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
            this.renderCorrection(text, matches);
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
      if (!this.menu) return;
      const el = this.menu.querySelector('.corrector-correction-content');
      if (!el) return;
      if (loading) {
        this.resetActionState();
        el.innerHTML = '<span class="corrector-spinner" aria-hidden="true"></span><span>Correction en cours\u2026</span>';
      }
    },

    showCorrectionError(msg) {
      const el = this.menu && this.menu.querySelector('.corrector-correction-content');
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
    renderCorrection(text, matches) {
      if (!this.menu) return;

      this.resetActionState();
      const preparedMatches = this.prepareMatches(matches);
      const corrected = this.applyMatches(text, preparedMatches);

      // Badge erreurs
      if (preparedMatches.length > 0) {
        const badge = document.createElement('span');
        badge.className   = 'corrector-badge';
        badge.textContent = preparedMatches.length + ' erreur' + (preparedMatches.length > 1 ? 's' : '');
        this.menu.querySelector('.corrector-title').appendChild(badge);
      }

      // Texte original avec erreurs soulignées
      const origEl = this.menu.querySelector('.corrector-original-content');
      origEl.replaceChildren(...this.buildSpans(text, preparedMatches, (m) => {
        const s = document.createElement('span');
        s.className   = 'corrector-error';
        s.title       = m.message || '';
        s.textContent = text.slice(m.offset, m.offset + m.length);
        return s;
      }));

      // Correction
      const corrEl = this.menu.querySelector('.corrector-correction-content');
      if (corrected === text) {
        const ok = document.createElement('span');
        ok.className   = 'corrector-ok';
        ok.textContent = '\u2713 Aucune correction nécessaire';
        corrEl.replaceChildren(ok);
      } else {
        corrEl.replaceChildren(...this.buildSpans(text, preparedMatches, (m) => {
          const s = document.createElement('span');
          s.className   = 'corrector-fix';
          s.textContent = m.replacements[0].value;
          return s;
        }));

        const applyBtn = this.menu.querySelector('.corrector-apply-btn');
        applyBtn.disabled = false;
        applyBtn.dataset.corrected = corrected;
        applyBtn.focus();

        const copyBtn = this.menu.querySelector('.corrector-copy-btn');
        copyBtn.style.display = 'inline-block';
        copyBtn.dataset.text  = corrected;
      }
    },

    prepareMatches(matches) {
      const sorted = (matches || [])
        .filter((match) => match && match.replacements && match.replacements.length > 0)
        .slice()
        .sort((a, b) => a.offset - b.offset);

      const prepared = [];
      let cursor = 0;
      for (const match of sorted) {
        if (match.offset < cursor) continue;
        prepared.push(match);
        cursor = match.offset + match.length;
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
        r = r.slice(0, m.offset) + m.replacements[0].value + r.slice(m.offset + m.length);
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
      if (!this.menu) return;
      this.clearApplyError();

      const title = this.menu.querySelector('.corrector-title');
      title?.querySelectorAll('.corrector-badge').forEach((badge) => badge.remove());

      const applyBtn = this.menu.querySelector('.corrector-apply-btn');
      if (applyBtn) {
        applyBtn.disabled = true;
        delete applyBtn.dataset.corrected;
      }

      const copyBtn = this.menu.querySelector('.corrector-copy-btn');
      if (copyBtn) {
        copyBtn.style.display = 'none';
        copyBtn.textContent = 'Copier';
        delete copyBtn.dataset.text;
      }
    },

    clearApplyError() {
      this.menu?.querySelector('.corrector-apply-error')?.remove();
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

      menu.querySelector('.corrector-original-content').textContent = this.selectedText;
      menu.style.left = `${Math.max(0, x)}px`;
      menu.style.top = `${Math.max(0, y)}px`;

      // Boutons
      menu.querySelector('.corrector-apply-btn').addEventListener('click', (e) => {
        const c = e.currentTarget.dataset.corrected;
        if (c) this.applyCorrection(c);
      });
      menu.querySelector('.corrector-copy-btn').addEventListener('click', (e) => {
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
      menu.querySelector('.corrector-cancel-btn').addEventListener('click', close);
      menu.querySelector('.corrector-close-btn').addEventListener('click',  close);
      menu.querySelector('.corrector-settings-btn').addEventListener('click', (e) => {
        e.preventDefault();
        this.toggleSettingsPanel();
      });
      menu.querySelector('.corrector-setting-debug').addEventListener('change', (e) => {
        this.setDebugEnabled(e.currentTarget.checked);
      });
      menu.querySelector('.corrector-setting-confirmation').addEventListener('change', (e) => {
        this.setConfirmationEnabled(e.currentTarget.checked);
      });
      menu.querySelector('.corrector-download-logs-btn').addEventListener('click', () => downloadLogs());
      menu.addEventListener('keydown', (e) => this.handleMenuKeyDown(e));

      document.body.appendChild(menu);
      this.menu = menu;
      this.resetActionState();
      this.syncSettingsPanel();

      // Drag
      this.makeDraggable(menu);

      requestAnimationFrame(() => {
        this.adjustMenuPosition(menu);
        menu.querySelector('.corrector-cancel-btn').focus();
      });
    },

    // ─────────────────────────────────────────────
    // Drag & drop + sauvegarde position
    // ─────────────────────────────────────────────
    makeDraggable(menu) {
      const header = menu.querySelector('.corrector-header');
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
      const btns  = Array.from(this.menu.querySelectorAll('button:not(:disabled)'));
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
      if (!this.menu) return;
      let errEl = this.menu.querySelector('.corrector-apply-error');
      if (!errEl) {
        errEl = document.createElement('div');
        errEl.className = 'corrector-apply-error';
        const actions = this.menu.querySelector('.corrector-actions');
        actions.parentNode.insertBefore(errEl, actions);
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
        .corrector-setting-row input { margin: 0; }
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
          .corrector-setting-row        { color:#fdba74; }
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
