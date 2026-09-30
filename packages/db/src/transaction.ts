import type { ITransaction, TransactionStatement } from './types.js';

/**
 * Preserve statement ordering and transaction semantics while allowing
 * transports such as remote libSQL to collapse many writes into one exchange.
 */
export async function runStatements(tx: ITransaction, statements: readonly TransactionStatement[]): Promise<void> {
  if (statements.length === 0) return;
  if (tx.runBatch) {
    await tx.runBatch(statements);
    return;
  }
  for (const statement of statements) {
    await tx.run(statement.query, statement.params);
  }
}
