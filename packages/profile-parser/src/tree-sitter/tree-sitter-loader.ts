/**
 * TreeSitterLoader — Singleton for initializing web-tree-sitter and loading WASM grammars.
 *
 * Handles Parser.init() with correct locateFile for WASM, caches Language objects,
 * and resolves WASM file paths across environments (Electron packaged, dev, CLI, CI).
 *
 * Runtime and grammar binaries come from pinned npm dependencies, including packaged/offline use.
 */

import { join, dirname, extname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';

// Keep the runtime lazy: loading a profile must not instantiate WASM before parsing.
let runtime: Promise<typeof import('web-tree-sitter')> | undefined;
const getRuntime = () => (runtime ??= import('web-tree-sitter'));

export type SupportedLanguage =
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'javascript'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'csharp'
  | 'zig';

/** Filenames used both by published grammars and the desktop's combined WASM directory. */
const WASM_FILE_MAP: Record<SupportedLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  rust: 'tree-sitter-rust.wasm',
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  zig: 'tree-sitter-zig.wasm',
};

/** Map from file extension to language name */
const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.zig': 'zig',
};

/**
 * A web-tree-sitter CST node (also used for the Parser handle itself). The runtime is loaded
 * lazily as WASM, so its types are not available statically — every language substrate shares
 * this one opaque alias rather than redeclaring it.
 */
// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter node type is opaque here
export type TsNode = any;

export class TreeSitterLoader {
  private static instance: TreeSitterLoader | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private languageCache = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parserCache = new Map<string, any>();
  private wasmDir: string | null = null;

  private constructor() {}

  static getInstance(): TreeSitterLoader {
    if (!TreeSitterLoader.instance) {
      TreeSitterLoader.instance = new TreeSitterLoader();
    }
    return TreeSitterLoader.instance;
  }

