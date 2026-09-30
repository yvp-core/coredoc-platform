import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { RUST_MAC_POLICY } from './scip-run.js';
import { runIsolatedProcess } from '../../facts/scip/isolated-process.js';

it.skipIf(process.platform !== 'darwin')(
  'terminates Rust workers while rejecting signals to a host process',
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'isolated-rust-'));
    try {
      const result = await runIsolatedProcess(
        process.execPath,
        [
          '-e',
          `
      const {spawn} = require('node:child_process');
      const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
      let host;
      try { process.kill(Number(process.argv[1]),0); host='allowed'; } catch(e) { host=e.code; }
      worker.on('spawn',()=>worker.kill('SIGTERM'));
      worker.on('exit',(_,signal)=>console.log(JSON.stringify({host,signal})));
    `,
          String(process.pid),
        ],
        {
          label: 'Rust',
          cwd: work,
          writeRoots: [work],
          readRoots: [dirname(process.execPath)],
          timeoutMs: 5000,
          macPolicy: RUST_MAC_POLICY,
        },
      );
      expect(JSON.parse(result)).toEqual({ host: 'EPERM', signal: 'SIGTERM' });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
