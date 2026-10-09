const MASK = '[REDACTED]';
/** Shorter values would mask ordinary words; every credential the runner holds is far longer. */
const MIN_SECRET_LENGTH = 8;

/**
 * Replaces every exact occurrence of the given credentials in each string of
 * a payload. The server also masks common credential shapes; this catches
 * the values the runner itself holds, whatever their shape.
 */
export function secretMasker(secrets: Array<string | null | undefined>): <T>(value: T) => T {
  const values = [...new Set(secrets.filter((secret): secret is string => (secret?.length ?? 0) >= MIN_SECRET_LENGTH))];
  // Longest first, so a credential that contains another is masked whole.
  values.sort((a, b) => b.length - a.length);
  const maskText = (text: string) => values.reduce((masked, secret) => masked.split(secret).join(MASK), text);
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') return maskText(value);
    if (Array.isArray(value)) return value.map(mask);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mask(entry)]));
    }
    return value;
  };
  return <T>(value: T) => (values.length ? (mask(value) as T) : value);
}
