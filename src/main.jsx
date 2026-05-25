import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, BookOpen, Check, Languages, Loader2, Search, Sparkles } from 'lucide-react';
import './styles.css';

const NOUN_FILE_NAME = 'german_nouns.json';
const WORD_FILE_NAME = 'german_words.json';
const TRANSLATION_FILE_NAME = 'german_english.json';
const RUSSIAN_TRANSLATION_FILE_NAME = 'english_russian.json';
const ENGLISH_GERMAN_TRANSLATION_FILE_NAME = 'english_german.json';
const RUSSIAN_ENGLISH_TRANSLATION_FILE_NAME = 'russian_english.json';

const ARTICLE_BY_GENUS = {
  m: 'der',
  f: 'die',
  n: 'das'
};

const DETERMINER_FORMS = [
  { base: 'ein', english: 'a / an', forms: { der: 'ein', die: 'eine', das: 'ein' } },
  { base: 'kein', english: 'no / not a', forms: { der: 'kein', die: 'keine', das: 'kein' } },
  { base: 'mein', english: 'my', forms: { der: 'mein', die: 'meine', das: 'mein' } },
  { base: 'dein', english: 'your', forms: { der: 'dein', die: 'deine', das: 'dein' } },
  { base: 'sein', english: 'his / its', forms: { der: 'sein', die: 'seine', das: 'sein' } },
  { base: 'ihr', english: 'her / their', forms: { der: 'ihr', die: 'ihre', das: 'ihr' } },
  { base: 'unser', english: 'our', forms: { der: 'unser', die: 'unsere', das: 'unser' } },
  { base: 'euer', english: 'your (plural)', forms: { der: 'euer', die: 'eure', das: 'euer' } },
  { base: 'Ihr', english: 'your (formal)', forms: { der: 'Ihr', die: 'Ihre', das: 'Ihr' } }
];

const IRREGULAR_VERB_FORMS = {
  sein: [
    ['ich', 'bin'],
    ['du', 'bist'],
    ['er/sie/es', 'ist'],
    ['wir', 'sind'],
    ['ihr', 'seid'],
    ['sie/Sie', 'sind']
  ],
  haben: [
    ['ich', 'habe'],
    ['du', 'hast'],
    ['er/sie/es', 'hat'],
    ['wir', 'haben'],
    ['ihr', 'habt'],
    ['sie/Sie', 'haben']
  ],
  werden: [
    ['ich', 'werde'],
    ['du', 'wirst'],
    ['er/sie/es', 'wird'],
    ['wir', 'werden'],
    ['ihr', 'werdet'],
    ['sie/Sie', 'werden']
  ],
  wissen: [
    ['ich', 'weiß'],
    ['du', 'weißt'],
    ['er/sie/es', 'weiß'],
    ['wir', 'wissen'],
    ['ihr', 'wisst'],
    ['sie/Sie', 'wissen']
  ]
};

const PRONOUN_TRANSLATIONS = {
  ich: 'I',
  du: 'you',
  'er/sie/es': 'he / she / it',
  wir: 'we',
  ihr: 'you (plural)',
  'sie/Sie': 'they / you (formal)'
};

const TRANSLATION_DIRECTIONS = [
  {
    id: 'german-english',
    label: 'German to English',
    inputLabel: 'German word',
    placeholder: 'Haus',
    dictionary: 'germanEnglish',
    resultLabel: 'English'
  },
  {
    id: 'english-german',
    label: 'English to German',
    inputLabel: 'English word',
    placeholder: 'house',
    dictionary: 'englishGerman',
    resultLabel: 'German'
  },
  {
    id: 'english-russian',
    label: 'English to Russian',
    inputLabel: 'English word',
    placeholder: 'tree',
    dictionary: 'englishRussian',
    resultLabel: 'Russian'
  },
  {
    id: 'russian-english',
    label: 'Russian to English',
    inputLabel: 'Russian word',
    placeholder: 'дом',
    dictionary: 'russianEnglish',
    resultLabel: 'English'
  }
];

const TRANSLATION_FILE_BY_DICTIONARY = {
  germanEnglish: {
    fileName: TRANSLATION_FILE_NAME,
    sourceName: 'German',
    targetName: 'English'
  },
  englishGerman: {
    fileName: ENGLISH_GERMAN_TRANSLATION_FILE_NAME,
    sourceName: 'English',
    targetName: 'German'
  },
  englishRussian: {
    fileName: RUSSIAN_TRANSLATION_FILE_NAME,
    sourceName: 'English',
    targetName: 'Russian'
  },
  russianEnglish: {
    fileName: RUSSIAN_ENGLISH_TRANSLATION_FILE_NAME,
    sourceName: 'Russian',
    targetName: 'English'
  }
};

function assetUrl(path) {
  return new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).toString();
}

