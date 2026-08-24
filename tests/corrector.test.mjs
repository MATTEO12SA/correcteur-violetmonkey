import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const userscript = readFileSync(join(root, 'corrector.user.js'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const getBlockBody = (name) => {
  const markers = [`    ${name}(`, `    async ${name}(`];
  const start = Math.max(...markers.map((marker) => userscript.indexOf(marker)));
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
  const asyncPrefix = userscript.includes(`    async ${name}(`) ? 'async ' : '';
  const envNames = Object.keys(env);
  const envValues = Object.values(env);
  return new Function(...envNames, `return ${asyncPrefix}function(${args.join(', ')}) {${body}};`)(...envValues);
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
  assert.equal(pkg.version, '4.12.0');
  assert.match(userscript, /@version\s+4\.12\.0/);
  const updateLine = userscript.split(/\r?\n/).find((line) => line.includes('@updateURL'));
  assert.equal(
    updateLine,
    '// @updateURL      https://raw.githubusercontent.com/MATTEO12SA/correcteur-violetmonkey/main/corrector.user.js'
  );
  assert.match(userscript, /@connect\s+api\.languagetool\.org/);
  assert.match(userscript, /@grant\s+GM_setValue/);
  assert.match(userscript, /@grant\s+GM_getValue/);
  assert.match(userscript, /@grant\s+GM_setClipboard/);
  assert.doesNotMatch(userscript, /@grant\s+GM_deleteValue/);
  assert.match(userscript, /LANGUAGETOOL_ENDPOINT = 'https:\/\/api\.languagetool\.org\/v2\/check'/);
  assert.match(userscript, /SCRIPT_USER_AGENT = 'CorrecteurDePhrases\/4\.12\.0/);
  assert.doesNotMatch(userscript, /languagetoolplus\.com/);
  assert.doesNotMatch(userscript, /tryDraftReactWholeEditorReplacement/);
});

test('LanguageTool requests keep strict mode and rate-limit guards explicit', () => {
  assert.match(userscript, /LANGUAGETOOL_PREFERRED_VARIANTS = 'fr-FR,en-US,de-DE,pt-PT'/);
  assert.match(userscript, /level: context\.mode === 'strict' \? 'picky' : 'default'/);
  assert.match(userscript, /'Accept': 'application\/json'/);
  assert.match(userscript, /'User-Agent': SCRIPT_USER_AGENT/);
  assert.match(userscript, /LANGUAGETOOL_RATE_LIMIT_COOLDOWN_MS = 60000/);
  assert.match(userscript, /LANGUAGETOOL_MAX_BYTES_PER_MINUTE = 75000/);
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
    {},
    'Bonjour',
    { mode: 'chat-lite', language: 'fr' }
  ));
  assert.equal(chatParams.get('language'), 'fr');
  assert.equal(chatParams.get('level'), 'default');
  assert.equal(chatParams.get('disabledCategories'), 'STYLE,REDUNDANCY,COLLOQUIALISMS,TYPOGRAPHY');

  const balancedParams = new URLSearchParams(buildLanguageToolPayload.call(
    {},
    'Bonjour',
    { mode: 'balanced', language: 'auto' }
  ));
  assert.equal(balancedParams.get('language'), 'auto');
  assert.equal(balancedParams.get('disabledCategories'), 'STYLE,REDUNDANCY');

  const strictParams = new URLSearchParams(buildLanguageToolPayload.call(
    {},
    'Hello',
    { mode: 'strict', language: 'en-US' }
  ));
  assert.equal(strictParams.get('level'), 'picky');
  assert.equal(strictParams.has('disabledCategories'), false);
});

