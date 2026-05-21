import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, BookOpen, Check, Loader2, Search, Sparkles } from 'lucide-react';
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
const TRANSLATION_FILE_NAME = 'GERMAN_ENGLISH_TRANSLATION.csv';
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

function mergeEnglishValues(...values) {
  const translations = new Set();

  values
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => translations.add(value));

  return [...translations].join(', ');
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
      english: mergeEnglishValues(existing.english, row.english)
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
  report(85, 'Registering CSV files with DuckDB...');

  await db.registerFileBuffer(NOUN_FILE_NAME, nounBuffer);
  await db.registerFileBuffer(TRANSLATION_FILE_NAME, translationBuffer);
  report(90, 'Preparing searchable noun data...');

  await conn.query(`
    CREATE OR REPLACE VIEW nouns AS
    SELECT *
    FROM read_csv_auto('${NOUN_FILE_NAME}', header = true, ignore_errors = true);
  `);
  report(94, 'Preparing English translations...');

  await conn.query(`
    CREATE OR REPLACE VIEW translations AS
    SELECT DISTINCT
      lower(trim(CAST(GERMAN AS VARCHAR))) AS german_key,
      lower(trim(CAST(ENGLISH AS VARCHAR))) AS english_key,
      trim(CAST(ENGLISH AS VARCHAR)) AS english
    FROM read_csv_auto('${TRANSLATION_FILE_NAME}', header = true, ignore_errors = true)
    WHERE GERMAN IS NOT NULL
      AND ENGLISH IS NOT NULL
      AND trim(CAST(GERMAN AS VARCHAR)) <> ''
      AND trim(CAST(ENGLISH AS VARCHAR)) <> '';
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
    return rows.map((row) => ({ ...row, english: '' }));
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
        0 AS source_rank,
        1000 AS hits,
        length(translations.english) AS token_length
      FROM lookup
      JOIN translations ON translations.german_key = lookup.term
    ),
    phrase_matches AS (
      SELECT
        lookup.row_index,
        regexp_replace(token, '[^a-z]', '', 'g') AS english,
        1 AS source_rank,
        count(*) AS hits,
        length(regexp_replace(token, '[^a-z]', '', 'g')) AS token_length
      FROM lookup
      JOIN translations ON (' ' || translations.german_key || ' ') LIKE ('% ' || lookup.term || ' %')
      CROSS JOIN unnest(string_split(translations.english_key, ' ')) AS english_tokens(token)
      WHERE length(regexp_replace(token, '[^a-z]', '', 'g')) > 2
        AND regexp_replace(token, '[^a-z]', '', 'g') NOT IN (${ENGLISH_STOP_WORDS.map((word) => `'${word}'`).join(', ')})
      GROUP BY lookup.row_index, regexp_replace(token, '[^a-z]', '', 'g')
    ),
    ranked_matches AS (
      SELECT
        row_index,
        english,
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
      string_agg(DISTINCT english, ', ' ORDER BY english) AS english
    FROM ranked_matches
    WHERE rank = 1
    GROUP BY row_index;
  `;

  const translationsByIndex = new Map(
    (await conn.query(translationSql)).toArray().map((row) => {
      const translation = row.toJSON();
      return [Number(translation.row_index), translation.english || ''];
    })
  );

  return dedupeRows(rows.map((row, index) => ({
    ...row,
    english: translationsByIndex.get(index) || ''
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
      </div>
    </article>
  );
}

function App() {
  const [readyState, setReadyState] = useState('loading');
  const [status, setStatus] = useState('Loading DuckDB and CSV data...');
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [typeaheadSuggestions, setTypeaheadSuggestions] = useState([]);
  const [suppressedSuggestionTerm, setSuppressedSuggestionTerm] = useState('');
  const [result, setResult] = useState({ exact: [], suggestions: [] });
  const [lastQuery, setLastQuery] = useState('');
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
  }, [readyState, searchTerm, suppressedSuggestionTerm]);

  const helperText = useMemo(() => {
    if (readyState === 'loading') {
      return 'Preparing the in-browser SQL engine.';
    }

    if (readyState === 'error') {
      return 'The local CSV could not be loaded.';
    }

    return 'Search exact German nouns such as Haus, Katze, Baum, or Mädchen to see the article and English translation when available.';
  }, [readyState]);

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

  const knownResult = useMemo(
    () => ({
      exact: dedupeRows(result.exact.filter(hasKnownArticle)),
      suggestions: dedupeRows(result.suggestions.filter(hasKnownArticle))
    }),
    [result]
  );
  const showEmpty = lastQuery && !knownResult.exact.length && !knownResult.suggestions.length && !isSearching;
  const showTypeahead = searchTerm.trim().length > 1 && (isSuggesting || typeaheadSuggestions.length > 0);

  return (
    <main className="app-shell">
      <section className="search-panel" aria-labelledby="app-title">
        <div className="title-row">
          <div className="mark" aria-hidden="true">
            <BookOpen size={26} />
          </div>
          <div>
            <p className="eyebrow">German noun articles</p>
            <h1 id="app-title">Der, die oder das?</h1>
          </div>
        </div>

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

        <div className={`status status-${readyState}`} role={readyState === 'error' ? 'alert' : 'status'}>
          {readyState === 'error' ? <AlertCircle size={18} /> : <Sparkles size={18} />}
          <span>
            {readyState === 'loading' ? `${status} ${loadingProgress}%` : status}
          </span>
        </div>

        <p className="helper">{helperText}</p>
      </section>

      <section className="results-panel" aria-live="polite">
        {!lastQuery && (
          <div className="empty-state">
            <p>Enter a noun to see which article the CSV data returns.</p>
          </div>
        )}

        {isSearching && (
          <div className="empty-state">
            <Loader2 className="spin" size={30} />
            <p>Querying nouns.csv with DuckDB...</p>
          </div>
        )}

        {!!knownResult.exact.length && !isSearching && (
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

        {!!knownResult.suggestions.length && !isSearching && (
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

        {showEmpty && (
          <div className="empty-state">
            <AlertCircle size={30} />
            <p>No noun found for “{lastQuery}”.</p>
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
