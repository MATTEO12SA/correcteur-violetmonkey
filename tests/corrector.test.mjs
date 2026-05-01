import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const userscript = readFileSync(join(root, 'corrector.user.js'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const getBlockBody = (name) => {
  const marker = `    ${name}(`;
  const start = userscript.indexOf(marker);
  assert.notEqual(start, -1, `method ${name} should exist`);
  const braceStart = userscript.indexOf('{', start);
  assert.notEqual(braceStart, -1, `method ${name} should have a body`);
  let depth = 0;
  for (let i = braceStart; i < userscript.length; i++) {
    const char = userscript[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return userscript.slice(braceStart + 1, i);
    }
  }
  assert.fail(`method ${name} body was not closed`);
};

const buildMethod = (name, args, env = {}) => {
  const body = getBlockBody(name);
  const envNames = Object.keys(env);
  const envValues = Object.values(env);
  return new Function(...envNames, `return function(${args.join(', ')}) {${body}};`)(...envValues);
};

const getConstArrowSource = (name) => {
  const marker = `const ${name} = `;
  const start = userscript.indexOf(marker);
  assert.notEqual(start, -1, `helper ${name} should exist`);
  const braceStart = userscript.indexOf('{', start);
  assert.notEqual(braceStart, -1, `helper ${name} should have a body`);
  let depth = 0;
  for (let i = braceStart; i < userscript.length; i++) {
    const char = userscript[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const semi = userscript.indexOf(';', i);
        return userscript.slice(start, semi + 1);
      }
    }
  }
  assert.fail(`helper ${name} body was not closed`);
};

const createCorrectionHarness = () => {
  const WORD_TOKEN_REGEX = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;
  const LETTER_REGEX = /\p{L}/gu;
  const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const MENTION_REGEX = /@[A-Za-z0-9_]{2,}/g;
  const HASHTAG_REGEX = /#[\p{L}\p{N}_-]{2,}/gu;
  const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const SYMBOL_REGEX = /[^\s\p{L}\p{N}]/gu;
  const INLINE_CODE_REGEX = /`[^`\n]+`/g;
  const HOST_CHAT_REGEX = /(?:^|\.)(?:twitch|kick|discord|slack|telegram|messenger|teams|irccloud|chat)\./i;
  const CODEISH_BRACKET_REGEX = /[`{}[\]<>]/;
  const CODEISH_COMMAND_REGEX = /(?:^|\s)(?:npm|pnpm|yarn|git|cd|ls|rm|cp|mv|sudo|npx)\b/i;
  const SENTENCE_END_REGEX = /[.!?…]\s*$/;
  const TITLE_CASE_REGEX = /^\p{Lu}[\p{Ll}]+$/u;
  const NON_LETTER_REGEX = /[^\p{L}]/gu;
  const DANGEROUS_UNICODE_REGEX = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
  const ZALGO_COMBINER_REGEX = /[\u0300-\u036f]{4,}/;
  const cloneRegex = (regex) => new RegExp(regex.source, regex.flags);
  const countPatternMatches = (text, regex) => {
    const source = text || '';
    if (!source) return 0;
    const pattern = cloneRegex(regex);
    let count = 0;
    while (pattern.exec(source)) count += 1;
    return count;
  };
  const isSafeReplacement = (val) => {
    if (typeof val !== 'string') return false;
    if (DANGEROUS_UNICODE_REGEX.test(val)) return false;
    if (ZALGO_COMBINER_REGEX.test(val)) return false;
    return true;
  };
  const { hashFNV1a } = new Function(`${getConstArrowSource('hashFNV1a')}; return { hashFNV1a };`)();
  const env = {
    WORD_TOKEN_REGEX,
    LETTER_REGEX,
    URL_REGEX,
    EMAIL_REGEX,
    MENTION_REGEX,
    HASHTAG_REGEX,
    EMOJI_REGEX,
    SYMBOL_REGEX,
    INLINE_CODE_REGEX,
    HOST_CHAT_REGEX,
    CODEISH_BRACKET_REGEX,
    CODEISH_COMMAND_REGEX,
    SENTENCE_END_REGEX,
    TITLE_CASE_REGEX,
    NON_LETTER_REGEX,
    countPatternMatches,
    cloneRegex,
    isSafeReplacement,
    hashFNV1a,
  };
  const harness = {};
  const methodArgs = {
    analyzeSelectionText: ['text', 'host'],
    buildCorrectionCacheKey: ['text', 'context'],
    mergeProtectedRanges: ['ranges'],
    collectPatternRanges: ['text', 'regex', 'kind'],
    rangesOverlap: ['start', 'end', 'ranges'],
    countWords: ['text'],
    getMatchIssueType: ['match'],
    getMatchCategoryId: ['match'],
    getMatchRuleId: ['match'],
    createMatchInfo: ['match', 'text'],
    isSentenceStart: ['text', 'offset'],
    upperCaseFirstLetter: ['text'],
    lowerCaseFirstLetter: ['text'],
    normalizeReplacementCasing: ['matchInfo', 'replacement', 'text'],
    isReplacementSafe: ['matchInfo', 'replacement', 'replacementWordCount', 'context'],
    scoreReplacementCandidate: ['matchInfo', 'replacement', 'replacementWordCount', 'context'],
    pickReplacement: ['matchInfo', 'text', 'context'],
    scorePreparedMatch: ['matchInfo', 'replacementValue', 'context'],
    shouldKeepMatchInfo: ['matchInfo', 'context'],
    shouldKeepMatchFinal: ['matchInfo', 'replacementValue', 'context'],
    shouldKeepMatch: ['matchInfo', 'replacementValue', 'context'],
    prepareMatches: ['text', 'matches', 'correctionContext'],
    applyMatches: ['text', 'matches'],
  };
  for (const [name, args] of Object.entries(methodArgs)) {
    harness[name] = buildMethod(name, args, env);
  }
  return harness;
};