test('detectLanguageHint prefers field lang and defaults to auto', () => {
  class FakeHTMLElement {}
  const mapLanguageCode = buildMethod('mapLanguageCode', ['rawLang']);
  const detectLanguageHint = buildMethod('detectLanguageHint', ['selectionContext'], {
    Node: { TEXT_NODE: 3 },
    HTMLElement: FakeHTMLElement,
  });

  const frField = Object.create(FakeHTMLElement.prototype);
  frField.getAttribute = () => 'fr-FR';
  frField.closest = () => frField;

  assert.equal(mapLanguageCode('en-GB'), 'en-GB');
  assert.equal(mapLanguageCode('fr-FR'), 'fr');
  assert.equal(mapLanguageCode('ja'), null);

  const fromField = detectLanguageHint.call(
    { mapLanguageCode },
    { type: 'control', el: frField }
  );
  assert.equal(fromField, 'fr');

  const fallbackAuto = detectLanguageHint.call(
    { mapLanguageCode },
    null
  );
  assert.equal(fallbackAuto, null);
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
  const sanitizeSourceStart = userscript.indexOf('const sanitizeCachedMatches = ');
  const persistLoadStart = userscript.indexOf('const persistCacheLoad = ');
  const sanitizeSource = userscript.slice(sanitizeSourceStart, persistLoadStart);
  const createHarness = new Function(`
    const CORRECTION_CACHE_MAX = 2;
    const CORRECTION_CACHE_TTL_MS = 10;
    const persistCalls = [];
    const persistCacheSave = (cache) => persistCalls.push(Array.from(cache.keys()));
    ${sanitizeSource}
    ${lruCacheGetSource}
    ${lruCacheSetSource}
    return { lruCacheGet, lruCacheSet, persistCalls };
  `);
  const { lruCacheGet, lruCacheSet, persistCalls } = createHarness();
  const cache = new Map();

  lruCacheSet(cache, 'a', [{ offset: 0, length: 1, replacements: [{ value: 'x' }] }]);
  lruCacheSet(cache, 'b', [{ offset: 0, length: 1, replacements: [{ value: 'y' }] }]);
  assert.equal(lruCacheGet(cache, 'a')[0].replacements[0].value, 'x');
  lruCacheSet(cache, 'c', [{ offset: 0, length: 1, replacements: [{ value: 'z' }] }]);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('c'), true);

  cache.set('old', { v: [{ offset: 0, length: 1, replacements: [{ value: '9' }] }], t: Date.now() - 20 });
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
  assert.match(userscript, /const copyTextToClipboard = async \(text, shadowRoot = null\) =>/);
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

test('text control replacement validates target state before writing', () => {
  const validateControlSelectionContext = buildMethod('validateControlSelectionContext', ['context']);

  const validEl = { isConnected: true, value: 'Bonjour le monde' };
  assert.deepEqual(
    validateControlSelectionContext({ type: 'control', el: validEl, start: 11, end: 16, rawText: 'monde' }),
    { ok: true, reason: null }
  );

  assert.equal(
    validateControlSelectionContext({ type: 'control', el: { ...validEl, isConnected: false }, start: 11, end: 16, rawText: 'monde' }).reason,
    'target-detached'
  );
  assert.equal(
    validateControlSelectionContext({ type: 'control', el: { ...validEl, readOnly: true }, start: 11, end: 16, rawText: 'monde' }).reason,
    'not-editable'
  );
  assert.equal(
    validateControlSelectionContext({ type: 'control', el: validEl, start: 11, end: 16, rawText: 'site' }).reason,
    'selection-changed'
  );
});

test('applyControlReplacement writes textarea selection, preserves cursor and dispatches events', () => {
  const EventCtor = class {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
    }
  };
  const applyControlReplacement = buildMethod('applyControlReplacement', ['selectionContext', 'replacementText'], {
    Event: EventCtor,
  });
  const createApplyResult = buildMethod('createApplyResult', ['ok', 'method', 'reason', 'extra = {}']);
  const validateControlSelectionContext = buildMethod('validateControlSelectionContext', ['context']);
  const planTextControlReplacement = buildMethod(
    'planTextControlReplacement',
    ['value', 'start', 'end', 'originalText', 'replacementText']
  );
  const events = [];
  const textarea = {
    tagName: 'TEXTAREA',
    isConnected: true,
    disabled: false,
    readOnly: false,
    value: 'Bonjour le monde',
    scrollTop: 42,
    focusOptions: null,
    selectionStart: null,
    selectionEnd: null,
    focus(options) { this.focusOptions = options; },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    dispatchEvent(event) {
      events.push(event.type);
      return true;
    },
  };
  const harness = {
    createApplyResult,
    validateControlSelectionContext(context) {
      return validateControlSelectionContext.call(this, context);
    },
    planTextControlReplacement,
    focusWithoutScroll(el) { el.focus({ preventScroll: true }); },
    dispatchReplacementBeforeInput() {
      events.push('beforeinput');
      return true;
    },
    setNativeControlValue(el, value) { el.value = value; },
    dispatchReplacementInput() { events.push('input'); },
  };

  const result = applyControlReplacement.call(
    harness,
    { type: 'control', kind: 'textarea', el: textarea, start: 11, end: 16, rawText: 'monde' },
    'site'
  );

  assert.equal(result.ok, true);
  assert.equal(result.method, 'textarea');
  assert.equal(result.reason, null);
  assert.equal(textarea.value, 'Bonjour le site');
  assert.equal(textarea.selectionStart, 15);
  assert.equal(textarea.selectionEnd, 15);
  assert.equal(textarea.scrollTop, 42);
  assert.deepEqual(events, ['beforeinput', 'input', 'change']);
});

