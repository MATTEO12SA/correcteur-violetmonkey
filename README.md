# Correcteur de Phrases — Violentmonkey

Userscript qui corrige automatiquement les phrases sélectionnées sur n'importe quel site web (hors iframes), via l'API LanguageTool.

---

## Installation

### 1. Installer Violentmonkey

- **Chrome / Edge** : [Chrome Web Store](https://chrome.google.com/webstore/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag)
- **Firefox** : [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/violentmonkey/)

### 2. Installer le script

Ouvre ce lien dans ton navigateur (Violentmonkey détecte automatiquement le script) :

```
https://raw.githubusercontent.com/MATTEO12SA/correcteur-violetmonkey/main/corrector.user.js
```

Une fenêtre d'installation apparaît → clique **Confirmer**.

---

## Utilisation

1. **Sélectionnez** du texte sur une page web (souris, tactile ou clavier)
2. Une bulle noire **✎ Corriger** apparaît au-dessus de la sélection
3. Cliquez dessus → le panneau de correction s'ouvre
4. Attendez la correction (quelques secondes)
5. Cliquez **Appliquer** pour remplacer le texte dans la page, ou **Copier** pour copier la version corrigée

Le remplacement automatique utilise plusieurs stratégies selon le contexte : champs `input` / `textarea`, zones `contenteditable`, puis fallback **Copier** si l'éditeur bloque la modification. Utilisez **Copier** si un site empêche encore techniquement la modification automatique, notamment dans certains éditeurs web complexes ou champs contrôlés par React.

Le script est déclaré avec `@noframes` : il ne tourne pas dans les iframes (ex. certains composeurs Google Docs ou previews embarquées).

### Raccourcis
| Action | Comment |
|--------|---------|
| Fermer le panneau | `Échap` ou bouton **Fermer** |
| Déplacer le panneau | Cliquer-glisser sur le header, ou boutons de position dans les paramètres |
| Naviguer au clavier | `Tab` / `Shift+Tab` entre les contrôles du panneau |

---

## Mise à jour automatique

Le script se met à jour automatiquement via Violentmonkey dès qu'une nouvelle version est publiée.

Pour forcer une mise à jour manuelle :
1. Cliquez sur l'icône Violentmonkey dans le navigateur
2. Ouvrez le **Tableau de bord**
3. Trouvez "Correcteur de Phrases"
4. Cliquez l'icône **↻** (vérifier les mises à jour)

---

## Fonctionnalités

- Détection de langue via `language=auto` (LanguageTool), avec variantes préférées
- Utilise le `lang` du champ ou de l'ancêtre le plus proche quand il est fiable, sinon `auto`
- Diff visuel : erreurs soulignées en rouge, corrections surlignées en vert
- Modes de correction `Chat`, `Équilibré` et `Strict` via l'engrenage
- Mode `Strict` avec niveau LanguageTool `picky`, modes `Chat` et `Équilibré` en niveau standard
- Filtrage serveur des catégories trop agressives en modes `Chat` et `Équilibré`
- Filtrage intelligent des suggestions trop agressives sur les messages courts et le chat
- Protection des `@mentions`, `#hashtags`, URLs, emails et blocs inline sensibles
- Exclusion des champs sensibles (`password`, paiement, `autocomplete` carte / téléphone / email)
- Cache persistant des corrections récentes (sans extraits de texte LanguageTool)
- Gestion claire des limites API (requêtes et volume), timeouts et erreurs réseau
- Panneau déplaçable, position mémorisée entre les sessions
- Compatible avec les SPA (Facebook, Instagram, Twitter…)
- Interface isolée en Shadow DOM pour éviter les conflits CSS avec les sites visités
- Panneau responsive sur petits écrans
- Dark mode automatique
- Navigation clavier, focus visible et rôles ARIA utiles
- États visuels dédiés : chargement, succès, aucune correction, limite API, timeout, réseau et remplacement impossible
- Paramètres rapides via l'engrenage du panneau
- Fonctionne sur les pages principales (`*://*/*`, hors iframes)

## API et confidentialité

Le script utilise l'endpoint public documenté de LanguageTool :

```
https://api.languagetool.org/v2/check
```

Quand vous cliquez **Corriger**, le texte sélectionné est envoyé à LanguageTool pour analyse. Le script envoie un `User-Agent` applicatif, utilise `language=auto` (ou le `lang` local fiable du champ), et ajoute `preferredVariants=fr-FR,en-US,de-DE,pt-PT`.

Limites importantes du service gratuit :

- environ 20 requêtes par minute par IP ;
- environ 75 KB de texte par minute ;
- environ 20 KB par requête.

Le script bloque donc les sélections trop longues et respecte un quota local de requêtes et d'octets avant l'appel API. Il affiche un message clair en cas de limite, timeout ou erreur réseau.

Les réglages (mode, debug, confirmation, position) sont stockés via `GM_setValue` / `GM_getValue` (stockage Violentmonkey), pas dans le `localStorage` de la page.

## Cache persistant

Les corrections LanguageTool sont conservées localement pendant 7 jours via le stockage Violentmonkey (`GM_setValue` / `GM_getValue`). La clé de cache utilise le site, le mode de correction, la langue, le profil du texte, sa longueur et un hash FNV-1a du contenu, ce qui évite de stocker le texte complet dans les clés.

Les valeurs de cache ne conservent que les champs utiles (`offset`, `length`, `replacements`, `message`, `rule`) : les extraits `context.text` de LanguageTool ne sont pas persistés.

Le cache est limité à 200 entrées récentes. Il sert uniquement à réafficher instantanément une correction déjà obtenue pour le même texte et le même mode.

## Debug local

Le mode debug est désactivé par défaut.

- Le même engrenage permet aussi de choisir le niveau de correction (`Chat`, `Équilibré`, `Strict`)
- Méthode recommandée : ouvrez le panneau du correcteur puis cliquez sur l'engrenage pour activer les logs
- Les logs se téléchargent manuellement via le bouton `Télécharger les logs` dans ce même panneau
- Activer temporairement sur une page : ajoutez `?correctorDebug=1` à l'URL

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
- la logique de cache et l'absence de texte complet dans les clés / valeurs ;
- certains cas de remplacement automatique testables sans navigateur réel ;
- la détection de langue et les gardes d'ouverture du panneau.

L'analyse du code et la recherche GitHub qui guident les améliorations récentes sont documentées dans `docs/code-analysis.md` et `docs/github-research.md`.

---

## Technologies

- JavaScript vanilla
- [LanguageTool API publique](https://dev.languagetool.org/public-http-api.html) (gratuit, sans clé API)
- Violentmonkey `GM_xmlhttpRequest` (contourne le CSP des sites)