const makeContext = (overrides = {}) => ({
  host: 'example.com',
  mode: 'balanced',
  language: 'fr',
  flavor: 'prose',
  profile: {
    wordCount: 6,
    letterCount: 20,
    urlCount: 0,
    mentionCount: 0,
    hashtagCount: 0,
    emojiCount: 0,
    symbolRatio: 0,
    codeish: false,
    chatLike: false,
    ...(overrides.profile || {}),
  },
  protectedRanges: [],
  ...overrides,
});

test('userscript metadata targets the public LanguageTool API', () => {
  assert.equal(pkg.version, '4.11.0');
  assert.match(userscript, /@version\s+4\.11\.0/);
  assert.match(userscript, /@connect\s+api\.languagetool\.org/);
  assert.match(userscript, /@grant\s+GM_setValue/);
  assert.match(userscript, /@grant\s+GM_getValue/);
  assert.match(userscript, /@grant\s+GM_deleteValue/);
  assert.match(userscript, /@grant\s+GM_setClipboard/);
  assert.match(userscript, /LANGUAGETOOL_ENDPOINT = 'https:\/\/api\.languagetool\.org\/v2\/check'/);
  assert.doesNotMatch(userscript, /languagetoolplus\.com/);
});

test('LanguageTool requests keep strict mode and rate-limit guards explicit', () => {
  assert.match(userscript, /LANGUAGETOOL_PREFERRED_VARIANTS = 'fr-FR,en-US,de-DE,pt-PT'/);
  assert.match(userscript, /level: context\.mode === 'strict' \? 'picky' : 'default'/);
  assert.match(userscript, /'Accept': 'application\/json'/);
  assert.match(userscript, /LANGUAGETOOL_RATE_LIMIT_COOLDOWN_MS = 60000/);
  assert.match(userscript, /_languageToolCooldownUntil: 0/);
  assert.match(userscript, /getCooldownError\(\)/);
  assert.match(userscript, /startLanguageToolCooldown\(\)/);
  assert.match(userscript, /res\.status === 429/);
});

