import { describe, expect, it } from 'vitest';
import { cleanRuntimeLog, createRuntimeLogFilter } from './runtime-log.js';

describe('cleanRuntimeLog', () => {
  it('removes only the known Electron codesign probe denied by the process sandbox', () => {
    const noisy =
      '[0825/132625.675326:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)\n' +
      'Parsing supabase...\n' +
      'Error: real parse failure\n';

    expect(cleanRuntimeLog(noisy)).toBe('Parsing supabase...\nError: real parse failure\n');
    expect(cleanRuntimeLog('task_name_for_pid: some other failure\n')).toBe('task_name_for_pid: some other failure\n');
  });

  it('removes the known line when stderr splits it across arbitrary chunks', () => {
    const filter = createRuntimeLogFilter();

    expect(filter.push('[0825/132625.675326:ERROR:electron/shell/common/mac/code')).toBe('');
    expect(filter.push('sign_util.cc:79] task_name_for_pid: (os/kern) failure (5)\nParsing ')).toBe('');
    expect(filter.push('supabase...\nError: real parse failure\n')).toBe(
      'Parsing supabase...\nError: real parse failure\n',
    );
    expect(filter.flush()).toBe('');
  });

  it('flushes real unterminated stderr and never buffers an unbounded non-matching line', () => {
    const filter = createRuntimeLogFilter();
    expect(filter.push('real partial error')).toBe('');
    expect(filter.flush()).toBe('real partial error');

    const longFilter = createRuntimeLogFilter();
    const longError = `Error: ${'x'.repeat(600)}`;
    expect(longFilter.push(longError)).toBe(longError);
    expect(longFilter.flush()).toBe('');
  });
});
