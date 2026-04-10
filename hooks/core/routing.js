/**
 * Pure routing logic for PreToolUse hooks.
 * Returns NORMALIZED decision objects (NOT platform-specific format).
 *
 * Decision types:
 * - { action: "deny", reason: string }
 * - { action: "ask" }
 * - { action: "modify", updatedInput: object }
 * - { action: "context", additionalContext: string }
 * - null (passthrough)
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

import {
  ROUTING_BLOCK, READ_GUIDANCE, GREP_GUIDANCE, BASH_GUIDANCE,
  createRoutingBlock, createReadGuidance, createGrepGuidance, createBashGuidance,
} from "../routing-block.js";
import { createToolNamer } from "./tool-naming.js";
import { existsSync, mkdirSync, rmSync, openSync, closeSync, constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Guidance throttle: show each advisory type at most once per session.
// Hybrid approach:
//   - In-memory Set for same-process (vitest)
//   - File-based markers with O_EXCL for cross-process atomicity (Claude Code)
// Session scoped via process.ppid (= host PID, constant for session lifetime).
const _guidanceShown = new Set();
const _guidanceId = process.env.VITEST_WORKER_ID
  ? `${process.ppid}-w${process.env.VITEST_WORKER_ID}`
  : String(process.ppid);
const _guidanceDir = resolve(tmpdir(), `context-mode-guidance-${_guidanceId}`);

function guidanceOnce(type, content) {
  // Fast path: in-memory (same process)
  if (_guidanceShown.has(type)) return null;

  // Ensure marker directory exists
  try { mkdirSync(_guidanceDir, { recursive: true }); } catch {}

  // Atomic create-or-fail: O_CREAT | O_EXCL | O_WRONLY
  // First process to create the file wins; others get EEXIST.
  const marker = resolve(_guidanceDir, type);
  try {
    const fd = openSync(marker, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    closeSync(fd);
  } catch {
    // EEXIST = another process already created it, or we did in-memory
    _guidanceShown.add(type);
    return null;
  }

  _guidanceShown.add(type);
  return { action: "context", additionalContext: content };
}

export function resetGuidanceThrottle() {
  _guidanceShown.clear();
  try { rmSync(_guidanceDir, { recursive: true, force: true }); } catch {}
}

/**
 * Strip heredoc content from a shell command.
 * Handles: <<EOF, <<"EOF", <<'EOF', <<-EOF (indented), with optional spaces.
 */
function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "");
}

/**
 * Strip ALL quoted content from a shell command so regex only matches command tokens.
 * Removes heredocs, single-quoted strings, and double-quoted strings.
 * This prevents false positives like: gh issue edit --body "text with curl in it"
 */
function stripQuotedContent(cmd) {
  return stripHeredocs(cmd)
    .replace(/'[^']*'/g, "''")                    // single-quoted strings
    .replace(/"[^"]*"/g, '""');                   // double-quoted strings
}

/**
 * Route a PreToolUse event. Returns normalized decision object or null for passthrough.
 * Always uses Cowork tool naming (no platform parameter needed).
 *
 * @param {string} toolName - The tool name (canonical Claude Code name)
 * @param {object} toolInput - The tool input/parameters
 * @param {string} [projectDir] - Project directory (reserved for future use)
 */
