# Analyse du code existant

## Fonctionnement actuel

- La sélection est capturée par `getSelectionContext()`, qui privilégie les champs actifs `input`/`textarea` via `selectionStart` et `selectionEnd`, puis les sélections DOM via un `Range` cloné.
- La bulle "Corriger" est affichée par `_checkSelectionAndShowPill()` et `showPill()` (souris, tactile, clavier dont Ctrl+A). Elle mémorise le contexte de sélection pour éviter de relire une sélection perdue au clic.
- Un garde temporel (`MENU_OPEN_CLICK_GUARD_MS`) empêche la fermeture immédiate du panneau au clic qui suit l'ouverture depuis la bulle.
- L'appel LanguageTool est construit dans `buildLanguageToolPayload()` puis envoyé via `GM_xmlhttpRequest` vers `https://api.languagetool.org/v2/check`, avec `User-Agent` applicatif, timeout, limite de taille, quota local requêtes + octets/min, cooldown sur `429` et messages d'erreur dédiés.
- La langue privilégie le `lang` du champ / ancêtre ; sinon `language=auto` (pas le `lang` global de la page).
- Les réponses LanguageTool passent par `normalizeLanguageToolMatches()`, `prepareMatches()`, `shouldKeepMatchInfo()`, `pickReplacement()` et `applyMatches()`.
- Les `@mentions`, `#hashtags`, URLs, emails et fragments inline sensibles sont protégés ; les champs `password` / email / tel / paiement / autocomplete sensibles sont exclus.
- Le cache persistant (`GM_setValue`) sanitise les matches (pas de `context.text`) avec TTL 7 jours et LRU 200.
- Les réglages et la position du panneau passent par le stockage Violentmonkey, avec repli `localStorage`.
- Remplacement : `input`/`textarea` (setter natif), `contenteditable` (range / `insertText`, sans hack fibres Draft.js), texte statique, sinon fallback Copier dans le Shadow DOM.
- Interface Shadow DOM compacte (host 0×0), `lang="fr"`, zones scrollables au clavier, boutons de position, toast undo plus long.

## Points forts

- Flux critique cohérent : contexte → LanguageTool → filtrage → affichage → application / Copier.
- Pas d'écriture dangereuse sans vérification du texte original.
- Modes `Chat`, `Équilibré`, `Strict` distincts.
- Tests sans appel réseau réel, y compris langue, cache sanitisé, garde d'ouverture.

## Risques restants / limites

- Les éditeurs riches restent partiellement incompatibles ; le fallback Copier reste nécessaire.
- `@noframes` : pas d'exécution dans les iframes (Google Docs, etc.).
- Pas de suite e2e navigateur : les courses souris/SPA restent à valider manuellement.
- Le CSS conserve encore deux couches historiques (base + polish) ; un nettoyage total est possible mais non bloquant.
