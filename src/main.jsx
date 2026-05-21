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

const ARTICLE_BY_GENUS = {
  m: 'der',
  f: 'die',
  n: 'das'
};

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

async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load nouns.csv (${response.status})`);
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
  onProgress(5);
  const duckdbModuleUrl = assetUrl('duckdb-browser.mjs');
  const duckdb = await import(/* @vite-ignore */ duckdbModuleUrl);
  onProgress(15);

  const bundle = await duckdb.selectBundle(BUNDLES);
  onProgress(25);

  const worker = await duckdb.createWorker(bundle.mainWorker);
  onProgress(35);

  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker, (event) => {
    const ratio = event.bytesTotal ? event.bytesLoaded / event.bytesTotal : 0;
    onProgress(35 + Math.round(ratio * 30));
  });
  onProgress(65);

  const conn = await db.connect();
  onProgress(70);

  const buffer = await fetchWithProgress(assetUrl('nouns.csv'), (ratio) => {
    onProgress(70 + Math.round(ratio * 20));
  });
  onProgress(90);

  await db.registerFileBuffer('nouns.csv', buffer);
  await conn.query(`
    CREATE OR REPLACE VIEW nouns AS
    SELECT *
    FROM read_csv_auto('nouns.csv', header = true, ignore_errors = true);
  `);
  onProgress(100);

  return { db, conn };
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

  const exact = (await conn.query(exactSql)).toArray().map((row) => row.toJSON());
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

  const suggestions = (await conn.query(suggestionSql)).toArray().map((row) => row.toJSON());
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
      </div>
    </article>
  );
}

function App() {
  const [readyState, setReadyState] = useState('loading');
  const [status, setStatus] = useState('Loading DuckDB and nouns.csv...');
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

    initDuckDb((progress) => {
      if (!cancelled) {
        setLoadingProgress(Math.max(0, Math.min(progress, 100)));
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
        setReadyState('ready');
        setStatus('Ready');
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

    return 'Search exact German nouns such as Haus, Katze, Baum, or Mädchen.';
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

  function handleSuggestionClick(row) {
    const displayNoun = getDisplayNoun(row);
    setSearchTerm(displayNoun);
    setSuppressedSuggestionTerm(normalizeInput(displayNoun));
    setTypeaheadSuggestions([]);
    setResult({ exact: [row], suggestions: [] });
    setLastQuery(displayNoun);
    setStatus('Ready');
    setIsSearching(false);
  }

  const knownResult = useMemo(
    () => ({
      exact: result.exact.filter(hasKnownArticle),
      suggestions: result.suggestions.filter(hasKnownArticle)
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
