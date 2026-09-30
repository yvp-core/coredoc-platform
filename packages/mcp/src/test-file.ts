/**
 * Test-file detection — single source for "is this dependent a test?".
 *
 * `analyze_change_impact` reports an `affectedTests` roll-up. The graph has no
 * "is a test" flag on a node, so the classification is done on the file PATH,
 * the one signal every language/runner shares. Deliberately convention-based
 * and framework-agnostic: it keys off naming/layout shapes (`*.spec.*`,
 * `*_test.*`, a `tests/` or `__tests__/` directory), never off a detected
 * runner or framework identity.
 *
 * Note the honest limit: many extraction profiles EXCLUDE test sources, in
 * which case no test node exists in the graph at all and this predicate can
 * never fire. That is why an empty `affectedTests` renders as an explicit
 * "verify with grep" zero rather than a silent omission.
 */

/** Directory segments that mark everything below them as test code. */
const TEST_DIR_SEGMENTS = new Set(['__tests__', '__test__', 'tests', 'test', 'spec', 'specs', 'e2e']);

/** `foo.spec.ts`, `foo.test.tsx`, `foo_test.go`, `foo_spec.rb`, `test_foo.py`. */
const TEST_FILE_NAME = /(\.|_)(spec|test)\.[A-Za-z0-9]+$|^test_[^/]+\.[A-Za-z0-9]+$/i;

/** Whether a repo-relative file path denotes test code. */
export function isTestFilePath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const fileName = segments.pop() ?? '';
  if (segments.some((segment) => TEST_DIR_SEGMENTS.has(segment.toLowerCase()))) return true;
  return TEST_FILE_NAME.test(fileName);
}
