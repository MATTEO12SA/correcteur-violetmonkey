// ==UserScript==
// @name           Correcteur de Phrases
// @namespace      http://violetmonkey.net/
// @version        4.0.0
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

  const STORAGE_KEY = '_corrector_pos';

  const TextCorrector = {
    selectedText:  '',
    selectedRange: null,
    menu:          null,
    pill:          null,
    currentRequest: null,
    styleEl:       null,
    previousFocus: null,

    // ─────────────────────────────────────────────
    // Init
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
      const wrap = (fn) => function (...a) {
        const r = fn.apply(this, a);
        window.dispatchEvent(new Event('_corrector_nav'));
        return r;
      };
      history.pushState    = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
      window.addEventListener('popstate',       () => window.dispatchEvent(new Event('_corrector_nav')));
      window.addEventListener('_corrector_nav', () => { this.hidePill(); this.closeMenu(); });

      const obs = new MutationObserver(() => {
        if (this.styleEl && !document.contains(this.styleEl)) this.injectStyles();
      });
      obs.observe(document.head || document.documentElement, { childList: true });
    },

    // ─────────────────────────────────────────────
    // Bulle flottante
    // ─────────────────────────────────────────────
    handleMouseUp(e) {
      if (this.menu?.contains(e.target)) return;
      if (this.pill?.contains(e.target)) return;
      setTimeout(() => {
        const sel  = window.getSelection();
        const text = sel ? sel.toString().trim() : '';
        if (!text || text.length < 3) { this.hidePill(); return; }
        const range = sel.getRangeAt(0);
        const rect  = range.getBoundingClientRect();
        if (!rect.width && !rect.height) { this.hidePill(); return; }
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

      const pW = 112, pH = 30, gap = 8;
      let x = rect.left + rect.width / 2 - pW / 2 + window.scrollX;
      let y = rect.top - pH - gap + window.scrollY;
      if (rect.top - pH - gap < 0) y = rect.bottom + gap + window.scrollY;
      x = Math.max(8, Math.min(x, window.innerWidth - pW - 8));

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
      const sel  = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (!text) return;

      this.selectedText  = text;
      this.previousFocus = document.activeElement;
      this.selectedRange = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

      const pillRect = this.pill ? this.pill.getBoundingClientRect() : null;
      const savedPos = this.loadPosition();

      this.hidePill();
      this.createMenu(
        savedPos ? savedPos.x : (pillRect ? pillRect.left : 80),
        savedPos ? savedPos.y : (pillRect ? pillRect.bottom + 10 : 80)
      );
      this.fetchCorrection(text);
    },

    // ─────────────────────────────────────────────
    // API LanguageTool
    // ─────────────────────────────────────────────
    fetchCorrection(text) {
      if (!this.menu) return;
      if (this.currentRequest) { this.currentRequest.abort(); this.currentRequest = null; }

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
          try { this.renderCorrection(text, JSON.parse(res.responseText).matches || []); }
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
          const el = this.menu && this.menu.querySelector('.corrector-correction-content');
          if (el) el.textContent = 'Delai depasse. Reessayez.';
        },
      });
    },

    setLoadingState(loading) {
      if (!this.menu) return;
      const el = this.menu.querySelector('.corrector-correction-content');
      if (!el) return;
      if (loading) {
        el.innerHTML = '<span class="corrector-spinner" aria-hidden="true"></span><span>Correction en cours\u2026</span>';
      }
    },

    showCorrectionError() {
      const el = this.menu && this.menu.querySelector('.corrector-correction-content');
      if (el) el.textContent = '\u26A0 Erreur : impossible de corriger.';
    },

    // ─────────────────────────────────────────────
    // Rendu du diff
    // ─────────────────────────────────────────────
    renderCorrection(text, matches) {
      if (!this.menu) return;

      const valid     = matches.filter(m => m.replacements && m.replacements.length > 0);
      const corrected = this.applyMatches(text, valid);

      // Badge erreurs
      if (valid.length > 0) {
        const badge = document.createElement('span');
        badge.className   = 'corrector-badge';
        badge.textContent = valid.length + ' erreur' + (valid.length > 1 ? 's' : '');
        this.menu.querySelector('.corrector-title').appendChild(badge);
      }

      // Texte original avec erreurs soulignées
      const origEl = this.menu.querySelector('.corrector-original-content');
      origEl.replaceChildren(...this.buildSpans(text, valid, (m) => {
        const s = document.createElement('span');
        s.className   = 'corrector-error';
        s.title       = m.message || '';
        s.textContent = text.slice(m.offset, m.offset + m.length);
        return s;
      }));

      // Correction
      const corrEl = this.menu.querySelector('.corrector-correction-content');
      if (corrected === text) {
        corrEl.innerHTML = '<span class="corrector-ok">\u2713 Aucune correction n\u00e9cessaire</span>';
      } else {
        corrEl.replaceChildren(...this.buildSpans(text, valid, (m) => {
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

    buildSpans(text, matches, makeSpan) {
      const nodes  = [];
      let cursor   = 0;
      const sorted = matches.slice().sort((a, b) => a.offset - b.offset);
      for (const m of sorted) {
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
      for (const m of matches.slice().sort((a, b) => b.offset - a.offset))
        r = r.slice(0, m.offset) + m.replacements[0].value + r.slice(m.offset + m.length);
      return r;
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
        '<div class="corrector-header" title="Maintenir pour deplacer">',
        '  <span class="corrector-title" id="corrector-title">\u270E Correcteur</span>',
        '  <button class="corrector-close-btn" aria-label="Fermer">\u2715</button>',
        '</div>',
        '<div class="corrector-section">',
        '  <div class="corrector-label">Texte selectionne</div>',
        '  <div class="corrector-original-content"></div>',
        '</div>',
        '<div class="corrector-section">',
        '  <div class="corrector-label">Correction suggeree</div>',
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
      menu.style.left = Math.max(0, Math.min(x, window.innerWidth  - 300)) + 'px';
      menu.style.top  = Math.max(0, Math.min(y, window.innerHeight - 200)) + 'px';

      // Boutons
      menu.querySelector('.corrector-apply-btn').addEventListener('click', (e) => {
        const c = e.currentTarget.dataset.corrected;
        if (c) this.applyCorrection(c);
      });
      menu.querySelector('.corrector-copy-btn').addEventListener('click', (e) => {
        const txt = e.currentTarget.dataset.text;
        if (!txt) return;
        const btn = e.currentTarget;
        navigator.clipboard.writeText(txt).then(() => {
          btn.textContent = '\u2713 Copie';
          setTimeout(() => { btn.textContent = 'Copier'; }, 1500);
        }).catch(() => {});
      });
      const close = () => this.closeMenu();
      menu.querySelector('.corrector-cancel-btn').addEventListener('click', close);
      menu.querySelector('.corrector-close-btn').addEventListener('click',  close);
      menu.addEventListener('keydown', (e) => this.handleMenuKeyDown(e));

      document.body.appendChild(menu);
      this.menu = menu;

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

      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.corrector-close-btn')) return;
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
    // Remplacement du texte — FIX saut de ligne
    // ─────────────────────────────────────────────
    applyCorrection(corrected) {
      if (!this.selectedRange) { this.closeMenu(); return; }

      try {
        // 1. Rétablir la sélection à partir du range mémorisé
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(this.selectedRange);
        }

        // 2. Essayer execCommand (meilleure compatibilité contenteditable)
        if (document.execCommand && document.execCommand('insertText', false, corrected)) {
          this.closeMenu();
          this.showConfirmation();
          return;
        }

        // 3. Fallback : manipulation de Range
        this.selectedRange.deleteContents();
        const textNode = document.createTextNode(corrected);
        this.selectedRange.insertNode(textNode);

        // Placer le curseur APRES le texte inséré (évite les sauts de ligne)
        const newRange = document.createRange();
        newRange.setStartAfter(textNode);
        newRange.collapse(true);
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(newRange);
        }

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
      toast.textContent = '\u2713 Correction appliquee';
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.classList.add('corrector-toast-fade');
        setTimeout(() => toast.remove(), 400);
      }, 1800);
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
      style.textContent = `
        @keyframes corrector-pop  { from{opacity:0;transform:scale(.93) translateY(-6px)} to{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes corrector-spin { to{transform:rotate(360deg)} }

        /* ── Bulle ── */
        .corrector-pill {
          position: absolute;
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
        .corrector-badge {
          font-size: 11px;
          background: #ef4444;
          color: #fff;
          border-radius: 999px;
          padding: 1px 7px;
          font-weight: 600;
        }
        .corrector-close-btn {
          background: none; border: none; cursor: pointer;
          font-size: 15px; color: #9ca3af; border-radius: 6px;
          padding: 2px 6px; line-height: 1;
          transition: background .15s, color .15s;
        }
        .corrector-close-btn:hover { background: #f3f4f6; color: #374151; }

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
          .corrector-close-btn          { color:#71717a; }
          .corrector-close-btn:hover    { background:#3f3f46; color:#f4f4f5; }
          .corrector-label              { color:#71717a; }
          .corrector-original-content   { background:#27272a; border-color:#3f3f46; color:#a1a1aa; }
          .corrector-correction-content { background:#1e3a5f; border-color:#1d4ed8; color:#93c5fd; }
          .corrector-cancel-btn         { background:#27272a; border-color:#3f3f46; color:#d4d4d8; }
          .corrector-cancel-btn:hover   { background:#3f3f46; }
          .corrector-actions            { border-color:#3f3f46; }
        }

        /* Toast */
        .corrector-toast {
          position: fixed; bottom: 24px; right: 24px;
          background: #16a34a; color: #fff;
          padding: 10px 20px; border-radius: 8px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          font-size: 13px; font-weight: 600;
          z-index: 2147483647;
          box-shadow: 0 4px 14px rgba(0,0,0,.2);
          transition: opacity .4s, transform .4s;
          animation: corrector-pop .2s ease-out;
        }
        .corrector-toast-fade { opacity: 0; transform: translateY(8px); }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  };

  TextCorrector.init();
})();