export function routePreToolUse(toolName, toolInput, projectDir) {
  // Always use Cowork tool namer
  const t = createToolNamer();

  // Always use Cowork-specific guidance/routing content
  const routingBlock = ROUTING_BLOCK;
  const readGuidance = READ_GUIDANCE;
  const grepGuidance = GREP_GUIDANCE;
  const bashGuidance = BASH_GUIDANCE;

  // ─── Bash: routing logic ───
  if (toolName === "Bash") {
    const command = toolInput.command ?? "";

    // curl/wget detection: strip quoted content first to avoid false positives
    // like `gh issue edit --body "text with curl in it"` (Issue #63).
    const stripped = stripQuotedContent(command);

    // curl/wget — allow silent file-output downloads, block stdout floods (#166).
    // Algorithm: split chained commands, evaluate each segment independently.
    if (/(^|\s|&&|\||\;)(curl|wget)\s/i.test(stripped)) {
      // Split on chain operators (&&, ||, ;) to evaluate each segment
      const segments = stripped.split(/\s*(?:&&|\|\||;)\s*/);
      const hasDangerousSegment = segments.some(seg => {
        const s = seg.trim();
        // Only evaluate segments that contain curl or wget
        if (!/(^|\s)(curl|wget)\s/i.test(s)) return false;

        const isCurl = /\bcurl\b/i.test(s);
        const isWget = /\bwget\b/i.test(s);

        // Check for file output flags
        const hasFileOutput = isCurl
          ? /\s(-o|--output)\s/.test(s) || /\s*>\s*/.test(s) || /\s*>>\s*/.test(s)
          : /\s(-O|--output-document)\s/.test(s) || /\s*>\s*/.test(s) || /\s*>>\s*/.test(s);

        if (!hasFileOutput) return true; // no file output → dangerous

        // Stdout aliases: -o -, -o /dev/stdout, -O -
        if (isCurl && /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(s)) return true;
        if (isWget && /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(s)) return true;

        // Verbose/trace flags flood stderr → context
        if (/\s(-v|--verbose|--trace|-D\s+-)\b/.test(s)) return true;

        // Must be silent (curl: -s/--silent, wget: -q/--quiet) to prevent progress bar stderr flood
        const isSilent = isCurl
          ? /\s-[a-zA-Z]*s|--silent/.test(s)
          : /\s-[a-zA-Z]*q|--quiet/.test(s);
        if (!isSilent) return true;

        return false; // safe: silent + file output + no verbose + no stdout alias
      });

      if (hasDangerousSegment) {
        return {
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: curl/wget blocked. Think in Code — use ${t("ctx_execute")}(language, code) to write code that fetches, processes, and prints only the answer. Or use ${t("ctx_fetch_and_index")}(url, source) to fetch and index. Write pure JS with try/catch, no npm deps. Do NOT retry with curl/wget."`,
          },
        };
      }
      // All segments safe → allow through
      return null;
    }

    // Inline HTTP detection: strip only heredocs (not quotes) so that
    // code passed via -e/-c flags is still visible to the regex, while
    // heredoc content (e.g. cat << EOF ... requests.get ... EOF) is removed.
    // These patterns are specific enough that false positives in quoted
    // text are rare, unlike single-word "curl"/"wget" (Issue #63).
    const noHeredoc = stripHeredocs(command);
    if (
      /fetch\s*\(\s*['"](https?:\/\/|http)/i.test(noHeredoc) ||
      /requests\.(get|post|put)\s*\(/i.test(noHeredoc) ||
      /http\.(get|request)\s*\(/i.test(noHeredoc)
    ) {
      return {
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: Inline HTTP blocked. Think in Code — use ${t("ctx_execute")}(language, code) to write code that fetches, processes, and console.log() only the result. Write robust pure JS with try/catch, no npm deps. Do NOT retry with Bash."`,
        },
      };
    }

    // Build tools (gradle, maven) → redirect to execute sandbox (Issue #38).
    // These produce extremely verbose output that should stay in sandbox.
    if (/(^|\s|&&|\||\;)(\.\/gradlew|gradlew|gradle|\.\/mvnw|mvnw|mvn)\s/i.test(stripped)) {
      const safeCmd = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return {
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: Build tool redirected. Think in Code — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"${safeCmd} 2>&1 | tail -30\\") to run and print only errors/summary. Do NOT retry with Bash."`,
        },
      };
    }

    // ─── git log: redirect unbounded logs through compressor ───
    if (/(?:^|\s|&&|\||\;)git\s+log\b/.test(stripped)) {
      const hasLimit = /\s(-n\s*\d|--max-count[= ]\d|-\d+)\b/.test(stripped);
      const hasShortFormat = /\s(--oneline|--format=|--pretty=oneline)/.test(stripped);
      const hasPipe = /\|\s*(head|grep|wc|tail|awk|sed|sort|uniq|cut)\b/.test(command);
      if (!hasLimit && !hasShortFormat && !hasPipe) {
        return {
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: git log routed through compressor for token efficiency. Full output indexed to knowledge base. Use ctx_search(queries: [...]) to find specific content. Do NOT retry with Bash — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"git log 2>&1\\") instead."`,
          },
        };
      }
    }

    // ─── git diff: redirect unbounded diffs ───
    if (/(?:^|\s|&&|\||\;)git\s+diff\b/.test(stripped)) {
      const hasStat = /\s--stat\b/.test(stripped);
      const hasPipe = /\|\s*(head|grep|wc|tail|awk|sed|sort|uniq|cut)\b/.test(command);
      const hasSingleFile = /git\s+diff\s+(?:--\w+\s+)*[\w./-]+\.(js|ts|py|rs|go|java|jsx|tsx|css|html|json|yaml|yml|toml|md|txt)\b/.test(stripped);
      if (!hasStat && !hasPipe && !hasSingleFile) {
        return {
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: git diff routed through compressor for token efficiency. Full output indexed. Use ctx_search to find specific changes. Do NOT retry with Bash — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"git diff 2>&1\\") instead."`,
          },
        };
      }
    }

    // ─── npm test / jest / vitest: redirect test runners ───
    if (/(?:^|\s|&&|\||\;)(npm\s+test|npx\s+(jest|vitest))\b/.test(stripped)) {
      const hasPipe = /\|\s*(head|grep|wc|tail|awk|sed|sort|uniq|cut)\b/.test(command);
      if (!hasPipe) {
        return {
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: test runner routed through compressor. Failures preserved verbatim, passes summarized. Full output indexed. Do NOT retry with Bash — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"npm test 2>&1\\") instead."`,
          },
        };
      }
    }

    // ─── pytest: redirect ───
    if (/(?:^|\s|&&|\||\;)(pytest|python\s+-m\s+pytest)\b/.test(stripped)) {
      const hasPipe = /\|\s*(head|grep|wc|tail|awk|sed|sort|uniq|cut)\b/.test(command);
      if (!hasPipe) {
        return {
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: pytest routed through compressor. Failures preserved verbatim, passes summarized. Full output indexed. Do NOT retry with Bash — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"pytest 2>&1\\") instead."`,
          },
        };
      }
    }

    // ─── npm install / npm ci: redirect ───
    if (/(?:^|\s|&&|\||\;)npm\s+(install|ci)\b/.test(stripped)) {
      return {
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: npm install routed through compressor. Summary + warnings preserved, progress stripped. Full output indexed. Do NOT retry with Bash — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"npm install 2>&1\\") instead."`,
        },
      };
    }

    // ─── pip install: redirect ───
    if (/(?:^|\s|&&|\||\;)pip\s+install\b/.test(stripped)) {
      return {
        action: "modify",
        updatedInput: {
          command: `echo "context-mode: pip install routed through compressor. Summary preserved, download progress stripped. Full output indexed. Do NOT retry with Bash — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"pip install 2>&1\\") instead."`,
        },
      };
    }

    // ─── cargo build / cargo test: redirect ───
    if (/(?:^|\s|&&|\||\;)cargo\s+(build|test)\b/.test(stripped)) {
      const hasPipe = /\|\s*(head|grep|wc|tail|awk|sed|sort|uniq|cut)\b/.test(command);
      if (!hasPipe) {
        return {
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: cargo routed through compressor. Errors/warnings preserved, compile steps collapsed. Full output indexed. Do NOT retry with Bash — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"cargo build 2>&1\\") instead."`,
          },
        };
      }
    }

    // ─── docker build: redirect ───
    if (/(?:^|\s|&&|\||\;)docker\s+build\b/.test(stripped)) {
      const hasPipe = /\|\s*(head|grep|wc|tail|awk|sed|sort|uniq|cut)\b/.test(command);
      if (!hasPipe) {
        return {
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: docker build routed through compressor. Steps + errors preserved, cache lines collapsed. Full output indexed. Do NOT retry with Bash — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"docker build . 2>&1\\") instead."`,
          },
        };
      }
    }

    // ─── make / cmake --build: redirect ───
    if (/(?:^|\s|&&|\||\;)(make|cmake\s+--build)\b/.test(stripped)) {
      const hasPipe = /\|\s*(head|grep|wc|tail|awk|sed|sort|uniq|cut)\b/.test(command);
      if (!hasPipe) {
        return {
          action: "modify",
          updatedInput: {
            command: `echo "context-mode: build routed through compressor. Warnings/errors preserved, compile invocations collapsed. Full output indexed. Do NOT retry with Bash — use ${t("ctx_execute")}(language: \\"shell\\", code: \\"make 2>&1\\") instead."`,
          },
        };
      }
    }

    // allow all other Bash commands, but inject routing nudge (once per session)
    return guidanceOnce("bash", bashGuidance);
  }

  // ─── Read: nudge toward execute_file (once per session) ───
  if (toolName === "Read") {
    return guidanceOnce("read", readGuidance);
  }

  // ─── Grep: nudge toward execute (once per session) ───
  if (toolName === "Grep") {
    return guidanceOnce("grep", grepGuidance);
  }

  // ─── WebFetch: deny + redirect to sandbox ───
  if (toolName === "WebFetch") {
    const url = toolInput.url ?? "";
    return {
      action: "deny",
      reason: `context-mode: WebFetch blocked. Think in Code — use ${t("ctx_fetch_and_index")}(url: "${url}", source: "...") to fetch and index, then ${t("ctx_search")}(queries: [...]) to query. Or use ${t("ctx_execute")}(language, code) to fetch, process, and console.log() only what you need. Write pure JS, no npm deps. Do NOT use curl, wget, or WebFetch.`,
    };
  }

  // ─── Agent/Task: inject context-mode routing into subagent prompts ───
  if (toolName === "Agent" || toolName === "Task") {
    const subagentType = toolInput.subagent_type ?? "";
    // Detect the correct field name for the prompt/request/objective/question/query
    const fieldName = ["prompt", "request", "objective", "question", "query", "task"].find(f => f in toolInput) ?? "prompt";
    const prompt = toolInput[fieldName] ?? "";

    const updatedInput =
      subagentType === "Bash"
        ? { ...toolInput, [fieldName]: prompt + routingBlock, subagent_type: "general-purpose" }
        : { ...toolInput, [fieldName]: prompt + routingBlock };

    return { action: "modify", updatedInput };
  }

  // ─── MCP execute: passthrough (no security module) ───
  // Match both __execute and __ctx_execute (prefixed tool names)
  if (
    (toolName.includes("context-mode") && /(?:__|\/)(ctx_)?execute$/.test(toolName)) ||
    /^MCP:(ctx_)?execute$/.test(toolName)
  ) {
    return null;
  }

  // ─── MCP execute_file: passthrough (no security module) ───
  if (
    (toolName.includes("context-mode") && /(?:__|\/)(ctx_)?execute_file$/.test(toolName)) ||
    /^MCP:(ctx_)?execute_file$/.test(toolName)
  ) {
    return null;
  }

  // ─── MCP batch_execute: passthrough (no security module) ───
  if (toolName.includes("context-mode") && /(?:__|\/)(ctx_)?batch_execute$/.test(toolName)) {
    return null;
  }

  // Unknown tool — pass through
  return null;
}
