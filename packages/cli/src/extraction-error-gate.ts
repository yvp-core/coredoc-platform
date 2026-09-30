import type { ParsedRepo } from '@coredoc/core/types';

/**
 * Refuse to publish a graph when its extractor explicitly reports known data loss.
 * Warnings remain visible in the output but are non-blocking; `error` means callers
 * must keep the previous successful artifact instead of replacing it with a partial one.
 */
export function assertNoBlockingExtractionErrors(parsedRepo: ParsedRepo): void {
  const errors = (parsedRepo.errors ?? []).filter((error) => error.severity === 'error');
  if (errors.length === 0) return;

  const samples = errors
    .slice(0, 3)
    .map((error) => `${error.file}: ${error.message}`)
    .join('; ');
  const remainder = errors.length > 3 ? `; +${errors.length - 3} more` : '';
  throw new Error(
    `Extraction produced ${errors.length} blocking error(s); refusing to publish a partial graph. ${samples}${remainder}`,
  );
}
