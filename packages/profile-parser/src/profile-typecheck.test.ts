/**
 * Acceptance for the profile typecheck gate. Each case writes a real profile module to
 * a temp dir and runs the gate over it, because the failure this guards against is
 * exactly the one a mocked schema would hide: the CLI transpiles profiles without
 * typechecking, so a rule naming a field the schema lacks loads fine and extracts
 * nothing. The regressions below are the two shapes seen in the wild.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scoreProfile } from './score.js';
import {
  ProfileCapabilityError,
  ProfileTypeError,
  assertProfileTypechecks,
  profileCapabilityViolations,
  typecheckProfile,
} from './profile-typecheck.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Write a profile module to a temp dir and return its path. */
function writeProfile(source: string, name = 'profile.ts'): string {
  dir = mkdtempSync(join(tmpdir(), 'pp-typecheck-'));
  const p = join(dir, name);
  writeFileSync(p, source);
  return p;
}

const VALID = `import type { ExtractionProfile } from '@coredoc/profile-parser';

const profile: ExtractionProfile = {
  parserId: 'fixture/valid',
  substrate: { language: 'ts', include: ['src/**/*.ts'], exclude: ['**/node_modules/**'] },
  entrypoints: [
    {
      kind: 'cli',
      detect: { via: 'call-shape', callee: '*.command' },
      command: { arg: 0, as: 'string-literal' },
      action: { call: 'action', arg: 0 },
    },
  ],
};

export default profile;
`;

