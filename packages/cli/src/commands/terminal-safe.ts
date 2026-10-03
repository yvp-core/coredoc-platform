/**
 * Strip C0/C1 control characters (including ESC/CSI/OSC sequences' control
 * bytes) from untrusted text before it is written to a terminal.
 *
 * The SERVER is an untrusted source of terminal text: `commands/intent-cloud.ts`
 * prints refusal messages, field paths and item ids verbatim (spec §12 forbids
 * paraphrasing them), and that content is agent-authored. An embedded ANSI/OSC
 * escape could rewrite the terminal that is meant to show what went wrong.
 *
 * Normal printable text and ordinary spaces survive; tabs and newlines are
 * dropped so a single rendered line cannot be split or repositioned.
 *
 * `JSON.stringify` is NOT a substitute. It escapes C0 but passes C1 and DEL
 * through verbatim — `\x9b` is 8-bit CSI and `\x9d` is 8-bit OSC on any terminal
 * that honours them.
 */
export function stripControlChars(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching C0/C1 to strip them.
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/** Render an untrusted value that may be absent. */
export function safe(value: string | undefined): string {
  return value === undefined ? '' : stripControlChars(value);
}