test('applyControlReplacement refuses stale, readonly, detached, and canceled inputs', () => {
  const EventCtor = class {
    constructor(type) { this.type = type; }
  };
  const applyControlReplacement = buildMethod('applyControlReplacement', ['selectionContext', 'replacementText'], {
    Event: EventCtor,
  });
  const createApplyResult = buildMethod('createApplyResult', ['ok', 'method', 'reason', 'extra = {}']);
  const validateControlSelectionContext = buildMethod('validateControlSelectionContext', ['context']);
  const planTextControlReplacement = buildMethod(
    'planTextControlReplacement',
    ['value', 'start', 'end', 'originalText', 'replacementText']
  );
  const makeHarness = (beforeInputAccepted = true) => ({
    createApplyResult,
    validateControlSelectionContext(context) {
      return validateControlSelectionContext.call(this, context);
    },
    planTextControlReplacement,
    focusWithoutScroll() {},
    dispatchReplacementBeforeInput() { return beforeInputAccepted; },
    setNativeControlValue(el, value) { el.value = value; },
    dispatchReplacementInput() {},
  });
  const makeInput = (overrides = {}) => ({
    tagName: 'INPUT',
    isConnected: true,
    disabled: false,
    readOnly: false,
    value: 'abc def ghi',
    setSelectionRange() {},
    dispatchEvent() { return true; },
    ...overrides,
  });

  const stale = applyControlReplacement.call(
    makeHarness(),
    { type: 'control', kind: 'input', el: makeInput(), start: 4, end: 7, rawText: 'xyz' },
    'DEF'
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.method, null);
  assert.equal(stale.reason, 'selection-changed');

  const readonly = applyControlReplacement.call(
    makeHarness(),
    { type: 'control', kind: 'input', el: makeInput({ readOnly: true }), start: 4, end: 7, rawText: 'def' },
    'DEF'
  );
  assert.equal(readonly.reason, 'not-editable');

  const detached = applyControlReplacement.call(
    makeHarness(),
    { type: 'control', kind: 'input', el: makeInput({ isConnected: false }), start: 4, end: 7, rawText: 'def' },
    'DEF'
  );
  assert.equal(detached.reason, 'target-detached');

  const canceled = applyControlReplacement.call(
    makeHarness(false),
    { type: 'control', kind: 'input', el: makeInput(), start: 4, end: 7, rawText: 'def' },
    'DEF'
  );
  assert.equal(canceled.reason, 'beforeinput-cancelled');
});

