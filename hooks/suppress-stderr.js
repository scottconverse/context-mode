/**
 * Suppress stderr output from hook subprocesses.
 * Prevents deprecation warnings and debug noise from entering context.
 *
 * Ported from mksglu/context-mode (https://github.com/mksglu/context-mode)
 * by @mksglu, licensed under Elastic License 2.0.
 */

const _origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = () => true;