test('LanguageTool payload uses language hints and server-side category filters by mode', () => {
  const buildLanguageToolPayload = buildMethod('buildLanguageToolPayload', ['text', 'context'], {
    URLSearchParams,
    LANGUAGETOOL_PREFERRED_VARIANTS: 'fr-FR,en-US,de-DE,pt-PT',
  });

  const chatParams = new URLSearchParams(buildLanguageToolPayload.call(
    { detectLanguageHint: () => 'fr' },
    'Bonjour',
    { mode: 'chat-lite' }
  ));
  assert.equal(chatParams.get('language'), 'fr');
  assert.equal(chatParams.get('level'), 'default');
  assert.equal(chatParams.get('disabledCategories'), 'STYLE,REDUNDANCY,COLLOQUIALISMS,TYPOGRAPHY');

  const balancedParams = new URLSearchParams(buildLanguageToolPayload.call(
    { detectLanguageHint: () => null },
    'Bonjour',
    { mode: 'balanced' }
  ));
  assert.equal(balancedParams.get('language'), 'auto');
  assert.equal(balancedParams.get('disabledCategories'), 'STYLE,REDUNDANCY');

  const strictParams = new URLSearchParams(buildLanguageToolPayload.call(
    { detectLanguageHint: () => 'en-US' },
    'Hello',
    { mode: 'strict' }
  ));
  assert.equal(strictParams.get('level'), 'picky');
  assert.equal(strictParams.has('disabledCategories'), false);
});

test('detectLanguageHint maps html lang to LanguageTool variants', () => {
  const detectLanguageHint = buildMethod('detectLanguageHint', [], {
    document: { documentElement: { lang: 'en-GB' } },
  });
  assert.equal(detectLanguageHint(), 'en-GB');

  const detectFrench = buildMethod('detectLanguageHint', [], {
    document: { documentElement: { lang: 'fr-FR' } },
  });
  assert.equal(detectFrench(), 'fr');

  const detectUnknown = buildMethod('detectLanguageHint', [], {
    document: { documentElement: { lang: 'ja' } },
  });
  assert.equal(detectUnknown(), null);
});

test('persistent cache uses compact hashed keys and a seven-day TTL', () => {
  assert.match(userscript, /PERSIST_CACHE_KEY = '__corrector_v4_cache'/);
  assert.match(userscript, /CORRECTION_CACHE_MAX = 200/);
  assert.match(userscript, /CORRECTION_CACHE_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(userscript, /correctionCache: persistCacheLoad\(\)/);
  assert.match(userscript, /GM_setValue\(PERSIST_CACHE_KEY, JSON\.stringify\(arr\)\)/);
  assert.match(userscript, /persistCacheSave\.flush\?\.\(\)/);
  assert.match(userscript, /return \[context\.host, context\.mode, context\.language \|\| 'auto', flavor, \(text \|\| ''\)\.length, hashFNV1a\(text\)\]\.join\('\|\|'\)/);
});

test('hashFNV1a is deterministic and compact', () => {
  const source = getConstArrowSource('hashFNV1a');
  const { hashFNV1a } = new Function(`${source}; return { hashFNV1a };`)();
  assert.equal(hashFNV1a('Bonjour'), hashFNV1a('Bonjour'));
  assert.notEqual(hashFNV1a('Bonjour'), hashFNV1a('Bonsoir'));
  assert.match(hashFNV1a('Un texte assez long '.repeat(100)), /^[0-9a-z]+$/);
  assert.ok(hashFNV1a('Un texte assez long '.repeat(100)).length <= 8);
});

test('lruCacheGet/Set evicts old entries and respects TTL', () => {
  const lruCacheGetSource = getConstArrowSource('lruCacheGet');
  const lruCacheSetSource = getConstArrowSource('lruCacheSet');
  const createHarness = new Function(`
    const CORRECTION_CACHE_MAX = 2;
    const CORRECTION_CACHE_TTL_MS = 10;
    const persistCalls = [];
    const persistCacheSave = (cache) => persistCalls.push(Array.from(cache.keys()));
    ${lruCacheGetSource}
    ${lruCacheSetSource}
    return { lruCacheGet, lruCacheSet, persistCalls };
  `);
  const { lruCacheGet, lruCacheSet, persistCalls } = createHarness();
  const cache = new Map();

  lruCacheSet(cache, 'a', 1);
  lruCacheSet(cache, 'b', 2);
  assert.equal(lruCacheGet(cache, 'a'), 1);
  lruCacheSet(cache, 'c', 3);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('c'), true);

  cache.set('old', { v: 9, t: Date.now() - 20 });
  assert.equal(lruCacheGet(cache, 'old'), null);
  assert.equal(cache.has('old'), false);
  assert.ok(persistCalls.length >= 4);
});

