# Recherche GitHub

## Requêtes utilisées

- `LanguageTool userscript`
- `LanguageTool GM_xmlhttpRequest`
- `LanguageTool Tampermonkey`
- `LanguageTool Violentmonkey`
- `userscript grammar correction`
- `Tampermonkey grammar checker`
- `contenteditable replace selection javascript`
- `textarea input replace selected text javascript`
- `React controlled input set native value`
- `Shadow DOM userscript popup`
- `selection tooltip userscript`
- `diff viewer javascript text correction`

Les recherches ont été faites avec GitHub Search, l'API GitHub et des requêtes web limitées aux résultats GitHub quand la recherche code retournait peu de résultats.

## Projets étudiés

### 1. LanguageTool browser add-on

- URL : https://github.com/languagetool-org/languagetool-browser-addon
- Licence : LGPL-2.1
- Fichiers lus : `COPYING`, `webextension/cs/contentscript.js`
- Points intéressants : distingue sélection de page et élément actif, traite séparément les champs simples et `contenteditable`, vérifie les noeuds texte avant remplacement, déclenche des événements `input` / `change`, et signale un échec quand le remplacement est impossible.
- Idées réutilisables : conserver un contexte actif vérifiable, refuser une correction si la cible ne correspond plus, privilégier des remplacements ciblés plutôt qu'une réécriture globale.
- Code copiable légalement : non pour ce projet, car la licence LGPL-2.1 n'est pas alignée avec l'objectif de ne reprendre que du code permissif simple.
- Décision : réécrire les idées, sans copie de code.

### 2. Spellcheck Website Tampermonkey Script

- URL : https://github.com/Codeconut-Ltd/Spellcheck-Website-Tampermonkey-Script
- Licence : MIT, indiquée dans `package.json`
- Fichiers lus : `README.md`, `package.json`, `scripts/tampermonkey-spellcheck.js`
- Points intéressants : userscript simple, activation manuelle possible via `window.ccSpellCheck()`, prise en compte du contenu chargé dynamiquement, documentation claire des limites.
- Idées réutilisables : documenter franchement les limites et préférer un fallback clair quand un site empêche la modification automatique.
- Code copiable légalement : oui, licence MIT, mais le comportement global `designMode` / `contentEditable` sur la page serait trop invasif.
- Décision : réécrire uniquement l'idée de documentation et de refus prudent.

### 3. React

- URL : https://github.com/facebook/react
- Licence : MIT
- Fichiers lus : `LICENSE`, `packages/react-dom-bindings/src/client/inputValueTracking.js`, `packages/react-dom-bindings/src/client/ReactDOMInput.js`, `packages/react-dom-bindings/src/events/plugins/ChangeEventPlugin.js`
- Points intéressants : React suit la valeur des inputs, normalise `input` / `change`, et restaure l'état des champs contrôlés. Cela confirme l'intérêt d'utiliser le setter natif de `value` puis de déclencher les événements attendus.
- Idées réutilisables : traiter `input` et `textarea` comme une cible distincte avec valeur native, focus, curseur et événements.
- Code copiable légalement : oui, licence MIT.
- Décision : aucun code copié ; le projet avait déjà cette stratégie, la PR ajoute une vérification de non-régression autour du fallback et du contexte.

### 4. testing-library/user-event

- URL : https://github.com/testing-library/user-event
- Licence : MIT
- Fichiers lus : `LICENSE`, `tests/event/input.ts`
- Points intéressants : les tests couvrent `input`, `textarea`, `contenteditable`, `beforeinput`, `inputType`, sélection et refus quand `beforeinput` est annulé.
- Idées réutilisables : tester les comportements de saisie via événements et sélection, même sans lancer un navigateur réel.
- Code copiable légalement : oui, licence MIT.
- Décision : aucun code copié ; ajout de tests structurels adaptés à la suite Node existante.

### 5. ProseMirror view

- URL : https://github.com/ProseMirror/prosemirror-view
- Licence : MIT
- Fichiers lus : `LICENSE`, `src/input.ts`, `src/domchange.ts`, `src/selection.ts`
- Points intéressants : suit l'origine et le moment de la sélection, vérifie que la sélection appartient toujours à l'éditeur, force des synchronisations DOM avant certaines opérations et préfère refuser les cas incohérents.
- Idées réutilisables : ne pas dépendre uniquement de `window.getSelection()` quand un contexte sauvegardé plus fiable existe déjà, et relire le rectangle depuis la cible ou le `Range` mémorisé.
- Code copiable légalement : oui, licence MIT.
- Décision : réécrire l'idée sous forme d'un helper local `getSelectionContextRect()`.