test('contenteditable range replacement inserts text and returns a structured result', () => {
  const insertedNodes = [];
  const events = [];
  const fakeSelection = {
    rangeCount: 1,
    removeAllRangesCalled: false,
    getRangeAt() { return range; },
    removeAllRanges() { this.removeAllRangesCalled = true; },
    addRange(nextRange) { this.addedRange = nextRange; },
  };
  const windowStub = { getSelection: () => fakeSelection };
  const applyContentEditableRangeReplacement = buildMethod(
    'applyContentEditableRangeReplacement',
    ['selectionContext', 'editableEl', 'replacementText'],
    { window: windowStub, document: { createTextNode: (text) => ({ nodeType: 3, nodeValue: text, isConnected: false }) } }
  );
  const createApplyResult = buildMethod('createApplyResult', ['ok', 'method', 'reason', 'extra = {}']);
  const editable = {
    isConnected: true,
    textContent: 'Je suis aller.',
    ownerDocument: {
      createTextNode(text) {
        return { nodeType: 3, nodeValue: text, isConnected: false };
      },
    },
  };
  const textNode = { nodeType: 3, isConnected: true, parentElement: editable };
  const range = {
    startContainer: textNode,
    endContainer: textNode,
    toString: () => 'aller',
    deleteContents() { editable.textContent = 'Je suis .'; },
    insertNode(node) {
      node.isConnected = true;
      insertedNodes.push(node);
      editable.textContent = 'Je suis allé.';
    },
    setStartAfter(node) { this.startAfter = node; },
    setEndAfter(node) { this.endAfter = node; },
    collapse(value) { this.collapsed = value; },
  };
  const harness = {
    createApplyResult,
    isRangeValid: () => true,
    rangeBelongsToEditable: () => true,
    focusWithoutScroll() {},
    restoreSavedRangeSelection: () => true,
    getActiveSelectionRangeInEditable: () => range,
    dispatchReplacementBeforeInput: () => true,
    dispatchReplacementInput: () => { events.push('input'); },
    tryExecCommandReplacement() { throw new Error('execCommand fallback should not run'); },
  };

  const result = applyContentEditableRangeReplacement.call(
    harness,
    { type: 'range', range, rawText: 'aller' },
    editable,
    'allé'
  );

  assert.equal(result.ok, true);
  assert.equal(result.method, 'contenteditable-range');
  assert.equal(result.reason, null);
  assert.equal(editable.textContent, 'Je suis allé.');
  assert.equal(insertedNodes[0].nodeValue, 'allé');
  assert.deepEqual(events, ['input']);
});

test('contenteditable replacement refuses invalid context and can fall back to execCommand', () => {
  const fakeSelection = { rangeCount: 1, getRangeAt: () => range, removeAllRanges() {}, addRange() {} };
  const applyContentEditableRangeReplacement = buildMethod(
    'applyContentEditableRangeReplacement',
    ['selectionContext', 'editableEl', 'replacementText'],
    { window: { getSelection: () => fakeSelection }, document: { createTextNode: (text) => ({ nodeValue: text }) } }
  );
  const createApplyResult = buildMethod('createApplyResult', ['ok', 'method', 'reason', 'extra = {}']);
  const editable = { isConnected: true, ownerDocument: { createTextNode: (text) => ({ nodeValue: text }) } };
  const range = {
    toString: () => 'aller',
    deleteContents() { throw new Error('blocked by editor'); },
  };
  const baseHarness = {
    createApplyResult,
    isRangeValid: () => true,
    rangeBelongsToEditable: () => true,
    focusWithoutScroll() {},
    restoreSavedRangeSelection: () => true,
    getActiveSelectionRangeInEditable: () => range,
    dispatchReplacementBeforeInput: () => true,
    dispatchReplacementInput() {},
  };

  const missingRange = applyContentEditableRangeReplacement.call(
    baseHarness,
    { type: 'range', rawText: 'aller' },
    editable,
    'allé'
  );
  assert.equal(missingRange.ok, false);
  assert.equal(missingRange.reason, 'range-invalid');

  const detached = applyContentEditableRangeReplacement.call(
    baseHarness,
    { type: 'range', range, rawText: 'aller' },
    { isConnected: false },
    'allé'
  );
  assert.equal(detached.reason, 'target-detached');

  const stale = applyContentEditableRangeReplacement.call(
    { ...baseHarness, isRangeValid: () => false },
    { type: 'range', range, rawText: 'aller' },
    editable,
    'allé'
  );
  assert.equal(stale.reason, 'selection-changed');

  const fallback = applyContentEditableRangeReplacement.call(
    {
      ...baseHarness,
      tryExecCommandReplacement() {
        return createApplyResult(true, 'exec-command', null, { kind: 'contenteditable' });
      },
    },
    { type: 'range', range, rawText: 'aller' },
    editable,
    'allé'
  );
  assert.equal(fallback.ok, true);
  assert.equal(fallback.method, 'exec-command');
});

