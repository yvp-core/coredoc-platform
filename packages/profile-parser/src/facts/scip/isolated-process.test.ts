import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { runIsolatedProcess } from './isolated-process.js';

it.skipIf(process.platform !== 'linux' || process.env.COREDOC_SANDBOX_E2E !== '1')(
  'creates a checkout mask when its home-directory parents are absent from the sandbox',
  async () => {
    const checkoutHome = mkdtempSync(join(homedir(), 'coredoc-source-mask-'));
    const source = join(checkoutHome, 'work', 'repo');
    mkdirSync(source, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), 'index-home-mask-'));
    writeFileSync(join(source, 'original'), 'fixture-only');
    try {
      const options = { label: 'home mask', cwd: work, readRoots: [dirname(process.execPath)], writeRoots: [work] };
      const args = [
        '-e',
        `
        const fs = require('node:fs');
        const path = require('node:path');
        const source = process.argv[1];
        console.log(JSON.stringify({ parent: fs.existsSync(path.dirname(source)), source: fs.existsSync(source), readable: fs.existsSync(source + '/original') }));
      `,
        source,
      ];
      // Prove the exact premise: none of the read/write binds created this parent.
      expect(JSON.parse(await runIsolatedProcess(process.execPath, args, options))).toEqual({
        parent: false,
        source: false,
        readable: false,
      });
      expect(JSON.parse(await runIsolatedProcess(process.execPath, args, { ...options, sourceRoot: source }))).toEqual({
        parent: true,
        source: true,
        readable: false,
      });
      expect(readFileSync(join(source, 'original'), 'utf8')).toBe('fixture-only');
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(checkoutHome, { recursive: true, force: true });
    }
  },
);