### 6. jsdiff

- URL : https://github.com/kpdecker/jsdiff
- Licence : BSD-3-Clause
- Fichiers lus : `LICENSE`, `README.md`, `src/diff/word.ts`
- Points intéressants : diff par tokens avec conservation prudente des espaces, options de timeout et limitation de coût sur de gros textes.
- Idées réutilisables : garder un diff lisible orienté mots et éviter les traitements coûteux sur des sélections trop longues.
- Code copiable légalement : oui, licence BSD-3-Clause.
- Décision : ne pas ajouter de dépendance ; le diff existant est suffisant pour ce userscript.

## Synthèse des meilleures idées trouvées

- Les remplacements fiables commencent par un contexte de sélection vérifiable, pas par une recherche globale dans le DOM.
- Les champs `input` et `textarea` doivent rester séparés des sélections DOM classiques.
- Les éditeurs riches modifient souvent leur DOM entre deux événements ; il faut donc préférer un refus propre à une écriture approximative.
- Les frameworks comme React réagissent aux événements `input` / `change` et à la valeur native du champ.
- La documentation doit dire clairement quand le fallback copie reste nécessaire.

## Idées retenues pour ce projet

- Réutiliser le contexte mémorisé pour repositionner la bulle sur `input` / `textarea` au scroll, au lieu de dépendre uniquement de `window.getSelection()`.
- Relire le rectangle depuis le `Range` sauvegardé quand il existe encore, puis seulement utiliser la sélection globale comme dernier recours.
- Rendre le message de copie automatique échouée plus actionnable.
- Ajouter des tests de non-régression qui vérifient ces garanties sans DOM lourd.

## Idées rejetées et pourquoi

- Activer `document.designMode` ou rendre de larges zones `contenteditable` : trop invasif pour un correcteur qui fonctionne sur tous les sites.
- Ajouter `jsdiff` ou une bibliothèque de diff : valeur faible par rapport au coût de dépendance pour un userscript direct.
- Copier du code LanguageTool browser add-on : licence LGPL-2.1 et architecture d'extension trop différente.
- Ajouter un retry réseau automatique : risque d'aggraver les limites de l'API publique LanguageTool sans bénéfice clair.
- Gérer pleinement les iframes : le userscript est déclaré avec `@noframes`, et changer cela augmenterait fortement la surface de comportement.

## Décisions d'implémentation

- Amélioration 1 : ajouter `getSelectionContextRect()` pour mesurer un contexte sauvegardé de manière progressive.
- Inspiration GitHub : ProseMirror view et LanguageTool browser add-on.
- Pourquoi : la bulle ne doit pas disparaître au scroll seulement parce que `window.getSelection()` ne décrit pas une sélection `input` / `textarea`.
- Risque : garder une bulle sur une cible supprimée du DOM.
- Solution retenue : refuser si l'élément n'est plus connecté, si le `Range` est invalide ou si aucun rectangle fiable n'existe.

- Amélioration 2 : rendre le message d'échec de copie automatique plus direct.
- Inspiration GitHub : documentation explicite des limites dans Codeconut et refus propres dans LanguageTool browser add-on.
- Pourquoi : l'utilisateur doit savoir que la correction reste disponible via le bouton "Copier".
- Risque : masquer la cause technique précise.
- Solution retenue : conserver les raisons internes dans `getApplyFailureMessage()` mais afficher un fallback clair après échec de copie.

- Amélioration 3 : ajouter des tests structurels sur la stabilité de la bulle et le message de fallback.
- Inspiration GitHub : testing-library/user-event et React, qui testent les comportements de saisie et d'événements.
- Pourquoi : éviter une régression sur les champs contrôlés et les sélections de formulaire.
- Risque : tests trop couplés au texte source.
- Solution retenue : rester cohérent avec la suite existante, qui inspecte déjà les helpers du userscript sans bundler.

## Attribution et code réutilisé

Aucun code externe n'a été copié. Les modifications sont des réécritures locales inspirées par les comportements observés dans les dépôts étudiés.
