import { fileURLToPath } from 'node:url';
import { validateCSharpIndexRequest } from '@coredoc/profile-parser/csharp';
import { prepareDesktopCompilerIndex, type CompilerHostOptions } from './compiler-index-host.js';
export type CSharpHostOptions = CompilerHostOptions;

export const CSHARP_EXECUTION_NOTICE =
  'Enhanced analysis runs this repository’s MSBuild projects and build targets, including restore with network access, in an isolated copy. Only run it for repositories you trust; network access is not isolated from LAN/host services on every platform. Your source repository stays unchanged.';

export async function prepareDesktopCSharpIndex(input: unknown, options: CSharpHostOptions) {
  return prepareDesktopCompilerIndex(validateCSharpIndexRequest(input), options, {
    label: 'C#',
    notice: CSHARP_EXECUTION_NOTICE,
    childScript: fileURLToPath(new URL('./sdk-csharp-index-child.js', import.meta.url)),
  });
}