test('applyCorrectionToSelection returns ok method and reason fields', () => {
  const createApplyResult = buildMethod('createApplyResult', ['ok', 'method', 'reason', 'extra = {}']);
  const applyCorrectionToSelection = buildMethod(
    'applyCorrectionToSelection',
    ['correctedText', 'selectionContext', 'applyToken'],
    { Node: { TEXT_NODE: 3 } }
  );

  const missing = applyCorrectionToSelection.call({
    createApplyResult,
    getReplacementText: (text) => text,
  }, 'texte', null, 1);
  assert.equal(missing.ok, false);
  assert.equal(missing.method, null);
  assert.equal(missing.reason, 'selection-lost');

  const success = applyCorrectionToSelection.call({
    createApplyResult,
    getReplacementText: (text) => text,
    applyControlReplacement: () => createApplyResult(true, 'input', null, { kind: 'input' }),
  }, 'texte', { type: 'control', kind: 'input' }, 1);
  assert.equal(success.ok, true);
  assert.equal(success.method, 'input');
  assert.equal(success.reason, null);
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
  assert.match(userscript, /document\.execCommand\('insertText', false, replacementText\)/);
  assert.match(userscript, /if \(result\.ok\) this\.finishApplySuccess\(result\);/);
  assert.match(userscript, /void this\.handleApplyFailure\(this\.getApplyFailureMessage\(result\), corrected\)/);
  assert.match(userscript, /handleApplyFailure[\s\S]*copyTextToClipboard\(correctedText, this\.uiRoot\)/);
  assert.match(userscript, /replacementCopied: 'Remplacement impossible sur ce champ\. La correction a été copiée automatiquement\.'/);
  assert.match(userscript, /replacementCopyFailure: 'Remplacement impossible sur ce champ\. Utilisez le bouton Copier pour récupérer la correction\.'/);
});

test('getSelectionContextRect refuses detached controls without reading global selection', () => {
  let globalSelectionCalls = 0;
  const getSelectionContextRect = buildMethod('getSelectionContextRect', ['context'], {
    window: {
      getSelection() {
        globalSelectionCalls += 1;
        throw new Error('global selection should not be read');
      },
    },
  });

  const rect = getSelectionContextRect({
    type: 'control',
    el: {
      tagName: 'INPUT',
      isConnected: false,
      getBoundingClientRect() {
        throw new Error('detached controls should not be measured');
      },
    },
  });

  assert.equal(rect, null);
  assert.equal(globalSelectionCalls, 0);
});

test('getSelectionContextRect prefers input and textarea context over window selection', () => {
  let globalSelectionCalls = 0;
  const getSelectionContextRect = buildMethod('getSelectionContextRect', ['context'], {
    window: {
      getSelection() {
        globalSelectionCalls += 1;
        throw new Error('global selection should not be used for controls');
      },
    },
  });

  for (const tagName of ['INPUT', 'TEXTAREA']) {
    const expectedRect = { left: 10, top: 20, right: 110, bottom: 40, width: 100, height: 20 };
    const rect = getSelectionContextRect({
      type: 'control',
      el: {
        tagName,
        isConnected: true,
        getBoundingClientRect() {
          return expectedRect;
        },
      },
    });

    assert.equal(rect, expectedRect);
  }
  assert.equal(globalSelectionCalls, 0);
});

