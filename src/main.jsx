import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, BookOpen, Check, Languages, Loader2, Search, Sparkles } from 'lucide-react';
import './styles.css';

const BUNDLES = {
  mvp: {
    mainModule: assetUrl('duckdb-mvp.wasm'),
    mainWorker: assetUrl('duckdb-browser-mvp.worker.js')
  },
  eh: {
    mainModule: assetUrl('duckdb-eh.wasm'),
    mainWorker: assetUrl('duckdb-browser-eh.worker.js')
  }
};

const GENUS_COLUMNS = ['genus', 'genus 1', 'genus 2', 'genus 3', 'genus 4'];
const NOUN_FILE_NAME = 'nouns.csv';
const TRANSLATION_FILE_NAME = 'german_english.json';
const RUSSIAN_TRANSLATION_FILE_NAME = 'english_russian.json';
const ENGLISH_GERMAN_TRANSLATION_FILE_NAME = 'english_german.json';
const RUSSIAN_ENGLISH_TRANSLATION_FILE_NAME = 'russian_english.json';
const LOOKUP_COLUMNS = [
  'lemma',
  'nominativ singular',
  'nominativ singular 1',
  'nominativ singular 2',
  'nominativ singular 3',
  'nominativ singular 4'
];

const ARTICLE_BY_GENUS = {
  m: 'der',
  f: 'die',
  n: 'das'
};

const ENGLISH_STOP_WORDS = [
  'a',
  'about',
  'after',
  'all',
  'am',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'dont',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'i',
  'im',
  'in',
  'is',
  'it',
  'its',
  'john',
  'just',
  'mary',
  'me',
  'my',
  'of',
  'on',
  'our',
  'she',
  'that',
  'the',
  'their',
  'them',
  'there',
  'they',
  'this',
  'to',
  'tom',
  'toms',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
  'you',
  'your'
];

const SELECT_COLUMNS = `
  lemma,
  pos,
  genus,
  "genus 1",
  "genus 2",
  "genus 3",
  "genus 4",
  "nominativ singular",
  "nominativ singular 1",
  "nominativ singular 2",
  "nominativ singular 3",
  "nominativ singular 4"
`;

const TRANSLATION_DIRECTIONS = [
  {
    id: 'german-english',
    label: 'German to English',
    inputLabel: 'German word',
    placeholder: 'Haus',
    table: 'translations',
    sourceColumn: 'german_key',
    targetColumn: 'english',
    resultLabel: 'English'
  },
  {
    id: 'english-german',
    label: 'English to German',
    inputLabel: 'English word',
    placeholder: 'house',
    table: 'english_german_translations',
    sourceColumn: 'english_key',
    targetColumn: 'german',
    resultLabel: 'German'
  },
  {
    id: 'english-russian',
    label: 'English to Russian',
    inputLabel: 'English word',
    placeholder: 'tree',
    table: 'russian_translations',
    sourceColumn: 'english_key',
    targetColumn: 'russian',
    resultLabel: 'Russian'
  },
  {
    id: 'russian-english',
    label: 'Russian to English',
    inputLabel: 'Russian word',
    placeholder: 'дом',
    table: 'russian_english_translations',
    sourceColumn: 'russian_key',
    targetColumn: 'english',
    resultLabel: 'English'
  }
];

function assetUrl(path) {
  return new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).toString();
}

function escapeSql(value) {
  return value.replace(/'/g, "''");
}

function normalizeInput(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeLookupTerm(value) {
  return normalizeInput(String(value || ''))
    .toLowerCase()
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

function parseTranslationObject(buffer, fileName, sourceName, targetName) {
  const jsonText = new TextDecoder().decode(buffer);
  const translations = JSON.parse(jsonText);

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
      english: mergeTranslationValues(existing.english, row.english),
      russian: mergeTranslationValues(existing.russian, row.russian)
    });
  }

  return [...rowsByIdentity.values()];
}

