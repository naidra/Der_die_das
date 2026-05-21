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

async function initDuckDb() {
  const duckdbModuleUrl = assetUrl('duckdb-browser.mjs');
  const duckdb = await import(/* @vite-ignore */ duckdbModuleUrl);
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = await duckdb.createWorker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  const conn = await db.connect();
  const response = await fetch(assetUrl('nouns.csv'));
  if (!response.ok) {
    throw new Error(`Could not load nouns.csv (${response.status})`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  await db.registerFileBuffer('nouns.csv', buffer);
  await conn.query(`
    CREATE OR REPLACE VIEW nouns AS
    SELECT *
    FROM read_csv_auto('nouns.csv', header = true, ignore_errors = true);
  `);

  return { db, conn };
}

async function queryNouns(conn, rawTerm) {
  const term = normalizeInput(rawTerm);
  if (!term) {
    return { exact: [], suggestions: [] };
  }

  const escapedTerm = escapeSql(term.toLowerCase());
  const selectColumns = `
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

  const exactSql = `
    SELECT ${selectColumns}
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
    SELECT ${selectColumns}
    FROM nouns
    WHERE lower(lemma) LIKE '${escapedTerm}%'
       OR lower("nominativ singular") LIKE '${escapedTerm}%'
    ORDER BY length(lemma), lemma
    LIMIT 12;
  `;

  const suggestions = (await conn.query(suggestionSql)).toArray().map((row) => row.toJSON());
  return { exact: [], suggestions };
}

function ResultCard({ row, subtle = false }) {
  const articles = getArticles(row);
  const displayNoun = row['nominativ singular'] || row.lemma;

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
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [result, setResult] = useState({ exact: [], suggestions: [] });
  const [lastQuery, setLastQuery] = useState('');
  const dbRef = useRef(null);
  const connRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    initDuckDb()
      .then(({ db, conn }) => {
        if (cancelled) {
          conn.close();
          db.terminate();
          return;
        }

        dbRef.current = db;
        connRef.current = conn;
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
      return;
    }

    setIsSearching(true);
    setStatus('Running SQL query...');
    setLastQuery(normalized);

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

  const knownResult = useMemo(
    () => ({
      exact: result.exact.filter(hasKnownArticle),
      suggestions: result.suggestions.filter(hasKnownArticle)
    }),
    [result]
  );
  const showEmpty = lastQuery && !knownResult.exact.length && !knownResult.suggestions.length && !isSearching;

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
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Type a noun..."
              autoComplete="off"
              disabled={readyState !== 'ready'}
            />
            <button type="submit" disabled={readyState !== 'ready' || isSearching}>
              {isSearching ? <Loader2 className="spin" size={20} /> : <Check size={20} />}
              <span>Check</span>
            </button>
          </div>
        </form>

        <div className={`status status-${readyState}`} role={readyState === 'error' ? 'alert' : 'status'}>
          {readyState === 'error' ? <AlertCircle size={18} /> : <Sparkles size={18} />}
          <span>{status}</span>
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
