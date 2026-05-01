# Correcteur de Phrases — Violetmonkey

Userscript qui corrige automatiquement les phrases sélectionnées sur n'importe quel site web, via l'API LanguageTool.

---

## Installation

### 1. Installer Violetmonkey

- **Chrome / Edge** : [Chrome Web Store](https://chrome.google.com/webstore/detail/violetmonkey/jinjaccalgkegedbjfncswigafejgdne)
- **Firefox** : [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/violetmonkey/)

### 2. Installer le script

Ouvre ce lien dans ton navigateur (Violetmonkey détecte automatiquement le script) :

```
https://raw.githubusercontent.com/MATTEO12SA/correcteur-violetmonkey/main/corrector.user.js
```

Une fenêtre d'installation apparaît → clique **Confirmer**.

---

## Utilisation

1. **Sélectionne** du texte sur n'importe quelle page web avec la souris
2. Une bulle noire **✎ Corriger** apparaît au-dessus de ta sélection
3. Clique dessus → le panneau de correction s'ouvre
4. Attends la correction (quelques secondes)
5. Clique **Appliquer** pour remplacer le texte dans la page, ou **Copier** pour copier la version corrigée

Le remplacement automatique utilise plusieurs stratégies selon le contexte : champs `input` / `textarea`, zones `contenteditable`, puis fallback **Copier** si l'éditeur bloque la modification. Utilise **Copier** si un site empêche encore techniquement la modification automatique, notamment dans certains éditeurs web complexes ou champs contrôlés par React.

### Raccourcis
| Action | Comment |
|--------|---------|
| Fermer le panneau | `Échap` ou bouton **Fermer** |
| Déplacer le panneau | Cliquer-glisser sur le header |
| Naviguer au clavier | `Tab` / `Shift+Tab` entre les boutons |

---

## Mise à jour automatique

Le script se met à jour automatiquement via Violetmonkey dès qu'une nouvelle version est publiée.

Pour forcer une mise à jour manuelle :
1. Clique sur l'icône Violetmonkey dans le navigateur
2. Ouvre le **Tableau de bord**
3. Trouve "Correcteur de Phrases"
4. Clique l'icône **↻** (vérifier les mises à jour)

---

## Fonctionnalités

- Détection automatique de la langue
- Utilise le `lang` de la page quand il est disponible pour éviter une détection serveur inutile
- Diff visuel : erreurs soulignées en rouge, corrections surlignées en vert
- Modes de correction `Chat`, `Équilibré` et `Strict` via l'engrenage
- Mode `Strict` avec niveau LanguageTool `picky`, modes `Chat` et `Équilibré` en niveau standard
- Filtrage serveur des catégories trop agressives en modes `Chat` et `Équilibré`
- Filtrage intelligent des suggestions trop agressives sur les messages courts et le chat
- Protection des `@mentions`, `#hashtags`, URLs, emails et blocs inline sensibles
- Cache persistant des corrections récentes pour accélérer les textes déjà corrigés
- Gestion claire des limites API, timeouts et erreurs réseau
- Remplacement automatique renforcé dans les `textarea`, `input`, zones `contenteditable`, éditeurs modernes et SPA, avec contexte de sélection vérifié et fallback **Copier** quand un site refuse la modification
- Panneau déplaçable, position mémorisée entre les sessions
- Compatible avec les SPA (Facebook, Instagram, Twitter…)
- Interface isolée en Shadow DOM pour éviter les conflits CSS avec les sites visités
- Panneau responsive sur petits écrans
- Dark mode automatique
- Navigation clavier complète, focus visible et rôles ARIA utiles
- États visuels dédiés : chargement, succès, aucune correction, limite API, timeout, réseau et remplacement impossible
- Paramètres rapides via l'engrenage du panneau
- Fonctionne sur tous les sites (`*://*/*`)

## API et confidentialité

Le script utilise l'endpoint public documenté de LanguageTool :

```
https://api.languagetool.org/v2/check
```

Quand tu cliques **Corriger**, le texte sélectionné est envoyé à LanguageTool pour analyse. Le script ajoute `preferredVariants=fr-FR,en-US,de-DE,pt-PT` afin d'améliorer la détection automatique des variantes de langue.

Limites importantes du service gratuit :

- environ 20 requêtes par minute par IP ;
- environ 75 KB de texte par minute ;
- environ 20 KB par requête.

Le script bloque donc les sélections trop longues avant l'appel API et affiche un message clair en cas de limite, timeout ou erreur réseau.

## Cache persistant

Les corrections LanguageTool sont conservées localement pendant 7 jours via le stockage Violetmonkey (`GM_setValue` / `GM_getValue`). La clé de cache utilise le site, le mode de correction, le profil du texte, sa longueur et un hash FNV-1a du contenu, ce qui évite de stocker le texte complet dans les clés.

Le cache est limité à 200 entrées récentes. Il sert uniquement à réafficher instantanément une correction déjà obtenue pour le même texte et le même mode.

## Debug local

Le mode debug est désactivé par défaut.

- Le même engrenage permet aussi de choisir le niveau de correction (`Chat`, `Équilibré`, `Strict`)
- Méthode recommandée : ouvre le panneau du correcteur puis clique sur l'engrenage pour activer les logs
- Les logs se téléchargent manuellement via le bouton `Télécharger les logs` dans ce même panneau
- Activer temporairement sur une page : ajoute `?correctorDebug=1` à l'URL
- Activer de façon persistante via la console :

```js
localStorage.setItem('__corrector_debug', '1');
```

- Désactiver :

```js
localStorage.removeItem('__corrector_debug');
```

### Vérification du code

Le projet peut être vérifié localement avec :

```bash
npm run check
npm test
```

Une CI GitHub Actions exécute automatiquement ces commandes sur chaque push et chaque Pull Request.

Les tests utilisent des réponses LanguageTool simulées : ils ne font pas d'appel réseau réel. Ils couvrent notamment :

- la protection des `@mentions`, `#hashtags`, URLs, emails et fragments inline sensibles ;
- l'application de corrections LanguageTool simulées ;
- le filtrage des suggestions selon les modes `Chat`, `Équilibré` et `Strict` ;
- la logique de cache et l'absence de texte complet dans les clés ;
- certains cas de remplacement automatique testables sans navigateur réel.

L'analyse du code et la recherche GitHub qui guident les améliorations récentes sont documentées dans `docs/code-analysis.md` et `docs/github-research.md`.

---

## Technologies

- JavaScript vanilla
- [LanguageTool API publique](https://dev.languagetool.org/public-http-api.html) (gratuit, sans clé API)
- Violetmonkey `GM_xmlhttpRequest` (contourne le CSP des sites)