function getArticles(row) {
  const articles = new Set();

  for (const column of GENUS_COLUMNS) {
    const value = row[column];
    if (!value) {
      continue;
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
  }

  return [...articles];
}

function hasKnownArticle(row) {
  return getArticles(row).length > 0;
}

function articleClass(article) {
  return `article article-${article}`;
}

function getDisplayNoun(row) {
  return row['nominativ singular'] || row.lemma;
}

function getTranslationLookupTerms(row) {
  const terms = new Set();

  for (const column of LOOKUP_COLUMNS) {
    const normalized = normalizeLookupTerm(row[column]);
    if (!normalized) {
      continue;
    }

    terms.add(normalized);
    terms.add(foldGermanTerm(normalized));
  }

  return [...terms];
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

function buildValuesSql(translations) {
  return translations
    .map(({ source, target }) => `('${escapeSql(source)}', '${escapeSql(target)}')`)
    .join(', ');
}

async function initDuckDb(onProgress = () => {}) {
  const report = (progress, status) => {
    onProgress({ progress, status });
  };

  report(5, 'Loading DuckDB module...');
  const duckdbModuleUrl = assetUrl('duckdb-browser.mjs');
  const duckdb = await import(/* @vite-ignore */ duckdbModuleUrl);
  report(15, 'Choosing the best DuckDB bundle...');

  const bundle = await duckdb.selectBundle(BUNDLES);
  report(25, 'Starting DuckDB worker...');

  const worker = await duckdb.createWorker(bundle.mainWorker);
  report(35, 'Starting DuckDB worker...');

  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker, (event) => {
    const ratio = event.bytesTotal ? event.bytesLoaded / event.bytesTotal : 0;
    report(35 + Math.round(ratio * 25), 'Initializing DuckDB engine...');
  });
  report(60, 'Opening DuckDB connection...');

  const conn = await db.connect();
  report(65, `Downloading ${NOUN_FILE_NAME}...`);

  const nounBuffer = await fetchWithProgress(assetUrl(NOUN_FILE_NAME), (ratio) => {
    report(65 + Math.round(ratio * 12), `Downloading ${NOUN_FILE_NAME}...`);
  }, NOUN_FILE_NAME);
  report(77, `Downloading ${TRANSLATION_FILE_NAME}...`);

  const translationBuffer = await fetchWithProgress(assetUrl(TRANSLATION_FILE_NAME), (ratio) => {
    report(77 + Math.round(ratio * 8), `Downloading ${TRANSLATION_FILE_NAME}...`);
  }, TRANSLATION_FILE_NAME);
  report(85, `Downloading ${RUSSIAN_TRANSLATION_FILE_NAME}...`);

  const russianTranslationBuffer = await fetchWithProgress(assetUrl(RUSSIAN_TRANSLATION_FILE_NAME), (ratio) => {
    report(85 + Math.round(ratio * 3), `Downloading ${RUSSIAN_TRANSLATION_FILE_NAME}...`);
  }, RUSSIAN_TRANSLATION_FILE_NAME);
  report(88, `Downloading ${ENGLISH_GERMAN_TRANSLATION_FILE_NAME}...`);

  const englishGermanTranslationBuffer = await fetchWithProgress(
    assetUrl(ENGLISH_GERMAN_TRANSLATION_FILE_NAME),
    (ratio) => {
      report(88 + Math.round(ratio), `Downloading ${ENGLISH_GERMAN_TRANSLATION_FILE_NAME}...`);
    },
    ENGLISH_GERMAN_TRANSLATION_FILE_NAME
  );
  report(89, `Downloading ${RUSSIAN_ENGLISH_TRANSLATION_FILE_NAME}...`);

  const russianEnglishTranslationBuffer = await fetchWithProgress(
    assetUrl(RUSSIAN_ENGLISH_TRANSLATION_FILE_NAME),
    (ratio) => {
      report(89 + Math.round(ratio), `Downloading ${RUSSIAN_ENGLISH_TRANSLATION_FILE_NAME}...`);
    },
    RUSSIAN_ENGLISH_TRANSLATION_FILE_NAME
  );
  report(90, 'Parsing translations...');

  const translations = parseTranslationObject(translationBuffer, TRANSLATION_FILE_NAME, 'German', 'English');
  const russianTranslations = parseTranslationObject(
    russianTranslationBuffer,
    RUSSIAN_TRANSLATION_FILE_NAME,
    'English',
    'Russian'
  );
  const englishGermanTranslations = parseTranslationObject(
    englishGermanTranslationBuffer,
    ENGLISH_GERMAN_TRANSLATION_FILE_NAME,
    'English',
    'German'
  );
  const russianEnglishTranslations = parseTranslationObject(
    russianEnglishTranslationBuffer,
    RUSSIAN_ENGLISH_TRANSLATION_FILE_NAME,
    'Russian',
    'English'
  );
  report(91, 'Registering noun data with DuckDB...');
  await db.registerFileBuffer(NOUN_FILE_NAME, nounBuffer);
  report(92, 'Preparing searchable noun data...');

  await conn.query(`
    CREATE OR REPLACE VIEW nouns AS
    SELECT *
    FROM read_csv_auto('${NOUN_FILE_NAME}', header = true, ignore_errors = true);
  `);
  report(94, 'Preparing translations...');

  const translationValues = buildValuesSql(translations);

  const russianTranslationValues = buildValuesSql(russianTranslations);
  const englishGermanTranslationValues = buildValuesSql(englishGermanTranslations);
  const russianEnglishTranslationValues = buildValuesSql(russianEnglishTranslations);

  await conn.query(`
    CREATE OR REPLACE TABLE translations AS
    SELECT DISTINCT
      lower(trim(CAST(german AS VARCHAR))) AS german_key,
      lower(trim(CAST(english AS VARCHAR))) AS english_key,
      trim(CAST(english AS VARCHAR)) AS english
    FROM (VALUES ${translationValues}) AS source(german, english);
  `);

  await conn.query(`
    CREATE OR REPLACE TABLE russian_translations AS
    SELECT DISTINCT
      lower(trim(CAST(english AS VARCHAR))) AS english_key,
      trim(CAST(russian AS VARCHAR)) AS russian
    FROM (VALUES ${russianTranslationValues}) AS source(english, russian);
  `);

  await conn.query(`
    CREATE OR REPLACE TABLE english_german_translations AS
    SELECT DISTINCT
      lower(trim(CAST(english AS VARCHAR))) AS english_key,
      trim(CAST(german AS VARCHAR)) AS german
    FROM (VALUES ${englishGermanTranslationValues}) AS source(english, german);
  `);

  await conn.query(`
    CREATE OR REPLACE TABLE russian_english_translations AS
    SELECT DISTINCT
      lower(trim(CAST(russian AS VARCHAR))) AS russian_key,
      trim(CAST(english AS VARCHAR)) AS english
    FROM (VALUES ${russianEnglishTranslationValues}) AS source(russian, english);
  `);
  report(99, 'Finalizing noun search...');

  return { db, conn };
}

async function enrichRowsWithTranslations(conn, rows) {
  if (!rows.length) {
    return [];
  }

  const lookupValues = rows.flatMap((row, rowIndex) =>
    getTranslationLookupTerms(row).map((term) => `(${rowIndex}, '${escapeSql(term)}')`)
  );

  if (!lookupValues.length) {
    return rows.map((row) => ({ ...row, english: '', russian: '' }));
  }

  const translationSql = `
    WITH
    lookup(row_index, term) AS (
      VALUES ${lookupValues.join(', ')}
    ),
    exact_matches AS (
      SELECT
        lookup.row_index,
        translations.english,
        russian_translations.russian,
        0 AS source_rank,
        1000 AS hits,
        length(translations.english) AS token_length
      FROM lookup
      JOIN translations ON translations.german_key = lookup.term
      LEFT JOIN russian_translations ON russian_translations.english_key = translations.english_key
    ),
    phrase_matches AS (
      SELECT
        lookup.row_index,
        regexp_replace(token, '[^a-z]', '', 'g') AS english,
        russian_translations.russian,
        1 AS source_rank,
        count(*) AS hits,
        length(regexp_replace(token, '[^a-z]', '', 'g')) AS token_length
      FROM lookup
      JOIN translations ON (' ' || translations.german_key || ' ') LIKE ('% ' || lookup.term || ' %')
      CROSS JOIN unnest(string_split(translations.english_key, ' ')) AS english_tokens(token)
      LEFT JOIN russian_translations ON russian_translations.english_key = regexp_replace(token, '[^a-z]', '', 'g')
      WHERE length(regexp_replace(token, '[^a-z]', '', 'g')) > 2
        AND regexp_replace(token, '[^a-z]', '', 'g') NOT IN (${ENGLISH_STOP_WORDS.map((word) => `'${word}'`).join(', ')})
      GROUP BY lookup.row_index, regexp_replace(token, '[^a-z]', '', 'g'), russian_translations.russian
    ),
    ranked_matches AS (
      SELECT
        row_index,
        english,
        russian,
        row_number() OVER (
          PARTITION BY row_index
          ORDER BY source_rank, hits DESC, token_length, english
        ) AS rank
      FROM (
        SELECT * FROM exact_matches
        UNION ALL
        SELECT * FROM phrase_matches
      )
    )
    SELECT
      row_index,
      string_agg(DISTINCT english, ', ' ORDER BY english) AS english,
      string_agg(DISTINCT russian, ', ' ORDER BY russian) FILTER (WHERE russian IS NOT NULL AND russian <> '') AS russian
    FROM ranked_matches
    WHERE rank = 1
    GROUP BY row_index;
  `;

  const translationsByIndex = new Map(
    (await conn.query(translationSql)).toArray().map((row) => {
      const translation = row.toJSON();
      return [Number(translation.row_index), {
        english: translation.english || '',
        russian: translation.russian || ''
      }];
    })
  );

  return dedupeRows(rows.map((row, index) => ({
    ...row,
    english: translationsByIndex.get(index)?.english || '',
    russian: translationsByIndex.get(index)?.russian || ''
  })));
}

async function queryNouns(conn, rawTerm) {
  const term = normalizeInput(rawTerm);
  if (!term) {
    return { exact: [], suggestions: [] };
  }

  const escapedTerm = escapeSql(term.toLowerCase());

  const exactSql = `
    SELECT ${SELECT_COLUMNS}
    FROM nouns
    WHERE lower(lemma) = '${escapedTerm}'
      OR lower("nominativ singular") = '${escapedTerm}'
      OR lower("nominativ singular 1") = '${escapedTerm}'
      OR lower("nominativ singular 2") = '${escapedTerm}'
      OR lower("nominativ singular 3") = '${escapedTerm}'
      OR lower("nominativ singular 4") = '${escapedTerm}'
    LIMIT 25;
  `;

  const exactRows = (await conn.query(exactSql)).toArray().map((row) => row.toJSON());
  const exact = await enrichRowsWithTranslations(conn, exactRows);
  if (exact.length) {
    return { exact, suggestions: [] };
  }

  const suggestionSql = `
    SELECT ${SELECT_COLUMNS}
    FROM nouns
    WHERE lower(lemma) LIKE '${escapedTerm}%'
       OR lower("nominativ singular") LIKE '${escapedTerm}%'
    ORDER BY length(lemma), lemma
    LIMIT 12;
  `;

  const suggestionRows = (await conn.query(suggestionSql)).toArray().map((row) => row.toJSON());
  const suggestions = await enrichRowsWithTranslations(conn, suggestionRows);
  return { exact: [], suggestions };
}

async function queryTypeaheadSuggestions(conn, rawTerm) {
  const term = normalizeInput(rawTerm);
  if (term.length <= 1) {
    return [];
  }

  const escapedTerm = escapeSql(term.toLowerCase());
  const suggestionSql = `
    SELECT ${SELECT_COLUMNS}
    FROM nouns
    WHERE lower(lemma) LIKE '${escapedTerm}%'
       OR lower("nominativ singular") LIKE '${escapedTerm}%'
    ORDER BY length(lemma), lemma
    LIMIT 25;
  `;

  return (await conn.query(suggestionSql))
    .toArray()
    .map((row) => row.toJSON())
    .filter(hasKnownArticle)
    .filter((row, index, rows) => rows.findIndex((item) => getResultIdentity(item) === getResultIdentity(row)) === index)
    .slice(0, 10);
}

async function queryTranslation(conn, directionId, rawTerm) {
  const direction = TRANSLATION_DIRECTIONS.find((item) => item.id === directionId) || TRANSLATION_DIRECTIONS[0];
  const term = normalizeInput(rawTerm);

  if (!term) {
    return { direction, exact: '', suggestions: [] };
  }

  const escapedTerm = escapeSql(term.toLowerCase());
  const exactSql = `
    SELECT string_agg(DISTINCT ${direction.targetColumn}, ', ' ORDER BY ${direction.targetColumn}) AS translation
    FROM ${direction.table}
    WHERE ${direction.sourceColumn} = '${escapedTerm}';
  `;

  const exactRow = (await conn.query(exactSql)).toArray()[0]?.toJSON();
  const exact = exactRow?.translation || '';

  if (exact) {
    return { direction, exact, suggestions: [] };
  }

  const suggestionSql = `
    SELECT
      ${direction.sourceColumn} AS source,
      string_agg(DISTINCT ${direction.targetColumn}, ', ' ORDER BY ${direction.targetColumn}) AS translation
    FROM ${direction.table}
    WHERE ${direction.sourceColumn} LIKE '${escapedTerm}%'
    GROUP BY ${direction.sourceColumn}
    ORDER BY length(${direction.sourceColumn}), ${direction.sourceColumn}
    LIMIT 8;
  `;

  const suggestions = (await conn.query(suggestionSql))
    .toArray()
    .map((row) => row.toJSON());

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
        {row.russian && <p className="translation">Russian: {row.russian}</p>}
      </div>
    </article>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState('articles');
  const [readyState, setReadyState] = useState('loading');
  const [status, setStatus] = useState('Loading DuckDB and local data...');
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [typeaheadSuggestions, setTypeaheadSuggestions] = useState([]);
  const [suppressedSuggestionTerm, setSuppressedSuggestionTerm] = useState('');
  const [result, setResult] = useState({ exact: [], suggestions: [] });
  const [lastQuery, setLastQuery] = useState('');
  const [translationTerm, setTranslationTerm] = useState('');
  const [translationDirection, setTranslationDirection] = useState(TRANSLATION_DIRECTIONS[0].id);
  const [translationResult, setTranslationResult] = useState({ exact: '', suggestions: [] });
  const [lastTranslationQuery, setLastTranslationQuery] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const dbRef = useRef(null);
  const connRef = useRef(null);
  const suggestionRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    initDuckDb(({ progress, status: nextStatus }) => {
      if (!cancelled) {
        setLoadingProgress(Math.max(0, Math.min(progress, 99)));
        setStatus(nextStatus);
      }
    })
      .then(({ db, conn }) => {
        if (cancelled) {
          conn.close();
          db.terminate();
          return;
        }

        dbRef.current = db;
        connRef.current = conn;
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
      connRef.current?.close?.();
      dbRef.current?.terminate?.();
    };
  }, []);

  useEffect(() => {
    const normalized = normalizeInput(searchTerm);
    const requestId = suggestionRequestRef.current + 1;
    suggestionRequestRef.current = requestId;

    if (
      readyState !== 'ready' ||
      activeTab !== 'articles' ||
      !connRef.current ||
      normalized.length <= 1 ||
      normalized === suppressedSuggestionTerm
    ) {
      setTypeaheadSuggestions([]);
      setIsSuggesting(false);
      return undefined;
    }

    setIsSuggesting(true);

    let isActive = true;

    const timeoutId = window.setTimeout(async () => {
      try {
        const nextSuggestions = await queryTypeaheadSuggestions(connRef.current, normalized);
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
  }, [activeTab, readyState, searchTerm, suppressedSuggestionTerm]);

  const helperText = useMemo(() => {
    if (readyState === 'loading') {
      return 'Preparing the in-browser SQL engine.';
    }

    if (readyState === 'error') {
      return 'The local data could not be loaded.';
    }

    if (activeTab === 'translation') {
      return 'Translate individual words between German, English, and Russian using the local JSON dictionaries.';
    }

    return 'Search exact German nouns such as Haus, Katze, Baum, or Mädchen to see the article and English translation when available.';
  }, [activeTab, readyState]);

  const selectedTranslationDirection = useMemo(
    () => TRANSLATION_DIRECTIONS.find((direction) => direction.id === translationDirection) || TRANSLATION_DIRECTIONS[0],
    [translationDirection]
  );

  async function handleSubmit(event) {
    event.preventDefault();
    if (readyState !== 'ready' || !connRef.current) {
      return;
    }

    const normalized = normalizeInput(searchTerm);
    if (!normalized) {
      setResult({ exact: [], suggestions: [] });
      setLastQuery('');
      setTypeaheadSuggestions([]);
      return;
    }

    setIsSearching(true);
    setStatus('Running SQL query...');
    setLastQuery(normalized);
    setTypeaheadSuggestions([]);

    try {
      const nextResult = await queryNouns(connRef.current, normalized);
      setResult(nextResult);
      setStatus('Ready');
    } catch (error) {
      setResult({ exact: [], suggestions: [] });
      setStatus(error?.message || String(error));
    } finally {
      setIsSearching(false);
    }
  }

  async function handleSuggestionClick(row) {
    const displayNoun = getDisplayNoun(row);
    setSearchTerm(displayNoun);
    setSuppressedSuggestionTerm(normalizeInput(displayNoun));
    setTypeaheadSuggestions([]);
    setLastQuery(displayNoun);
    setIsSearching(true);
    setStatus('Running SQL query...');

    try {
      const nextResult = await queryNouns(connRef.current, displayNoun);
      setResult(nextResult.exact.length ? nextResult : { exact: [row], suggestions: [] });
      setStatus('Ready');
    } catch (error) {
      setResult({ exact: [row], suggestions: [] });
      setStatus(error?.message || String(error));
    } finally {
      setIsSearching(false);
    }
  }

  async function handleTranslationSubmit(event) {
    event.preventDefault();
    if (readyState !== 'ready' || !connRef.current) {
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
      const nextResult = await queryTranslation(connRef.current, translationDirection, normalized);
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
      exact: dedupeRows(result.exact.filter(hasKnownArticle)),
      suggestions: dedupeRows(result.suggestions.filter(hasKnownArticle))
    }),
    [result]
  );
  const showEmpty = lastQuery && !knownResult.exact.length && !knownResult.suggestions.length && !isSearching;
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

        <div className="tab-switch" role="tablist" aria-label="Search mode">
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
            <label htmlFor="noun-search">German noun</label>
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
                placeholder="Type a noun..."
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
              <div className="suggestions" id="noun-suggestions" role="listbox" aria-label="Noun suggestions">
                {isSuggesting && (
                  <div className="suggestion-state">
                    <Loader2 className="spin" size={16} />
                    <span>Searching...</span>
                  </div>
                )}

                {!isSuggesting &&
                  typeaheadSuggestions.map((row, index) => {
                    const displayNoun = getDisplayNoun(row);

                    return (
                      <button
                        className="suggestion-item"
                        key={`${row.lemma}-${displayNoun}-${index}`}
                        onClick={() => handleSuggestionClick(row)}
                        role="option"
                        type="button"
                      >
                        <span className="suggestion-name">
                          <span>{displayNoun}</span>
                        </span>
                        {row.lemma !== displayNoun && <span className="suggestion-lemma">{row.lemma}</span>}
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
            <p>Enter a noun to see which article the local data returns.</p>
          </div>
        )}

        {activeTab === 'articles' && isSearching && (
          <div className="empty-state">
            <Loader2 className="spin" size={30} />
            <p>Querying nouns.csv with DuckDB...</p>
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

        {activeTab === 'articles' && showEmpty && (
          <div className="empty-state">
            <AlertCircle size={30} />
            <p>No noun found for “{lastQuery}”.</p>
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