test('sensitive inline blocks are protected from LanguageTool replacements', () => {
  const corrector = createCorrectionHarness();
  const text = 'Salut @matteo, lis https://example.com puis contact dev@example.com avec #Projet et `npm test`.';
  const analysis = corrector.analyzeSelectionText(text, 'chat.example.com');
  const protectedKinds = new Set(analysis.protectedRanges.map((range) => range.kind));

  assert.ok(analysis.profile.urlCount >= 1);
  assert.ok(analysis.profile.mentionCount >= 1);
  assert.ok(analysis.profile.hashtagCount >= 1);
  assert.equal(analysis.profile.chatLike, true);
  assert.ok(['url', 'email', 'mention', 'hashtag', 'code'].every((kind) => protectedKinds.has(kind)));

  const context = makeContext({
    mode: 'balanced',
    profile: analysis.profile,
    protectedRanges: analysis.protectedRanges,
  });
  for (const token of ['@matteo', 'https://example.com', 'dev@example.com', '#Projet', '`npm test`']) {
    const match = {
      offset: text.indexOf(token),
      length: token.length,
      replacements: [{ value: 'remplacement' }],
      rule: { issueType: 'misspelling', category: { id: 'TYPOS' }, id: 'FAKE_RULE' },
    };
    const matchInfo = corrector.createMatchInfo(match, text);
    assert.equal(corrector.shouldKeepMatchInfo(matchInfo, context), false, `${token} should be protected`);
  }
});

test('simulated LanguageTool matches produce the expected corrected text', () => {
  const corrector = createCorrectionHarness();
  const text = 'Je suis aller au magasin.';
  const context = makeContext({ mode: 'balanced' });
  const matches = [{
    offset: 8,
    length: 5,
    message: 'Accord du participe passé',
    replacements: [{ value: 'allé' }],
    rule: { issueType: 'grammar', category: { id: 'GRAMMAR' }, id: 'FAKE_GRAMMAR' },
  }];

  const prepared = corrector.prepareMatches(text, matches, context);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].replacementValue, 'allé');
  assert.equal(corrector.applyMatches(text, prepared), 'Je suis allé au magasin.');
});

test('correction modes keep chat and balanced stricter than strict for style suggestions', () => {
  const corrector = createCorrectionHarness();
  const text = 'Salut';
  const styleMatch = {
    offset: 0,
    length: 5,
    message: 'Formulation plus soutenue',
    replacements: [{ value: 'Bonjour à toutes et à tous' }],
    rule: { issueType: 'style', category: { id: 'STYLE' }, id: 'FAKE_STYLE' },
  };

  const chatPrepared = corrector.prepareMatches(text, [styleMatch], makeContext({ mode: 'chat-lite' }));
  const balancedPrepared = corrector.prepareMatches(text, [styleMatch], makeContext({ mode: 'balanced' }));
  const strictPrepared = corrector.prepareMatches(text, [styleMatch], makeContext({ mode: 'strict' }));

  assert.equal(chatPrepared.length, 0);
  assert.equal(balancedPrepared.length, 0);
  assert.equal(strictPrepared.length, 1);
  assert.equal(corrector.applyMatches(text, strictPrepared), 'Bonjour à toutes et à tous');
});