test('getSelectionContextRect uses saved DOM ranges before window selection', () => {
  let globalSelectionCalls = 0;
  const getSelectionContextRect = buildMethod('getSelectionContextRect', ['context'], {
    window: {
      getSelection() {
        globalSelectionCalls += 1;
        throw new Error('global selection should not be used when range is valid');
      },
    },
  });
  const expectedRect = { left: 2, top: 4, right: 20, bottom: 14, width: 18, height: 10 };

  const rect = getSelectionContextRect({
    type: 'range',
    range: {
      getBoundingClientRect() {
        return expectedRect;
      },
    },
  });

  assert.equal(rect, expectedRect);
  assert.equal(globalSelectionCalls, 0);
});

test('handleApplyFailure shows manual copy guidance when automatic copy fails', async () => {
  const handleApplyFailure = buildMethod('handleApplyFailure', ['message', 'correctedText'], {
    copyTextToClipboard: async () => false,
    dbgProblem() {},
    USER_MESSAGES: {
      replacementCopied: 'Remplacement impossible sur ce champ. La correction a été copiée automatiquement.',
      replacementCopyFailure: 'Remplacement impossible sur ce champ. Utilisez le bouton Copier pour récupérer la correction.',
      applyGenericFailure: 'Impossible de remplacer sur ce site. Utilisez "Copier".',
    },
  });
  const copyBtn = { dataset: {}, style: {} };
  let shownMessage = '';

  await handleApplyFailure.call({
    getMenuRefs: () => ({ copyBtn }),
    showApplyError: (message) => { shownMessage = message; },
    uiRoot: null,
    selectionSource: { type: 'control', kind: 'input' },
  }, 'fallback initial', 'Texte corrigé');

  assert.equal(copyBtn.dataset.text, 'Texte corrigé');
  assert.equal(copyBtn.style.display, 'inline-block');
  assert.equal(
    shownMessage,
    'Remplacement impossible sur ce champ. Utilisez le bouton Copier pour récupérer la correction.'
  );
});

