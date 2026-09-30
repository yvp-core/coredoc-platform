import type { AnchorBinding, AnchorEnvelope } from './anchor-mapping-types.js';
const MAX_BLOCK_BYTES = 32 * 1024;
const MAX_BINDINGS = 50;
const MAX_TARGETS = 200;
const ITEM_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{40}$/;
const ALLOWED_ENVELOPE_KEYS = new Set(['schemaVersion', 'headSha', 'bindings']);
const ALLOWED_BINDING_KEYS = new Set(['itemId', 'files', 'symbols', 'replaceNodeIds']);

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

function relativePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.length > 0 && parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function symbolLocator(value: string): boolean {
  const split = value.lastIndexOf('#');
  return split > 0 && split < value.length - 1 && relativePath(value.slice(0, split));
}

function binding(value: unknown): AnchorBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ALLOWED_BINDING_KEYS)) return undefined;
  if (typeof record.itemId !== 'string' || record.itemId.length > 64 || !ITEM_ID.test(record.itemId)) return undefined;
  const files = record.files ?? [];
  const symbols = record.symbols ?? [];
  const replaceNodeIds = record.replaceNodeIds ?? [];
  if (!strings(files) || !strings(symbols) || !strings(replaceNodeIds)) return undefined;
  if (!files.every(relativePath) || !symbols.every(symbolLocator) || replaceNodeIds.some((id) => id.length > 500))
    return undefined;
  if (files.length + symbols.length + replaceNodeIds.length === 0) return undefined;
  return { itemId: record.itemId, files, symbols, replaceNodeIds };
}

function envelope(value: unknown): AnchorEnvelope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ALLOWED_ENVELOPE_KEYS)) return undefined;
  if (record.schemaVersion !== 1 || typeof record.headSha !== 'string' || !SHA.test(record.headSha)) return undefined;
  if (!Array.isArray(record.bindings) || record.bindings.length > MAX_BINDINGS) return undefined;
  const bindings = record.bindings.map(binding);
  if (bindings.some((entry) => entry === undefined)) return undefined;
  const concrete = bindings as AnchorBinding[];
  if (new Set(concrete.map((entry) => entry.itemId)).size !== concrete.length) return undefined;
  const targetCount = concrete.reduce(
    (count, entry) => count + entry.files.length + entry.symbols.length + entry.replaceNodeIds.length,
    0,
  );
  if (targetCount > MAX_TARGETS) return undefined;
  return { schemaVersion: 1, headSha: record.headSha, bindings: concrete };
}

/** Validate a structured transport envelope without uploading the rest of the PR body. */
export function parseAnchorEnvelope(value: unknown): AnchorEnvelope | undefined {
  const parsed = envelope(value);
  return parsed && Buffer.byteLength(JSON.stringify(parsed), 'utf8') <= MAX_BLOCK_BYTES ? parsed : undefined;
}
