// ==UserScript==
// @name           Correcteur de Phrases
// @namespace      http://violetmonkey.net/
// @version        3.1.0
// @description    Corrige automatiquement les phrases sélectionnées via LanguageTool
// @author         Matteo12SA
// @match          *://*/*
// @updateURL      https://raw.githubusercontent.com/MATTEO12SA/correcteur-violetmonkey/main/corrector.user.js
// @downloadURL    https://raw.githubusercontent.com/MATTEO12SA/correcteur-violetmonkey/main/corrector.user.js
// @grant          GM_xmlhttpRequest
// @connect        api.languagetoolplus.com
// @run-at         document-end
// ==/UserScript==

(function () {
  'use strict';

  const TextCorrector = {
    selectedText: '',
    selectedRange: null,
    menu: null,
    pill: null,               // bulle flottante "Corriger"
    currentRequest: null,
    styleEl: null,
    previousFocus: null,

    // ─────────────────────────────────────────────
    // Initialisation
    // ─────────────────────────────────────────────
    init() {
      document.addEventListener('mouseup',         (e) => this.handleMouseUp(e));
      document.addEventListener('selectionchange', ()  => this.handleSelectionChange());
      document.addEventListener('click',           (e) => this.handleOutsideClick(e));
      document.addEventListener('keydown',         (e) => this.handleKeyDown(e));
      this.injectStyles();
      this.watchNavigation();
    },

    // ─────────────────────────────────────────────
    // Support SPA
    // ─────────────────────────────────────────────
    watchNavigation() {
      const wrap = (original) => function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event('_corrector_nav'));
        return result;
      };
      history.pushState    = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
      window.addEventListener('popstate',       () => window.dispatchEvent(new Event('_corrector_nav')));
      window.addEventListener('_corrector_nav', () => this.onNavigate());

      const observer = new MutationObserver(() => {
        if (this.styleEl && !document.contains(this.styleEl)) this.injectStyles();
      });
      observer.observe(document.head || document.documentElement, { childList: true });
    },

    onNavigate() {
      this.hidePill();
      this.closeMenu();
      if (this.styleEl && !document.contains(this.styleEl)) this.injectStyles();
    },

    // ─────────────────────────────────────────────
    // Module 1 : Bulle flottante au-dessus de la selection
    // ─────────────────────────────────────────────
    handleMouseUp(event) {
      if (this.menu?.contains(event.target)) return;
      if (this.pill?.contains(event.target)) return;
      setTimeout(() => {
        const selection = window.getSelection();
        const text = selection ? selection.toString().trim() : '';
        if (!text || text.length < 3) { this.hidePill(); return; }
        const range = selection.getRangeAt(0);
        const rect  = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) { this.hidePill(); return; }
        this.showPill(rect);
      }, 10);
    },

    handleSelectionChange() {
      const sel = window.getSelection();
      if (!sel || !sel.toString().trim()) this.hidePill();
    },

    showPill(rect) {
      this.hidePill();
      const pill = document.createElement('button');
      pill.className = 'corrector-pill';
      pill.setAttribute('aria-label', 'Corriger le texte selectionne');
      pill.textContent = '\u270E Corriger';

      const pillW = 110, pillH = 30, margin = 8;
      let x = rect.left + rect.width / 2 - pillW / 2 + window.scrollX;
      let y = rect.top  - pillH - margin  + window.scrollY;
      if (rect.top - pillH - margin < 0) y = rect.bottom + margin + window.scrollY;
      x = Math.max(8, Math.min(x, window.innerWidth - pillW - 8));

      pill.style.left = x + 'px';
      pill.style.top  = y + 'px';
      pill.addEventListener('mousedown', (e) => { e.preventDefault(); this.triggerCorrection(); });

      document.body.appendChild(pill);
      this.pill = pill;
    },

    hidePill() {
      if (this.pill) { this.pill.remove(); this.pill = null; }
    },

    triggerCorrection() {
      const selection = window.getSelection();
      if (!selection || !selection.toString().trim()) return;
      const text = selection.toString().trim();
      this.selectedText  = text;
      this.previousFocus = document.activeElement;
      this.selectedRange = selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;

      const pillRect = this.pill ? this.pill.getBoundingClientRect() : null;
      const x = pillRect ? pillRect.left : 100;
      const y = pillRect ? pillRect.bottom + 8 : 100;
      this.hidePill();
      this.createMenu(x, y);
      this.fetchCorrection(text);
    },

    // ─────────────────────────────────────────────
    // Module 2 : Correction LanguageTool
    // ─────────────────────────────────────────────
    fetchCorrection(text) {
      if (!this.menu) return;
      if (this.currentRequest) { this.currentRequest.abort(); this.currentRequest = null; }

      const correctionEl = this.menu.querySelector('.corrector-correction-content');
      if (correctionEl) correctionEl.setAttribute('aria-busy', 'true');

      this.currentRequest = GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.languagetoolplus.com/v2/check',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({ text: text, language: 'auto' }).toString(),
        timeout: 10000,
        onload: (response) => {
          this.currentRequest = null;
          if (!this.menu) return;
          const el = this.menu.querySelector('.corrector-correction-content');
          if (el) el.removeAttribute('aria-busy');
          if (response.status < 200 || response.status >= 300) { this.showCorrectionError(); return; }
          try {
            const data = JSON.parse(response.responseText);
            this.renderCorrection(text, data.matches || []);
          } catch (e) { this.showCorrectionError(); }
        },
        onerror: () => {
          this.currentRequest = null;
          if (!this.menu) return;
          const el = this.menu.querySelector('.corrector-correction-content');
          if (el) el.removeAttribute('aria-busy');
          this.showCorrectionError();
        },
        ontimeout: () => {
          this.currentRequest = null;
          const el = this.menu ? this.menu.querySelector('.corrector-correction-content') : null;
          if (el) { el.removeAttribute('aria-busy'); el.textContent = 'Delai depasse. Reessayez.'; }
        },
      });
    },

    showCorrectionError() {
      const el = this.menu ? this.menu.querySelector('.corrector-correction-content') : null;
      if (el) el.textContent = 'Erreur : impossible de corriger le texte.';
    },

    // ─────────────────────────────────────────────
    // Rendu diff : rouge = erreurs, vert = corrections
    // ─────────────────────────────────────────────
    renderCorrection(text, matches) {
      if (!this.menu) return;
      const validMatches = matches.filter(function(m) { return m.replacements && m.replacements.length > 0; });
      const corrected = this.applyMatches(text, validMatches);

      if (validMatches.length > 0) {
        const badge = document.createElement('span');
        badge.className = 'corrector-badge';
        badge.textContent = validMatches.length + ' erreur' + (validMatches.length > 1 ? 's' : '');
        this.menu.querySelector('.corrector-header').appendChild(badge);
      }

      const originalEl = this.menu.querySelector('.corrector-original-content');
      originalEl.replaceChildren.apply(originalEl,
        this.buildSpans(text, validMatches, function(m) {
          const s = document.createElement('span');
          s.className = 'corrector-error';
          s.textContent = text.slice(m.offset, m.offset + m.length);
          return s;
        })
      );

      const correctionEl = this.menu.querySelector('.corrector-correction-content');
      if (corrected === text) {
        correctionEl.textContent = '\u2713 Aucune correction necessaire';
      } else {
          correctionEl.replaceChildren.apply(correctionEl,
          this.buildSpans(text, validMatches, function(m) {
            const s = document.createElement('span');
            s.className = 'corrector-fix';
            s.textContent = m.replacements[0].value;
            return s;
          })
        );
        const applyBtn = this.menu.querySelector('.corrector-apply-btn');
        applyBtn.disabled = false;
        applyBtn.dataset.corrected = corrected;
        applyBtn.focus();
        const copyBtn = this.menu.querySelector('.corrector-copy-btn');
        copyBtn.style.display = 'inline-block';
        copyBtn.dataset.text = corrected;
      }
    },

    buildSpans(text, matches, makeSpan) {
      const nodes = [];
      let cursor = 0;
      const sorted = matches.slice().sort(function(a, b) { return a.offset - b.offset; });
      for (let i = 0; i < sorted.length; i++) {
        const match = sorted[i];
        if (match.offset > cursor) nodes.push(document.createTextNode(text.slice(cursor, match.offset)));
        nodes.push(makeSpan(match));
        cursor = match.offset + match.length;
      }
      if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)));
      return nodes;
    },

    applyMatches(text, matches) {
      if (!matches.length) return text;
      let result = text;
      const sorted = matches.slice().sort(function(a, b) { return b.offset - a.offset; });
      for (let i = 0; i < sorted.length; i++) {
        const match = sorted[i];
        result = result.slice(0, match.offset) + match.replacements[0].value + result.slice(match.offset + match.length);
      }
      return result;
    },

    // ─────────────────────────────────────────────
    // Module 3 : Panneau de correction accessible
    // ─────────────────────────────────────────────
    createMenu(x, y) {
      this.closeMenu();
      const menu = document.createElement('div');
      menu.className = 'text-corrector-menu';
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-modal', 'true');
      menu.setAttribute('aria-labelledby', 'corrector-title');

      menu.innerHTML = [
        '<div class="corrector-header">',
        '  <span id="corrector-title">\u270E Correcteur de Phrases</span>',
        '  <button class="corrector-close-btn" aria-label="Fermer">\u2715</button>',
        '</div>',
        '<div class="corrector-section">',
        '  <div class="corrector-label">Texte selectionne :</div>',
        '  <div class="corrector-original-content"></div>',
        '</div>',
        '<div class="corrector-section">',
        '  <div class="corrector-label">Correction suggeree :</div>',
        '  <div class="corrector-correction-content" aria-live="polite" aria-atomic="true">',
        '    <span class="corrector-spinner" aria-hidden="true"></span>',
        '    Correction en cours\u2026',
        '  </div>',
        '</div>',
        '<div class="corrector-actions">',
        '  <button class="corrector-apply-btn" disabled>Appliquer</button>',
        '  <button class="corrector-copy-btn" style="display:none">Copier</button>',
        '  <button class="corrector-cancel-btn">Annuler</button>',
        '</div>',
      ].join('');

      menu.querySelector('.corrector-original-content').textContent = this.selectedText;
      menu.style.left = x + 'px';
      menu.style.top  = y + 'px';

      const self = this;
      menu.querySelector('.corrector-apply-btn').addEventListener('click', function(e) {
        const c = e.currentTarget.dataset.corrected;
        if (c) self.applyCorrection(c);
      });
      menu.querySelector('.corrector-copy-btn').addEventListener('click', function(e) {
        const txt = e.currentTarget.dataset.text;
        if (!txt) return;
        const btn = e.currentTarget;
        navigator.clipboard.writeText(txt).then(function() {
          btn.textContent = '\u2713 Copie';
          setTimeout(function() { btn.textContent = 'Copier'; }, 1500);
        }).catch(function() {});
      });
      function close() { self.closeMenu(); }
      menu.querySelector('.corrector-cancel-btn').addEventListener('click', close);
      menu.querySelector('.corrector-close-btn').addEventListener('click', close);
      menu.addEventListener('keydown', function(e) { self.handleMenuKeyDown(e); });

      document.body.appendChild(menu);
      this.menu = menu;

      requestAnimationFrame(function() {
        self.adjustMenuPosition(menu);
        menu.querySelector('.corrector-cancel-btn').focus();
      });
    },

    handleMenuKeyDown(e) {
      if (e.key === 'Escape') { this.closeMenu(); return; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(this.menu.querySelectorAll('button:not(:disabled)'));
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },

    adjustMenuPosition(menu) {
      const rect = menu.getBoundingClientRect();
      if (rect.right  > window.innerWidth)  menu.style.left = Math.max(0, window.innerWidth  - rect.width  - 10) + 'px';
      if (rect.bottom > window.innerHeight) menu.style.top  = Math.max(0, window.innerHeight - rect.height - 10) + 'px';
    },

    // ─────────────────────────────────────────────
    // Module 4 : Remplacement du texte
    // ─────────────────────────────────────────────
    applyCorrection(corrected) {
      if (!this.selectedRange) { this.closeMenu(); return; }
      try {
        this.selectedRange.deleteContents();
        this.selectedRange.insertNode(document.createTextNode(corrected));
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        this.closeMenu();
        this.showConfirmation();
      } catch (err) {
        console.error('[Correcteur]', err);
        this.closeMenu();
      }
    },

    showConfirmation() {
      const toast = document.createElement('div');
      toast.className = 'corrector-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.textContent = '\u2713 Correction appliquee';
      document.body.appendChild(toast);
      setTimeout(function() {
        toast.classList.add('corrector-toast-fade');
        setTimeout(function() { toast.remove(); }, 400);
      }, 1800);
    },

    // ─────────────────────────────────────────────
    // Module 5 : Evenements
    // ─────────────────────────────────────────────
    handleOutsideClick(event) {
      if (this.pill && this.pill.contains(event.target)) return;
      if (this.menu && !this.menu.contains(event.target)) this.closeMenu();
    },

    handleKeyDown(event) {
      if (event.key === 'Escape') {
        this.hidePill();
        if (this.menu) this.closeMenu();
      }
    },

    closeMenu() {
      if (this.currentRequest) { this.currentRequest.abort(); this.currentRequest = null; }
      if (this.menu) {
        this.menu.remove();
        this.menu = null;
        if (this.previousFocus && typeof this.previousFocus.focus === 'function') this.previousFocus.focus();
        this.previousFocus = null;
      }
    },

    // ─────────────────────────────────────────────
    // Styles CSS
    // ─────────────────────────────────────────────
    injectStyles() {
      const style = document.createElement('style');
      this.styleEl = style;
      style.textContent = [
        '@keyframes corrector-pop  { from { opacity:0; transform:scale(.92) translateY(-4px) } to { opacity:1; transform:scale(1) translateY(0) } }',
        '@keyframes corrector-spin { to { transform:rotate(360deg) } }',

        '.corrector-pill {',
        '  position:absolute; z-index:2147483647;',
        '  background:#1a1a2e; color:#fff; border:none; border-radius:20px;',
        '  padding:5px 14px;',
        '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;',
        '  font-size:12px; font-weight:600; cursor:pointer;',
        '  box-shadow:0 4px 14px rgba(0,0,0,.3);',
        '  animation:corrector-pop .15s ease-out;',
        '  white-space:nowrap; transition:background .15s, transform .1s;',
        '}',
        '.corrector-pill:hover  { background:#007bff; transform:translateY(-1px); }',
        '.corrector-pill:active { transform:translateY(0); }',
        '.corrector-pill:focus-visible { outline:3px solid #007bff; outline-offset:2px; }',
        '.corrector-pill::after {',
        '  content:""; position:absolute; bottom:-5px; left:50%; transform:translateX(-50%);',
        '  border:5px solid transparent; border-top-color:#1a1a2e; border-bottom:none;',
        '}',
        '.corrector-pill:hover::after { border-top-color:#007bff; }',

        '.text-corrector-menu {',
        '  position:fixed; background:#fff; border:2px solid #333; border-radius:10px;',
        '  padding:14px 16px; z-index:2147483647;',
        '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;',
        '  font-size:13px; box-shadow:0 8px 24px rgba(0,0,0,.18);',
        '  max-width:440px; min-width:290px; color:#222;',
        '  animation:corrector-pop .15s ease-out;',
        '}',
        '.text-corrector-menu button:focus-visible { outline:3px solid #007bff; outline-offset:2px; }',

        '@media (prefers-color-scheme:dark) {',
        '  .text-corrector-menu          { background:#1e1e1e; border-color:#555; color:#e0e0e0; }',
        '  .corrector-header             { color:#4da6ff!important; border-color:#444!important; }',
        '  .corrector-label              { color:#888!important; }',
        '  .corrector-original-content   { background:#2a2a2a!important; border-color:#444!important; color:#bbb!important; }',
        '  .corrector-correction-content { background:#1a2a3a!important; border-color:#2a5a8a!important; color:#a8d4ff!important; }',
        '  .corrector-cancel-btn         { background:#2a2a2a!important; border-color:#555!important; color:#ccc!important; }',
        '  .corrector-cancel-btn:hover   { background:#3a3a3a!important; }',
        '  .corrector-close-btn          { color:#aaa!important; }',
        '  .corrector-close-btn:hover    { background:#333!important; color:#fff!important; }',
        '}',

        '.corrector-header {',
        '  font-weight:bold; font-size:14px; margin-bottom:12px; color:#0056b3;',
        '  border-bottom:1px solid #e0e0e0; padding-bottom:8px;',
        '  display:flex; align-items:center; justify-content:space-between; gap:8px;',
        '}',
        '.corrector-close-btn {',
        '  background:none; border:none; cursor:pointer; font-size:14px; color:#888;',
        '  border-radius:4px; padding:2px 6px; line-height:1;',
        '  transition:background .15s, color .15s; flex-shrink:0;',
        '}',
        '.corrector-close-btn:hover { background:#f0f0f0; color:#333; }',
        '.corrector-badge { font-size:11px; background:#e74c3c; color:white; border-radius:10px; padding:2px 8px; font-weight:normal; margin-left:6px; }',
        '.corrector-section { margin-bottom:10px; }',
        '.corrector-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:#888; margin-bottom:4px; }',

        '.corrector-original-content, .corrector-correction-content {',
        '  border-radius:5px; padding:7px 10px; max-height:100px;',
        '  overflow-y:auto; white-space:pre-wrap; word-break:break-word; line-height:1.65;',
        '}',
        '.corrector-original-content  { background:#f6f6f6; border:1px solid #e0e0e0; color:#555; font-style:italic; }',
        '.corrector-correction-content {',
        '  background:#eaf4ff; border:1px solid #b3d4f0; color:#003a70; font-weight:500;',
        '  min-height:36px; display:flex; align-items:flex-start; gap:6px; flex-wrap:wrap;',
        '}',
        '.corrector-spinner {',
        '  display:inline-block; width:13px; height:13px;',
        '  border:2px solid #b3d4f0; border-top-color:#0056b3;',
        '  border-radius:50%; animation:corrector-spin .7s linear infinite;',
        '  flex-shrink:0; margin-top:2px;',
        '}',
        '.corrector-correction-content:not([aria-busy]) .corrector-spinner { display:none; }',
        '.corrector-error { background:#ffe5e5; color:#c0392b; border-radius:3px; text-decoration:underline wavy #e74c3c; padding:0 2px; }',
        '.corrector-fix   { background:#d4f5d4; color:#1a6b1a; border-radius:3px; font-weight:bold; padding:0 2px; }',

        '.corrector-actions { display:flex; gap:8px; margin-top:10px; align-items:center; flex-wrap:wrap; }',
        '.corrector-apply-btn {',
        '  cursor:pointer; padding:7px 16px; border:none; background:#007bff; color:white;',
        '  border-radius:5px; font-size:13px; font-weight:600; transition:background .15s, transform .1s;',
        '}',
        '.corrector-apply-btn:hover:not(:disabled)  { background:#0056b3; transform:translateY(-1px); }',
        '.corrector-apply-btn:active:not(:disabled) { transform:translateY(0); }',
        '.corrector-apply-btn:disabled { background:#bbb; cursor:default; }',
        '.corrector-copy-btn {',
        '  cursor:pointer; padding:7px 14px; border:1.5px solid #28a745;',
        '  background:transparent; color:#28a745; border-radius:5px; font-size:13px;',
        '  transition:background .15s, color .15s;',
        '}',
        '.corrector-copy-btn:hover { background:#28a745; color:white; }',
        '.corrector-cancel-btn {',
        '  cursor:pointer; padding:7px 14px; border:1.5px solid #ccc;',
        '  background:#f5f5f5; color:#444; border-radius:5px; font-size:13px;',
        '  transition:background .15s; margin-left:auto;',
        '}',
        '.corrector-cancel-btn:hover { background:#e8e8e8; }',
        '.corrector-toast {',
        '  position:fixed; bottom:24px; right:24px; background:#28a745; color:white;',
        '  padding:10px 20px; border-radius:6px;',
        '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;',
        '  font-size:13px; font-weight:500; z-index:2147483647;',
        '  box-shadow:0 4px 12px rgba(0,0,0,.2); transition:opacity .4s, transform .4s;',
        '  animation:corrector-pop .2s ease-out;',
        '}',
        '.corrector-toast-fade { opacity:0; transform:translateY(6px); }',
      ].join('\n');
      (document.head || document.documentElement).appendChild(style);
    }
  };

  TextCorrector.init();
})();
