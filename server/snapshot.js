/**
 * Snapshot builder — creates priority-tiered XML snapshots
 * for session resume after context compaction.
 *
 * Budget: ≤2KB. P1 events always preserved. P3/P4 dropped first.
 */

import { escapeXML } from './utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SNAPSHOT_BYTES = 2048;
const MAX_ACTIVE_FILES = 10;
const MAX_QUERIES = 4;
const MAX_QUERY_LEN = 80;

// ─── Snapshot Builder ─────────────────────────────────────────────────────────

/**
 * Build a priority-tiered XML resume snapshot from session events.
 */
export function buildResumeSnapshot(events, { compactCount = 0, searchTool = 'ctx_search' } = {}) {
  // Group events by category
  const grouped = {};
  for (const event of events) {
    const cat = event.category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(event);
  }

  const sections = [];

  // ─── Files Section (P1) ─────────────────────────────────────────────────

  if (grouped.file) {
    const fileOps = new Map(); // path -> { reads, writes, edits }
    for (const evt of grouped.file) {
      const path = typeof evt.data === 'string' ? evt.data : '';
      if (!path) continue;
      if (!fileOps.has(path)) fileOps.set(path, { reads: 0, writes: 0, edits: 0 });
      const ops = fileOps.get(path);
      if (evt.type === 'file_read') ops.reads++;
      else if (evt.type === 'file_write') ops.writes++;
      else if (evt.type === 'file_edit') ops.edits++;
    }

    // Sort by recency (last seen in events array), take top MAX_ACTIVE_FILES
    const sortedFiles = [...fileOps.entries()]
      .slice(-MAX_ACTIVE_FILES)
      .reverse();

    if (sortedFiles.length > 0) {
      let xml = `<files count="${sortedFiles.length}">\n`;
      for (const [path, ops] of sortedFiles) {
        const opStr = [];
        if (ops.writes > 0) opStr.push(`write×${ops.writes}`);
        if (ops.edits > 0) opStr.push(`edit×${ops.edits}`);
        if (ops.reads > 0) opStr.push(`read×${ops.reads}`);
        xml += `  <file>${escapeXML(path)} (${opStr.join(', ')})</file>\n`;
      }

      // Add search hint
      const fileQueries = buildQueries(sortedFiles.map(([p]) => p));
      if (fileQueries.length > 0) {
        xml += `  <tool_call>${searchTool}(queries: ${JSON.stringify(fileQueries)}, source: "session-events")</tool_call>\n`;
      }

      xml += '</files>';
      sections.push({ xml, priority: 1, category: 'files' });
    }
  }

  // ─── Errors Section (P2) ────────────────────────────────────────────────

  if (grouped.error) {
    const errors = grouped.error.slice(-5); // Last 5 errors
    let xml = `<errors count="${errors.length}">\n`;
    for (const evt of errors) {
      let errMsg;
      try {
        const parsed = JSON.parse(evt.data);
        errMsg = parsed.error || parsed.command || evt.data;
      } catch {
        errMsg = evt.data;
      }
      xml += `  <error>${escapeXML(String(errMsg).slice(0, 150))}</error>\n`;
    }

    const errQueries = buildQueries(errors.map(e => e.data));
    if (errQueries.length > 0) {
      xml += `  <tool_call>${searchTool}(queries: ${JSON.stringify(errQueries)}, source: "session-events")</tool_call>\n`;
    }

    xml += '</errors>';
    sections.push({ xml, priority: 2, category: 'errors' });
  }

  // ─── Decisions Section (P3) ─────────────────────────────────────────────

  if (grouped.decision) {
    const decisions = dedup(grouped.decision.map(e => e.data)).slice(-5);
    let xml = `<decisions count="${decisions.length}">\n`;
    for (const d of decisions) {
      xml += `  <decision>${escapeXML(String(d).slice(0, 150))}</decision>\n`;
    }
    xml += '</decisions>';
    sections.push({ xml, priority: 3, category: 'decisions' });
  }

  // ─── Rules Section (P1) ─────────────────────────────────────────────────

  if (grouped.rule) {
    const rules = dedup(grouped.rule.map(e => e.data)).slice(-5);
    let xml = `<rules count="${rules.length}">\n`;
    for (const r of rules) {
      xml += `  <rule>${escapeXML(String(r).slice(0, 150))}</rule>\n`;
    }
    xml += '</rules>';
    sections.push({ xml, priority: 1, category: 'rules' });
  }

  // ─── Git Section (P3) ──────────────────────────────────────────────────

  if (grouped.git) {
    const gitOps = grouped.git.slice(-5);
    let xml = `<git count="${gitOps.length}">\n`;
    for (const evt of gitOps) {
      xml += `  <operation>${escapeXML(String(evt.data).slice(0, 150))}</operation>\n`;
    }
    xml += '</git>';
    sections.push({ xml, priority: 3, category: 'git' });
  }

  // ─── Task State Section (P1) ───────────────────────────────────────────

  if (grouped.task) {
    const taskState = renderTaskState(grouped.task);
    if (taskState) {
      sections.push({ xml: taskState, priority: 1, category: 'tasks' });
    }
  }

  // ─── Environment Section (P4) ──────────────────────────────────────────

  if (grouped.cwd || grouped.env) {
    let xml = '<environment>\n';
    if (grouped.cwd) {
      const lastCwd = grouped.cwd[grouped.cwd.length - 1];
      xml += `  <cwd>${escapeXML(String(lastCwd.data).slice(0, 200))}</cwd>\n`;
    }
    if (grouped.env) {
      for (const evt of grouped.env.slice(-3)) {
        xml += `  <env>${escapeXML(String(evt.data).slice(0, 150))}</env>\n`;
      }
    }
    xml += '</environment>';
    sections.push({ xml, priority: 4, category: 'environment' });
  }

  // ─── Subagent Section (P3) ─────────────────────────────────────────────

  if (grouped.subagent) {
    const agents = grouped.subagent.slice(-5);
    let xml = `<subagents count="${agents.length}">\n`;
    for (const evt of agents) {
      try {
        const parsed = JSON.parse(evt.data);
        xml += `  <agent>${escapeXML(parsed.description || '(unnamed)')}</agent>\n`;
      } catch {
        xml += `  <agent>${escapeXML(String(evt.data).slice(0, 100))}</agent>\n`;
      }
    }
    xml += '</subagents>';
    sections.push({ xml, priority: 3, category: 'subagents' });
  }

  // ─── Budget-fit: drop low-priority sections if over budget ────────────

  // Sort by priority (1 = highest, keep first)
  sections.sort((a, b) => a.priority - b.priority);

  const included = [];
  let totalBytes = '<session_resume>\n</session_resume>'.length;

  for (const section of sections) {
    const sectionBytes = Buffer.byteLength(section.xml, 'utf8') + 1; // +1 for newline
    if (totalBytes + sectionBytes <= MAX_SNAPSHOT_BYTES) {
      included.push(section);
      totalBytes += sectionBytes;
    }
    // If over budget, skip this (lower priority) section
  }

  // Build final XML
  let snapshot = '<session_resume>\n';
  for (const section of included) {
    snapshot += section.xml + '\n';
  }
  snapshot += '</session_resume>';

  return snapshot;
}

