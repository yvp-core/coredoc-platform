import { fileURLToPath } from 'node:url';
import { validateOptionalIndexRequest } from '@coredoc/profile-parser/optional-index';
import { prepareDesktopCompilerIndex, type CompilerHostOptions } from './compiler-index-host.js';

export const OPTIONAL_EXECUTION_NOTICE =
  'Enhanced analysis uses an optional language indexer in a protected source copy. Tools are installed only when you choose Install. Your source repository stays unchanged.';

export async function prepareDesktopOptionalIndex(input: unknown, options: CompilerHostOptions) {
  const request = validateOptionalIndexRequest(input);
  const label =
    request.language === 'ruby'
      ? 'Ruby'
      : request.language === 'python'
        ? 'Python'
        : request.language === 'go'
          ? 'Go'
          : 'Rust';
  return prepareDesktopCompilerIndex(request, options, {
    label,
    notice:
      request.language === 'go'
        ? 'Enhanced Go analysis loads Go modules and may run build tooling with network access. Source files are read-only; dependency and build caches are stored outside your repository and reused. Only run it for repositories you trust; network access is not isolated from LAN/host services on every platform. Your repository stays unchanged.'
        : request.language === 'rust'
          ? 'Enhanced Rust analysis runs Cargo, build scripts and procedural macros with network access. Source files are read-only; dependency and build caches are stored outside your repository and reused. Only run it for repositories you trust; network access is not isolated from LAN/host services on every platform. Your source repository stays unchanged.'
          : OPTIONAL_EXECUTION_NOTICE,
    childScript: fileURLToPath(new URL('./sdk-optional-index-child.js', import.meta.url)),
  });
}
