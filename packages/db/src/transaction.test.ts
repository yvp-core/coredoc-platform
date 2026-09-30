import { describe, expect, it, vi } from 'vitest';
import type { ITransaction, TransactionStatement } from './types.js';
import { runStatements } from './transaction.js';

const statements: TransactionStatement[] = [
  { query: 'first', params: { value: 1 } },
  { query: 'second', params: { value: 2 } },
  { query: 'third' },
];

describe('runStatements', () => {
  it('uses one transport batch when the transaction exposes runBatch', async () => {
    const run = vi.fn();
    const runBatch = vi.fn().mockResolvedValue(undefined);
    await runStatements({ run, runBatch } as unknown as ITransaction, statements);
    expect(runBatch).toHaveBeenCalledOnce();
    expect(runBatch).toHaveBeenCalledWith(statements);
    expect(run).not.toHaveBeenCalled();
  });

  it('falls back to ordered transaction runs', async () => {
    const order: string[] = [];
    const tx: ITransaction = {
      run: async (query) => {
        order.push(query);
        return [];
      },
    };
    await runStatements(tx, statements);
    expect(order).toEqual(['first', 'second', 'third']);
  });
});
