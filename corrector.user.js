// ==UserScript==
// @name           Correcteur de Phrases
// @namespace      http://violetmonkey.net/
// @version        4.2.7
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
  const DEBUG = true;
  const _logs = [];

  const dbg = (...a) => {
    if (!DEBUG) return;
    const line = a.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    _logs.push(new Date().toISOString().slice(11, 23) + ' ' + line);
  };

  // Snapshot complet de l'état du DOM + sélection à un instant T
  const snap = (label, el) => {
    if (!DEBUG) return;
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
    if (!DEBUG) return;
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

  // Surveille les events clavier + input sur un élément pendant N ms puis télécharge
  const watchKeys = (el, ms) => {
    if (!DEBUG) return;
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
    if (!_logs.length) return;
    const blob = new Blob([_logs.join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'correcteur-debug.txt'; a.click();
    URL.revokeObjectURL(url);
  };

  const TextCorrector = {
    selectedText:   '',
    selectedRange:  null,
    savedInputSel:  null,   // { start, end } capturé au déclenchement pour input/textarea
    menu:           null,
    pill:           null,
    currentRequest: null,
    styleEl:        null,
    previousFocus:  null,
    lastApply:      null,   // données pour le bouton Annuler
    _selChangeTid:  null,

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
      setTimeout(() => this._checkSelectionAndShowPill(), 10);
    },

    // Affiche la bulle après sélection clavier (Shift+flèche, Shift+End, etc.)
    handleKeyUp(e) {
      if (!e.shiftKey) return;
      setTimeout(() => this._checkSelectionAndShowPill(), 10);
    },

    _checkSelectionAndShowPill() {
      const sel  = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (!text || text.length < 3) { this.hidePill(); return; }
      if (sel.rangeCount === 0) { this.hidePill(); return; }
      const range = sel.getRangeAt(0);
      const rect  = range.getBoundingClientRect();
      if (!rect.width && !rect.height) { this.hidePill(); return; }
      this.showPill(rect);
    },

    // Debounce : selectionchange se déclenche à chaque frappe sur toute la page
    handleSelectionChange() {
      clearTimeout(this._selChangeTid);
      this._selChangeTid = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || !sel.toString().trim()) this.hidePill();
      }, 80);
    },

    showPill(rect) {
      this.hidePill();
      const pill = document.createElement('button');
      pill.className = 'corrector-pill';
      pill.setAttribute('aria-label', 'Corriger le texte sélectionné');
      pill.textContent = '\u270E Corriger';

      // position:fixed → coordonnées viewport directes (getBoundingClientRect déjà relatives au viewport)
      const pW = 112, pH = 30, gap = 8;
      let x = rect.left + rect.width / 2 - pW / 2;
      let y = rect.top - pH - gap;
      if (rect.top - pH - gap < 0) y = rect.bottom + gap;
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

      // Capture la position curseur input/textarea au moment du clic sur la bulle.
      // Ne pas la relire dans applyCorrection : le curseur peut avoir bougé pendant la lecture du panneau.
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') &&
          typeof ae.selectionStart === 'number') {
        this.savedInputSel = { start: ae.selectionStart, end: ae.selectionEnd };
      } else {
        this.savedInputSel = null;
      }

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
          this.showCorrectionError('Délai dépassé.');
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

    showCorrectionError(msg) {
      const el = this.menu && this.menu.querySelector('.corrector-correction-content');
      if (!el) return;
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
        const ok = document.createElement('span');
        ok.className   = 'corrector-ok';
        ok.textContent = '\u2713 Aucune correction nécessaire';
        corrEl.replaceChildren(ok);
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
        if (m.offset < cursor) continue; // ignore les matches qui chevauchent le précédent
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
      let boundary = text.length; // frontière basse : ne pas toucher ce qui a déjà été remplacé
      for (const m of matches.slice().sort((a, b) => b.offset - a.offset)) {
        if (m.offset + m.length > boundary) continue; // chevauche un remplacement précédent
        r = r.slice(0, m.offset) + m.replacements[0].value + r.slice(m.offset + m.length);
        boundary = m.offset;
      }
      return r;
    },

    // Vérifie que la range sauvegardée pointe toujours vers le bon texte dans le DOM
    isRangeValid() {
      if (!this.selectedRange) return false;
      const sc = this.selectedRange.startContainer;
      const ec = this.selectedRange.endContainer;
      if (!sc.isConnected || !ec.isConnected) return false;
      if (this.selectedRange.toString() !== this.selectedText) return false;
      return true;
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
        '  <button class="corrector-close-btn" aria-label="Fermer">\u2715</button>',
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
        DEBUG ? '  <button class="corrector-debug-btn">Logs</button>' : '',
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
      if (DEBUG) menu.querySelector('.corrector-debug-btn')?.addEventListener('click', () => downloadLogs());
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

      // Nettoyage si le menu est fermé pendant un drag (évite des listeners fantômes)
      menu._dragCleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
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
    // Remplacement du texte
    // 3 stratégies selon le type d'élément cible
    // ─────────────────────────────────────────────
    applyCorrection(corrected) {
      if (!this.selectedRange) { this.showApplyError('Sélection perdue. Resélectionnez le texte.'); return; }

      try {
        const anchor = this.selectedRange.commonAncestorContainer;
        const parent = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
        const sel    = window.getSelection();

        // ── Cas 1 : <input> ou <textarea> ──────────
        const inputEl = parent && parent.closest('input, textarea');
        if (inputEl && typeof inputEl.selectionStart === 'number') {
          // Utilise la sélection capturée au déclenchement (pas la position courante qui a pu bouger)
          const start = this.savedInputSel ? this.savedInputSel.start : inputEl.selectionStart;
          const end   = this.savedInputSel ? this.savedInputSel.end   : inputEl.selectionEnd;
          const originalValue = inputEl.value;
          inputEl.setRangeText(corrected, start, end, 'end');
          inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
          this.lastApply = { type: 'input', el: inputEl, originalValue, start, end };
          this.closeMenu();
          inputEl.focus();
          this.showConfirmation(true);
          return;
        }

        // ── Cas 2 : contenteditable ─────────────────
        const editableEl = parent && parent.closest('[contenteditable="true"], [contenteditable=""]');
        if (editableEl) {
          snap('A_avant_tout', editableEl);
          if (!this.isRangeValid()) {
            this.showApplyError('Le texte a changé depuis la sélection. Resélectionnez.');
            return;
          }
          editableEl.focus();
          snap('B_focus_done', editableEl);
          watchMutations(editableEl, 8000);
          watchKeys(editableEl, 8000);

          // ── Stratégie : selectAll → paste ───────────────────────────────────
          // Draft.js utilise son SelectionState INTERNE pour le paste (pas window.getSelection).
          // addRange() ne suffit pas : Draft.js override la sélection DOM via son onFocus.
          // execCommand('selectAll') met à jour à la fois le DOM ET le SelectionState de Draft.js
          // via le selectionchange qu'il émet, que Draft.js traite de façon native.
          // Étape 1 : laisser Draft.js finir son cycle onFocus (~30 ms)
          setTimeout(() => {
            document.execCommand('selectAll');
            snap('B2_apres_selectAll', editableEl);

            // Étape 2 : laisser Draft.js traiter le selectionchange de selectAll (~20 ms)
            setTimeout(() => {
              snap('B3_avant_paste', editableEl);
              let handled = false;
              try {
                const dt = new DataTransfer();
                dt.setData('text/plain', corrected);
                // Pas de text/html : Draft.js parserait le HTML et casserait le texte brut
                const pasteEvt = new ClipboardEvent('paste', {
                  bubbles: true, cancelable: true, clipboardData: dt,
                });
                handled = !editableEl.dispatchEvent(pasteEvt);
                snap('C_paste_dispatched_handled=' + handled, editableEl);
              } catch (err) {
                dbg('paste dispatch error: ' + err.message);
              }

              // ── Fallback execCommand ─────────────────────────────────────────
              if (!handled) {
                const execOk = document.execCommand('insertText', false, corrected);
                snap('D_execCommand_ok=' + execOk, editableEl);
              }

              this.lastApply = { type: 'contenteditable' };
              editableEl.focus();
              this.closeMenu();
              snap('E_apres_closeMenu', editableEl);
              this.showConfirmation(false);
            }, 20);
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
        const textNode = document.createTextNode(corrected);
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
      if (this.menu) {
        if (typeof this.menu._dragCleanup === 'function') this.menu._dragCleanup();
        this.menu.remove();
        this.menu = null;
        if (this.previousFocus && typeof this.previousFocus.focus === 'function') this.previousFocus.focus();
        this.previousFocus = null;
        this.selectedRange = null;
        this.savedInputSel = null;
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
          .corrector-close-btn          { color:#71717a; }
          .corrector-close-btn:hover    { background:#3f3f46; color:#f4f4f5; }
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
