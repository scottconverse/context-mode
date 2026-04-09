/**
 * Shared utility functions for the knowledge base.
 * Query sanitization, Levenshtein distance, snippet extraction,
 * proximity scoring, and stopwords.
 */

// ─── Stopwords ────────────────────────────────────────────────────────────────

export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'must',
  'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
  'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same', 'also', 'just', 'about',
  'above', 'after', 'again', 'any', 'before', 'below', 'between',
  'down', 'during', 'here', 'into', 'out', 'over', 'there', 'through',
  'under', 'until', 'up', 'very'
]);

// ─── Query Sanitization ──────────────────────────────────────────────────────

/**
 * Sanitize a query for FTS5 MATCH with Porter stemmer.
 * Removes FTS5 operators, quotes each term, joins with AND or OR.
 */
export function sanitizeQuery(query, mode = 'AND') {
  const words = query
    .replace(/['"(){}[\]*:^~]/g, ' ')
    .split(/\s+/)
    .filter(w =>
      w.length > 0 &&
      !['AND', 'OR', 'NOT', 'NEAR'].includes(w.toUpperCase())
    );

  if (words.length === 0) return null;
  return words.map(w => `"${w}"`).join(mode === 'OR' ? ' OR ' : ' ');
}

/**
 * Sanitize a query for FTS5 trigram MATCH.
 * Skips terms shorter than 3 characters (trigram minimum).
 */
export function sanitizeTrigramQuery(query, mode = 'AND') {
  const words = query
    .replace(/['"(){}[\]*:^~]/g, ' ')
    .split(/\s+/)
    .filter(w =>
      w.length >= 3 &&
      !['AND', 'OR', 'NOT', 'NEAR'].includes(w.toUpperCase())
    );

  if (words.length === 0) return null;
  return words.map(w => `"${w}"`).join(mode === 'OR' ? ' OR ' : ' ');
}

// ─── Levenshtein Distance ─────────────────────────────────────────────────────

/**
 * Compute Levenshtein edit distance between two strings.
 */
export function levenshtein(a, b) {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Use single-row DP
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

/**
 * Maximum edit distance threshold based on word length.
 * Short words: strict matching. Long words: more lenient.
 */
export function maxEditDistance(wordLength) {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

// ─── Position and Proximity ───────────────────────────────────────────────────

/**
 * Find all positions of a term in text (case-insensitive).
 */
export function findAllPositions(text, term) {
  const positions = [];
  const lower = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  let idx = 0;
  while (idx < lower.length) {
    const found = lower.indexOf(lowerTerm, idx);
    if (found === -1) break;
    positions.push(found);
    idx = found + 1;
  }
  return positions;
}

/**
 * Find the minimum span (window) covering at least one occurrence of each term.
 * Uses a sweep-line approach across position lists.
 */
export function findMinSpan(positionLists) {
  // Filter out empty lists
  const lists = positionLists.filter(l => l.length > 0);
  if (lists.length === 0) return Infinity;
  if (lists.length === 1) return 0;

  // Initialize pointers
  const ptrs = new Array(lists.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    // Find current min and max positions
    let minPos = Infinity, maxPos = -Infinity;
    let minIdx = 0;

    for (let i = 0; i < lists.length; i++) {
      const pos = lists[i][ptrs[i]];
      if (pos < minPos) {
        minPos = pos;
        minIdx = i;
      }
      if (pos > maxPos) maxPos = pos;
    }

    const span = maxPos - minPos;
    if (span < minSpan) minSpan = span;

    // Advance the pointer at the minimum position
    ptrs[minIdx]++;
    if (ptrs[minIdx] >= lists[minIdx].length) break;
  }

  return minSpan;
}

// ─── FTS5 Highlight Parsing ───────────────────────────────────────────────────

const STX = '\x02'; // Start of highlight marker
const ETX = '\x03'; // End of highlight marker

/**
 * Parse positions from FTS5 highlight markers (STX/ETX).
 */
export function positionsFromHighlight(highlighted) {
  const positions = [];
  let idx = 0;
  while (idx < highlighted.length) {
    const start = highlighted.indexOf(STX, idx);
    if (start === -1) break;
    const end = highlighted.indexOf(ETX, start);
    if (end === -1) break;
    positions.push(start - positions.length * 2); // Adjust for removed markers
    idx = end + 1;
  }
  return positions;
}

/**
 * Strip STX/ETX highlight markers from text.
 */
export function stripMarkers(highlighted) {
  return highlighted.replace(/[\x02\x03]/g, '');
}

// ─── Smart Snippet Extraction ─────────────────────────────────────────────────

/**
 * Extract a smart snippet: windows around matching terms,
 * merged overlapping, concatenated up to maxLen.
 */
export function extractSnippet(content, query, maxLen = 1500, highlighted = null) {
  if (!content || content.length <= maxLen) return content;

  // Get match positions
  let positions = [];
  if (highlighted) {
    positions = positionsFromHighlight(highlighted);
  }

  // Fallback: use query term positions
  if (positions.length === 0 && query) {
    const terms = query
      .replace(/['"(){}[\]*:^~]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    const cleanContent = highlighted ? stripMarkers(highlighted) : content;
    for (const term of terms) {
      const termPositions = findAllPositions(cleanContent, term);
      positions.push(...termPositions);
    }
  }

  if (positions.length === 0) {
    // No matches found, return from start
    return content.slice(0, maxLen) + (content.length > maxLen ? '...' : '');
  }

  // Sort and deduplicate positions
  positions = [...new Set(positions)].sort((a, b) => a - b);

  // Build windows (300 chars around each match)
  const WINDOW = 300;
  const cleanContent = highlighted ? stripMarkers(highlighted) : content;
  const windows = [];

  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW / 2);
    const end = Math.min(cleanContent.length, pos + WINDOW / 2);
    windows.push({ start, end });
  }

  // Merge overlapping windows
  const merged = [windows[0]];
  for (let i = 1; i < windows.length; i++) {
    const prev = merged[merged.length - 1];
    if (windows[i].start <= prev.end) {
      prev.end = Math.max(prev.end, windows[i].end);
    } else {
      merged.push(windows[i]);
    }
  }

  // Concatenate windows up to maxLen
  let snippet = '';
  for (const win of merged) {
    const chunk = cleanContent.slice(win.start, win.end);
    if (snippet.length + chunk.length > maxLen) {
      const remaining = maxLen - snippet.length;
      if (remaining > 50) {
        snippet += (snippet ? ' ... ' : '') + chunk.slice(0, remaining) + '...';
      }
      break;
    }
    snippet += (snippet ? ' ... ' : '') + chunk;
  }

  // Add ellipsis if we didn't start at the beginning
  if (merged[0].start > 0) snippet = '...' + snippet;

  return snippet;
}

// ─── XML Escaping ─────────────────────────────────────────────────────────────

export function escapeXML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