  /**
   * Detect the language for a given file path based on extension.
   */
  static detectLanguage(filePath: string): SupportedLanguage | null {
    const ext = extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext] ?? null;
  }

  /**
   * Initialize web-tree-sitter. Safe to call multiple times — only runs once.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    const wasmDir = this.getWasmDir();
    this.wasmDir = wasmDir;

    const { Parser } = await getRuntime();

    // Resolve and pre-load the core tree-sitter.wasm binary.
    // Passing wasmBinary directly bypasses locateFile resolution, which can
    // fail silently in environments like vitest or with pnpm strict isolation.
    const coreWasmPath = this.resolveCoreWasm('web-tree-sitter.wasm');
    const initOptions: Record<string, unknown> = {};

    if (existsSync(coreWasmPath)) {
      initOptions.wasmBinary = readFileSync(coreWasmPath);
    } else {
      // Fallback to locateFile for environments where the file is resolved differently
      initOptions.locateFile = (scriptName: string) => join(wasmDir, scriptName);
    }

    await Parser.init(initOptions);

    this.initialized = true;
  }

  /**
   * Resolve the runtime WASM through its public export (package.json is not exported).
   */
  private resolveCoreWasm(scriptName: string): string {
    const copied = process.env.COREDOC_TREESITTER_WASM_DIR && join(this.wasmDir!, scriptName);
    if (copied && existsSync(copied)) return copied;
    const tryResolve = (base: string | URL): string | null => {
      try {
        const req = createRequire(base);
        const candidate = req.resolve(`web-tree-sitter/${scriptName}`);
        if (existsSync(candidate)) return candidate;
      } catch {
        // Not resolvable from this base
      }
      return null;
    };

    // 1. From this module's URL
    const fromMeta = tryResolve(import.meta.url);
    if (fromMeta) return fromMeta;

    // 2. From process.cwd()
    const fromCwd = tryResolve(join(process.cwd(), 'noop.js'));
    if (fromCwd) return fromCwd;

    // 3. Walk up from process.cwd() checking node_modules directly
    let current = process.cwd();
    for (let i = 0; i < 8; i++) {
      const candidate = join(current, 'node_modules', 'web-tree-sitter', scriptName);
      if (existsSync(candidate)) return candidate;
      const parent = join(current, '..');
      if (parent === current) break;
      current = parent;
    }

    // Last resort: fall back to wasmDir
    return join(this.wasmDir!, scriptName);
  }

  /**
   * Resolve the directory containing WASM grammar files.
   */
  private getWasmDir(): string {
    // 1. Explicit env override (useful for testing or custom setups)
    if (process.env.COREDOC_TREESITTER_WASM_DIR) {
      return process.env.COREDOC_TREESITTER_WASM_DIR;
    }

    // 2. Electron packaged: grammars/ in resources
    const resourcesPath = (process as any).resourcesPath as string | undefined;
    if (resourcesPath && existsSync(join(resourcesPath, 'grammars'))) {
      return join(resourcesPath, 'grammars');
    }

    // 3. Resolve the published general grammar bundle.
    try {
      const esmRequire = createRequire(import.meta.url);
      const wasmsPkg = esmRequire.resolve('@cursorless/tree-sitter-wasms/package.json');
      const wasmsOut = join(dirname(wasmsPkg), 'out');
      if (existsSync(wasmsOut)) {
        return wasmsOut;
      }
    } catch {
      // Not resolvable — try known paths
    }

    // 4. Dev/CLI: walk up from __dirname to find the grammar bundle.
    // This handles ESM contexts where require.resolve may not work
    let current = __dirname;
    for (let i = 0; i < 8; i++) {
      const candidate = join(current, 'node_modules', '@cursorless', 'tree-sitter-wasms', 'out');
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = join(current, '..');
      if (parent === current) break;
      current = parent;
    }

    throw new Error(
      'Could not locate @cursorless/tree-sitter-wasms WASM files. ' +
        'Set COREDOC_TREESITTER_WASM_DIR or install @cursorless/tree-sitter-wasms.',
    );
  }

  /**
   * Load and cache a Language from its WASM file.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async loadGrammar(lang: SupportedLanguage): Promise<any> {
    await this.initialize();

    const cached = this.languageCache.get(lang);
    if (cached) return cached;

    const wasmFile = WASM_FILE_MAP[lang];
    if (!wasmFile) {
      throw new Error(`Unsupported language: ${lang}`);
    }

    const { Language } = await getRuntime();
    let wasmPath = join(this.wasmDir!, wasmFile);
    if (lang === 'csharp') {
      // Directory overrides can contain the general bundle's C# 0.19 binary.
      // Prefer the pinned dependency; bundled desktop workers use its copied WASM.
      try {
        wasmPath = createRequire(import.meta.url).resolve(`tree-sitter-c-sharp/${wasmFile}`);
      } catch {
        // Packaged workers cannot resolve data packages from their bundle location.
      }
    }
    const language = await Language.load(wasmPath);
    if (lang === 'csharp' && language.abiVersion < 15) {
      throw new Error(
        'C# requires the shipped tree-sitter-c-sharp grammar. The WASM directory contains an older grammar.',
      );
    }
    this.languageCache.set(lang, language);
    return language;
  }

  /**
   * Get the configured Parser for the given language.
   *
   * The instance is memoised per grammar beside the Language: constructing a Parser and binding a
   * grammar to it is the expensive part, and `parse()` is synchronous, so one instance is safe to
   * share even under the multi-target `Promise.all`. The loader owns the Parser for the life of
   * the process — a caller must NOT `delete()` it. Callers still own every Tree they parse and
   * must release it (`releaseParsedTree`); the WASM heap cap is a tree problem, not a parser one.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getParser(lang: SupportedLanguage): Promise<any> {
    const cached = this.parserCache.get(lang);
    if (cached) return cached;

    const language = await this.loadGrammar(lang);
    const { Parser } = await getRuntime();
    const parser = new Parser();
    parser.setLanguage(language);
    this.parserCache.set(lang, parser);
    return parser;
  }
}
