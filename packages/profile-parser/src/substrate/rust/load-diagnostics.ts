export const SUPPORTED_RUST_ANALYZER_VERSION = '0.3.3049';

// Diagnostic text is not a stable upstream API; admit only the release verified by native tests.
export function assertSupportedRustAnalyzerVersion(output: string): void {
  const version = output.trim();
  const reported = version.match(/^rust-analyzer (\S+)/)?.[1];
  if (reported !== SUPPORTED_RUST_ANALYZER_VERSION && reported !== `${SUPPORTED_RUST_ANALYZER_VERSION}-standalone`)
    throw new Error(
      `Unsupported rust-analyzer diagnostics version: ${version.slice(0, 200) || '(empty response)'}. ` +
        `This Coredoc release supports rust-analyzer ${SUPPORTED_RUST_ANALYZER_VERSION}. Install that release on PATH or choose basic analysis.`,
    );
}

/** SCIP exits successfully after loader failures; require its loader trace before accepting the index. */
export function assertRustWorkspaceLoaded(log: string): void {
  if (!log.includes('LoadCargoConfig'))
    throw new Error(
      'rust-analyzer did not report workspace loading diagnostics. Verify the supported rust-analyzer installation or choose basic analysis.',
    );
  const failure = log.match(
    /Errors occurred while running build scripts[^\n]*|Failed to start proc-macro server[^\n]*|No proc-macro server started[^\n]*|proc-macro loading for [^\n]* failed:[^\n]*/,
  );
  if (failure) throw new Error(`Rust workspace loading failed: ${failure[0].slice(0, 500)}`);
}