describe('typecheckProfile', () => {
  it('accepts a profile that matches the schema', () => {
    expect(typecheckProfile(writeProfile(VALID))).toEqual([]);
  });

  it('rejects an unknown property on a rule', () => {
    // The gitnexus shape: `stateStores[].kind` does not exist, so the rule never
    // matched a factory and both React contexts were dropped from the graph.
    const diagnostics = typecheckProfile(
      writeProfile(
        VALID.replace(
          '  entrypoints:',
          "  stateStores: [{ kind: 'context', library: 'other', factory: 'createContext' }],\n  entrypoints:",
        ),
      ),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(2353);
    expect(diagnostics[0]?.message).toContain("'kind' does not exist in type 'StateStoreRule'");
  });

  it('rejects a custom rule reading a fact the substrate does not expose', () => {
    // The coredoc-trunk shape: ArgNode has `stringLiteral`, not `.type`/`.value`, so
    // every branch of the rule was falsy and it emitted zero entrypoints.
    const withCustomRule = VALID.replace(
      'export default profile;',
      `profile.customRules = [
  {
    name: 'bogus',
    run: (facts, emit) => {
      for (const call of facts.callShapes('ipcMain.handle')) {
        if (call.args[0]?.type === 'string-literal') emit.entrypoint({
          type: 'queue', channel: call.args[0].value, file: call.file,
          startLine: call.startLine, endLine: call.endLine,
        });
      }
    },
  },
];

export default profile;`,
    );
    const codes = typecheckProfile(writeProfile(withCustomRule)).map((d) => d.code);
    expect(codes).not.toHaveLength(0);
    expect(new Set(codes)).toEqual(new Set([2339]));
  });

  it('resolves a RustProfile through the public barrel and rejects an unknown knob', () => {
    // The gate compiles authored profiles against `src/types.ts`. Without the
    // `export * from './types/rust-profile.js'` line there, `RustProfile` is unresolvable and
    // EVERY Rust profile fails this gate — which now runs before `score` and `run`.
    const rust = `import type { RustProfile } from '@coredoc/profile-parser';

const profile: RustProfile = {
  parserId: 'fixture/rust',
  substrate: { language: 'rust', include: ['**/*.rs'] },
  entities: { deriveMacros: ['Queryable'] },
  entrypoints: { contracts: { frameworks: ['anchor'] } },
};

export default profile;
`;
    expect(typecheckProfile(writeProfile(rust))).toEqual([]);

    const diagnostics = typecheckProfile(writeProfile(rust.replace('deriveMacros:', 'baseClasses:')));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("'baseClasses' does not exist");
  });

  it('contextually types a customRules callback rather than calling its parameters implicit any', () => {
    // The packaged-desktop shape: the engine is bundled, so TypeScript could not find its own
    // lib.*.d.ts, the global Array type went missing, `CustomRule[]` degraded to an error type,
    // and this callback's parameters were reported as TS7006 — a correct profile failing the gate.
    const withCleanRule = VALID.replace(
      'export default profile;',
      `profile.customRules = [
  {
    name: 'ipc',
    run: (facts, emit) => {
      for (const call of facts.callShapes('ipcMain.handle')) {
        const channel = call.args[0]?.stringLiteral;
        if (!channel) continue;
        emit.entrypoint({
          type: 'queue', channel, file: call.file,
          startLine: call.loc.startLine, endLine: call.loc.endLine,
        });
      }
    },
  },
];

export default profile;`,
    );
    expect(typecheckProfile(writeProfile(withCleanRule))).toEqual([]);
  });

  it('reports the profile file only, not the engine sources it pulls in for the schema', () => {
    const profilePath = writeProfile(VALID.replace("parserId: 'fixture/valid',", 'parserId: 42,'));
    const diagnostics = typecheckProfile(profilePath);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(profilePath);
  });
});

describe('schema root resolution', () => {
  // Hosts that bundle the engine (the desktop app esbuilds it into its parse worker) leave this
  // module with no package of its own on disk, so the gate has to be pointed at a package copy.
  const ENV = 'COREDOC_PROFILE_SCHEMA_DIR';

  afterEach(() => {
    delete process.env[ENV];
  });

  it('compiles against the package named by the env override', () => {
    process.env[ENV] = fileURLToPath(new URL('..', import.meta.url));
    expect(typecheckProfile(writeProfile(VALID))).toEqual([]);
  });

  it('throws naming the env var when the override carries no schema', () => {
    process.env[ENV] = tmpdir();
    expect(() => typecheckProfile(writeProfile(VALID))).toThrow(ENV);
  });
});

describe('assertProfileTypechecks', () => {
  it('throws ProfileTypeError naming every offending line', () => {
    const profilePath = writeProfile(
      VALID.replace('  entrypoints:', "  components: { detect: { via: 'react-fc' } },\n  entrypoints:"),
    );
    expect(() => assertProfileTypechecks(profilePath)).toThrow(ProfileTypeError);
    try {
      assertProfileTypechecks(profilePath);
    } catch (err) {
      expect((err as ProfileTypeError).message).toContain('does not match the ExtractionProfile schema');
      expect((err as ProfileTypeError).message).toContain(profilePath);
    }
  });

  it('passes a schema-clean profile', () => {
    expect(() => assertProfileTypechecks(writeProfile(VALID))).not.toThrow();
  });

  it('skips a compiled .js profile, which carries no types to check', () => {
    expect(() => assertProfileTypechecks(writeProfile('export default { parserId: 1 };', 'profile.js'))).not.toThrow();
  });
});

describe('profile capability gate', () => {
  it.each([
    [
      'a dynamic import',
      VALID.replace(
        'const profile:',
        "const nodeProcess = await import('node:process');\nnodeProcess.exit(0);\n\nconst profile:",
      ),
      /dynamic import/i,
    ],
    ['a re-export', `${VALID}\nexport { default as unsafe } from 'node:process';\n`, /re-export/i],
    ['a top-level IIFE', VALID.replace('const profile:', '(() => 1)();\n\nconst profile:'), /top-level call/i],
    [
      'require inside a custom rule',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (_facts, _emit) => { require('node:child_process').execSync('true'); },
}];
export default profile;`,
      ),
      /require/i,
    ],
    [
      'eval inside a custom rule',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (_facts, _emit) => { eval('1 + 1'); },
}];
export default profile;`,
      ),
      /eval/i,
    ],
    [
      'Function inside a custom rule',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (_facts, _emit) => { new Function('return 1')(); },
}];
export default profile;`,
      ),
      /Function constructor/i,
    ],
    [
      'Function recovered through a prototype property',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (facts, _emit) => { facts.callShapes.constructor('return process')(); },
}];
export default profile;`,
      ),
      /prototype capability/i,
    ],
    [
      'Function recovered through a bracketed prototype property',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (facts, _emit) => { facts.callShapes['constructor']('return process')(); },
}];
export default profile;`,
      ),
      /prototype capability/i,
    ],
    [
      'Function recovered through a composed prototype property',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (facts, _emit) => { facts.callShapes['con' + 'structor']('return process')(); },
}];
export default profile;`,
      ),
      /prototype capability/i,
    ],
    [
      'Function recovered through object destructuring',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (facts, _emit) => { const { constructor: Ctor } = facts.callShapes; Ctor('return process')(); },
}];
export default profile;`,
      ),
      /prototype capability/i,
    ],
    [
      'a composed prototype property recovered through object destructuring',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (facts, _emit) => { const { ['pro' + 'totype']: proto } = facts.callShapes; void proto; },
}];
export default profile;`,
      ),
      /prototype capability/i,
    ],
    [
      '__proto__ recovered through object destructuring',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (facts, _emit) => { const { __proto__: proto } = facts.callShapes; void proto; },
}];
export default profile;`,
      ),
      /prototype capability/i,
    ],
    [
      'Function recovered through Reflect.get',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (facts, _emit) => { Reflect.get(facts.callShapes, 'constructor')('return process')(); },
}];
export default profile;`,
      ),
      /prototype capability/i,
    ],
    [
      'Function recovered through Object.getOwnPropertyDescriptor',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (facts, _emit) => { Object.getOwnPropertyDescriptor(facts.callShapes, 'constructor')?.value('return process')(); },
}];
export default profile;`,
      ),
      /prototype capability/i,
    ],
    [
      'ambient process access inside a custom rule',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (_facts, _emit) => { process.exit(0); },
}];
export default profile;`,
      ),
      /ambient runtime global 'process'/i,
    ],
    [
      'ambient globalThis access inside a custom rule',
      VALID.replace(
        'export default profile;',
        `profile.customRules = [{
  name: 'unsafe',
  run: (_facts, _emit) => { globalThis.console.log('side effect'); },
}];
export default profile;`,
      ),
      /ambient runtime global 'globalThis'/i,
    ],
  ])('rejects %s before the profile can be imported', (_label, source, expected) => {
    const profilePath = writeProfile(source);
    expect(
      profileCapabilityViolations(profilePath)
        .map((item) => item.message)
        .join('\n'),
    ).toMatch(expected);
    expect(() => assertProfileTypechecks(profilePath)).toThrow(ProfileCapabilityError);
  });

  it('allows facts-only custom-rule execution and declarative profile assembly', () => {
    const source = VALID.replace(
      'export default profile;',
      `profile.customRules = [{
  name: 'ipc',
  run: (facts, emit) => {
    for (const call of facts.callShapes('ipcMain.handle')) {
      const channel = call.args[0]?.stringLiteral;
      if (!channel) continue;
      emit.entrypoint({
        type: 'queue', channel, file: call.file,
        startLine: call.loc.startLine, endLine: call.loc.endLine,
      });
    }
  },
}];
export default profile;`,
    );
    const profilePath = writeProfile(source);
    expect(profileCapabilityViolations(profilePath)).toEqual([]);
    expect(() => assertProfileTypechecks(profilePath)).not.toThrow();
  });

  it('runs the capability gate in the score path before importing the module', async () => {
    const profilePath = writeProfile('');
    const sentinel = join(dir, 'module-imported.txt');
    writeFileSync(
      profilePath,
      `const fs = await import('node:fs');
fs.writeFileSync(${JSON.stringify(sentinel)}, 'executed');
export default {
  parserId: 'fixture/must-not-import',
  substrate: { language: 'ts', include: ['**/*.ts'] },
};
`,
    );

    await expect(scoreProfile(profilePath, dir)).rejects.toThrow(ProfileCapabilityError);
    expect(existsSync(sentinel)).toBe(false);
  });
});