// ─── Task State Renderer ──────────────────────────────────────────────────────

/**
 * Reconstruct pending tasks from create/update events.
 */
function renderTaskState(taskEvents) {
  const tasks = new Map(); // content -> { status, activeForm }

  for (const evt of taskEvents) {
    try {
      const data = JSON.parse(evt.data);
      const key = data.content || '';
      if (!key) continue;
      tasks.set(key, {
        status: data.status || 'pending',
        activeForm: data.activeForm || key
      });
    } catch { continue; }
  }

  // Filter to pending/in_progress only
  const pending = [...tasks.entries()]
    .filter(([, v]) => v.status === 'pending' || v.status === 'in_progress');

  if (pending.length === 0) return null;

  let xml = `<task_state count="${pending.length}">\n`;
  for (const [content, info] of pending) {
    const marker = info.status === 'in_progress' ? '🔄' : '⬜';
    xml += `  <task status="${info.status}">${marker} ${escapeXML(content)}</task>\n`;
  }
  xml += '</task_state>';

  return xml;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build search queries from a list of items.
 * Takes first N items, truncated to MAX_QUERY_LEN.
 */
function buildQueries(items, maxQueries = MAX_QUERIES) {
  return items
    .slice(0, maxQueries)
    .map(item => String(item).slice(0, MAX_QUERY_LEN))
    .filter(q => q.length > 2);
}

/**
 * Deduplicate an array of strings.
 */
function dedup(items) {
  return [...new Set(items)];
}