function normalizeInput(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeLookupTerm(value) {
  return normalizeInput(String(value || ''))
    .toLocaleLowerCase()
    .replace(/[.,!?;:"'()[\]{}]/g, '')
    .replace(/\s+/g, ' ');
}

function foldGermanTerm(value) {
  return value
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss');
}

function normalizeArticlesKey(articles) {
  return [...articles].sort().join('|');
}

function getResultIdentity(row) {
  return `${normalizeArticlesKey(getArticles(row))}:${normalizeLookupTerm(getDisplayNoun(row))}`;
}

function mergeTranslationValues(...values) {
  const translations = new Set();

  values
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => translations.add(value));

  return [...translations].join(', ');
}

function parseTranslationObject(translations, fileName, sourceName, targetName) {

  if (!translations || Array.isArray(translations) || typeof translations !== 'object') {
    throw new Error(`${fileName} must be a JSON object of ${sourceName} terms to ${targetName} translations`);
  }

  return Object.entries(translations)
    .map(([source, target]) => ({
      source: String(source || '').trim(),
      target: String(target || '').trim()
    }))
    .filter(({ source, target }) => source && target);
}

function createTranslationMap(translations) {
  const map = new Map();

  for (const { source, target } of translations) {
    const key = normalizeLookupTerm(source);
    const existing = map.get(key);
    map.set(key, mergeTranslationValues(existing, target));
  }

  return map;
}

function addWordIndexEntry(index, key, row) {
  if (!key || index.has(key)) {
    return;
  }

  index.set(key, row);
}

function createWordIndex(words) {
  const index = new Map();

  for (const row of words) {
    const key = normalizeLookupTerm(row.word);
    addWordIndexEntry(index, key, row);
    addWordIndexEntry(index, foldGermanTerm(key), row);
  }

  return index;
}

function addNounIndexEntry(index, key, row) {
  if (!key) {
    return;
  }

  const existing = index.get(key) || [];
  existing.push(row);
  index.set(key, existing);
}

function createNounIndex(nouns) {
  const index = new Map();

  for (const row of nouns) {
    const key = normalizeLookupTerm(row.lemma);
    addNounIndexEntry(index, key, row);
    addNounIndexEntry(index, foldGermanTerm(key), row);
  }

  return index;
}

function getNounSuggestionIdentity(row) {
  return `noun:${getResultIdentity(row)}`;
}

function getVerbSuggestionIdentity(row) {
  return `verb:${normalizeLookupTerm(row.word)}`;
}

function parseWordList(words, fileName) {
  if (!Array.isArray(words)) {
    throw new Error(`${fileName} must be a JSON array of German verbs`);
  }

  const rowsByWord = new Map();

  words.forEach((entry) => {
    const row = typeof entry === 'string' ? { word: entry } : entry;
    const word = String(row?.word || '').trim();

    if (!/^[a-zäöüß]+$/.test(word)) {
      return;
    }

    rowsByWord.set(word, {
      type: 'verb',
      word,
      forms: row.forms && typeof row.forms === 'object' ? row.forms : null,
      past: String(row.past || '').trim(),
      participle: String(row.participle || '').trim(),
      auxiliary: String(row.auxiliary || '').trim()
    });
  });

  return [...rowsByWord.values()]
    .sort((a, b) => a.word.localeCompare(b.word, 'de'));
}

function dedupeRows(rows) {
  const rowsByIdentity = new Map();

  for (const row of rows) {
    const identity = getResultIdentity(row);
    const existing = rowsByIdentity.get(identity);

    if (!existing) {
      rowsByIdentity.set(identity, row);
      continue;
    }

    rowsByIdentity.set(identity, {
      ...existing,
      english: mergeTranslationValues(existing.english, row.english)
    });
  }

  return [...rowsByIdentity.values()];
}

function getEnglishForNoun(data, row) {
  const normalized = normalizeLookupTerm(row.lemma);
  return data.translationMaps.germanEnglish.get(normalized) || data.translationMaps.germanEnglish.get(foldGermanTerm(normalized)) || '';
}

function getEnglishForWord(data, row) {
  const normalized = normalizeLookupTerm(row.word);
  return data.translationMaps.germanEnglish.get(normalized) || data.translationMaps.germanEnglish.get(foldGermanTerm(normalized)) || '';
}

function enrichWordWithEnglish(data, row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    english: getEnglishForWord(data, row)
  };
}

function enrichRowsWithEnglish(data, rows) {
  return dedupeRows(rows.map((row) => ({
    ...row,
    english: getEnglishForNoun(data, row)
  })));
}

function getArticles(row) {
  const articles = new Set();
  const value = row.genus;

  if (!value) {
    return [];
  }

  String(value)
    .split(/[,;/\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .forEach((genus) => {
      if (ARTICLE_BY_GENUS[genus]) {
        articles.add(ARTICLE_BY_GENUS[genus]);
      }
    });

  return [...articles];
}

function hasKnownArticle(row) {
  return getArticles(row).length > 0;
}

function articleClass(article) {
  return `article article-${article}`;
}

function getDisplayNoun(row) {
  return row.lemma;
}

function getWordForms(row) {
  const lowerWord = normalizeLookupTerm(row.word);
  const sourceForms = row.forms;

  if (sourceForms) {
    return ['ich', 'du', 'er/sie/es', 'wir', 'ihr', 'sie/Sie']
      .map((pronoun) => ({
        pronoun,
        form: String(sourceForms[pronoun] || '').trim()
      }))
      .filter(({ form }) => form);
  }

  const irregularForms = IRREGULAR_VERB_FORMS[lowerWord];

  if (irregularForms) {
    return irregularForms.map(([pronoun, form]) => ({ pronoun, form }));
  }

  if (!lowerWord.endsWith('en') && !lowerWord.endsWith('n')) {
    return [];
  }

  const stem = lowerWord.endsWith('en') ? lowerWord.slice(0, -2) : lowerWord.slice(0, -1);
  const needsE = /[td]$/.test(stem);
  const duEnding = /(?:s|ß|x|z)$/.test(stem) ? 't' : `${needsE ? 'e' : ''}st`;
  const tEnding = `${needsE ? 'e' : ''}t`;

  return [
    { pronoun: 'ich', form: `${stem}e` },
    { pronoun: 'du', form: `${stem}${duEnding}` },
    { pronoun: 'er/sie/es', form: `${stem}${tEnding}` },
    { pronoun: 'wir', form: lowerWord },
    { pronoun: 'ihr', form: `${stem}${tEnding}` },
    { pronoun: 'sie/Sie', form: lowerWord }
  ];
}

async function fetchWithProgress(url, onProgress, fileName = 'file') {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${fileName} (${response.status})`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (!response.body || !contentLength) {
    onProgress(1);
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    receivedLength += value.length;
    onProgress(Math.min(receivedLength / contentLength, 1));
  }

  const buffer = new Uint8Array(receivedLength);
  let position = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, position);
    position += chunk.length;
  }

  return buffer;
}

function parseJsonBuffer(buffer, fileName) {
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error(`${fileName} is not valid JSON`);
  }
}

async function loadTranslationMap(dictionary, onProgress = () => {}) {
  const config = TRANSLATION_FILE_BY_DICTIONARY[dictionary];

  if (!config) {
    throw new Error(`Unknown translation dictionary: ${dictionary}`);
  }

  const buffer = await fetchWithProgress(assetUrl(config.fileName), onProgress, config.fileName);
  const translations = parseTranslationObject(
    parseJsonBuffer(buffer, config.fileName),
    config.fileName,
    config.sourceName,
    config.targetName
  );

  return createTranslationMap(translations);
}

async function initAppData(onProgress = () => {}) {
  const report = (progress, status) => {
    onProgress({ progress, status });
  };

  report(10, `Downloading ${NOUN_FILE_NAME}...`);

  const nounBuffer = await fetchWithProgress(assetUrl(NOUN_FILE_NAME), (ratio) => {
    report(10 + Math.round(ratio * 45), `Downloading ${NOUN_FILE_NAME}...`);
  }, NOUN_FILE_NAME);
  report(65, `Downloading ${TRANSLATION_FILE_NAME}...`);

  const germanEnglishMap = await loadTranslationMap('germanEnglish', (ratio) => {
    report(55 + Math.round(ratio * 25), `Downloading ${TRANSLATION_FILE_NAME}...`);
  });
  report(80, `Downloading ${WORD_FILE_NAME}...`);

  const wordBuffer = await fetchWithProgress(assetUrl(WORD_FILE_NAME), (ratio) => {
    report(80 + Math.round(ratio * 15), `Downloading ${WORD_FILE_NAME}...`);
  }, WORD_FILE_NAME);
  report(95, 'Preparing local indexes...');

  const nouns = parseJsonBuffer(nounBuffer, NOUN_FILE_NAME)
    .map((row) => ({
      lemma: String(row.lemma || '').trim(),
      genus: String(row.genus || '').trim()
    }))
    .filter((row) => row.lemma);
  const words = parseWordList(parseJsonBuffer(wordBuffer, WORD_FILE_NAME), WORD_FILE_NAME);

  report(99, 'Finalizing local search...');

  return {
    nouns,
    nounIndex: createNounIndex(nouns),
    words,
    wordIndex: createWordIndex(words),
    translationMaps: {
      germanEnglish: germanEnglishMap
    }
  };
}

async function querySearch(data, rawTerm, searchKind) {
  const term = normalizeInput(rawTerm);
  if (!term) {
    return { exact: [], suggestions: [], word: null };
  }

  const lookupTerm = normalizeLookupTerm(term);

  if (searchKind === 'verbs') {
    const exactWord = data.wordIndex.get(lookupTerm) || data.wordIndex.get(foldGermanTerm(lookupTerm)) || null;
    if (exactWord) {
      return { exact: [], suggestions: [], word: enrichWordWithEnglish(data, exactWord) };
    }

    const foldedTerm = foldGermanTerm(lookupTerm);
    const suggestions = data.words
      .filter((row) => {
        const word = normalizeLookupTerm(row.word);
        return word.startsWith(lookupTerm) || foldGermanTerm(word).startsWith(foldedTerm);
      })
      .sort((a, b) => a.word.length - b.word.length || a.word.localeCompare(b.word, 'de'))
      .slice(0, 12)
      .map((row) => ({ type: 'verb', row }));

    return { exact: [], suggestions, word: null };
  }

  const exactRows = (data.nounIndex.get(lookupTerm) || data.nounIndex.get(foldGermanTerm(lookupTerm)) || []).slice(0, 25);
  const exact = enrichRowsWithEnglish(data, exactRows);
  if (exact.length) {
    return { exact, suggestions: [], word: null };
  }

  const foldedTerm = foldGermanTerm(lookupTerm);
  const suggestionRows = data.nouns
    .filter((row) => {
      const lemma = normalizeLookupTerm(row.lemma);
      return lemma.startsWith(lookupTerm) || foldGermanTerm(lemma).startsWith(foldedTerm);
    })
    .sort((a, b) => a.lemma.length - b.lemma.length || a.lemma.localeCompare(b.lemma, 'de'))
    .slice(0, 12);
  const suggestions = enrichRowsWithEnglish(data, suggestionRows);
  return { exact: [], suggestions, word: null };
}

async function queryTypeaheadSuggestions(data, rawTerm, searchKind) {
  const term = normalizeInput(rawTerm);
  if (term.length <= 1) {
    return [];
  }

  const lookupTerm = normalizeLookupTerm(term);
  const foldedTerm = foldGermanTerm(lookupTerm);

  if (searchKind === 'verbs') {
    return data.words
      .filter((row) => {
        const word = normalizeLookupTerm(row.word);
        return word.startsWith(lookupTerm) || foldGermanTerm(word).startsWith(foldedTerm);
      })
      .sort((a, b) => a.word.length - b.word.length || a.word.localeCompare(b.word, 'de'))
      .filter((row, index, rows) => rows.findIndex((item) => normalizeLookupTerm(item.word) === normalizeLookupTerm(row.word)) === index)
      .slice(0, 10)
      .map((row) => ({ type: 'verb', row }));
  }

  const nounSuggestions = data.nouns
    .filter((row) => {
      const lemma = normalizeLookupTerm(row.lemma);
      return lemma.startsWith(lookupTerm) || foldGermanTerm(lemma).startsWith(foldedTerm);
    })
    .sort((a, b) => a.lemma.length - b.lemma.length || a.lemma.localeCompare(b.lemma, 'de'))
    .slice(0, 25)
    .filter(hasKnownArticle)
    .filter((row, index, rows) => rows.findIndex((item) => getResultIdentity(item) === getResultIdentity(row)) === index)
    .slice(0, 8)
    .map((row) => ({ type: 'noun', row }));

  return nounSuggestions;
}

async function queryTranslation(data, directionId, rawTerm) {
  const direction = TRANSLATION_DIRECTIONS.find((item) => item.id === directionId) || TRANSLATION_DIRECTIONS[0];
  const term = normalizeInput(rawTerm);

  if (!term) {
    return { direction, exact: '', suggestions: [] };
  }

  const map = data.translationMaps[direction.dictionary];
  if (!map) {
    throw new Error(`Translation data for ${direction.label} is not loaded`);
  }

  const lookupTerm = normalizeLookupTerm(term);
  const exact = map.get(lookupTerm) || (direction.dictionary === 'germanEnglish' ? map.get(foldGermanTerm(lookupTerm)) : '');

  if (exact) {
    return { direction, exact, suggestions: [] };
  }

  const suggestions = [...map.entries()]
    .filter(([source]) => source.startsWith(lookupTerm))
    .sort(([sourceA], [sourceB]) => sourceA.length - sourceB.length || sourceA.localeCompare(sourceB))
    .slice(0, 8)
    .map(([source, translation]) => ({ source, translation }));

  return { direction, exact: '', suggestions };
}

function ResultCard({ row, subtle = false }) {
  const articles = getArticles(row);
  const displayNoun = getDisplayNoun(row);

  if (!articles.length) {
    return null;
  }

  return (
    <article className={subtle ? 'result-card subtle' : 'result-card'}>
      <div>
        <p className="noun">
          {articles.map((article) => (
            <span className={articleClass(article)} key={`${row.lemma}-${article}`}>
              {article}
            </span>
          ))}
          <span>{displayNoun}</span>
        </p>
        {row.lemma !== displayNoun && <p className="lemma">Lemma: {row.lemma}</p>}
        {row.english && <p className="translation">English: {row.english}</p>}
        {articles.map((article) => (
          <table className="determiner-table" aria-label={`${article} determiner forms for ${displayNoun}`} key={`${row.lemma}-${article}-determiners`}>
            <thead>
              <tr>
                <th scope="col">German</th>
                <th scope="col">English</th>
              </tr>
            </thead>
            <tbody>
              {DETERMINER_FORMS.map((item) => (
                <tr key={`${article}-${item.base}`}>
                  <td>{item.forms[article]}</td>
                  <td>{item.english}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </article>
  );
}

function WordCard({ row }) {
  const forms = getWordForms(row);

  return (
    <article className="result-card word-card">
      <table className="conjugation-table" aria-label={`Conjugation table for ${row.word}`}>
        <tbody>
          {forms.map(({ pronoun, form }) => (
            <tr key={`${row.word}-${pronoun}`}>
              <th data-tooltip={PRONOUN_TRANSLATIONS[pronoun]} scope="row" tabIndex="0">
                {pronoun}
              </th>
              <td>{form}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState('articles');
  const [readyState, setReadyState] = useState('loading');
  const [status, setStatus] = useState('Loading local JSON data...');
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [searchKind, setSearchKind] = useState('nouns');
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [typeaheadSuggestions, setTypeaheadSuggestions] = useState([]);
  const [suppressedSuggestionTerm, setSuppressedSuggestionTerm] = useState('');
  const [result, setResult] = useState({ exact: [], suggestions: [], word: null });
  const [lastQuery, setLastQuery] = useState('');
  const [translationTerm, setTranslationTerm] = useState('');
  const [translationDirection, setTranslationDirection] = useState(TRANSLATION_DIRECTIONS[0].id);
  const [translationResult, setTranslationResult] = useState({ exact: '', suggestions: [] });
  const [lastTranslationQuery, setLastTranslationQuery] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const dataRef = useRef(null);
  const suggestionRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    initAppData(({ progress, status: nextStatus }) => {
      if (!cancelled) {
        setLoadingProgress(Math.max(0, Math.min(progress, 99)));
        setStatus(nextStatus);
      }
    })
      .then((data) => {
        if (cancelled) {
          return;
        }

        dataRef.current = data;
        setLoadingProgress(100);
        setStatus('Ready');
        setReadyState('ready');
      })
      .catch((error) => {
        setReadyState('error');
        setStatus(error?.message || String(error));
      });

    return () => {
      cancelled = true;
      dataRef.current = null;
    };
  }, []);

  useEffect(() => {
    const normalized = normalizeInput(searchTerm);
    const requestId = suggestionRequestRef.current + 1;
    suggestionRequestRef.current = requestId;

    if (
      readyState !== 'ready' ||
      activeTab !== 'articles' ||
      !dataRef.current ||
      normalized.length <= 1 ||
      normalizeLookupTerm(normalized) === suppressedSuggestionTerm
    ) {
      setTypeaheadSuggestions([]);
      setIsSuggesting(false);
      return undefined;
    }

    setIsSuggesting(true);

    let isActive = true;

    const timeoutId = window.setTimeout(async () => {
      try {
        const nextSuggestions = await queryTypeaheadSuggestions(dataRef.current, normalized, searchKind);
        if (isActive && suggestionRequestRef.current === requestId) {
          setTypeaheadSuggestions(nextSuggestions);
        }
      } catch {
        if (isActive && suggestionRequestRef.current === requestId) {
          setTypeaheadSuggestions([]);
        }
      } finally {
        if (isActive && suggestionRequestRef.current === requestId) {
          setIsSuggesting(false);
        }
      }
    }, 250);

    return () => {
      isActive = false;
      window.clearTimeout(timeoutId);
    };
  }, [activeTab, readyState, searchKind, searchTerm, suppressedSuggestionTerm]);

  const helperText = useMemo(() => {
    if (readyState === 'loading') {
      return 'Loading compact local JSON dictionaries.';
    }

    if (readyState === 'error') {
      return 'The local data could not be loaded.';
    }

    if (activeTab === 'translation') {
      return 'Translate individual words between German, English, and Russian using the local JSON dictionaries.';
    }

    return searchKind === 'nouns'
      ? 'Search German nouns to see the article, English translation, and determiner forms.'
      : 'Search German verbs to see the conjugation table.';
  }, [activeTab, readyState, searchKind]);

  const selectedTranslationDirection = useMemo(
    () => TRANSLATION_DIRECTIONS.find((direction) => direction.id === translationDirection) || TRANSLATION_DIRECTIONS[0],
    [translationDirection]
  );

  async function handleSubmit(event) {
    event.preventDefault();
    if (readyState !== 'ready' || !dataRef.current) {
      return;
    }

    const normalized = normalizeInput(searchTerm);
    if (!normalized) {
      setResult({ exact: [], suggestions: [], word: null });
      setLastQuery('');
      setTypeaheadSuggestions([]);
      return;
    }

    setIsSearching(true);
    setStatus('Searching local JSON...');
    setLastQuery(normalized);
    setTypeaheadSuggestions([]);

    try {
      const nextResult = await querySearch(dataRef.current, normalized, searchKind);
      setResult(nextResult);
      setStatus('Ready');
    } catch (error) {
      setResult({ exact: [], suggestions: [], word: null });
      setStatus(error?.message || String(error));
    } finally {
      setIsSearching(false);
    }
  }

  async function handleNounSuggestionClick(row) {
    const displayNoun = getDisplayNoun(row);
    setSearchTerm(displayNoun);
    setSuppressedSuggestionTerm(normalizeLookupTerm(displayNoun));
    setTypeaheadSuggestions([]);
    setLastQuery(displayNoun);
    setIsSearching(true);
    setStatus('Searching local JSON...');

    try {
      const nextResult = await querySearch(dataRef.current, displayNoun, 'nouns');
      setResult(nextResult.exact.length ? nextResult : { exact: [row], suggestions: [], word: null });
      setStatus('Ready');
    } catch (error) {
      setResult({ exact: [row], suggestions: [], word: null });
      setStatus(error?.message || String(error));
    } finally {
      setIsSearching(false);
    }
  }

  function handleWordSuggestionClick(row) {
    const word = row.word;
    setSearchTerm(word);
    setSuppressedSuggestionTerm(normalizeLookupTerm(word));
    setTypeaheadSuggestions([]);
    setLastQuery(word);
    setResult({ exact: [], suggestions: [], word: enrichWordWithEnglish(dataRef.current, row) });
    setStatus('Ready');
  }

  async function handleTranslationSubmit(event) {
    event.preventDefault();
    if (readyState !== 'ready' || !dataRef.current) {
      return;
    }

    const normalized = normalizeInput(translationTerm);
    if (!normalized) {
      setTranslationResult({ exact: '', suggestions: [] });
      setLastTranslationQuery('');
      return;
    }

    setIsTranslating(true);
    setStatus('Running translation query...');
    setLastTranslationQuery(normalized);

    try {
      const direction = selectedTranslationDirection;
      if (!dataRef.current.translationMaps[direction.dictionary]) {
        const config = TRANSLATION_FILE_BY_DICTIONARY[direction.dictionary];
        setStatus(`Downloading ${config.fileName}...`);
        dataRef.current.translationMaps[direction.dictionary] = await loadTranslationMap(
          direction.dictionary,
          (ratio) => setStatus(`Downloading ${config.fileName}... ${Math.round(ratio * 100)}%`)
        );
      }

      setStatus('Running translation query...');
      const nextResult = await queryTranslation(dataRef.current, translationDirection, normalized);
      setTranslationResult(nextResult);
      setStatus('Ready');
    } catch (error) {
      setTranslationResult({ exact: '', suggestions: [] });
      setStatus(error?.message || String(error));
    } finally {
      setIsTranslating(false);
    }
  }

  const knownResult = useMemo(
    () => ({
      exact: dedupeRows((result.exact || []).filter(hasKnownArticle)),
      suggestions: dedupeRows((result.suggestions || []).filter(hasKnownArticle))
    }),
    [result]
  );
  const verbSuggestions = useMemo(
    () => (result.suggestions || []).filter((item) => item?.type === 'verb').map((item) => item.row),
    [result]
  );
  const showEmpty =
    lastQuery &&
    !knownResult.exact.length &&
    !knownResult.suggestions.length &&
    !verbSuggestions.length &&
    !result.word &&
    !isSearching;
  const showTypeahead = searchTerm.trim().length > 1 && (isSuggesting || typeaheadSuggestions.length > 0);
  const showTranslationEmpty =
    lastTranslationQuery && !translationResult.exact && !translationResult.suggestions.length && !isTranslating;

  return (
    <main className="app-shell">
      <section className="search-panel" aria-labelledby="app-title">
        <div className="title-row">
          <div className="mark" aria-hidden="true">
            <BookOpen size={26} />
          </div>
          <div>
            <p className="eyebrow">{activeTab === 'articles' ? 'German noun articles' : 'Translation only'}</p>
            <h1 id="app-title">{activeTab === 'articles' ? 'Der, die oder das?' : 'Word translator'}</h1>
          </div>
        </div>

        <div className="tab-switch tab-switch-hidden" role="tablist" aria-label="Search mode">
          <button
            aria-selected={activeTab === 'articles'}
            onClick={() => setActiveTab('articles')}
            role="tab"
            type="button"
          >
            <BookOpen size={17} />
            <span>Articles</span>
          </button>
          <button
            aria-selected={activeTab === 'translation'}
            onClick={() => {
              setActiveTab('translation');
              setTypeaheadSuggestions([]);
            }}
            role="tab"
            type="button"
          >
            <Languages size={17} />
            <span>Translation</span>
          </button>
        </div>

        {activeTab === 'articles' && (
          <form className="search-form" onSubmit={handleSubmit}>
            <div className="search-kind-toggle" role="tablist" aria-label="German search type">
              <button
                aria-selected={searchKind === 'nouns'}
                onClick={() => {
                  setSearchKind('nouns');
                  setResult({ exact: [], suggestions: [], word: null });
                  setLastQuery('');
                  setTypeaheadSuggestions([]);
                  setSuppressedSuggestionTerm('');
                }}
                role="tab"
                type="button"
              >
                Nouns
              </button>
              <button
                aria-selected={searchKind === 'verbs'}
                onClick={() => {
                  setSearchKind('verbs');
                  setResult({ exact: [], suggestions: [], word: null });
                  setLastQuery('');
                  setTypeaheadSuggestions([]);
                  setSuppressedSuggestionTerm('');
                }}
                role="tab"
                type="button"
              >
                Verbs
              </button>
            </div>

            <label htmlFor="noun-search">{searchKind === 'nouns' ? 'German noun' : 'German verb'}</label>
            <div className="search-box">
              <Search size={22} aria-hidden="true" />
              <input
                id="noun-search"
                type="search"
                value={searchTerm}
                onChange={(event) => {
                  setSearchTerm(event.target.value);
                  setSuppressedSuggestionTerm('');
                }}
                placeholder={searchKind === 'nouns' ? 'Type a noun...' : 'Type a verb...'}
                autoComplete="off"
                aria-autocomplete="list"
                aria-controls="noun-suggestions"
                aria-expanded={showTypeahead}
                disabled={readyState !== 'ready'}
              />
              <button type="submit" disabled={readyState !== 'ready' || isSearching}>
                {isSearching ? <Loader2 className="spin" size={20} /> : <Check size={20} />}
                <span>Check</span>
              </button>
            </div>

            {showTypeahead && (
              <div className="suggestions" id="noun-suggestions" role="listbox" aria-label={`${searchKind === 'nouns' ? 'Noun' : 'Verb'} suggestions`}>
                {isSuggesting && (
                  <div className="suggestion-state">
                    <Loader2 className="spin" size={16} />
                    <span>Searching...</span>
                  </div>
                )}

                {!isSuggesting &&
                  typeaheadSuggestions.map((suggestion, index) => {
                    const isNoun = suggestion.type === 'noun';
                    const row = suggestion.row;
                    const label = isNoun ? getDisplayNoun(row) : row.word;

                    return (
                      <button
                        className="suggestion-item"
                        key={`${isNoun ? getNounSuggestionIdentity(row) : getVerbSuggestionIdentity(row)}-${index}`}
                        onClick={() => (isNoun ? handleNounSuggestionClick(row) : handleWordSuggestionClick(row))}
                        role="option"
                        type="button"
                      >
                        <span className="suggestion-name">
                          <span>{label}</span>
                        </span>
                        <span className="suggestion-lemma">{isNoun ? 'noun' : 'verb'}</span>
                      </button>
                    );
                  })}
              </div>
            )}
          </form>
        )}

        {activeTab === 'translation' && (
          <form className="search-form translation-form" onSubmit={handleTranslationSubmit}>
            <label htmlFor="translation-direction">Direction</label>
            <select
              id="translation-direction"
              value={translationDirection}
              onChange={(event) => {
                setTranslationDirection(event.target.value);
                setTranslationResult({ exact: '', suggestions: [] });
                setLastTranslationQuery('');
              }}
              disabled={readyState !== 'ready'}
            >
              {TRANSLATION_DIRECTIONS.map((direction) => (
                <option key={direction.id} value={direction.id}>
                  {direction.label}
                </option>
              ))}
            </select>

            <label htmlFor="translation-search">{selectedTranslationDirection.inputLabel}</label>
            <div className="search-box">
              <Languages size={22} aria-hidden="true" />
              <input
                id="translation-search"
                type="search"
                value={translationTerm}
                onChange={(event) => setTranslationTerm(event.target.value)}
                placeholder={selectedTranslationDirection.placeholder}
                autoComplete="off"
                disabled={readyState !== 'ready'}
              />
              <button type="submit" disabled={readyState !== 'ready' || isTranslating}>
                {isTranslating ? <Loader2 className="spin" size={20} /> : <Search size={20} />}
                <span>Translate</span>
              </button>
            </div>
          </form>
        )}

        <div className={`status status-${readyState}`} role={readyState === 'error' ? 'alert' : 'status'}>
          {readyState === 'error' ? <AlertCircle size={18} /> : <Sparkles size={18} />}
          <span>
            {readyState === 'loading' ? `${status} ${loadingProgress}%` : status}
          </span>
        </div>

        <p className="helper">{helperText}</p>
      </section>

      <section className="results-panel" aria-live="polite">
        {activeTab === 'articles' && !lastQuery && (
          <div className="empty-state">
            <p>{searchKind === 'nouns' ? 'Enter a noun to see its article and forms.' : 'Enter a verb to see its conjugation table.'}</p>
          </div>
        )}

        {activeTab === 'articles' && isSearching && (
          <div className="empty-state">
            <Loader2 className="spin" size={30} />
            <p>Searching {searchKind === 'nouns' ? 'german_nouns.json' : 'german_words.json'}...</p>
          </div>
        )}

        {activeTab === 'articles' && !!knownResult.exact.length && !isSearching && (
          <>
            <div className="section-heading">
              <p>Best match</p>
              <span>{knownResult.exact.length} result{knownResult.exact.length === 1 ? '' : 's'}</span>
            </div>
            <div className="result-grid">
              {knownResult.exact.map((row, index) => (
                <ResultCard row={row} key={`${row.lemma}-${index}`} />
              ))}
            </div>
          </>
        )}

        {activeTab === 'articles' && !!knownResult.suggestions.length && !isSearching && (
          <>
            <div className="section-heading">
              <p>No exact match for “{lastQuery}”</p>
              <span>Similar entries</span>
            </div>
            <div className="result-grid">
              {knownResult.suggestions.map((row, index) => (
                <ResultCard row={row} subtle key={`${row.lemma}-${index}`} />
              ))}
            </div>
          </>
        )}

        {activeTab === 'articles' && result.word && !isSearching && (
          <>
            <div className="section-heading">
              <p>Verb forms</p>
              <span>External verb list</span>
            </div>
            <WordCard row={result.word} />
          </>
        )}

        {activeTab === 'articles' && !!verbSuggestions.length && !isSearching && (
          <>
            <div className="section-heading">
              <p>No exact match for “{lastQuery}”</p>
              <span>Similar verbs</span>
            </div>
            <div className="result-grid">
              {verbSuggestions.map((row) => (
                <button className="result-card verb-result-button" key={getVerbSuggestionIdentity(row)} onClick={() => handleWordSuggestionClick(row)} type="button">
                  {row.word}
                </button>
              ))}
            </div>
          </>
        )}

        {activeTab === 'articles' && showEmpty && (
          <div className="empty-state">
            <AlertCircle size={30} />
            <p>No {searchKind === 'nouns' ? 'noun' : 'verb'} found for “{lastQuery}”.</p>
          </div>
        )}

        {activeTab === 'translation' && !lastTranslationQuery && (
          <div className="empty-state">
            <p>Choose a direction and enter a word for dictionary translation.</p>
          </div>
        )}

        {activeTab === 'translation' && isTranslating && (
          <div className="empty-state">
            <Loader2 className="spin" size={30} />
            <p>Searching local JSON dictionaries...</p>
          </div>
        )}

        {activeTab === 'translation' && translationResult.exact && !isTranslating && (
          <>
            <div className="section-heading">
              <p>{translationResult.direction?.label || selectedTranslationDirection.label}</p>
              <span>Exact match</span>
            </div>
            <article className="result-card translation-card">
              <p className="translation-source">{lastTranslationQuery}</p>
              <p className="translation-target">
                <span>{translationResult.direction?.resultLabel || selectedTranslationDirection.resultLabel}</span>
                {translationResult.exact}
              </p>
            </article>
          </>
        )}

        {activeTab === 'translation' && !!translationResult.suggestions.length && !isTranslating && (
          <>
            <div className="section-heading">
              <p>No exact match for “{lastTranslationQuery}”</p>
              <span>Similar entries</span>
            </div>
            <div className="result-grid">
              {translationResult.suggestions.map((row) => (
                <article className="result-card subtle translation-card" key={row.source}>
                  <p className="translation-source">{row.source}</p>
                  <p className="translation-target">
                    <span>{translationResult.direction?.resultLabel || selectedTranslationDirection.resultLabel}</span>
                    {row.translation}
                  </p>
                </article>
              ))}
            </div>
          </>
        )}

        {activeTab === 'translation' && showTranslationEmpty && (
          <div className="empty-state">
            <AlertCircle size={30} />
            <p>No translation found for “{lastTranslationQuery}”.</p>
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
