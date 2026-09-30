import type { Arm, ArmFactors } from './types.js';

export const DEFAULT_ARMS: readonly Arm[] = ['withoutMcp', 'withMcp'];

const FACTORS: Record<Arm, ArmFactors> = {
  withMcp: { mcp: true, productGuide: true },
  mcpOnly: { mcp: true, productGuide: false },
  withoutMcp: { mcp: false, productGuide: false },
};

export function armFactorsFor(arm: Arm): ArmFactors {
  const factors = FACTORS[arm];
  if (!factors) throw new Error(`Unknown eval arm "${arm}".`);
  return { ...factors };
}

export function parseArmSelection(raw: string | undefined): Arm[] {
  if (!raw) return [...DEFAULT_ARMS];
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean) as Arm[];
  if (values.length === 0) throw new Error('At least one arm must be selected.');
  // Reject duplicates: two pipelines for the same arm resolve to the SAME worktree path, so
  // they would run concurrently against one checkout — one pipeline's `reset --hard` /
  // `clean -fd` firing while the other's agent is mid-read.
  const duplicates = values.filter((arm, index) => values.indexOf(arm) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate eval arm(s) selected: ${[...new Set(duplicates)].join(', ')}.`);
  }
  for (const arm of values) armFactorsFor(arm);
  return values;
}

export function buildArmSystemPrompt(
  basePrompt: string,
  factors: ArmFactors,
  productGuide: string | null,
): string {
  if (!factors.productGuide) return basePrompt;
  if (!productGuide?.trim()) {
    throw new Error('The withMcp product arm requires the product guide, but it is missing or empty.');
  }
  return [
    basePrompt,
    '<trusted-coredoc-product-guide>',
    productGuide,
    '</trusted-coredoc-product-guide>',
  ].join('\n\n');
}
