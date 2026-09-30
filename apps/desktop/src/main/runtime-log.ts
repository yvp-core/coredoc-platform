// Electron's bundled Node runtime probes the parent process signature on macOS. The deliberate
// authoring/parse sandbox denies Mach task inspection, so Electron logs this exact diagnostic even
// though the app signature is valid and execution continues normally. Keep real stderr intact.
const SANDBOXED_ELECTRON_CODESIGN_NOISE =
  /^\[\d{4}\/\d{6}\.\d+:ERROR:electron\/shell\/common\/mac\/codesign_util\.cc:\d+\] task_name_for_pid: \(os\/kern\) failure \(5\)\r?(?:\n|$)/gm;

// The known diagnostic is much shorter than this. Once an unterminated stderr line exceeds the
// bound it cannot be the diagnostic, so release it immediately instead of buffering arbitrary
// real stderr until process exit.
const MAX_FILTERABLE_LINE_LENGTH = 512;

export function cleanRuntimeLog(text: string): string {
  return text.replace(SANDBOXED_ELECTRON_CODESIGN_NOISE, '');
}

/**
 * Preserve stderr stream boundaries while withholding only a possible partial codesign line.
 * `data` chunks are arbitrary and can split a line at any byte, so applying `cleanRuntimeLog`
 * independently to each chunk is insufficient.
 */
export function createRuntimeLogFilter(): { push(chunk: string): string; flush(): string } {
  let pending = '';

  return {
    push(chunk) {
      pending += chunk;
      const lastNewline = pending.lastIndexOf('\n');
      if (lastNewline >= 0) {
        const complete = pending.slice(0, lastNewline + 1);
        pending = pending.slice(lastNewline + 1);
        return cleanRuntimeLog(complete);
      }
      if (pending.length > MAX_FILTERABLE_LINE_LENGTH) {
        const realStderr = pending;
        pending = '';
        return realStderr;
      }
      return '';
    },

    flush() {
      const remainder = cleanRuntimeLog(pending);
      pending = '';
      return remainder;
    },
  };
}