test('cache keys are stable and do not expose the selected text', () => {
  const corrector = createCorrectionHarness();
  const text = 'Texte privé très spécifique avec une phrase complète.';
  const context = makeContext({
    host: 'mail.example.com',
    mode: 'strict',
    language: 'fr',
    flavor: 'prose',
  });

  const firstKey = corrector.buildCorrectionCacheKey(text, context);
  const secondKey = corrector.buildCorrectionCacheKey(text, context);
  const changedKey = corrector.buildCorrectionCacheKey(text + ' Plus.', context);

  assert.equal(firstKey, secondKey);
  assert.notEqual(firstKey, changedKey);
  assert.equal(firstKey.includes(text), false);
  assert.match(firstKey, /^mail\.example\.com\|\|strict\|\|fr\|\|prose\|\|\d+\|\|[0-9a-z]+$/);
});

test('UI hardening helpers cover copy, contenteditable, abort, and menu position', () => {
  assert.match(userscript, /const copyTextToClipboard = async \(text\) =>/);
  assert.match(userscript, /navigator\.clipboard/);
  assert.match(userscript, /GM_setClipboard/);
  assert.match(userscript, /document\.execCommand\('copy'\)/);
  assert.match(userscript, /getEditableRootFromNode\(node\)/);
  assert.match(userscript, /isContentEditable/);
  assert.match(userscript, /contenteditable="plaintext-only"/);
  assert.match(userscript, /abortCurrentRequest\(\)/);
  assert.match(userscript, /typeof this\.currentRequest\.abort === 'function'/);
  assert.match(userscript, /getClampedMenuPosition\(menu, x, y\)/);
});

test('text control replacement planner preserves surrounding text and caret', () => {
  const planTextControlReplacement = buildMethod(
    'planTextControlReplacement',
    ['value', 'start', 'end', 'originalText', 'replacementText']
  );

  const textareaPlan = planTextControlReplacement('Bonjour le monde', 11, 16, 'monde', 'site');
  assert.equal(textareaPlan.ok, true);
  assert.equal(textareaPlan.value, 'Bonjour le site');
  assert.equal(textareaPlan.selectionStart, 15);
  assert.equal(textareaPlan.selectionEnd, 15);

  const inputPlan = planTextControlReplacement('abc def ghi', 4, 7, 'def', 'XYZ');
  assert.equal(inputPlan.ok, true);
  assert.equal(inputPlan.value, 'abc XYZ ghi');
  assert.equal(inputPlan.selectionStart, 7);
});

test('text control replacement planner refuses stale or invalid selections', () => {
  const planTextControlReplacement = buildMethod(
    'planTextControlReplacement',
    ['value', 'start', 'end', 'originalText', 'replacementText']
  );

  const stale = planTextControlReplacement('Bonjour la page', 8, 10, 'le', 'une');
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'selection-changed');

  const invalid = planTextControlReplacement('Bonjour', -1, 4, 'Bonj', 'Salut');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid-selection-offsets');
});