test('handleApplyFailure reports automatic copy success after replacement failure', async () => {
  const handleApplyFailure = buildMethod('handleApplyFailure', ['message', 'correctedText'], {
    copyTextToClipboard: async () => true,
    dbgProblem() {},
    USER_MESSAGES: {
      replacementCopied: 'Remplacement impossible sur ce champ. La correction a été copiée automatiquement.',
      replacementCopyFailure: 'Remplacement impossible sur ce champ. Utilisez le bouton Copier pour récupérer la correction.',
      applyGenericFailure: 'Impossible de remplacer sur ce site. Utilisez "Copier".',
    },
  });
  let shownMessage = '';

  await handleApplyFailure.call({
    getMenuRefs: () => ({ copyBtn: { dataset: {}, style: {} } }),
    showApplyError: (message) => { shownMessage = message; },
    uiRoot: null,
    selectionSource: { type: 'control', kind: 'textarea' },
  }, 'fallback initial', 'Texte corrigé');

  assert.equal(shownMessage, 'Remplacement impossible sur ce champ. La correction a été copiée automatiquement.');
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

test('normalizeLanguageToolMatches rejects invalid offsets and non-arrays', () => {
  const normalizeLanguageToolMatches = buildMethod('normalizeLanguageToolMatches', ['matches', 'text']);
  assert.deepEqual(normalizeLanguageToolMatches(null, 'abc'), []);
  assert.deepEqual(normalizeLanguageToolMatches('nope', 'abc'), []);
  const valid = [{ offset: 0, length: 1, replacements: [{ value: 'A' }] }];
  assert.equal(normalizeLanguageToolMatches(valid, 'abc').length, 1);
  assert.equal(
    normalizeLanguageToolMatches([{ offset: -1, length: 1, replacements: [{ value: 'A' }] }], 'abc').length,
    0
  );
  assert.equal(
    normalizeLanguageToolMatches([{ offset: 2, length: 5, replacements: [{ value: 'A' }] }], 'abc').length,
    0
  );
});

test('sanitizeCachedMatches strips LanguageTool context text excerpts', () => {
  assert.match(userscript, /const sanitizeCachedMatches = \(matches\) =>/);
  assert.match(readme, /context\.text/);

  // Behavioral check: persisted cache values keep only safe fields.
  const lruCacheSetSource = getConstArrowSource('lruCacheSet');
  const sanitizeSourceStart = userscript.indexOf('const sanitizeCachedMatches = ');
  const persistLoadStart = userscript.indexOf('const persistCacheLoad = ');
  assert.ok(sanitizeSourceStart > -1 && persistLoadStart > sanitizeSourceStart);
  const sanitizeSource = userscript.slice(sanitizeSourceStart, persistLoadStart);
  const createHarness = new Function(`
    const CORRECTION_CACHE_MAX = 2;
    const persistCalls = [];
    const persistCacheSave = (cache) => persistCalls.push(JSON.stringify(Array.from(cache.entries())));
    ${sanitizeSource}
    ${lruCacheSetSource}
    return { lruCacheSet, persistCalls };
  `);
  const { lruCacheSet, persistCalls } = createHarness();
  const cache = new Map();
  lruCacheSet(cache, 'k1', [{
    offset: 0,
    length: 5,
    message: 'ok',
    context: { text: 'SECRET private sentence', offset: 0, length: 5 },
    replacements: [{ value: 'salut', extra: 'drop-me' }],
    rule: { id: 'RULE', issueType: 'misspelling', category: { id: 'TYPOS' } },
  }]);
  assert.equal(cache.get('k1').v[0].context, undefined);
  assert.deepEqual(cache.get('k1').v[0].replacements, [{ value: 'salut' }]);
  assert.equal(persistCalls.join('').includes('SECRET'), false);
});

test('sensitive controls and email/tel input types are excluded', () => {
  class FakeHTMLElement {
    constructor(attrs = {}) {
      this.tagName = attrs.tagName || 'INPUT';
      this.type = attrs.type || 'text';
      this.id = attrs.id || '';
      this._attrs = attrs;
    }
    getAttribute(name) {
      return this._attrs[name] || null;
    }
  }
  const SENSITIVE_AUTOCOMPLETE = new Set([
    'email', 'tel', 'phone', 'mobile', 'username', 'current-password', 'new-password',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name',
    'cc-type', 'transaction-amount', 'transaction-currency', 'one-time-code',
  ]);
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url']);
  const source = `
    const HTMLElement = FakeHTMLElement;
    const SENSITIVE_AUTOCOMPLETE = new Set(${JSON.stringify([...SENSITIVE_AUTOCOMPLETE])});
    const TEXT_INPUT_TYPES = new Set(${JSON.stringify([...TEXT_INPUT_TYPES])});
    ${getConstArrowSource('isSensitiveControl')}
    ${getConstArrowSource('isTextControl')}
    return { isSensitiveControl, isTextControl };
  `;
  const { isSensitiveControl, isTextControl } = new Function('FakeHTMLElement', source)(FakeHTMLElement);

  assert.equal(isTextControl(new FakeHTMLElement({ tagName: 'INPUT', type: 'text' })), true);
  assert.equal(isTextControl(new FakeHTMLElement({ tagName: 'INPUT', type: 'email' })), false);
  assert.equal(isTextControl(new FakeHTMLElement({ tagName: 'INPUT', type: 'tel' })), false);
  assert.equal(isTextControl(new FakeHTMLElement({ tagName: 'INPUT', type: 'password' })), false);
  assert.equal(isTextControl(new FakeHTMLElement({ tagName: 'INPUT', type: 'text', autocomplete: 'cc-number' })), false);
  assert.equal(isSensitiveControl(new FakeHTMLElement({ tagName: 'INPUT', type: 'text', name: 'card_number' })), true);
});

test('menu open click guard and selection helpers are present', () => {
  assert.match(userscript, /MENU_OPEN_CLICK_GUARD_MS = 450/);
  assert.match(userscript, /_menuOpenedAt/);
  assert.match(userscript, /handleTouchEnd\(e\)/);
  assert.match(userscript, /if \(this\.menu\) return;/);
  assert.match(userscript, /Date\.now\(\) - \(this\._menuOpenedAt \|\| 0\) < MENU_OPEN_CLICK_GUARD_MS/);
  assert.match(userscript, /isSelectAll/);
  assert.match(userscript, /menu\.lang = 'fr'/);
  assert.match(userscript, /selectAllInsideEditable/);
  assert.match(userscript, /range\.selectNodeContents\(editableEl\)/);
});

test('handleOutsideClick ignores clicks right after opening the menu', () => {
  const MENU_OPEN_CLICK_GUARD_MS = 450;
  const handleOutsideClick = buildMethod('handleOutsideClick', ['e'], {
    MENU_OPEN_CLICK_GUARD_MS,
    Date,
  });
  let closed = 0;
  const harness = {
    menu: {},
    _menuOpenedAt: Date.now(),
    isUiEvent: () => false,
    closeMenu() { closed += 1; },
  };
  handleOutsideClick.call(harness, {});
  assert.equal(closed, 0);

  harness._menuOpenedAt = Date.now() - 1000;
  handleOutsideClick.call(harness, {});
  assert.equal(closed, 1);
});

test('debug logs capture API and apply problem paths', () => {
  assert.match(userscript, /const dbgProblem = \(scope, detail = \{\}\) =>/);
  assert.match(userscript, /dbgProblem\('languagetool-http'/);
  assert.match(userscript, /dbgProblem\('languagetool-network'\)/);
  assert.match(userscript, /dbgProblem\('languagetool-timeout'/);
  assert.match(userscript, /dbgProblem\('correction-error'/);
  assert.match(userscript, /dbgProblem\('apply-failure'/);
  assert.match(userscript, /dbgProblem\('apply-exception'/);
  assert.match(userscript, /dbg\('fetchCorrection start'/);
  assert.match(userscript, /dbg\('apply success'/);
  assert.match(userscript, /_logs\.length > 2000/);
});

test('personal dictionary remains out of scope', () => {
  assert.doesNotMatch(userscript, /__corrector_dict|Ajouter au dictionnaire|Dictionnaire personnel/);
  assert.doesNotMatch(readme, /Dictionnaire personnel|Ajouter au dictionnaire/);
});

test('README documents Violentmonkey install links and privacy limits', () => {
  assert.match(readme, /Violentmonkey/);
  assert.match(readme, /jinjaccalgkegednnccohejagnlnfdag/);
  assert.match(readme, /addons\.mozilla\.org\/firefox\/addon\/violentmonkey\//);
  assert.doesNotMatch(readme, /addon\/violetmonkey/);
  assert.doesNotMatch(readme, /jinjaccalgkegedbjfncswigafejgdne/);
  assert.match(readme, /https:\/\/api\.languagetool\.org\/v2\/check/);
  assert.match(readme, /texte sélectionné est envoyé à LanguageTool/);
  assert.match(readme, /preferredVariants=fr-FR,en-US,de-DE,pt-PT/);
  assert.match(readme, /20 requêtes par minute/);
  assert.match(readme, /20 KB par requête/);
  assert.match(readme, /75 KB/);
  assert.match(readme, /Cache persistant/);
  assert.match(readme, /7 jours/);
  assert.match(readme, /hash FNV-1a/);
  assert.match(readme, /context\.text/);
  assert.match(readme, /@noframes/);
});

test('README documents stronger automatic replacement without promising every site', () => {
  assert.match(readme, /remplacement automatique utilise plusieurs stratégies selon le contexte/i);
  assert.match(readme, /champs `input` \/ `textarea`, zones `contenteditable`, puis fallback \*\*Copier\*\*/);
  assert.doesNotMatch(readme, /100 % des sites|tous les éditeurs modernes sans exception/i);
});

test('README documents local checks and GitHub Actions coverage', () => {
  assert.match(readme, /npm run check/);
  assert.match(readme, /npm test/);
  assert.match(readme, /GitHub Actions exécute automatiquement ces commandes sur chaque push et chaque Pull Request/);
  assert.match(readme, /réponses LanguageTool simulées/);
  assert.match(readme, /protection des `@mentions`, `#hashtags`, URLs, emails/);
});
