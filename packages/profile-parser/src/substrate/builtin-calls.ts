/**
 * Language / runtime / framework call-noise filter.
 *
 * The tree-sitter pass records EVERY call expression; SCIP then resolves a subset
 * to in-repo function nodes (`calleeId`). The unresolved remainder is dominated by
 * calls into the JS language (`arr.map`, `str.replace`), the runtime stdlib
 * (`console.log`, `fs.existsSync`, `path.join`), and framework primitives (React
 * hooks). These carry no internal call-graph edge — they're noise that inflates
 * the `calls` array without adding a resolvable target.
 *
 * This module names those universal primitives so the engine can drop an
 * UNRESOLVED edge whose callee is one of them. It is intentionally NOT a
 * library/SDK denylist and contains nothing repo- or client-specific: only the
 * standard-library / built-in surface that is the same in every JS/TS codebase
 * (mirrors the role of `frameworkPrimitives` for JSX child edges).
 *
 * The filter applies ONLY when `calleeId` is undefined. A call that SCIP resolved
 * to an in-repo node keeps its edge even if the method shares a name with a
 * built-in (`repo.find()` resolved → kept; a bare unresolved `.find()` → dropped).
 */

const BUILTIN_CALL_NAMES: ReadonlySet<string> = new Set([
  // Array / iterable prototype
  'map',
  'filter',
  'forEach',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'reduce',
  'reduceRight',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'concat',
  'includes',
  'indexOf',
  'lastIndexOf',
  'join',
  'reverse',
  'sort',
  'flat',
  'flatMap',
  'fill',
  'copyWithin',
  'at',
  'entries',
  'keys',
  'values',
  // String prototype
  'replace',
  'replaceAll',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'substring',
  'substr',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'match',
  'matchAll',
  'search',
  'normalize',
  'localeCompare',
  // Object / Map / Set / collections
  'get',
  'set',
  'has',
  'add',
  'delete',
  'clear',
  'assign',
  'freeze',
  'create',
  'fromEntries',
  'defineProperty',
  'getOwnPropertyNames',
  'getPrototypeOf',
  // Number / Math
  'min',
  'max',
  'round',
  'floor',
  'ceil',
  'abs',
  'pow',
  'sqrt',
  'random',
  'sign',
  'trunc',
  'toFixed',
  'toPrecision',
  'isInteger',
  'isFinite',
  'isNaN',
  // JSON / global coercion
  'stringify',
  'parse',
  'parseInt',
  'parseFloat',
  'isArray',
  // Promise / Function prototype
  'then',
  'catch',
  'finally',
  'all',
  'allSettled',
  'race',
  'any',
  'resolve',
  'reject',
  'from',
  'of',
  'bind',
  'call',
  'apply',
  'toString',
  'valueOf',
  'hasOwnProperty',
  // console
  'log',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'assert',
  'dir',
  'group',
  'groupEnd',
  'table',
  'count',
  'time',
  'timeEnd',
  // timers / scheduling
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'setImmediate',
  'queueMicrotask',
  // Node fs / path stdlib (common synchronous surface)
  'existsSync',
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'dirname',
  'basename',
  'extname',
  'relative',
  // React hooks (framework primitives)
  'useState',
  'useEffect',
  'useRef',
  'useMemo',
  'useCallback',
  'useContext',
  'useReducer',
  'useLayoutEffect',
  'useImperativeHandle',
  'useId',
  'useTransition',
  'useDeferredValue',
  'useSyncExternalStore',
  'useDebugValue',
]);

/** Final identifier of a call expression: `a.b.foo` → `foo`, `useState` → `useState`. */
function callTail(expr: string): string | undefined {
  const m = expr.match(/([A-Za-z_$][\w$]*)\s*(?:\(\)?)?[.#]?\s*$/);
  return m?.[1];
}

/**
 * True when an UNRESOLVED call edge targets a language/runtime/framework built-in
 * and therefore carries no internal call-graph value. Resolved edges (with a
 * `calleeId`) are never noise — callers must pass only `calleeId`-less edges or
 * gate on resolution themselves.
 */
export function isLanguageBuiltinCall(calleeExpression: string | undefined): boolean {
  if (!calleeExpression) return false;
  const tail = callTail(calleeExpression);
  return tail !== undefined && BUILTIN_CALL_NAMES.has(tail);
}
