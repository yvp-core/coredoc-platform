import { AsyncLocalStorage } from 'node:async_hooks';

export interface CSharpIndexRequest {
  projects: string[];
  defines: string[];
  fallback: boolean;
}
export type CSharpIndexResponse = { path: string } | { basic: true };
type IndexHost = (request: CSharpIndexRequest) => Promise<CSharpIndexResponse>;
const host = new AsyncLocalStorage<IndexHost>();

/** Only the desktop bootstrap supplies this capability; profile imports remain sandboxed. */
export function withCSharpIndexHost<T>(prepare: IndexHost, run: () => Promise<T>): Promise<T> {
  return host.run(prepare, run);
}
export function getCSharpIndexHost(): IndexHost | undefined {
  return host.getStore();
}

/** Validate the untrusted request before the host starts any compiler process. */
export function validateCSharpIndexRequest(value: unknown): CSharpIndexRequest {
  const request = value as CSharpIndexRequest | undefined;
  if (
    !request ||
    !Array.isArray(request.projects) ||
    !request.projects.length ||
    request.projects.length > 512 ||
    !request.projects.every(
      (p) =>
        typeof p === 'string' &&
        p.length <= 4096 &&
        !/^[\\/-]/.test(p) &&
        !/[\\:\0\r\n]/.test(p) &&
        !p.split('/').includes('..') &&
        /\.(csproj|sln|slnx)$/.test(p),
    ) ||
    !Array.isArray(request.defines) ||
    request.defines.length > 256 ||
    !request.defines.every((d) => typeof d === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(d)) ||
    typeof request.fallback !== 'boolean'
  ) {
    throw new Error('Invalid C# compiler request from the profile sandbox.');
  }
  return { projects: [...request.projects], defines: [...request.defines], fallback: request.fallback };
}
