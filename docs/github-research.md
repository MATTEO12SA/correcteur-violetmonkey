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

## Recherche complémentaire : remplacement dans éditeurs modernes

### Source 1

- URL : https://github.com/codemirror/view
- Licence : MIT.
- Fichiers lus : `LICENSE`, `src/input.ts`.
- Idée utile : CodeMirror sépare strictement les événements appartenant à l'éditeur des événements globaux, garde une origine de sélection et refuse les opérations qui ne correspondent plus à l'état courant.
- Code copié : non.
- Décision : réécrire l'idée sous forme de validation locale avant remplacement et de retour structuré quand la sélection n'est plus fiable.

### Source 2

- URL : https://github.com/ianstormtaylor/slate
- Licence : MIT.
- Fichiers lus : `License.md`, `packages/slate-react/src/components/editable.tsx`.
- Idée utile : Slate traite `beforeinput` comme un signal critique dans les éditeurs riches, vérifie que la cible appartient bien à l'éditeur et respecte les éditeurs en lecture seule.
- Code copié : non.
- Décision : déclencher `beforeinput` avant l'insertion `contenteditable`, arrêter proprement si l'événement est annulé, et refuser les cibles non éditables.

### Source 3

- URL : https://github.com/slab/quill
- Licence : BSD-3-Clause.
- Fichiers lus : `LICENSE`, `packages/quill/src/modules/input.ts`.
- Idée utile : Quill tient compte de `insertReplacementText`, mappe la sélection avant de modifier le contenu et replace le curseur après insertion.
- Code copié : non.
- Décision : utiliser `inputType: 'insertReplacementText'`, insérer uniquement le texte sélectionné et replacer la sélection après le texte corrigé.

### Source 4

- URL : https://github.com/facebook/lexical
- Licence : MIT.
- Fichiers lus : `LICENSE`, `packages/lexical-playground/__tests__/e2e/Events.spec.mjs`, `packages/lexical-clipboard/src/clipboard.ts`.
- Idée utile : Lexical teste explicitement `beforeinput` avec `insertReplacementText` et vérifie que les opérations de presse-papiers appartiennent à l'éditeur actif.
- Code copié : non.
- Décision : ajouter des tests de non-régression sur le résultat structuré et les fallbacks sans appeler LanguageTool ni simuler tout un navigateur.

### Source 5

- URL : https://github.com/facebook/react
- Licence : MIT.
- Fichiers lus : `LICENSE`, `packages/react-dom-bindings/src/client/inputValueTracking.js`.
- Idée utile : les champs contrôlés suivent leur valeur interne ; l'utilisation du setter natif suivie d'événements `input` / `change` reste la stratégie la plus compatible.
- Code copié : non.
- Décision : renforcer les validations autour du setter natif existant et refuser les champs `readonly`, `disabled` ou détachés.

### Source 6

- URL : https://github.com/ProseMirror/prosemirror-view
- Licence : MIT.
- Fichiers lus : `LICENSE`, `src/domchange.ts`, `src/input.ts`.
- Idée utile : ProseMirror capture un état de sélection/document avant l'opération et compare le DOM ensuite pour éviter les remplacements incohérents.
- Code copié : non.
- Décision : conserver un remplacement progressif mais retourner une raison d'échec précise quand le `Range` sauvegardé ne correspond plus.

### Source 7

- URL : https://github.com/rxliuli/input-translator
- Licence : GPL-3.0.
- Fichiers lus : `LICENSE`, `lib/selection.ts`.
- Idée utile : l'extension distingue `input`, `textarea`, `contenteditable`, sélection active et fallback via presse-papiers.
- Code copié : non, licence non retenue pour réutilisation directe.
- Décision : ne reprendre aucune portion ; seulement confirmer la stratégie générale de séparation des cibles.

## Décisions d'implémentation complémentaires

- Amélioration 1 : retourner `{ ok, method, reason }` depuis les chemins de remplacement.
- Inspiration GitHub : CodeMirror, ProseMirror et Lexical.
- Pourquoi : les fallbacks et les tests doivent savoir si l'échec vient d'une sélection modifiée, d'une cible détachée ou d'un éditeur qui refuse l'insertion.
- Risque : rendre le flux existant plus complexe.
- Solution retenue : ajouter un helper local `createApplyResult()` et conserver les champs existants `kind`, `focusEl`, `lastApply` quand ils sont utiles.

- Amélioration 2 : renforcer `input` / `textarea`.
- Inspiration GitHub : React.
- Pourquoi : les champs contrôlés réagissent mieux au setter natif et aux événements, mais seulement si la sélection originale est encore exacte.
- Risque : modifier un champ qui n'est plus le bon.
- Solution retenue : refuser les cibles détachées, `readonly`, `disabled`, offsets invalides ou texte modifié ; préserver focus, curseur et `scrollTop`.

- Amélioration 3 : ajouter un remplacement `contenteditable` basé sur le `Range` sauvegardé.
- Inspiration GitHub : Slate, Quill, Lexical.
- Pourquoi : les éditeurs modernes attendent souvent `beforeinput` / `input` avec `insertReplacementText`.
- Risque : forcer une mutation DOM ignorée par l'état interne de l'éditeur.
- Solution retenue : vérifier l'appartenance du `Range`, respecter `beforeinput` annulé, insérer un `TextNode` sans toucher à `innerHTML`, puis utiliser `execCommand('insertText')` seulement comme fallback prudent.

## Attribution et code réutilisé

Aucun code externe n'a été copié. Les modifications sont des réécritures locales inspirées par les comportements observés dans les dépôts étudiés.
