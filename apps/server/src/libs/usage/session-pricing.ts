export const PRICE_MAP_VERSION = '2026-09-23';
export const PRICE_MAP_BASIS = 'standard-global-public-api-5m-cache-writes';

export interface SessionTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** A subset of output tokens, retained for display and never billed twice. */
  reasoning: number;
}

interface ModelPrice {
  provider: 'claude-code' | 'codex';
  model: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheCreationPerMillion: number;
  outputPerMillion: number;
  /** OpenAI input counts include cache subsets; Anthropic reports them separately. */
  inputIncludesCache: boolean;
  /** Above this aggregate, per-request long-context tiers cannot be reconstructed. */
  maxBaseTierAggregateInput?: number;
}

// Public standard/global API list prices pinned on PRICE_MAP_VERSION. Claude
// cache-creation uses the default five-minute write rate because the native
// counter carries no cache-TTL qualifier. These are estimates, not subscription
// spend or invoice reconstruction.
const MODEL_PRICES: readonly ModelPrice[] = [
  {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    cacheCreationPerMillion: 6.25,
    outputPerMillion: 30,
    inputIncludesCache: true,
    maxBaseTierAggregateInput: 272_000,
  },
  {
    provider: 'claude-code',
    model: 'claude-sonnet-4-6',
    inputPerMillion: 3,
    cachedInputPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
    outputPerMillion: 15,
    inputIncludesCache: false,
  },
  {
    provider: 'claude-code',
    model: 'claude-fable-5',
    inputPerMillion: 10,
    cachedInputPerMillion: 1.0,
    cacheCreationPerMillion: 12.5,
    outputPerMillion: 50,
    inputIncludesCache: false,
  },
  {
    provider: 'claude-code',
    model: 'claude-opus-5',
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    cacheCreationPerMillion: 6.25,
    outputPerMillion: 25,
    inputIncludesCache: false,
  },
  // Opus 5 has a 1M context window at standard pricing, no long-context premium;
  // an explicit entry is used rather than suffix-normalization logic.
  {
    provider: 'claude-code',
    model: 'claude-opus-5[1m]',
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    cacheCreationPerMillion: 6.25,
    outputPerMillion: 25,
    inputIncludesCache: false,
  },
  {
    provider: 'codex',
    model: 'gpt-5.6-luna',
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    cacheCreationPerMillion: 0.25,
    outputPerMillion: 1.2,
    inputIncludesCache: true,
    maxBaseTierAggregateInput: 272_000,
  },
  {
    provider: 'codex',
    model: 'gpt-6-sol',
    inputPerMillion: 2,
    cachedInputPerMillion: 0.2,
    cacheCreationPerMillion: 2.5,
    outputPerMillion: 10,
    inputIncludesCache: true,
    maxBaseTierAggregateInput: 272_000,
  },
  {
    provider: 'codex',
    model: 'gpt-6-luna',
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.01,
    cacheCreationPerMillion: 0.125,
    outputPerMillion: 0.5,
    inputIncludesCache: true,
    maxBaseTierAggregateInput: 272_000,
  },
  // Opus 5.5, like Opus 5, has no long-context premium on its 1M window.
  {
    provider: 'claude-code',
    model: 'claude-opus-5-5',
    inputPerMillion: 4,
    cachedInputPerMillion: 0.2,
    cacheCreationPerMillion: 5,
    outputPerMillion: 20,
    inputIncludesCache: false,
  },
  {
    provider: 'claude-code',
    model: 'claude-opus-5-5[1m]',
    inputPerMillion: 4,
    cachedInputPerMillion: 0.2,
    cacheCreationPerMillion: 5,
    outputPerMillion: 20,
    inputIncludesCache: false,
  },
];

export function isPricedModel(provider: string, model: string): boolean {
  return MODEL_PRICES.some((candidate) => candidate.provider === provider && candidate.model === model);
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function estimateSessionCostUsd(provider: string, model: string, usage: SessionTokenUsage): number | null {
  if (!Object.values(usage).every(validCount)) return null;
  if (usage.reasoning > usage.output) return null;
  const price = MODEL_PRICES.find((candidate) => candidate.provider === provider && candidate.model === model);
  if (!price) return null;
  if (price.maxBaseTierAggregateInput !== undefined && usage.input > price.maxBaseTierAggregateInput) return null;

  const ordinaryInput = price.inputIncludesCache ? usage.input - usage.cacheRead - usage.cacheCreation : usage.input;
  if (ordinaryInput < 0) return null;

  return (
    (ordinaryInput * price.inputPerMillion +
      usage.cacheRead * price.cachedInputPerMillion +
      usage.cacheCreation * price.cacheCreationPerMillion +
      usage.output * price.outputPerMillion) /
    1_000_000
  );
}
