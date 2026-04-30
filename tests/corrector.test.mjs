import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const userscript = readFileSync(join(root, 'corrector.user.js'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

test('userscript metadata targets the public LanguageTool API', () => {
  assert.match(userscript, /@version\s+4\.8\.0/);
  assert.match(userscript, /@connect\s+api\.languagetool\.org/);
  assert.match(userscript, /LANGUAGETOOL_ENDPOINT = 'https:\/\/api\.languagetool\.org\/v2\/check'/);
  assert.doesNotMatch(userscript, /languagetoolplus\.com/);
});

test('LanguageTool requests keep strict mode and rate-limit guards explicit', () => {
  assert.match(userscript, /LANGUAGETOOL_PREFERRED_VARIANTS = 'fr-FR,en-US,de-DE,pt-PT'/);
  assert.match(userscript, /level: context\.mode === 'strict' \? 'picky' : 'default'/);
  assert.match(userscript, /LANGUAGETOOL_RATE_LIMIT_COOLDOWN_MS = 60000/);
  assert.match(userscript, /_languageToolCooldownUntil: 0/);
  assert.match(userscript, /getCooldownError\(\)/);
  assert.match(userscript, /startLanguageToolCooldown\(\)/);
  assert.match(userscript, /res\.status === 429/);
});

test('UI hardening helpers cover copy, contenteditable, abort, and menu position', () => {
  assert.match(userscript, /const copyTextToClipboard = async \(text\) =>/);
  assert.match(userscript, /navigator\.clipboard/);
  assert.match(userscript, /document\.execCommand\('copy'\)/);
  assert.match(userscript, /getEditableRootFromNode\(node\)/);
  assert.match(userscript, /isContentEditable/);
  assert.match(userscript, /contenteditable="plaintext-only"/);
  assert.match(userscript, /abortCurrentRequest\(\)/);
  assert.match(userscript, /typeof this\.currentRequest\.abort === 'function'/);
  assert.match(userscript, /getClampedMenuPosition\(menu, x, y\)/);
});

test('UI is isolated in a Shadow DOM root without global style injection', () => {
  assert.match(userscript, /UI_ROOT_ID = '__corrector_violetmonkey_root'/);
  assert.match(userscript, /ensureUiRoot\(\)/);
  assert.match(userscript, /attachShadow\(\{\s*mode: 'open'\s*\}\)/);
  assert.match(userscript, /root\.appendChild\(style\)/);
  assert.match(userscript, /this\.ensureUiRoot\(\)\.appendChild\(pill\)/);
  assert.match(userscript, /this\.ensureUiRoot\(\)\.appendChild\(menu\)/);
  assert.match(userscript, /this\.ensureUiRoot\(\)\.appendChild\(toast\)/);
  assert.doesNotMatch(userscript, /document\.head/);
  assert.doesNotMatch(userscript, /document\.body\.appendChild\((pill|menu|toast)\)/);
  assert.match(userscript, /event\.composedPath\(\)/);
});

test('panel accessibility keeps dialog labels, status regions, and focus trap', () => {
  assert.match(userscript, /aria-describedby', 'corrector-desc corrector-service-note'/);
  assert.match(userscript, /corrector-sr-only/);
  assert.match(userscript, /aria-controls="corrector-settings-panel"/);
  assert.match(userscript, /role="status"/);
  assert.match(userscript, /aria-live="polite"/);
  assert.match(userscript, /getFocusableElements\(root = this\.menu\)/);
  assert.match(userscript, /this\.getCurrentFocus\(\)/);
});

test('UI states and diff highlights are explicit', () => {
  assert.match(userscript, /USER_MESSAGES = \{[\s\S]*loading: 'Correction en cours\.\.\.'/);
  assert.match(userscript, /USER_MESSAGES = \{[\s\S]*noCorrection: 'Aucune correction nécessaire\.'/);
  assert.match(userscript, /data-corrector-state="loading"/);
  assert.match(userscript, /corrector-state-loading/);
  assert.match(userscript, /corrector-state-error/);
  assert.match(userscript, /corrector-state-success/);
  assert.match(userscript, /corrector-state-rate-limit/);
  assert.match(userscript, /corrector-state-timeout/);
  assert.match(userscript, /corrector-state-network/);
  assert.match(userscript, /corrector-error corrector-removed/);
  assert.match(userscript, /corrector-fix corrector-added/);
});

test('README documents privacy, endpoint, and public API limits', () => {
  assert.match(readme, /https:\/\/api\.languagetool\.org\/v2\/check/);
  assert.match(readme, /texte sélectionné est envoyé à LanguageTool/);
  assert.match(readme, /preferredVariants=fr-FR,en-US,de-DE,pt-PT/);
  assert.match(readme, /20 requêtes par minute/);
  assert.match(readme, /20 KB par requête/);
});