test('automatic apply routes through robust replacement and copy fallback helpers', () => {
  assert.match(userscript, /applyCorrectionToSelection\(correctedText, selectionContext, applyToken\)/);
  assert.match(userscript, /kind: el\.tagName === 'TEXTAREA' \? 'textarea' : 'input'/);
  assert.match(userscript, /setNativeControlValue\(el, value\)/);
  assert.match(userscript, /Object\.getOwnPropertyDescriptor\(proto, 'value'\)\?\.set/);
  assert.match(userscript, /new InputEvent\('beforeinput'/);
  assert.match(userscript, /inputType: 'insertReplacementText'/);
  assert.match(userscript, /restoreSavedRangeSelection\(this\.selectionSource\)/);
  assert.match(userscript, /range\.deleteContents\(\)/);
  assert.match(userscript, /handleApplyFailure[\s\S]*copyTextToClipboard\(correctedText\)/);
  assert.match(userscript, /replacementCopied: 'Remplacement impossible sur ce champ\. La correction a été copiée automatiquement\.'/);
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

test('prepareMatches filters noisy match info before scoring replacements', () => {
  const prepareBody = getBlockBody('prepareMatches');
  const infoCheckIndex = prepareBody.indexOf('this.shouldKeepMatchInfo(matchInfo, correctionContext)');
  const pickIndex = prepareBody.indexOf('this.pickReplacement(matchInfo, text, correctionContext)');
  const finalCheckIndex = prepareBody.indexOf('this.shouldKeepMatchFinal(matchInfo, replacementValue, correctionContext)');
  assert.ok(infoCheckIndex > -1);
  assert.ok(pickIndex > -1);
  assert.ok(finalCheckIndex > -1);
  assert.ok(infoCheckIndex < pickIndex);
  assert.ok(pickIndex < finalCheckIndex);
  assert.match(userscript, /shouldKeepMatch\(matchInfo, replacementValue, context\) \{\s*return this\.shouldKeepMatchInfo/);
});

test('applyMatches applies sorted replacements in one pass and skips overlaps', () => {
  const applyMatches = buildMethod('applyMatches', ['text', 'matches']);
  assert.equal(applyMatches('abcdef', []), 'abcdef');
  assert.equal(applyMatches('abcdef', null), 'abcdef');
  assert.equal(
    applyMatches('abcdef', [
      { offset: 4, length: 2, replacementValue: 'YZ' },
      { offset: 1, length: 2, replacementValue: 'XX' },
    ]),
    'aXXdYZ'
  );
  assert.equal(
    applyMatches('abcdefg', [
      { offset: 2, length: 3, replacementValue: 'X' },
      { offset: 3, length: 2, replacementValue: 'Y' },
    ]),
    'abXfg'
  );
});

test('applyMatches remains fast for long selections', () => {
  const applyMatches = buildMethod('applyMatches', ['text', 'matches']);
  const text = 'a'.repeat(20000);
  const matches = Array.from({ length: 50 }, (_, i) => ({
    offset: i * 350,
    length: 1,
    replacementValue: 'b',
  }));
  const start = performance.now();
  const result = applyMatches(text, matches);
  const elapsed = performance.now() - start;
  assert.equal(result.length, text.length);
  assert.ok(elapsed < 25, `applyMatches took ${elapsed.toFixed(2)} ms`);
});

test('personal dictionary remains out of scope', () => {
  assert.doesNotMatch(userscript, /__corrector_dict|Ajouter au dictionnaire|Dictionnaire personnel/);
  assert.doesNotMatch(readme, /Dictionnaire personnel|Ajouter au dictionnaire/);
});

test('README documents privacy, endpoint, and public API limits', () => {
  assert.match(readme, /https:\/\/api\.languagetool\.org\/v2\/check/);
  assert.match(readme, /texte sélectionné est envoyé à LanguageTool/);
  assert.match(readme, /preferredVariants=fr-FR,en-US,de-DE,pt-PT/);
  assert.match(readme, /20 requêtes par minute/);
  assert.match(readme, /20 KB par requête/);
  assert.match(readme, /Cache persistant/);
  assert.match(readme, /7 jours/);
  assert.match(readme, /hash FNV-1a/);
});

test('README documents stronger automatic replacement without promising every site', () => {
  assert.match(readme, /remplacement automatique est renforcé pour les champs `textarea`, `input`, les zones `contenteditable`/i);
  assert.match(readme, /fallback \*\*Copier\*\* quand un site refuse la modification/);
  assert.doesNotMatch(readme, /100 % des sites|tous les éditeurs modernes sans exception/i);
});

test('README documents local checks and GitHub Actions coverage', () => {
  assert.match(readme, /npm run check/);
  assert.match(readme, /npm test/);
  assert.match(readme, /GitHub Actions exécute automatiquement ces commandes sur chaque push et chaque Pull Request/);
  assert.match(readme, /réponses LanguageTool simulées/);
  assert.match(readme, /protection des `@mentions`, `#hashtags`, URLs, emails/);
});