const clang = '/Library/Developer/CommandLineTools/usr/bin/clang';
it.skipIf(process.platform !== 'darwin' && !(process.platform === 'linux' && process.env.COREDOC_SANDBOX_E2E === '1'))(
  'indexes original source paths read-only without exposing omitted files',
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'index-direct-'));
    const source = mkdtempSync(join(tmpdir(), 'index-checkout-'));
    mkdirSync(join(source, 'src'));
    writeFileSync(join(source, 'src/main.go'), 'package main');
    writeFileSync(join(source, '.env'), 'FIXTURE=private');
    try {
      const result = await runIsolatedProcess(
        process.execPath,
        [
          '-e',
          `
        const fs = require('node:fs');
        const attempt = fn => { try { fn(); return true; } catch { return false; } };
        console.log(JSON.stringify({
          cwd: process.cwd(), source: fs.readFileSync('src/main.go', 'utf8'),
          secret: attempt(() => fs.readFileSync('.env')),
          secretMetadata: attempt(() => fs.statSync('.env')),
          write: attempt(() => fs.writeFileSync('src/main.go', 'changed')),
          create: attempt(() => fs.writeFileSync('new-file', 'changed')),
          cache: attempt(() => fs.writeFileSync(process.argv[1] + '/cache', 'reusable')),
        }));
      `,
          work,
        ],
        {
          label: 'direct source',
          cwd: source,
          sourceRoot: source,
          sourceFiles: ['src/main.go'],
          readRoots: [dirname(process.execPath)],
          writeRoots: [work],
        },
      );
      expect(JSON.parse(result)).toEqual({
        cwd: realpathSync(source),
        source: 'package main',
        secret: false,
        secretMetadata: false,
        write: false,
        create: false,
        cache: true,
      });
      expect(readFileSync(join(source, 'src/main.go'), 'utf8')).toBe('package main');
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'darwin' || !existsSync(clang))(
  'denies numeric sysctl access to another process environment',
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'index-sysctl-'));
    // Only this test-owned process is queried; never inspect the test runner or user processes.
    const host = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { COREDOC_DUMMY_TOKEN: 'fixture-only' },
      stdio: 'ignore',
    });
    try {
      const source = join(work, 'probe.c');
      const binary = join(work, 'probe');
      writeFileSync(
        source,
        `#include <sys/types.h>
#include <sys/sysctl.h>
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int mib[] = { CTL_KERN, KERN_PROCARGS2, strcmp(argv[1], "self") == 0 ? getpid() : atoi(argv[1]) };
  char buffer[262144]; size_t size = sizeof(buffer);
  int result = sysctl(mib, 3, buffer, &size, NULL, 0);
  if (result == 0) {
    const char *token = "COREDOC_DUMMY_TOKEN=fixture-only";
    int found = 0;
    for (size_t i = 0; i + strlen(token) <= size; ++i)
      if (memcmp(buffer + i, token, strlen(token)) == 0) found = 1;
    printf("readable:%d\\n", found);
  } else printf("denied:%d\\n", errno);
  return 0;
}`,
      );
      execFileSync(clang, ['-isysroot', '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk', source, '-o', binary]);
      expect(execFileSync(binary, [String(host.pid)], { encoding: 'utf8' }).trim()).toBe('readable:1');
      expect(
        (
          await runIsolatedProcess(binary, [String(host.pid)], {
            label: 'sysctl proof',
            cwd: work,
            writeRoots: [work],
            readRoots: [],
            allowNetwork: true,
          })
        ).trim(),
      ).toMatch(/^denied:(1|13)$/);
      expect(
        (
          await runIsolatedProcess(binary, ['self'], {
            label: 'self sysctl proof',
            cwd: work,
            writeRoots: [work],
            readRoots: [],
          })
        ).trim(),
      ).toMatch(/^readable:/);
    } finally {
      host.kill('SIGKILL');
      rmSync(work, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'darwin' && !(process.platform === 'linux' && process.env.COREDOC_SANDBOX_E2E === '1'))(
  'compiler children read/write only declared data roots',
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'index-containment-'));
    const source = mkdtempSync(join(tmpdir(), 'index-original-'));
    writeFileSync(join(source, 'original'), 'unchanged');
    try {
      const output = await runIsolatedProcess(
        process.execPath,
        [
          '-e',
          `
      const fs = require('node:fs');
      const attempt = (fn) => { try { fn(); return true; } catch { return false; } };
      const source = process.argv[1];
      console.log(JSON.stringify({
        systemData: attempt(() => fs.readFileSync('/etc/services')),
        sourceRead: attempt(() => fs.readFileSync(source + '/original')),
        sourceWrite: attempt(() => fs.writeFileSync(source + '/original', 'changed')),
        output: attempt(() => fs.writeFileSync('result', 'allowed')),
      }));
    `,
          source,
        ],
        {
          label: 'containment',
          cwd: work,
          readRoots: [dirname(process.execPath)],
          writeRoots: [work],
          sourceRoot: source,
        },
      );
      expect(JSON.parse(output)).toEqual({ systemData: false, sourceRead: false, sourceWrite: false, output: true });
      expect(readFileSync(join(source, 'original'), 'utf8')).toBe('unchanged');
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'darwin')(
  'network-enabled tooling cannot use host sockets or inspect home metadata',
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'index-network-'));
    // A socket in an otherwise readable directory proves the network boundary itself.
    const socket = join(work, 'host.sock');
    const server = createServer((client) => client.end('host credential'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    const local = createServer((client) => client.end('host service'));
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const address = local.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP fixture address');
    try {
      const output = await runIsolatedProcess(
        process.execPath,
        [
          '-e',
          `
      const fs = require('node:fs');
      let metadata;
      try { fs.statSync(process.argv[2]); metadata = 'allowed'; } catch(e) { metadata = e.code; }
      const connect = (target) => new Promise(resolve => {
        const socket = require('node:net').connect(target);
        socket.on('connect', () => { resolve('allowed'); socket.destroy(); });
        socket.on('error', e => resolve(e.code));
      });
      Promise.all([connect(process.argv[1]), connect({host:'127.0.0.1',port:Number(process.argv[3])})])
        .then(([socket, loopback]) => console.log(JSON.stringify({metadata, socket, loopback})));
    `,
          socket,
          fileURLToPath(import.meta.url),
          String(address.port),
        ],
        {
          label: 'test',
          cwd: work,
          writeRoots: [work],
          readRoots: [dirname(process.execPath)],
          allowNetwork: true,
          timeoutMs: 5000,
        },
      );
      expect(JSON.parse(output)).toEqual({ metadata: 'EPERM', socket: 'EPERM', loopback: 'EPERM' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => local.close(() => resolve()));
      rmSync(work, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux' || process.env.COREDOC_SANDBOX_E2E !== '1').each(['/usr/src', '/usr/lib'])(
  'masks an original checkout inside %s and system aliases, including omitted credential files',
  async (parent) => {
    // The CI setup grants this test-owned directory only; never mount over a real checkout.
    const source = mkdtempSync(`${parent}/coredoc-sandbox-tests/repo-`);
    const work = mkdtempSync(join(tmpdir(), 'index-system-containment-'));
    writeFileSync(join(source, '.env'), 'DUMMY=fixture-only');
    writeFileSync(join(work, 'copied.go'), 'package main');
    try {
      const output = await runIsolatedProcess(
        process.execPath,
        [
          '-e',
          `
        const fs = require('node:fs');
        const readable = p => { try { fs.readFileSync(p + '/.env'); return true; } catch { return false; } };
        const original = process.argv[1];
        console.log(JSON.stringify({ readable: readable(original), alias: readable(original.replace('/usr/lib/', '/lib/')), copied: fs.readFileSync('copied.go', 'utf8') }));
      `,
          source,
        ],
        {
          label: 'system-bind containment',
          cwd: work,
          readRoots: [dirname(process.execPath)],
          writeRoots: [work],
          sourceRoot: source,
        },
      );
      expect(JSON.parse(output)).toEqual({ readable: false, alias: false, copied: 'package main' });
      expect(readFileSync(join(source, '.env'), 'utf8')).toBe('DUMMY=fixture-only');
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    }
  },
);
