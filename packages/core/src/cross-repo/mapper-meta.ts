import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const HISTORY_CAP = 20;

const RegenHistoryEntrySchema = z.object({
  at: z.string(),
  rate: z.number(),
  trigger: z.enum(['manual', 'incremental', 'accept-regressions']),
  edgesAdded: z.number(),
  edgesRemoved: z.number(),
});

const MapperMetaSchema = z.object({
  generatedAt: z.string(),
  generatedBy: z.object({ model: z.string(), iterations: z.number() }),
  inputsHash: z.string(),
  baselineResolutionRate: z.number(),
  baselineEdgeIds: z.array(z.string()),
  regenHistory: z.array(RegenHistoryEntrySchema),
});

export type RegenHistoryEntry = z.infer<typeof RegenHistoryEntrySchema>;
export type MapperMeta = z.infer<typeof MapperMetaSchema>;

export function readMapperMeta(file: string): MapperMeta | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw);
  const result = MapperMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `mapper.meta.json at ${file} has invalid structure: ${result.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return result.data;
}

export function writeMapperMeta(file: string, meta: MapperMeta): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
}

export function appendRegenHistory(meta: MapperMeta, entry: RegenHistoryEntry): MapperMeta {
  const next = [...meta.regenHistory, entry];
  const trimmed = next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
  return { ...meta, regenHistory: trimmed };
}
