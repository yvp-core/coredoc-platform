/**
 * The one anchor operation that is not in `contract/intent-operations.ts`:
 * PREVIEW.
 *
 * Preview is a READ — it resolves exactly what a write would resolve and writes
 * nothing — so it carries no idempotency key and arrives as query parameters,
 * which is a different shape from the three mutation schemas. It lives here
 * rather than in `contract/` because this change does not own that directory;
 * it is built from the same primitives, so the two surfaces still validate a
 * repo key and a node id identically.
 */
import { z } from 'zod';
import { graphNodeId, repoKey, slugId } from './contract/index.js';

export const PreviewIntentAnchorQuerySchema = z.object({ itemId: slugId(), repoKey, nodeId: graphNodeId }).strict();

export type PreviewIntentAnchorQuery = z.infer<typeof PreviewIntentAnchorQuerySchema>;
