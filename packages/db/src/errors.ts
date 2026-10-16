export class GraphFileReadOnlyError extends Error {
  readonly code = 'GRAPH_FILE_READ_ONLY' as const;

  constructor(engine: 'ladybug') {
    super(`Cannot mutate a read-only ${engine} graph file`);
    this.name = 'GraphFileReadOnlyError';
  }
}

export type GraphFileOpenErrorCode =
  | 'INVALID_BUDGET'
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'NOT_REGULAR_FILE'
  | 'FILE_TOO_LARGE'
  | 'INITIALIZATION_FAILED';

export class GraphFileOpenError extends Error {
  constructor(
    readonly code: GraphFileOpenErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GraphFileOpenError';
  }
}
