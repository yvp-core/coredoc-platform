/**
 * Acceptance for synthesized inline-handler hydration + fact re-attribution.
 *
 * A handler synthesized for an inline arrow (`ipcMain.handle(ch, () => …)`,
 * `app.post(p, (req) => …)`) used to be an empty shell: no sourceCode (the summarizer
 * fell back to guessing from the node name) and no outgoing edges (the substrate
 * attributes calls to the nearest NAMED scope — the registrar function). These tests
 * pin the fixed contract: an inline handler owns its span's source and the facts
 * recorded inside it, while identifier stubs and named nested functions are untouched.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { CustomRule, ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The electron-ipc custom rule every desktop profile uses (inline → handlerFunction). */
const IPC_RULE: CustomRule = {
  name: 'electron-ipc',
  run: (facts, emit) => {
    for (const call of facts.callShapes('ipcMain.handle')) {
      const channel = call.args[0]?.stringLiteral;
      if (!channel) continue;
      const named = call.args[1]?.identifier;
      const handlerId = named
        ? facts.functionId(call.file, named)
        : emit.handlerFunction({
            name: `ipc:${channel}`,
            file: call.file,
            startLine: call.loc.startLine,
            endLine: call.loc.endLine,
          });
      emit.entrypoint({
        type: 'queue',
        system: 'electron-ipc',
        channel,
        handlerId,
        file: call.file,
        startLine: call.loc.startLine,
        endLine: call.loc.endLine,
      });
    }
  },
};

async function run(src: string, profilePatch: Partial<ExtractionProfile>): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-synth-'));
  writeFileSync(join(dir, 'app.ts'), src);
  const profile: ExtractionProfile = {
    parserId: 'test-synth-handlers',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    ...profilePatch,
  };
  const { repo } = await runProfile(profile, dir, 'synth-test');
  return repo;
}

const IPC_SRC = `export function registerIpc(ipcMain: any) {
  ipcMain.handle('chat:send', async (_e: unknown, text: string) => {
    return send(text);
  });
  ipcMain.handle('chat:list', listChats);
}

export function send(text: string) {
  return text;
}

export function listChats() {
  return [];
}
`;

