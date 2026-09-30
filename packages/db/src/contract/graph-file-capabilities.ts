import { openGraphFile, type IGraphRepository, type GraphFileOptions } from '../index.js';

declare const options: GraphFileOptions;

function needsWriter(repository: IGraphRepository): IGraphRepository {
  return repository;
}

async function capabilityContract(): Promise<void> {
  const readOnly = await openGraphFile(options);
  // @ts-expect-error A serving handle must not satisfy the write capability.
  needsWriter(readOnly.repository);
  // @ts-expect-error Mutations are absent from the read-only handle type.
  await readOnly.repository.pushNodes([]);
  await readOnly.repository.containsNodeText(['sensitive-canary'], ['repo-hash']);
  for await (const _node of readOnly.repository.scanStoredNodes()) {
    // Ladybug immutable-file validation exposes a streaming raw projection.
  }
  for await (const _edge of readOnly.repository.scanStoredEdges()) {
    // Ladybug immutable-file validation exposes a streaming raw projection.
  }
}

void capabilityContract;
