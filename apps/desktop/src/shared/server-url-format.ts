/**
 * Normalization for an operator- or user-supplied Coredoc server URL.
 *
 * Shared by the main process (managed config, the `workspace:setServerUrl`
 * handler) and the renderer's server-entry form so that an address the form
 * accepts is byte-identical to the one main persists — a renderer-only check
 * would let `https://host/` and `https://host` become two different origins
 * (and main must re-validate anyway, since renderer input is untrusted).
 */

/**
 * Returns the canonical form of `value`, or `null` when it is not a usable
 * server address. Rejects credentials, query and fragment: those never belong
 * in an API base URL and silently carrying them would leak into every request.
 *
 * The result is rebuilt from the parsed URL rather than echoed back from the
 * input. Every caller concatenates it (`${serverUrl}${path}`), and the input
 * can carry syntax the parser reports as empty — `https://host#` has no
 * fragment and `https://host?` has no query, yet echoing either verbatim would
 * turn the next `/api/v1/...` into a fragment or query string and silently
 * point the app at the server root.
 */
export function normalizeServerUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}
