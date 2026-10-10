import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import type { Plugin } from 'vite';
import { writeFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Banner: CJS polyfills + native module resolution redirect
// ---------------------------------------------------------------------------
// Native-addon helper modules (node-gyp-build, bindings) resolve from the
// runtime bundle (dist/runtime/).
const nativeModuleBanner = `\
const __import_meta_url = require("url").pathToFileURL(__filename).href;

(function() {
  var Module = require('module');
  var nodePath = require('path');
  var fs = require('fs');
  var HELPER_MODS = { 'node-gyp-build': 1, 'bindings': 1, 'file-uri-to-path': 1 };

  var runtimeDir = nodePath.join(__dirname, '..', 'runtime');
  var unpackedDir = runtimeDir.replace(/app\\.asar([\\\\/])/, 'app.asar.unpacked$1');
  var runtimeNM = null;
  var candidates = [
    nodePath.join(unpackedDir, 'node_modules'),
    nodePath.join(unpackedDir, '_vendor'),
    nodePath.join(runtimeDir, 'node_modules'),
    nodePath.join(runtimeDir, '_vendor'),
  ];
  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.statSync(candidates[i]).isDirectory()) { runtimeNM = candidates[i]; break; } } catch {}
  }

  if (runtimeNM) {
    var origResolve = Module._resolveFilename;
    Module._resolveFilename = function(request, parent, isMain, options) {
      if (HELPER_MODS[request]) {
        try {
          var modDir = nodePath.join(runtimeNM, request);
          var pkgPath = nodePath.join(modDir, 'package.json');
          var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          var entry = nodePath.join(modDir, pkg.main || 'index.js');
          if (fs.existsSync(entry)) return entry;
        } catch {}
      }
      return origResolve.call(this, request, parent, isMain, options);
    };
  }
})();
`;

// ---------------------------------------------------------------------------
// Vite plugin: inject banner + post-build steps for main process
// ---------------------------------------------------------------------------
function mainProcessPlugin(): Plugin {
  const desktopDir = path.resolve(__dirname);

  return {
    name: 'coredoc-main-process',
    apply: 'build',

    generateBundle(_options, bundle) {
      // Rollup code-splits into .cjs chunk files. The `define` option replaces
      // `import.meta.url` → `__import_meta_url` in ALL files, so every chunk
      // needs the polyfill variable. Entry points get the full banner (including
      // the native module resolution IIFE); non-entry chunks just get the var.
      const metaUrlLine = 'const __import_meta_url = require("url").pathToFileURL(__filename).href;\n';

      for (const [, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && /\.(js|cjs|mjs)$/.test(chunk.fileName)) {
          if (chunk.isEntry) {
            chunk.code = nativeModuleBanner + '\n' + chunk.code;
          } else {
            chunk.code = metaUrlLine + chunk.code;
          }
        }
      }
    },

    closeBundle() {
      const outDir = path.join(desktopDir, 'dist', 'main');

      // Write package.json to set CJS mode for the bundled output.
      // The parent package.json has "type": "module" for dev mode, but the
      // bundled output is CJS (required for ASAR compatibility).
      writeFileSync(path.join(outDir, 'package.json'), '{"type":"commonjs"}\n');
      console.log('\n[cjs] Wrote dist/main/package.json with type=commonjs');
    },
  };
}

// Modules that must NOT be bundled into the main process.
// Everything else (including @coredoc/* workspace deps) gets bundled.
// @libsql/client uses platform-specific native binaries (e.g. @libsql/darwin-arm64)
// that cannot be resolved by Rollup at build time.
const mainExternals = [
  'electron',
  'electron-updater',
  '@libsql/client',
  // @ladybugdb/core dlopens a native lbugjs.node relative to its own module
  // path; bundling it into a chunk breaks that resolution at app load.
  '@ladybugdb/core',
  'neo4j-driver',
  '@anthropic-ai/claude-agent-sdk',
  'typescript',
];

function resolveBuildEnv(mode: string): {
  coredocServerUrl: string;
  coredocWebUrl: string;
  posthogKey: string;
  posthogHost: string;
} {
  // Populate process.env from the monorepo-root `.env` for any var the shell
  // did NOT set — the single root `.env` is the primary fallback, shared with
  // the CLI/MCP builds. Shell/CI env still wins; a missing root `.env` is a
  // no-op. This lands ABOVE the desktop-local `apps/desktop/.env` below.
  try {
    process.loadEnvFile(path.join(__dirname, '../../.env'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Load desktop-local .env files (apps/desktop/.env, .env.local, .env.<mode>).
  const fileEnv = loadEnv(mode, __dirname, '');

  // Precedence: shell/CI env (incl. root `.env` hoisted into process.env above)
  // > desktop-local `.env` > hardcoded default.
  const coredocServerUrl = process.env.COREDOC_SERVER_URL || fileEnv.COREDOC_SERVER_URL || 'http://localhost:3000';
  // Web dashboard URL is optional: empty default when unset (feature hides at runtime).
  const coredocWebUrl = process.env.COREDOC_WEB_URL || fileEnv.COREDOC_WEB_URL || '';
  const posthogKey = process.env.COREDOC_POSTHOG_KEY || fileEnv.COREDOC_POSTHOG_KEY || '';
  const posthogHost = process.env.COREDOC_POSTHOG_HOST || fileEnv.COREDOC_POSTHOG_HOST || '';

  return { coredocServerUrl, coredocWebUrl, posthogKey, posthogHost };
}

// ---------------------------------------------------------------------------
// electron-vite config
// ---------------------------------------------------------------------------
export default defineConfig(({ mode }) => {
  const { coredocServerUrl, coredocWebUrl, posthogKey, posthogHost } = resolveBuildEnv(mode);

  return {
    main: {
      plugins: [mainProcessPlugin()],
      build: {
        outDir: 'dist/main',
        rollupOptions: {
          input: {
            index: path.join(__dirname, 'src', 'main', 'index.ts'),
            'sdk-worker': path.join(__dirname, 'src', 'main', 'sdk-worker.ts'),
            'sdk-csharp-index-child': path.join(__dirname, 'src', 'main', 'sdk-csharp-index-child.ts'),
            'sdk-optional-index-child': path.join(__dirname, 'src', 'main', 'sdk-optional-index-child.ts'),
            'sdk-parse-child': path.join(__dirname, 'src', 'main', 'sdk-parse-child.ts'),
          },
          external: mainExternals,
          output: {
            format: 'cjs',
            entryFileNames: '[name].js',
          },
        },
        target: 'node22',
        sourcemap: mode === 'development',
        minify: mode !== 'development',
      },
      define: {
        'import.meta.url': '__import_meta_url',
        __COREDOC_DEFAULT_SERVER_URL__: JSON.stringify(coredocServerUrl),
        __COREDOC_DEFAULT_WEB_URL__: JSON.stringify(coredocWebUrl),
        __COREDOC_DEFAULT_POSTHOG_KEY__: JSON.stringify(posthogKey),
        __COREDOC_DEFAULT_POSTHOG_HOST__: JSON.stringify(posthogHost),
      },
    },

    preload: {
      // The sandboxed preload cannot require() packages at runtime, so the
      // browser-safe `@coredoc/core/browser/*` modules that shared/ipc-types.ts
      // re-exports are bundled in rather than externalized.
      plugins: [externalizeDepsPlugin({ exclude: ['@coredoc/core'] })],
      build: {
        outDir: 'dist/preload',
        rollupOptions: {
          input: {
            index: path.join(__dirname, 'src', 'preload', 'index.ts'),
          },
          output: {
            format: 'cjs',
            entryFileNames: '[name].js',
          },
        },
        sourcemap: mode === 'development',
        minify: mode !== 'development',
      },
    },

    renderer: {
      root: '.',
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
        },
      },
      build: {
        outDir: 'dist/renderer',
        emptyOutDir: true,
        rollupOptions: {
          input: path.join(__dirname, 'index.html'),
        },
        sourcemap: mode === 'development',
      },
      server: {
        port: 5173,
      },
    },
  };
});
