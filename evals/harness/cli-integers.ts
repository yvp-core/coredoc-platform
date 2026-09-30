export function parsePositiveIntegerFlag(
  value: string | undefined,
  flag: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid ${flag} "${value}": expected a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${flag} "${value}": expected a positive integer.`);
  }
  return parsed;
}
