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
- Diff visuel : erreurs soulignées en rouge, corrections surlignées en vert
- Panneau déplaçable, position mémorisée entre les sessions
- Compatible avec les SPA (Facebook, Instagram, Twitter…)
- Dark mode automatique
- Navigation clavier complète (accessibilité)
- Fonctionne sur tous les sites (`*://*/*`)

## Debug local

Le mode debug est désactivé par défaut.

- Activer temporairement sur une page : ajoute `?correctorDebug=1` à l'URL
- Activer de façon persistante :

```js
localStorage.setItem('__corrector_debug', '1');
```

- Désactiver :

```js
localStorage.removeItem('__corrector_debug');
```

---

## Technologies

- JavaScript vanilla
- [LanguageTool API](https://languagetool.org/http-api/) (gratuit, sans clé API)
- Violetmonkey `GM_xmlhttpRequest` (contourne le CSP des sites)