describe('inline handler hydration (custom-rule path)', () => {
  it('attaches the registration span source and a content-derived versionedId', async () => {
    const repo = await run(IPC_SRC, { customRules: [IPC_RULE] });
    const handler = repo.functions.find((f) => f.name === 'ipc:chat:send');
    expect(handler).toBeDefined();
    expect(handler?.sourceCode).toContain("ipcMain.handle('chat:send'");
    expect(handler?.sourceCode).toContain('send(text)');

    // Content-derived versionedId: same source ⇒ same versionedId, a body edit ⇒ a new one.
    const repo2 = await run(IPC_SRC, { customRules: [IPC_RULE] });
    const handler2 = repo2.functions.find((f) => f.name === 'ipc:chat:send');
    expect(handler2?.versionedId).toBe(handler?.versionedId);

    const edited = IPC_SRC.replace('send(text)', 'send(text.trim())');
    const repo3 = await run(edited, { customRules: [IPC_RULE] });
    const handler3 = repo3.functions.find((f) => f.name === 'ipc:chat:send');
    expect(handler3?.id).toBe(handler?.id);
    expect(handler3?.versionedId).not.toBe(handler?.versionedId);
  });

  it('re-parents calls inside the handler span from the registrar onto the handler', async () => {
    const repo = await run(IPC_SRC, { customRules: [IPC_RULE] });
    const handler = repo.functions.find((f) => f.name === 'ipc:chat:send');
    const registrar = repo.functions.find((f) => f.name === 'registerIpc');
    expect(handler && registrar).toBeTruthy();

    const sendCall = repo.calls.find((c) => c.calleeExpression === 'send');
    expect(sendCall?.callerId).toBe(handler?.id);

    // Nothing inside the inline span still hangs off the registrar…
    const inSpan = (line: number): boolean =>
      line >= (handler?.location.startLine ?? 0) && line <= (handler?.location.endLine ?? 0);
    const leaked = repo.calls.filter((c) => c.callerId === registrar?.id && inSpan(c.location.startLine));
    expect(leaked).toEqual([]);

    // …while the named-handler registration (`chat:list`, no synthesis) stays with it.
    const listReg = repo.calls.find((c) => c.calleeExpression === 'ipcMain.handle' && !inSpan(c.location.startLine));
    expect(listReg?.callerId).toBe(registrar?.id);
  });

  it('leaves a named function nested inside the handler owning its own calls', async () => {
    const src = `export function registerDeep(ipcMain: any) {
  ipcMain.handle('deep:run', () => {
    const helper = () => inner();
    return helper();
  });
}

export function inner() {
  return 1;
}
`;
    const repo = await run(src, { customRules: [IPC_RULE] });
    const handler = repo.functions.find((f) => f.name === 'ipc:deep:run');
    expect(handler).toBeDefined();

    // The direct call in the handler body re-parents onto it…
    const helperCall = repo.calls.find((c) => c.calleeExpression === 'helper');
    expect(helperCall?.callerId).toBe(handler?.id);
    // …but `inner()` belongs to the named `helper`, never to the handler.
    const innerCalls = repo.calls.filter((c) => c.calleeExpression === 'inner');
    for (const c of innerCalls) expect(c.callerId).not.toBe(handler?.id);
  });

  it('re-parents custom-rule external calls and db ops emitted inside the handler span', async () => {
    const src = `export function registerBilling(ipcMain: any) {
  ipcMain.handle('billing:charge', async () => {
    store.scan('accounts');
    return rpc('billing', 'charge');
  });
}
`;
    const rules: CustomRule[] = [
      IPC_RULE,
      {
        name: 'rpc-egress',
        run: (facts, emit) => {
          for (const call of facts.callShapes('rpc')) {
            const callerId = facts.enclosingFunctionId(call.file, call.loc.startLine);
            if (!callerId) continue;
            emit.externalCall({
              callerId,
              serviceName: call.args[0]?.stringLiteral ?? 'unknown',
              method: call.args[1]?.stringLiteral ?? 'unknown',
              file: call.file,
              startLine: call.loc.startLine,
              endLine: call.loc.endLine,
            });
          }
        },
      },
      {
        name: 'store-scan',
        run: (facts, emit) => {
          for (const call of facts.callShapes('store.scan')) {
            const performerId = facts.enclosingFunctionId(call.file, call.loc.startLine);
            if (!performerId) continue;
            emit.dbOperation({
              performerId,
              entityName: call.args[0]?.stringLiteral ?? 'unknown',
              operation: 'read',
              file: call.file,
              startLine: call.loc.startLine,
              endLine: call.loc.endLine,
            });
          }
        },
      },
    ];
    const repo = await run(src, { customRules: rules });
    const handler = repo.functions.find((f) => f.name === 'ipc:billing:charge');
    expect(handler).toBeDefined();
    expect(repo.externalCalls.map((e) => e.callerId)).toEqual([handler?.id]);
    expect(repo.dbOperations.map((o) => o.performerId)).toEqual([handler?.id]);
  });
});

describe('inline handler hydration (registration-rule path)', () => {
  const HTTP_SRC = `export function mount(app: any) {
  app.post('/things', (req: any) => {
    return createThing(req);
  });
  app.get('/things', importedList);
}

export function createThing(x: any) {
  return x;
}
`;
  const HTTP_PROFILE: Partial<ExtractionProfile> = {
    entrypoints: [
      {
        kind: 'http',
        detect: { via: 'call-shape', callee: 'app.*' },
        method: 'from-callee',
        methodPath: { arg: 0, as: 'string-literal' },
        paramSyntax: 'colon',
      },
    ],
  };

  it('hydrates the inline route handler and re-parents its calls', async () => {
    const repo = await run(HTTP_SRC, HTTP_PROFILE);
    const handler = repo.functions.find((f) => f.name === 'post:/things');
    expect(handler?.sourceCode).toContain("app.post('/things'");
    const createCall = repo.calls.find((c) => c.calleeExpression === 'createThing');
    expect(createCall?.callerId).toBe(handler?.id);
  });

  it('leaves an identifier stub source-less with no re-parented edges', async () => {
    const repo = await run(HTTP_SRC, HTTP_PROFILE);
    // `importedList` names a function that lives elsewhere — the stub must not claim
    // the registration line as its body, nor any edges at that line.
    const stub = repo.functions.find((f) => f.name === 'importedList');
    expect(stub).toBeDefined();
    expect(stub?.sourceCode).toBeUndefined();
    expect(repo.calls.filter((c) => c.callerId === stub?.id)).toEqual([]);
  });
});
