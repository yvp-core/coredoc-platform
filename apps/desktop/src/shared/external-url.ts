/**
 * The one policy for a URL the app may hand to `shell.openExternal`.
 *
 * Shared by the main process (`delivery:openExternal`, which must re-validate
 * because renderer input is untrusted) and every renderer surface that decides
 * whether something renders as a link at all. A renderer-only gate that was
 * laxer than main's produced links that looked clickable and silently did
 * nothing; keeping both on this function is what makes "looks clickable" and
 * "opens" the same predicate.
 *
 * Query and fragment are allowed: `https://x/y?tab=1#section` is an ordinary
 * documentation link, and they carry no privilege the path does not. What is
 * refused is what makes the target something other than a public https
 * resource — another scheme (`javascript:`, `file:`), embedded credentials, a
 * URL long enough to be a payload, and whitespace or control characters, which
 * the parser silently strips or encodes and which would otherwise let the
 * string handed to the shell differ from the one shown to the user.
 */

const MAX_EXTERNAL_URL_LENGTH = 2_048;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const UNSAFE_CHARACTERS = /[\s\u0000-\u001f\u007f]/;

/** Returns `value` verbatim when it may be opened externally, else `null`. */
export function externalHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_EXTERNAL_URL_LENGTH) return null;
  if (UNSAFE_CHARACTERS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return value;
}
