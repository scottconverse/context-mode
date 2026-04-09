/**
 * Exit code classification for sandbox execution.
 * Distinguishes real errors from test runners and linters
 * that exit non-zero with meaningful output.
 */

/**
 * Classify a non-zero exit code.
 * Returns { isError, output } where isError=false means
 * the tool produced valid output despite non-zero exit.
 */
export function classifyNonZeroExit({ language, exitCode, stdout, stderr }) {
  const output = stdout || '';
  const err = stderr || '';
  const combined = output + err;

  // Test runners: exit 1 means "tests failed" not "crash"
  const testRunnerPatterns = [
    /\d+ (passed|failed|skipped)/i,        // Jest, pytest, mocha
    /Tests?:\s+\d+/i,                       // Jest summary
    /FAIL\s+\w/,                            // Jest FAIL
    /FAILED\s+\(/,                          // pytest FAILED
    /\d+ failing/i,                         // Mocha
    /test result:/i,                        // Rust cargo test
    /--- FAIL:/,                            // Go test
    /Failures:\s+\d+/,                      // NUnit/xUnit
    /examples?,\s*\d+\s*failures?/i,        // RSpec
  ];

  for (const pattern of testRunnerPatterns) {
    if (pattern.test(combined)) {
      return { isError: false, output: combined };
    }
  }

  // Linters: exit 1 means "found issues" not "crash"
  const linterPatterns = [
    /\d+ errors?/i,                         // ESLint
    /\d+ warnings?/i,                       // Various linters
    /✖ \d+ problems?/,                      // ESLint
    /\d+ violations?/i,                     // Rubocop, flake8
    /Found \d+ errors?/i,                   // mypy, tsc
    /warning\[/,                            // Rust clippy
  ];

  for (const pattern of linterPatterns) {
    if (pattern.test(combined)) {
      return { isError: false, output: combined };
    }
  }

  // Exit code 2 for Python argparse errors, etc. — real error
  // Exit code 137 — SIGKILL (OOM or timeout) — real error
  // Exit code 139 — SIGSEGV — real error
  if ([137, 139, 134].includes(exitCode)) {
    return { isError: true, output: combined };
  }

  // If there's substantial stdout with exit code 1, likely not a crash
  if (exitCode === 1 && output.length > 100 && err.length < 50) {
    return { isError: false, output: combined };
  }

  // Default: treat non-zero exit as error
  return { isError: true, output: combined };
}
