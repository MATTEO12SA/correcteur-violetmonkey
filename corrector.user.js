// ==UserScript==
// @name           Correcteur de Phrases
// @namespace      http://violetmonkey.net/
// @version        2.1.0
// @description    Corrige automatiquement les phrases sélectionnées via LanguageTool
// @author
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
    currentRequest: null,
    styleEl: null,

    // ─────────────────────────────────────────────
    // Initialisation
    // ─────────────────────────────────────────────
    init() {
      document.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
      document.addEventListener('click',       (e) => this.handleOutsideClick(e));
      document.addEventListener('keydown',     (e) => this.handleKeyDown(e));
      this.injectStyles();
      this.watchNavigation();
    },

    // ─────────────────────────────────────────────
    // Support SPA (Facebook, Instagram, Twitter…)
    // ─────────────────────────────────────────────
    watchNavigation() {
      // Intercepte pushState / replaceState (navigation programmatique)
      const wrap = (original) => function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event('_corrector_nav'));
        return result;
      };
      history.pushState    = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);

      // Navigation arrière / avant
      window.addEventListener('popstate',       () => window.dispatchEvent(new Event('_corrector_nav')));
      window.addEventListener('_corrector_nav', () => this.onNavigate());

      // Surveille si notre <style> est supprimé du <head> par le SPA
      const observer = new MutationObserver(() => {
        if (this.styleEl && !document.contains(this.styleEl)) {
          this.injectStyles();
        }
      });
      observer.observe(document.head || document.documentElement, {
        childList: true,
        subtree: false,
      });
    },

    onNavigate() {
      this.closeMenu();
      if (this.styleEl && !document.contains(this.styleEl)) {
        this.injectStyles();
      }
    },

    // ─────────────────────────────────────────────
    // Module 1 : Détection de la sélection
    // ─────────────────────────────────────────────
    handleContextMenu(event) {
      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : '';

      if (!text || text.length < 3) {
        this.closeMenu();
        return;
      }

      event.preventDefault();

      this.selectedText = text;
      this.selectedRange = (selection.rangeCount > 0)
        ? selection.getRangeAt(0).cloneRange()
        : null;

      this.createMenu(event.clientX, event.clientY);
      this.fetchCorrection(text);
    },

    // ─────────────────────────────────────────────
    // Module 2 : Correction via LanguageTool
    // GM_xmlhttpRequest bypass le CSP des sites
    // ─────────────────────────────────────────────
    fetchCorrection(text) {
      if (!this.menu) return;

      if (this.currentRequest) {
        this.currentRequest.abort();
        this.currentRequest = null;
      }

      this.currentRequest = GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.languagetoolplus.com/v2/check',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({ text, language: 'auto' }).toString(),
        timeout: 10000,

        onload: (response) => {
          this.currentRequest = null;
          if (!this.menu) return;

          if (response.status < 200 || response.status >= 300) {
            this.showCorrectionError();
            return;
          }
          try {
            const data = JSON.parse(response.responseText);
            this.renderCorrection(text, data.matches || []);
          } catch {
            this.showCorrectionError();
          }
        },

        onerror: () => {
          this.currentRequest = null;
          if (this.menu) this.showCorrectionError();
        },

        ontimeout: () => {
          this.currentRequest = null;
          const el = this.menu?.querySelector('.corrector-correction-content');
          if (el) el.textContent = 'Délai dépassé. Réessayez.';
        },
      });
    },

    showCorrectionError() {
      const el = this.menu?.querySelector('.corrector-correction-content');
      if (el) el.textContent = 'Erreur : impossible de corriger le texte.';
    },

    // ─────────────────────────────────────────────
    // Rendu du diff : erreurs rouge / corrections vert
    // ─────────────────────────────────────────────
    renderCorrection(text, matches) {
      if (!this.menu) return;

      const validMatches = matches.filter(m => m.replacements?.length > 0);
      const corrected = this.applyMatches(text, validMatches);

      // Badge avec le nombre d'erreurs
      const header = this.menu.querySelector('.corrector-header');
      if (validMatches.length > 0) {
        const badge = document.createElement('span');
        badge.className = 'corrector-badge';
        badge.textContent = `${validMatches.length} erreur${validMatches.length > 1 ? 's' : ''}`;
        header.appendChild(badge);
      }

      // Original : segments erronés surlignés en rouge
      const originalEl = this.menu.querySelector('.corrector-original-content');
      originalEl.replaceChildren(
        ...this.buildSpans(text, validMatches, (m) => {
          const span = document.createElement('span');
          span.className = 'corrector-error';
          span.title = m.message || '';
          span.textContent = text.slice(m.offset, m.offset + m.length);
          return span;
        })
      );

      // Correction : segments corrigés surlignés en vert
      const correctionEl = this.menu.querySelector('.corrector-correction-content');
      if (corrected === text) {
        correctionEl.textContent = '✓ Aucune correction nécessaire';
      } else {
        correctionEl.replaceChildren(
          ...this.buildSpans(text, validMatches, (m) => {
            const span = document.createElement('span');
            span.className = 'corrector-fix';
            span.textContent = m.replacements[0].value;
            return span;
          })
        );

        const applyBtn = this.menu.querySelector('.corrector-apply-btn');
        applyBtn.disabled = false;
        applyBtn.dataset.corrected = corrected;

        const copyBtn = this.menu.querySelector('.corrector-copy-btn');
        copyBtn.style.display = 'inline-block';
        copyBtn.dataset.text = corrected;
      }
    },

    // Construit un tableau de nœuds DOM en alternant texte normal et spans pour chaque match
    buildSpans(text, matches, makeSpan) {
      const nodes = [];
      let cursor = 0;
      const sorted = [...matches].sort((a, b) => a.offset - b.offset);

      for (const match of sorted) {
        if (match.offset > cursor) {
          nodes.push(document.createTextNode(text.slice(cursor, match.offset)));
        }
        nodes.push(makeSpan(match));
        cursor = match.offset + match.length;
      }

      if (cursor < text.length) {
        nodes.push(document.createTextNode(text.slice(cursor)));
      }

      return nodes;
    },

    applyMatches(text, matches) {
      if (!matches.length) return text;
      const sorted = [...matches].sort((a, b) => b.offset - a.offset);
      let result = text;
      for (const match of sorted) {
        const rep = match.replacements[0].value;
        result = result.slice(0, match.offset) + rep + result.slice(match.offset + match.length);
      }
      return result;
    },

    // ─────────────────────────────────────────────
    // Module 3 : Menu contextuel
    // ─────────────────────────────────────────────
    createMenu(x, y) {
      this.closeMenu();

      const menu = document.createElement('div');
      menu.className = 'text-corrector-menu';

      menu.innerHTML = `
        <div class="corrector-header">✎ Correcteur de Phrases</div>
        <div class="corrector-section">
          <div class="corrector-label">Texte sélectionné :</div>
          <div class="corrector-original-content"></div>
        </div>
        <div class="corrector-section">
          <div class="corrector-label">Correction suggérée :</div>
          <div class="corrector-correction-content">Correction en cours…</div>
        </div>
        <div class="corrector-actions">
          <button class="corrector-apply-btn" disabled>Appliquer</button>
          <button class="corrector-copy-btn" style="display:none">Copier</button>
          <button class="corrector-cancel-btn">Annuler</button>
        </div>
      `;

      // textContent → pas de XSS
      menu.querySelector('.corrector-original-content').textContent = this.selectedText;

      menu.style.left = x + 'px';
      menu.style.top  = y + 'px';

      menu.querySelector('.corrector-apply-btn').addEventListener('click', (e) => {
        const corrected = e.currentTarget.dataset.corrected;
        if (corrected) this.applyCorrection(corrected);
      });

      menu.querySelector('.corrector-copy-btn').addEventListener('click', (e) => {
        const txt = e.currentTarget.dataset.text;
        if (!txt) return;
        navigator.clipboard.writeText(txt).then(() => {
          e.currentTarget.textContent = '✓ Copié';
          setTimeout(() => { e.currentTarget.textContent = 'Copier'; }, 1500);
        }).catch(() => {});
      });

      menu.querySelector('.corrector-cancel-btn').addEventListener('click', () => this.closeMenu());

      document.body.appendChild(menu);
      this.menu = menu;

      requestAnimationFrame(() => this.adjustMenuPosition(menu));
    },

    adjustMenuPosition(menu) {
      const rect = menu.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (rect.right  > vw) menu.style.left = Math.max(0, vw - rect.width  - 10) + 'px';
      if (rect.bottom > vh) menu.style.top  = Math.max(0, vh - rect.height - 10) + 'px';
    },

    // ─────────────────────────────────────────────
    // Module 4 : Remplacement du texte
    // ─────────────────────────────────────────────
    applyCorrection(corrected) {
      if (!this.selectedRange) { this.closeMenu(); return; }

      try {
        this.selectedRange.deleteContents();
        this.selectedRange.insertNode(document.createTextNode(corrected));
        window.getSelection()?.removeAllRanges();
        this.closeMenu();
        this.showConfirmation();
      } catch (err) {
        console.error('[Correcteur] Impossible de remplacer le texte :', err);
        this.closeMenu();
      }
    },

    showConfirmation() {
      const toast = document.createElement('div');
      toast.className = 'corrector-toast';
      toast.textContent = '✓ Correction appliquée';
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.classList.add('corrector-toast-fade');
        setTimeout(() => toast.remove(), 400);
      }, 1800);
    },

    // ─────────────────────────────────────────────
    // Module 5 : Gestion des événements
    // ─────────────────────────────────────────────
    handleOutsideClick(event) {
      if (this.menu && !this.menu.contains(event.target)) this.closeMenu();
    },

    handleKeyDown(event) {
      if (event.key === 'Escape') this.closeMenu();
    },

    closeMenu() {
      if (this.currentRequest) {
        this.currentRequest.abort();
        this.currentRequest = null;
      }
      if (this.menu) {
        this.menu.remove();
        this.menu = null;
      }
    },

    // ─────────────────────────────────────────────
    // Styles CSS
    // ─────────────────────────────────────────────
    injectStyles() {
      const style = document.createElement('style');
      this.styleEl = style;
      style.textContent = `
        .text-corrector-menu {
          position: fixed;
          background: #fff;
          border: 2px solid #333;
          border-radius: 8px;
          padding: 12px 14px;
          z-index: 2147483647;
          font-family: Arial, sans-serif;
          font-size: 13px;
          box-shadow: 0 6px 20px rgba(0,0,0,0.25);
          max-width: 440px;
          min-width: 280px;
          color: #222;
        }

        @media (prefers-color-scheme: dark) {
          .text-corrector-menu {
            background: #1e1e1e;
            border-color: #555;
            color: #e0e0e0;
            box-shadow: 0 6px 20px rgba(0,0,0,0.6);
          }
          .corrector-header { color: #4da6ff !important; border-color: #444 !important; }
          .corrector-label  { color: #888 !important; }
          .corrector-original-content  { background: #2a2a2a !important; border-color: #444 !important; color: #bbb !important; }
          .corrector-correction-content { background: #1a2a3a !important; border-color: #2a5a8a !important; color: #a8d4ff !important; }
          .corrector-cancel-btn { background: #2a2a2a !important; border-color: #555 !important; color: #ccc !important; }
          .corrector-cancel-btn:hover { background: #3a3a3a !important; }
        }

        .corrector-header {
          font-weight: bold;
          font-size: 14px;
          margin-bottom: 10px;
          color: #0056b3;
          border-bottom: 1px solid #ddd;
          padding-bottom: 6px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .corrector-badge {
          font-size: 11px;
          background: #e74c3c;
          color: white;
          border-radius: 10px;
          padding: 2px 8px;
          font-weight: normal;
        }

        .corrector-section { margin-bottom: 10px; }

        .corrector-label {
          font-size: 11px;
          font-weight: bold;
          text-transform: uppercase;
          color: #888;
          margin-bottom: 3px;
        }

        .corrector-original-content,
        .corrector-correction-content {
          border-radius: 3px;
          padding: 6px 8px;
          max-height: 100px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
          line-height: 1.6;
        }

        .corrector-original-content {
          background: #f8f8f8;
          border: 1px solid #ddd;
          color: #555;
          font-style: italic;
        }

        .corrector-correction-content {
          background: #eaf4ff;
          border: 1px solid #b3d4f0;
          color: #003a70;
          font-weight: 500;
        }

        /* Mot erroné : fond rouge + soulignement ondulé */
        .corrector-error {
          background: #ffe5e5;
          color: #c0392b;
          border-radius: 2px;
          text-decoration: underline wavy #e74c3c;
          padding: 0 1px;
          cursor: help;
        }

        /* Mot corrigé : fond vert */
        .corrector-fix {
          background: #d4f5d4;
          color: #1a6b1a;
          border-radius: 2px;
          font-weight: bold;
          padding: 0 1px;
        }

        .corrector-actions {
          display: flex;
          gap: 8px;
          margin-top: 8px;
          align-items: center;
          flex-wrap: wrap;
        }

        .corrector-apply-btn {
          cursor: pointer;
          padding: 6px 14px;
          border: none;
          background: #007bff;
          color: white;
          border-radius: 4px;
          font-size: 13px;
          transition: background 0.15s;
        }
        .corrector-apply-btn:hover:not(:disabled) { background: #0056b3; }
        .corrector-apply-btn:disabled { background: #aaa; cursor: default; }

        .corrector-copy-btn {
          cursor: pointer;
          padding: 6px 14px;
          border: 1px solid #28a745;
          background: transparent;
          color: #28a745;
          border-radius: 4px;
          font-size: 13px;
          transition: background 0.15s, color 0.15s;
        }
        .corrector-copy-btn:hover { background: #28a745; color: white; }

        .corrector-cancel-btn {
          cursor: pointer;
          padding: 6px 14px;
          border: 1px solid #aaa;
          background: #f0f0f0;
          color: #333;
          border-radius: 4px;
          font-size: 13px;
          transition: background 0.15s;
          margin-left: auto;
        }
        .corrector-cancel-btn:hover { background: #ddd; }

        .corrector-toast {
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: #28a745;
          color: white;
          padding: 10px 18px;
          border-radius: 5px;
          font-family: Arial, sans-serif;
          font-size: 13px;
          z-index: 2147483647;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
          transition: opacity 0.4s;
        }
        .corrector-toast-fade { opacity: 0; }
      `;
      (document.head || document.documentElement).appendChild(style);
    }
  };

  TextCorrector.init();
})();
