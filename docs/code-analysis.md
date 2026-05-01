# Analyse du code existant

## Fonctionnement actuel

- La sélection est capturée par `getSelectionContext()`, qui privilégie les champs actifs `input`/`textarea` via `selectionStart` et `selectionEnd`, puis les sélections DOM via un `Range` cloné.
- La bulle "Corriger" est affichée par `_checkSelectionAndShowPill()` et `showPill()`. Elle mémorise le contexte de sélection pour éviter de relire une sélection perdue au clic.
- L'appel LanguageTool est construit dans `buildLanguageToolPayload()` puis envoyé via `GM_xmlhttpRequest` vers `https://api.languagetool.org/v2/check`, avec timeout, limite de taille, cooldown sur `429` et messages d'erreur dédiés.
- Les réponses LanguageTool passent par `prepareMatches()`, `shouldKeepMatchInfo()`, `pickReplacement()` et `applyMatches()` pour trier les suggestions, éviter les chevauchements et appliquer les corrections de la fin vers le début du texte.
- Les `@mentions`, `#hashtags`, URLs, emails et fragments inline sensibles sont détectés par `analyzeSelectionText()` puis protégés avec des plages interdites aux remplacements.
- Le diff visuel est généré dans le panneau Shadow DOM avec les classes `corrector-error` et `corrector-fix`.
- Le bouton "Appliquer" utilise `applyCorrectionToSelection()` puis des branches dédiées pour `input`/`textarea`, `contenteditable` et texte statique.
- Le bouton "Copier" et le fallback utilisent `copyTextToClipboard()`, qui tente `navigator.clipboard`, `GM_setClipboard`, puis un `textarea` temporaire avec `execCommand('copy')`.
- Le cache persistant repose sur `GM_setValue` / `GM_getValue`, une clé compacte incluant site, mode, langue, profil, longueur et hash FNV-1a, avec TTL de 7 jours et limite LRU à 200 entrées.
- La compatibilité SPA est gérée par le patch `history.pushState` / `replaceState`, `popstate` et un `MutationObserver` qui recrée le Shadow DOM si le site supprime le conteneur.
- L'interface est isolée en Shadow DOM, avec panneau déplaçable, état visuel, rôles ARIA, focus trap, responsive mobile et dark mode.

## Points forts

- Le flux critique est déjà cohérent : capture de contexte, correction LanguageTool, filtrage, affichage, application et fallback copie.
- Le remplacement automatique évite les écritures dangereuses en vérifiant le texte original avant de modifier le DOM.
- Les modes `Chat`, `Équilibré` et `Strict` ont des règles serveur et client distinctes.
- Les appels réseau et le cache sont testables sans appel réel à LanguageTool.
- Les tests existants couvrent déjà les protections inline, les corrections simulées, les modes, le cache et une partie du remplacement automatique.

## Points faibles

- La bulle de sélection se repositionnait surtout à partir de `window.getSelection()`. Pour une sélection dans `input` ou `textarea`, ce signal peut être absent, donc la bulle pouvait disparaître au scroll alors que le contexte mémorisé était encore valide.
- Les éditeurs riches restent difficiles à traiter : un `Range` cloné peut devenir invalide si l'éditeur réécrit son DOM entre la sélection et le clic.
- Les vrais éditeurs React/Vue/Svelte nécessitent encore des tests manuels navigateur, car la suite Node ne simule pas un DOM complet.
- Le fallback copie était robuste techniquement, mais le message d'échec automatique pouvait être plus direct pour l'utilisateur.

## Parties à améliorer en priorité

- Conserver la stabilité de la bulle quand le contexte sauvegardé est un champ contrôlé `input`/`textarea`.
- Garder les refus de remplacement explicites et orienter l'utilisateur vers le bouton "Copier" quand la copie automatique échoue.
- Renforcer les tests structurels autour des comportements inspirés par la recherche GitHub sans introduire de DOM lourd ni de bundler.
- Documenter la recherche pour que les futures PR puissent comprendre quelles approches ont été retenues ou rejetées.

## Risques à éviter

- Modifier du texte sans vérifier que la sélection originale correspond toujours au contenu courant.
- Remplacer globalement du `innerHTML` ou activer `contentEditable` sur de larges portions de page.
- Ajouter une dépendance lourde ou un build step qui compliquerait l'installation directe du userscript dans Violetmonkey.
- Copier du code depuis un dépôt à licence incompatible ou sans attribution.
- Faire des appels réseau réels à LanguageTool dans les tests.
