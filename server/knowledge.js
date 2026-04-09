/**
 * ContentStore — SQLite FTS5 knowledge base.
 *
 * Dual-strategy search (Porter stemmer + trigram) merged via
 * Reciprocal Rank Fusion. Proximity reranking for multi-term queries.
 * Levenshtein fuzzy correction when initial results are empty.
 */

import { openDatabase, closeDB, withRetry } from './db-base.js';
import {
  sanitizeQuery, sanitizeTrigramQuery,
  levenshtein, maxEditDistance,
  findAllPositions, findMinSpan,
  extractSnippet, stripMarkers,
  STOPWORDS
} from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CHUNK_BYTES = 4096;
const RRF_K = 60;

// ─── ContentStore ─────────────────────────────────────────────────────────────

export class ContentStore {
  #db;
  #dbPath;
  #stmts = {};

  constructor(dbPath) {
    this.#dbPath = dbPath;
    this.#db = openDatabase(dbPath);
    this.#createSchema();
    this.#prepareStatements();
  }

  // ─── Schema ───────────────────────────────────────────────────────────────

  #createSchema() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER,
        code_chunk_count INTEGER,
        indexed_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);

      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );
    `);

    // FTS5 tables — created separately since IF NOT EXISTS isn't standard for virtual tables
    try {
      this.#db.exec(`
        CREATE VIRTUAL TABLE chunks USING fts5(
          title,
          content,
          source_id UNINDEXED,
          content_type UNINDEXED,
          tokenize='porter unicode61'
        );
      `);
    } catch (err) {
      if (!err.message.includes('already exists')) throw err;
    }

    try {
      this.#db.exec(`
        CREATE VIRTUAL TABLE chunks_trigram USING fts5(
          title,
          content,
          source_id UNINDEXED,
          content_type UNINDEXED,
          tokenize='trigram'
        );
      `);
    } catch (err) {
      if (!err.message.includes('already exists')) throw err;
    }
  }

  // ─── Prepared Statements ──────────────────────────────────────────────────

  #prepareStatements() {
    const db = this.#db;

    // Insert
    this.#stmts.insertSource = db.prepare(
      'INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, ?, ?)'
    );
    this.#stmts.insertChunk = db.prepare(
      'INSERT INTO chunks (title, content, source_id, content_type) VALUES (?, ?, ?, ?)'
    );
    this.#stmts.insertChunkTrigram = db.prepare(
      'INSERT INTO chunks_trigram (title, content, source_id, content_type) VALUES (?, ?, ?, ?)'
    );
    this.#stmts.insertVocab = db.prepare(
      'INSERT OR IGNORE INTO vocabulary (word) VALUES (?)'
    );

    // Delete (for re-indexing same source)
    this.#stmts.deleteChunksByLabel = db.prepare(
      'DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)'
    );
    this.#stmts.deleteChunksTrigramByLabel = db.prepare(
      'DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)'
    );
    this.#stmts.deleteSourceByLabel = db.prepare(
      'DELETE FROM sources WHERE label = ?'
    );

    // Search — Porter stemmer
    this.#stmts.searchPorter = db.prepare(`
      SELECT title, content, source_id, content_type,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = CAST(chunks.source_id AS INTEGER)
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    this.#stmts.searchPorterBySource = db.prepare(`
      SELECT title, content, source_id, content_type,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted
      FROM chunks
      JOIN sources ON sources.id = CAST(chunks.source_id AS INTEGER)
      WHERE chunks MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Search — Trigram
    this.#stmts.searchTrigram = db.prepare(`
      SELECT title, content, source_id, content_type,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = CAST(chunks_trigram.source_id AS INTEGER)
      WHERE chunks_trigram MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    this.#stmts.searchTrigramBySource = db.prepare(`
      SELECT title, content, source_id, content_type,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
      FROM chunks_trigram
      JOIN sources ON sources.id = CAST(chunks_trigram.source_id AS INTEGER)
      WHERE chunks_trigram MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Meta
    this.#stmts.getSourceMeta = db.prepare(
      'SELECT label, chunk_count AS chunkCount, code_chunk_count AS codeChunkCount, indexed_at AS indexedAt FROM sources WHERE label = ?'
    );
    this.#stmts.getSourceById = db.prepare(
      'SELECT label FROM sources WHERE id = ?'
    );

    // Vocabulary for fuzzy correction
    this.#stmts.getVocab = db.prepare(
      'SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?'
    );

    // Chunk listing
    this.#stmts.getChunksBySource = db.prepare(`
      SELECT title, content, content_type
      FROM chunks
      WHERE source_id = (SELECT id FROM sources WHERE label = ? LIMIT 1)
      ORDER BY rowid
    `);

    // Count
    this.#stmts.chunkCount = db.prepare('SELECT COUNT(*) AS count FROM chunks');
  }

  // ─── Indexing ─────────────────────────────────────────────────────────────

  /**
   * Index markdown/text content.
   */
  index({ content, source, path }) {
    const text = content || '';
    const label = source || path || `indexed:${Date.now()}`;

    // Delete existing content with same label (re-index)
    this.#deleteByLabel(label);

    const chunks = this.#chunkMarkdown(text);

    const insertAll = this.#db.transaction(() => {
      let codeChunks = 0;

      const sourceResult = this.#stmts.insertSource.run(label, chunks.length, 0);
      const sourceId = sourceResult.lastInsertRowid.toString();

      for (const chunk of chunks) {
        const contentType = this.#classifyChunk(chunk.content) ? 'code' : 'prose';
        if (contentType === 'code') codeChunks++;

        this.#stmts.insertChunk.run(chunk.title, chunk.content, sourceId, contentType);
        this.#stmts.insertChunkTrigram.run(chunk.title, chunk.content, sourceId, contentType);
      }

      // Update code chunk count
      this.#db.prepare('UPDATE sources SET code_chunk_count = ? WHERE id = ?')
        .run(codeChunks, sourceId);

      // Extract vocabulary
      this.#extractAndStoreVocabulary(text);

      return { sourceId, totalChunks: chunks.length, codeChunks, label };
    });

    return withRetry(() => insertAll());
  }

  /**
   * Index JSON content.
   */
  indexJSON(content, source) {
    let parsed;
    try {
      parsed = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      // Not valid JSON, fall back to plain text
      return this.indexPlainText(content, source);
    }

    const chunks = this.#chunkJSON(parsed, '');
    if (chunks.length === 0) {
      return this.indexPlainText(JSON.stringify(parsed, null, 2), source);
    }

    const label = source || `json:${Date.now()}`;
    this.#deleteByLabel(label);

    const insertAll = this.#db.transaction(() => {
      const sourceResult = this.#stmts.insertSource.run(label, chunks.length, 0);
      const sourceId = sourceResult.lastInsertRowid.toString();

      for (const chunk of chunks) {
        this.#stmts.insertChunk.run(chunk.title, chunk.content, sourceId, 'prose');
        this.#stmts.insertChunkTrigram.run(chunk.title, chunk.content, sourceId, 'prose');
      }

      this.#extractAndStoreVocabulary(JSON.stringify(parsed));
      return { sourceId, totalChunks: chunks.length, codeChunks: 0, label };
    });

    return withRetry(() => insertAll());
  }

  /**
   * Index plain text content.
   */
  indexPlainText(content, source, linesPerChunk = 20) {
    const label = source || `text:${Date.now()}`;
    const chunks = this.#chunkPlainText(content, linesPerChunk);

    this.#deleteByLabel(label);

    const insertAll = this.#db.transaction(() => {
      const sourceResult = this.#stmts.insertSource.run(label, chunks.length, 0);
      const sourceId = sourceResult.lastInsertRowid.toString();

      for (const chunk of chunks) {
        const contentType = this.#classifyChunk(chunk.content) ? 'code' : 'prose';
        this.#stmts.insertChunk.run(chunk.title, chunk.content, sourceId, contentType);
        this.#stmts.insertChunkTrigram.run(chunk.title, chunk.content, sourceId, contentType);
      }

      this.#extractAndStoreVocabulary(content);
      return { sourceId, totalChunks: chunks.length, codeChunks: 0, label };
    });

    return withRetry(() => insertAll());
  }

  #deleteByLabel(label) {
    withRetry(() => {
      this.#stmts.deleteChunksByLabel.run(label);
      this.#stmts.deleteChunksTrigramByLabel.run(label);
      this.#stmts.deleteSourceByLabel.run(label);
    });
  }

  // ─── Search Pipeline ──────────────────────────────────────────────────────

  /**
   * Porter stemmer FTS5 search.
   */
  search(query, limit = 10, source = null, mode = 'AND') {
    const sanitized = sanitizeQuery(query, mode);
    if (!sanitized) return [];

    try {
      if (source) {
        return this.#stmts.searchPorterBySource.all(sanitized, source, limit);
      }
      return this.#stmts.searchPorter.all(sanitized, limit);
    } catch {
      return [];
    }
  }

  /**
   * Trigram FTS5 search.
   */
  searchTrigram(query, limit = 10, source = null, mode = 'AND') {
    const sanitized = sanitizeTrigramQuery(query, mode);
    if (!sanitized) return [];

    try {
      if (source) {
        return this.#stmts.searchTrigramBySource.all(sanitized, source, limit);
      }
      return this.#stmts.searchTrigram.all(sanitized, limit);
    } catch {
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion: merge Porter and Trigram results.
   */
  #rrfSearch(query, limit, source = null) {
    const fetchLimit = Math.max(limit * 2, 10);

    const porterResults = this.search(query, fetchLimit, source, 'OR');
    const trigramResults = this.searchTrigram(query, fetchLimit, source, 'OR');

    const scoreMap = new Map();

    for (let i = 0; i < porterResults.length; i++) {
      const r = porterResults[i];
      const key = `${r.source_id}::${r.title}`;
      if (!scoreMap.has(key)) {
        scoreMap.set(key, { result: r, score: 0 });
      }
      scoreMap.get(key).score += 1 / (RRF_K + i + 1);
    }

    for (let i = 0; i < trigramResults.length; i++) {
      const r = trigramResults[i];
      const key = `${r.source_id}::${r.title}`;
      if (!scoreMap.has(key)) {
        scoreMap.set(key, { result: r, score: 0 });
      }
      scoreMap.get(key).score += 1 / (RRF_K + i + 1);
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(entry => entry.result);
  }

  /**
   * Proximity reranking for multi-term queries.
   * Boosts results where query terms appear close together.
   */
  #applyProximityReranking(results, query) {
    const terms = query
      .replace(/['"(){}[\]*:^~]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    if (terms.length < 2) return results;

    return results
      .map(r => {
        const content = stripMarkers(r.highlighted || r.content);
        const positionLists = terms.map(t => findAllPositions(content, t));

        // Skip if any term has no occurrences
        if (positionLists.some(l => l.length === 0)) {
          return { result: r, boost: 0 };
        }

        const minSpan = findMinSpan(positionLists);
        const boost = 1 / (1 + minSpan / content.length);
        return { result: r, boost };
      })
      .sort((a, b) => b.boost - a.boost)
      .map(entry => entry.result);
  }

  /**
   * Fuzzy correction: find best vocabulary match for misspelled terms.
   */
  #fuzzyCorrect(query) {
    const terms = query
      .replace(/['"(){}[\]*:^~]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3);

    let corrected = false;
    const correctedTerms = terms.map(term => {
      const maxDist = maxEditDistance(term.length);
      const candidates = this.#stmts.getVocab.all(
        term.length - maxDist,
        term.length + maxDist
      );

      let bestWord = null;
      let bestDist = Infinity;

      for (const { word } of candidates) {
        const dist = levenshtein(term.toLowerCase(), word.toLowerCase());
        if (dist <= maxDist && dist < bestDist) {
          bestDist = dist;
          bestWord = word;
        }
      }

      if (bestWord && bestWord.toLowerCase() !== term.toLowerCase()) {
        corrected = true;
        return bestWord;
      }
      return term;
    });

    return corrected ? correctedTerms.join(' ') : null;
  }

  /**
   * Unified search with fallback: RRF → fuzzy correction → empty.
   */
  searchWithFallback(query, limit = 2, source = null, contentType = null) {
    // Layer 1: RRF search with proximity reranking
    let results = this.#rrfSearch(query, limit, source);
    results = this.#applyProximityReranking(results, query);

    if (results.length > 0) {
      return this.#formatResults(results, query, 'rrf');
    }

    // Layer 2: Fuzzy correction
    const corrected = this.#fuzzyCorrect(query);
    if (corrected) {
      results = this.#rrfSearch(corrected, limit, source);
      results = this.#applyProximityReranking(results, corrected);

      if (results.length > 0) {
        return this.#formatResults(results, corrected, 'rrf-fuzzy');
      }
    }

    // Layer 3: Empty
    return [];
  }

  /**
   * Format search results with snippets and source labels.
   */
  #formatResults(results, query, matchLayer) {
    return results.map(r => {
      const sourceLabel = this.#getSourceLabel(r.source_id);
      const snippet = extractSnippet(r.content, query, 1500, r.highlighted);

      return {
        title: r.title || '(untitled)',
        content: r.content,
        snippet,
        sourceLabel,
        contentType: r.content_type,
        matchLayer,
        rank: r.rank
      };
    });
  }

  #getSourceLabel(sourceId) {
    try {
      const row = this.#stmts.getSourceById.get(parseInt(sourceId));
      return row ? row.label : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ─── Source Metadata ──────────────────────────────────────────────────────

  getSourceMeta(label) {
    try {
      return this.#stmts.getSourceMeta.get(label) || null;
    } catch {
      return null;
    }
  }

  getChunksBySource(sourceLabel) {
    try {
      return this.#stmts.getChunksBySource.all(sourceLabel);
    } catch {
      return [];
    }
  }

  getChunkCount() {
    try {
      return this.#stmts.chunkCount.get().count;
    } catch {
      return 0;
    }
  }

  // ─── Distinctive Terms ────────────────────────────────────────────────────

  /**
   * Get distinctive terms for a source using document frequency analysis.
   */
  getDistinctiveTerms(sourceLabel, maxTerms = 10) {
    const chunks = this.getChunksBySource(sourceLabel);
    if (chunks.length === 0) return [];

    // Count document frequency per word
    const df = new Map();
    for (const chunk of chunks) {
      const words = new Set(
        (chunk.content || '')
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter(w => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()))
          .map(w => w.toLowerCase())
      );
      for (const word of words) {
        df.set(word, (df.get(word) || 0) + 1);
      }
    }

    // Score: IDF + length bonus + identifier bonus
    const totalChunks = chunks.length;
    const scored = [];

    for (const [word, freq] of df) {
      // Appears in 2 to 40% of chunks
      if (freq < 2 || freq > Math.ceil(totalChunks * 0.4)) continue;

      const idf = Math.log(totalChunks / freq);
      const lengthBonus = Math.min(word.length / 20, 0.5);

      // Identifier bonus: underscores or camelCase
      let idBonus = 0;
      if (word.includes('_')) idBonus = 1.5;
      else if (/[a-z][A-Z]/.test(word)) idBonus = 0.8;

      scored.push({ word, score: idf + lengthBonus + idBonus });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTerms)
      .map(s => s.word);
  }

  // ─── Chunking: Markdown ───────────────────────────────────────────────────

  #chunkMarkdown(text) {
    const lines = text.split('\n');
    const chunks = [];
    const headingStack = [];
    let currentContent = '';
    let inCodeBlock = false;
    let codeBlockFence = '';

    const flushChunk = () => {
      const content = currentContent.trim();
      if (!content) return;

      const title = headingStack.length > 0
        ? headingStack.join(' > ')
        : '(content)';

      // Split oversized chunks at paragraph boundaries
      if (Buffer.byteLength(content, 'utf8') > MAX_CHUNK_BYTES) {
        const paragraphs = content.split(/\n\n+/);
        let accumulated = '';

        for (const para of paragraphs) {
          if (accumulated && Buffer.byteLength(accumulated + '\n\n' + para, 'utf8') > MAX_CHUNK_BYTES) {
            chunks.push({ title, content: accumulated.trim() });
            accumulated = para;
          } else {
            accumulated += (accumulated ? '\n\n' : '') + para;
          }
        }
        if (accumulated.trim()) {
          chunks.push({ title, content: accumulated.trim() });
        }
      } else {
        chunks.push({ title, content });
      }

      currentContent = '';
    };

    for (const line of lines) {
      // Code block detection
      const fenceMatch = line.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockFence = fenceMatch[1][0].repeat(fenceMatch[1].length);
          currentContent += line + '\n';
          continue;
        } else if (line.trim().startsWith(codeBlockFence[0]) &&
                   line.trim().length >= codeBlockFence.length) {
          inCodeBlock = false;
          codeBlockFence = '';
          currentContent += line + '\n';
          continue;
        }
      }

      if (inCodeBlock) {
        currentContent += line + '\n';
        continue;
      }

      // Heading detection
      const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
      if (headingMatch) {
        flushChunk();
        const level = headingMatch[1].length;
        const text = headingMatch[2].trim();

        // Pop deeper levels
        while (headingStack.length >= level) {
          headingStack.pop();
        }
        headingStack.push(text);
        continue;
      }

      // Horizontal rule
      if (/^[-_*]{3,}\s*$/.test(line)) {
        flushChunk();
        continue;
      }

      currentContent += line + '\n';
    }

    // Flush remaining
    flushChunk();

    // If no chunks were created, create one with all content
    if (chunks.length === 0 && text.trim()) {
      chunks.push({ title: '(content)', content: text.trim() });
    }

    return chunks;
  }

  // ─── Chunking: JSON ───────────────────────────────────────────────────────

  #chunkJSON(obj, pathPrefix, chunks = []) {
    if (obj === null || obj === undefined) return chunks;

    if (Array.isArray(obj)) {
      // Batch array items by size
      let batch = '';
      let batchIdx = 0;

      for (let i = 0; i < obj.length; i++) {
        const item = typeof obj[i] === 'object'
          ? JSON.stringify(obj[i], null, 2)
          : String(obj[i]);

        if (batch && Buffer.byteLength(batch + '\n' + item, 'utf8') > MAX_CHUNK_BYTES) {
          chunks.push({
            title: `${pathPrefix}[${batchIdx}-${i - 1}]`,
            content: batch
          });
          batch = item;
          batchIdx = i;
        } else {
          batch += (batch ? '\n' : '') + item;
        }
      }

      if (batch) {
        chunks.push({
          title: `${pathPrefix}[${batchIdx}-${obj.length - 1}]`,
          content: batch
        });
      }
    } else if (typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        const newPath = pathPrefix ? `${pathPrefix}.${key}` : key;

        if (typeof value === 'object' && value !== null) {
          this.#chunkJSON(value, newPath, chunks);
        } else {
          const content = String(value);
          if (Buffer.byteLength(content, 'utf8') > 50) {
            chunks.push({ title: newPath, content });
          }
        }
      }
    }

    return chunks;
  }

  // ─── Chunking: Plain Text ─────────────────────────────────────────────────

  #chunkPlainText(text, linesPerChunk = 20) {
    // Try blank-line splitting first
    const sections = text.split(/\n\s*\n/);
    if (sections.length >= 3 && sections.length <= 200) {
      const chunks = [];
      let idx = 0;
      for (const section of sections) {
        const trimmed = section.trim();
        if (!trimmed) continue;
        if (Buffer.byteLength(trimmed, 'utf8') > MAX_CHUNK_BYTES * 2) {
          // Too large, split further
          const subLines = trimmed.split('\n');
          for (let i = 0; i < subLines.length; i += linesPerChunk) {
            const chunk = subLines.slice(i, i + linesPerChunk).join('\n');
            chunks.push({ title: `Section ${idx + 1} (part ${Math.floor(i / linesPerChunk) + 1})`, content: chunk });
          }
        } else {
          chunks.push({ title: `Section ${idx + 1}`, content: trimmed });
        }
        idx++;
      }
      return chunks;
    }

    // Fallback: fixed-size line groups with 2-line overlap
    const lines = text.split('\n');
    const chunks = [];
    const overlap = 2;

    for (let i = 0; i < lines.length; i += linesPerChunk - overlap) {
      const chunk = lines.slice(i, i + linesPerChunk).join('\n');
      if (chunk.trim()) {
        chunks.push({
          title: `Lines ${i + 1}-${Math.min(i + linesPerChunk, lines.length)}`,
          content: chunk
        });
      }
    }

    return chunks;
  }

  // ─── Content Classification ───────────────────────────────────────────────

  #classifyChunk(content) {
    // Heuristic: is this code?
    const codeIndicators = [
      /^\s*(import|from|require|export|const|let|var|function|class|def |async |await )/m,
      /^\s*(if|else|for|while|return|try|catch|switch|case)\s*[({]/m,
      /[{}\[\]();].*[{}\[\]();]/m, // Multiple brackets
      /^\s*\/\//m,                   // Comments
      /^\s*#\s*\w/m,                 // Python/shell comments
      /=>/,                          // Arrow functions
      /\.\w+\(/,                     // Method calls
    ];

    let codeScore = 0;
    for (const pattern of codeIndicators) {
      if (pattern.test(content)) codeScore++;
    }

    return codeScore >= 3;
  }

  // ─── Vocabulary ───────────────────────────────────────────────────────────

  #extractAndStoreVocabulary(text) {
    const words = text
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));

    const unique = new Set(words.map(w => w.toLowerCase()));

    for (const word of unique) {
      try {
        this.#stmts.insertVocab.run(word);
      } catch { /* ignore duplicates */ }
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  close() {
    closeDB(this.#db);
  }
}
