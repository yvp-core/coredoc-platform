/**
 * Acceptance for the customRules escape hatch.
 *
 * The emit surface is the whole bound on what a bespoke rule can do, so each emitter is
 * exercised end-to-end through `runProfile` and asserted on the assembled ParsedRepo —
 * a rule that "runs" but whose nodes never reach the graph is the exact failure this
 * covers. Also pins the id-validation contract: a rule may not reference a function
 * that does not exist.
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

const SRC = `export function registerIpc(ipcMain: any) {
  ipcMain.handle('chat:send', async (_e: unknown, text: string) => send(text));
  ipcMain.handle('chat:list', listChats);
}

export function listChats() {
  return [];
}

export function callBilling() {
  return rpc('billing', 'charge');
}

export function loadRows() {
  return store.scan('accounts');
}
`;

async function run(customRules: CustomRule[]): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-custom-'));
  writeFileSync(join(dir, 'app.ts'), SRC);
  const profile: ExtractionProfile = {
    parserId: 'test-custom-rules',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    customRules,
  };
  const { repo } = await runProfile(profile, dir, 'custom-test');
  return repo;
}

describe('customRules emit.entrypoint', () => {
  it('emits an http endpoint with canonicalized params', async () => {
    const repo = await run([
      {
        name: 'http-from-convention',
        run: (facts, emit) => {
          for (const call of facts.callShapes('ipcMain.handle')) {
            const channel = call.args[0]?.stringLiteral;
            if (!channel) continue;
            emit.entrypoint({
              type: 'http',
              method: 'POST',
              path: `/rpc/${channel.replace(':', '/')}/:id`,
              file: call.file,
              startLine: call.loc.startLine,
              endLine: call.loc.endLine,
            });
          }
        },
      },
    ]);
    const http = repo.entrypoints.filter((e) => e.type === 'http');
    const paths = http.map((e) => (e.details as { path: string }).path).sort();
    expect(paths).toEqual(['/rpc/chat/list/{id}', '/rpc/chat/send/{id}']);
    expect((http[0]?.details as { pathParams?: string[] }).pathParams).toEqual(['id']);
  });

  it('emits queue channels, resolving named handlers and synthesizing anonymous ones', async () => {
    const repo = await run([
      {
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
      },
    ]);
    const queue = repo.entrypoints.filter((e) => e.type === 'queue');
    expect(queue.map((e) => (e.details as { topic: string }).topic).sort()).toEqual(['chat:list', 'chat:send']);

    const fnIds = new Set(repo.functions.map((f) => f.id));
    for (const ep of queue) expect(fnIds.has(ep.handlerId)).toBe(true);

    const listChats = repo.functions.find((f) => f.name === 'listChats');
    const listEp = queue.find((e) => (e.details as { topic: string }).topic === 'chat:list');
    expect(listEp?.handlerId).toBe(listChats?.id);
  });
});

describe('customRules emit.externalCall', () => {
  it('lands an external call edge on the assembled repo', async () => {
    const repo = await run([
      {
        name: 'rpc-egress',
        run: (facts, emit) => {
          for (const call of facts.callShapes('rpc')) {
            const callerId = facts.functionId(call.file, 'callBilling');
            if (!callerId) continue;
            emit.externalCall({
              callerId,
              serviceName: 'billing',
              method: 'charge',
              sdkName: 'internal-rpc',
              targetPattern: '/charge',
              httpMethod: 'POST',
              file: call.file,
              startLine: call.loc.startLine,
              endLine: call.loc.endLine,
            });
          }
        },
      },
    ]);
    expect(repo.externalCalls).toHaveLength(1);
    const edge = repo.externalCalls[0];
    expect(edge?.serviceName).toBe('billing');
    expect(edge?.method).toBe('charge');
    expect(edge?.sdkName).toBe('internal-rpc');
    expect(edge?.targetDescriptor?.protocol).toBe('http');
    expect(repo.stats.totalExternalCalls).toBe(1);
  });
});

describe('customRules facts.enclosingFunctionId', () => {
  it('attributes a call site to its enclosing object-literal wrapper (preload invoke shape)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-custom-'));
    writeFileSync(
      join(dir, 'preload.ts'),
      `const api = {
  loadConfig: (configPath?: string) => ipcRenderer.invoke('config:load', configPath),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
};
export default api;
`,
    );
    const profile: ExtractionProfile = {
      parserId: 'test-custom-rules',
      substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
      customRules: [
        {
          name: 'ipc-invokes',
          run: (facts, emit) => {
            for (const call of facts.callShapes('ipcRenderer.invoke')) {
              const channel = call.args[0]?.stringLiteral;
              if (!channel) continue;
              const callerId = facts.enclosingFunctionId(call.file, call.loc.startLine);
              if (!callerId) continue;
              emit.externalCall({
                callerId,
                serviceName: 'desktop-main',
                sdkName: 'electron-ipc',
                method: channel,
                targetPattern: channel,
                ipc: { channel, direction: 'invoke' },
                file: call.file,
                startLine: call.loc.startLine,
                endLine: call.loc.endLine,
              });
            }
          },
        },
      ],
    };
    const { repo } = await runProfile(profile, dir, 'custom-test');
    expect(repo.externalCalls.map((e) => e.method).sort()).toEqual(['config:load', 'config:save']);
    const fnById = new Map(repo.functions.map((f) => [f.id, f.name]));
    expect(repo.externalCalls.map((e) => fnById.get(e.callerId)).sort()).toEqual(['loadConfig', 'saveConfig']);
    // The ipc descriptor is what the linker's topic hop keys on (channel = topic).
    for (const ec of repo.externalCalls) {
      expect(ec.targetDescriptor?.protocol).toBe('ipc');
      expect(ec.targetDescriptor?.ipc?.channel).toBe(ec.method);
    }
  });
});

describe('customRules emit.dbOperation', () => {
  it('lands a db operation on the assembled repo', async () => {
    const repo = await run([
      {
        name: 'store-scan',
        run: (facts, emit) => {
          for (const call of facts.callShapes('store.scan')) {
            const performerId = facts.functionId(call.file, 'loadRows');
            if (!performerId) continue;
            emit.dbOperation({
              performerId,
              entityName: call.args[0]?.stringLiteral ?? 'unknown',
              operation: 'read',
              details: 'store.scan',
              file: call.file,
              startLine: call.loc.startLine,
              endLine: call.loc.endLine,
            });
          }
        },
      },
    ]);
    expect(repo.dbOperations).toHaveLength(1);
    expect(repo.dbOperations[0]?.entityName).toBe('accounts');
    expect(repo.dbOperations[0]?.operation).toBe('read');
    expect(repo.dbOperations[0]?.details).toBe('store.scan');
  });
});

describe('customRules id validation', () => {
  it('throws naming the rule when an emitted id is not a real function node', async () => {
    await expect(
      run([
        {
          name: 'dangling',
          run: (facts, emit) => {
            for (const call of facts.callShapes('ipcMain.handle')) {
              emit.entrypoint({
                type: 'queue',
                channel: 'x',
                handlerId: 'not-a-real-id',
                file: call.file,
                startLine: call.loc.startLine,
                endLine: call.loc.endLine,
              });
            }
          },
        },
      ]),
    ).rejects.toThrow(/customRules\['dangling'\] emitted handlerId='not-a-real-id'/);
  });
});
