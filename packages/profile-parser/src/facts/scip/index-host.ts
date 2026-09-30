import { AsyncLocalStorage } from 'node:async_hooks';
import type { OptionalScipResult, ScipArtifact } from './source-manifest.js';
export { copyOptionalScip } from './source-manifest.js';

export type OptionalIndexLanguage = 'ruby' | 'python' | 'rust' | 'go';
export interface IndexPolicy {
  mode?: 'basic' | 'enhanced';
  fallback?: boolean;
}
export interface OptionalIndexRequest {
  language: OptionalIndexLanguage;
  fallback: boolean;
}
export type OptionalIndexResponse = { path: string } | { basic: true };
type IndexHost = (request: OptionalIndexRequest) => Promise<OptionalIndexResponse>;
const host = new AsyncLocalStorage<IndexHost>();

export function withOptionalIndexHost<T>(prepare: IndexHost, run: () => Promise<T>): Promise<T> {
  return host.run(prepare, run);
}
export function getOptionalIndexHost(): IndexHost | undefined {
  return host.getStore();
}

/** No paths, commands, environment variables or installation choices come from the profile. */
export function validateOptionalIndexRequest(value: unknown): OptionalIndexRequest {
  const request = value as OptionalIndexRequest | undefined;
  if (!request || !['ruby', 'python', 'rust', 'go'].includes(request.language) || typeof request.fallback !== 'boolean')
    throw new Error('Invalid optional analysis request from the profile sandbox.');
  return { language: request.language, fallback: request.fallback };
}

/** Apply the same explicit/basic/fallback policy to language-owned compiler work. */
export async function optionalAnalysis<T>(
  language: OptionalIndexLanguage,
  policy: IndexPolicy | undefined,
  prepare: () => Promise<OptionalScipResult>,
  consume: (index: string | ScipArtifact) => T,
): Promise<{ result?: T; analysis: import('@coredoc/core').AnalysisRecord }> {
  const analysis: import('@coredoc/core').AnalysisRecord = {
    language,
    mode: 'basic',
    compilerReceiverTypes: false,
    fallback: false,
  };
  if (policy?.mode === 'basic') return { analysis };
  try {
    const host = getOptionalIndexHost();
    let index: string | ScipArtifact | undefined;
    if (host) {
      const response = await host({ language, fallback: policy?.fallback !== false });
      if ('basic' in response) {
        if (policy?.fallback === false) throw new Error('Strict enhanced analysis cannot use basic mode.');
        return { analysis };
      }
      index = response.path;
    } else {
      const prepared = await prepare();
      if (!prepared.ok) throw new Error(prepared.degradeReason ?? `${language} indexer unavailable.`);
      index = prepared.scip ?? prepared.scipPath;
    }
    if (!index) throw new Error(`${language} indexer produced no index.`);
    const result = consume(index);
    return { result, analysis: { ...analysis, mode: 'enhanced' } };
  } catch (error) {
    if ((error instanceof Error && error.name === 'AbortError') || policy?.fallback === false) throw error;
    console.warn(
      `[coredoc] ${language}: using basic analysis. ${error instanceof Error ? error.message : String(error)}`,
    );
    return { analysis: { ...analysis, fallback: true } };
  }
}
