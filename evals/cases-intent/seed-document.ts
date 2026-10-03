// evals/cases-intent/seed-document.ts
/**
 * The eval's reviewed intent (`seed-intent.json`, written in the retired overlay
 * shape) as the `CloudIntentWorkspaceDocumentV1` that
 * `POST workspaces/:id/intent/import/workspace` takes.
 *
 * The document type is restated here rather than imported: it lives in
 * `apps/server`, which the evals package does not depend on. Only the fields the
 * seed uses are declared; the server validates the whole document on import.
 *
 * Two parts of the seed have no place in a workspace document and are dropped:
 * code anchors (the document carries none; anchors are written against a
 * published graph) and item-to-item relations (the cloud model relates tree
 * nodes, not items).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalIntentJson } from '@coredoc/core';

export const SEED_INTENT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'seed-intent.json');

/** `source.ref` of the imported document, recorded on every arrival transition. */
export const SEED_SOURCE_REF = 'coredoc-intent-eval-seed';

interface SeedSource {
  kind: string;
  ref: string;
  localId: string;
}

export interface SeedIntentFile {
  projectId: string;
  domains: Array<{ id: string; title: string; statement?: string }>;
  items: Array<{
    id: string;
    kind: string;
    domain?: string;
    title: string;
    statement: string;
    authority: 'accepted' | 'candidate' | 'superseded' | 'rejected';
    payload?: Record<string, unknown>;
    sources: SeedSource[];
    codeAnchors?: unknown[];
  }>;
  relations?: Array<{ from: string; to: string; type: string }>;
}

export interface WorkspaceDocument {
  formatVersion: 1;
  source: { ref: string; revision: string };
  domains: Array<{ id: string; title: string; statement?: string }>;
  features: [];
  items: Array<{
    id: string;
    kind: string;
    domainId?: string;
    title: string;
    statement: string;
    authority: SeedIntentFile['items'][number]['authority'];
    payload?: Record<string, unknown>;
    sources: SeedSource[];
  }>;
}

export function readSeedIntent(path: string = SEED_INTENT_PATH): SeedIntentFile {
  return JSON.parse(readFileSync(path, 'utf8')) as SeedIntentFile;
}

export function seedToWorkspaceDocument(seed: SeedIntentFile): WorkspaceDocument {
  const body = {
    domains: seed.domains.map((domain) => ({
      id: domain.id,
      title: domain.title,
      ...(domain.statement ? { statement: domain.statement } : {}),
    })),
    features: [] as [],
    items: seed.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      ...(item.domain ? { domainId: item.domain } : {}),
      title: item.title,
      statement: item.statement,
      authority: item.authority,
      ...(item.payload ? { payload: item.payload } : {}),
      sources: item.sources.map((source) => ({ kind: source.kind, ref: source.ref, localId: source.localId })),
    })),
  };
  return {
    formatVersion: 1,
    // The content's own digest, so re-seeding the same file names the same revision.
    source: { ref: SEED_SOURCE_REF, revision: createHash('sha256').update(canonicalIntentJson(body)).digest('hex') },
    ...body,
  };
}
