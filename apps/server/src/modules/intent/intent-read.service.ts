/**
 * File-like reads of the intent tree: `tree` lists the nodes, `node` returns
 * one domain or feature as a Markdown document, and `search` finds items with
 * the lexical matcher `get_intent_context` shares (`intent-lexical.ts`).
 *
 * - `tree` is the folder listing: ids, titles and nesting, nothing else.
 * - `node` is the file: the node's layout (headings, prose, item slots)
 *   rendered in order, each slot filled with the current item. With
 *   `refs: false` (the default) source references are stripped and the
 *   reader gets the bare facts; with `refs: true` they stay where the author
 *   put them, and sources not cited inline are appended to their item.
 * - Nothing is silently cut: a bounded answer says TRUNCATED and how to get
 *   the rest.
 */
import { Injectable } from '@nestjs/common';
import { DecisionStatus, IntentKind, type ContextCondition } from '@coredoc/core';
import { IntentItemAuthority, IntentItemKind, IntentNodeKind, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentErrorCode } from './contract/index.js';
import { likePattern } from './intent-context.select.js';
import { IntentLexicalMatch, matchLexically } from './intent-lexical.js';
import { INTENT_NODE_SCAN, unknownNodeError } from './intent-node-suggest.js';
import { readReleaseSnapshot } from './intent-release.service.js';
import type { Effectivity, ReleaseSnapshot } from './intent-release.fold.js';
import { intentStateError } from './intent-state-errors.js';
import { treeConditionsOf } from './intent-tree.service.js';

export const INTENT_READ_LIMITS = {
  /** Items one node read returns before it asks to be narrowed by kind. */
  nodeItems: 400,
  searchDefault: 50,
  searchMax: 200,
  searchTokens: 10,
  /** Nodes listed for a prose match; a search that hits more names the count. */
  proseMatches: 20,
  /** Characters around the first hit in a search line. */
  snippet: 180,
} as const;

/** Where an item without a layout slot is rendered, and how. */
const KIND_SECTIONS: { kind: IntentItemKind; heading: string; style: ItemStyle }[] = [
  { kind: IntentItemKind.capability, heading: 'Capabilities', style: 'bullet' },
  { kind: IntentItemKind.business_rule, heading: 'Rules', style: 'bullet' },
  { kind: IntentItemKind.use_case, heading: 'Use cases', style: 'heading' },
  { kind: IntentItemKind.flow, heading: 'Flows', style: 'heading' },
  { kind: IntentItemKind.decision, heading: 'Decisions', style: 'bullet' },
  { kind: IntentItemKind.limitation, heading: 'Limitations', style: 'bullet' },
];
const OPEN_QUESTIONS = 'Open questions';

const KIND_VALUES = new Set<string>(Object.values(IntentItemKind));

/** The section a node read ends with; everything above it is the node's own document. */
export const INTENT_NODE_FOOTER = '---';

/** `prose` renders an item as plain paragraphs: a node's overview kept as a reviewable capability. */
export type ItemStyle = 'bullet' | 'heading' | 'prose';

type LayoutBlock = { heading: string; level: 2 | 3 } | { lines: string[] } | { item: string; style?: ItemStyle };

export interface IntentReadNodeRequest {
  domain?: string;
  feature?: string;
  kind?: string[];
  includeCandidates?: boolean;
  refs?: boolean;
  /** Continue a truncated node read after this item id (items are paged by id). */
  after?: string;
}

export interface IntentReadSearchRequest {
  query: string;
  domain?: string;
  feature?: string;
  kind?: string[];
  includeCandidates?: boolean;
  refs?: boolean;
  limit?: number;
  /** The last id of the previous page; results are ordered by id. */
  after?: string;
}

export interface IntentDocumentItem {
  id: string;
  kind: IntentItemKind;
  title: string;
  statement: string;
  body: string[];
  authority: IntentItemAuthority;
  version: number;
  effectivity: Effectivity;
  openQuestion: boolean;
  proposedSuccessorOfId: string | null;
  appliesWhen: unknown[];
  /** A candidate proposing to replace this item, shown on this item's block. */
  pendingSuccessor: { id: string; title: string; statement: string; version: number } | null;
}

export type IntentDocumentBlock =
  | { type: 'heading'; text: string }
  | { type: 'prose'; lines: string[] }
  | { type: 'item'; style: ItemStyle; item: IntentDocumentItem };

export interface IntentNodeDocument {
  node: { kind: 'root' | 'domain' | 'feature'; id: string | null; title: string; domainId: string | null };
  sections: { heading: string | null; blocks: IntentDocumentBlock[] }[];
  related: { kind: IntentNodeKind; id: string; title: string; why: string }[];
  features: { id: string; title: string }[];
  delivery: { effective: number; planned: number; unrecorded: number };
  truncated: boolean;
}

interface ItemRow {
  id: string;
  kind: IntentItemKind;
  title: string;
  version: number;
  appliesWhen: Prisma.JsonValue;
  statement: string;
  body: Prisma.JsonValue;
  payload: Prisma.JsonValue;
  authority: IntentItemAuthority;
  proposedSuccessorOfId: string | null;
  supersededById: string | null;
  sources: { ref: string; locator: string | null; title: string | null }[];
}

interface NodeRef {
  kind: IntentNodeKind;
  id: string;
}

@Injectable()
export class IntentReadService {
  constructor(private readonly prisma: PrismaService) {}

  /* --------------------------------------------------------------- tree --- */

  async tree(workspaceId: string): Promise<string> {
    const [domains, features, counts] = await Promise.all([
      this.prisma.intentDomain.findMany({
        where: { workspaceId, archived: false },
        orderBy: { id: 'asc' },
        select: { id: true, title: true },
      }),
      this.prisma.intentFeature.findMany({
        where: { workspaceId, archived: false },
        orderBy: { id: 'asc' },
        select: { id: true, domainId: true, parentFeatureId: true, title: true },
      }),
      this.prisma.intentItem.groupBy({
        by: ['domainId', 'featureId'],
        where: { workspaceId, authority: IntentItemAuthority.accepted },
        _count: { _all: true },
      }),
    ]);

    const itemCount = new Map<string, number>();
    let rootItems = 0;
    let totalItems = 0;
    for (const row of counts) {
      totalItems += row._count._all;
      if (row.featureId) itemCount.set(nodeKey(IntentNodeKind.feature, row.featureId), row._count._all);
      else if (row.domainId) itemCount.set(nodeKey(IntentNodeKind.domain, row.domainId), row._count._all);
      else rootItems = row._count._all;
    }
    const byDomain = new Map<string, typeof features>();
    const byParent = new Map<string, typeof features>();
    const ids = new Set(features.map((feature) => feature.id));
    for (const feature of features) {
      // A sub-feature whose parent is archived (not listed) shows at the top level.
      if (feature.parentFeatureId && ids.has(feature.parentFeatureId))
        byParent.set(feature.parentFeatureId, [...(byParent.get(feature.parentFeatureId) ?? []), feature]);
      else byDomain.set(feature.domainId, [...(byDomain.get(feature.domainId) ?? []), feature]);
    }
    const empty = (kind: IntentNodeKind, id: string) =>
      (itemCount.get(nodeKey(kind, id)) ?? 0) === 0 ? ' (empty)' : '';

    const lines = [
      `# Intent tree: ${domains.length} domains, ${features.length} features, ${totalItems} accepted items`,
      'Open a node with intent_read {action: "node", domain or feature}; search item text with action "search".',
      '',
    ];
    if (rootItems > 0) lines.push(`- (product root): ${rootItems} items; open it with action "node" and no id`);
    const pushFeatures = (list: typeof features, indent: string) => {
      for (const feature of list) {
        lines.push(`${indent}- ${feature.id}: ${feature.title}${empty(IntentNodeKind.feature, feature.id)}`);
        pushFeatures(byParent.get(feature.id) ?? [], `${indent}  `);
      }
    };
    for (const domain of domains) {
      const children = byDomain.get(domain.id) ?? [];
      const allEmpty = features
        .filter((feature) => feature.domainId === domain.id)
        .every((feature) => empty(IntentNodeKind.feature, feature.id));
      lines.push(`- ${domain.id}: ${domain.title}${allEmpty ? empty(IntentNodeKind.domain, domain.id) : ''}`);
      pushFeatures(children, '  ');
    }
    return lines.join('\n');
  }

  /* --------------------------------------------------------------- node --- */

  async node(workspaceId: string, request: IntentReadNodeRequest): Promise<string> {
    const kinds = parseKinds(request.kind);
    const authority = authorities(request.includeCandidates);
    const target = await this.resolveNode(workspaceId, request);
    const refs = request.refs === true;

    const { current, stillInForce, release, more } = await this.loadNodeItems(
      workspaceId,
      target,
      authority,
      kinds,
      request.after,
    );
    const items = current;

    // A continuation page has no layout to fill: its items render in kind order.
    // Items still in force are listed on the first page only, so a continuation does not repeat them.
    const document = renderDocument(target.title, target.layout, items, request.after ? [] : stillInForce, {
      refs,
      filtered: Boolean(kinds) || request.after !== undefined,
      release,
    });
    const lines = [document];
    if (items.length === 0) {
      lines.push('', kinds ? 'No items of the requested kinds are attached here.' : 'No items are attached here.');
    }
    if (more) {
      lines.push(
        '',
        `TRUNCATED: this node holds more items than one read returns (${INTENT_READ_LIMITS.nodeItems}). Continue with after: "${items[items.length - 1]?.id}", or narrow it with a kind filter.`,
      );
    }

    // The footer is navigation and evidence about the document, not part of it.
    const footer: string[] = [];
    footer.push(target.header);
    if (target.kind !== 'root') {
      const related = await this.relatedOf(workspaceId, { kind: target.kind as IntentNodeKind, id: target.id });
      if (related.length > 0) {
        footer.push('', 'Related:');
        for (const relation of related)
          footer.push(`- ${relation.kind} ${relation.id}: ${relation.title}. ${relation.why}`);
      }
    }
    if (target.children.length > 0) {
      footer.push(
        '',
        `${target.kind === 'feature' ? 'Sub-features' : 'Features'}: ${target.children.map((child) => child.id).join(', ')}`,
      );
    }
    footer.push('', deliveryLine(items, release));
    footer.push(...(await this.inheritedNote(workspaceId, target, authority)));
    lines.push('', INTENT_NODE_FOOTER, ...footer);
    return lines.join('\n');
  }

  /* ------------------------------------------------------------- search --- */

  async search(workspaceId: string, request: IntentReadSearchRequest): Promise<string> {
    const tokens = [...new Set(request.query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
    if (tokens.length === 0) {
      throw intentStateError(IntentErrorCode.SchemaViolation, 'search needs at least one word in query', ['query']);
    }
    if (tokens.length > INTENT_READ_LIMITS.searchTokens) {
      throw intentStateError(
        IntentErrorCode.SchemaViolation,
        `search takes at most ${INTENT_READ_LIMITS.searchTokens} words`,
        ['query'],
      );
    }
    const limit = request.limit ?? INTENT_READ_LIMITS.searchDefault;
    if (!Number.isInteger(limit) || limit < 1 || limit > INTENT_READ_LIMITS.searchMax) {
      throw intentStateError(
        IntentErrorCode.InvalidPageLimit,
        `limit must be an integer from 1 to ${INTENT_READ_LIMITS.searchMax}`,
        ['limit'],
      );
    }
    const kinds = parseKinds(request.kind);
    const scope = request.domain || request.feature ? await this.resolveNode(workspaceId, request) : undefined;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`i.workspace_id = ${workspaceId}::uuid`,
      Prisma.sql`i.authority::text IN (${Prisma.join(authorities(request.includeCandidates))})`,
    ];
    if (kinds) conditions.push(Prisma.sql`i.kind::text IN (${Prisma.join(kinds)})`);
    if (scope?.kind === 'feature') conditions.push(Prisma.sql`i.feature_id = ${scope.id}`);
    if (scope?.kind === 'domain') conditions.push(Prisma.sql`i.domain_id = ${scope.id}`);
    const page = request.after ? Prisma.sql`AND i.id > ${request.after}` : Prisma.empty;
    // The matched fields, the item's text first, so a snippet shows content before its title.
    const text = Prisma.sql`concat_ws(' ', i.statement,
      (SELECT string_agg(v #>> '{}', ' ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.body) = 'array' THEN i.body ELSE '[]'::jsonb END) v),
      i.rationale, i.title)`;

    // Whether to fall back to any word is decided on the whole match, not on
    // this page, so every page of an any-word answer stays any-word.
    const {
      rows: [found],
      matched,
    } = await matchLexically(tokens, async (predicate) => {
      const where = Prisma.join([...conditions, predicate], ' AND ');
      const [rows, totals] = await Promise.all([
        this.prisma.$queryRaw<
          { id: string; kind: string; domain_id: string | null; feature_id: string | null; text: string }[]
        >`SELECT i.id, i.kind::text AS kind, i.domain_id, i.feature_id, ${text} AS text FROM intent_items i
          WHERE ${where} ${page} ORDER BY i.id ASC LIMIT ${limit + 1}`,
        this.prisma.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM intent_items i WHERE ${where}`,
      ]);
      const total = Number(totals[0]?.total ?? 0);
      return total > 0 ? [{ rows, total }] : [];
    });
    const { rows, total } = found ?? { rows: [], total: 0 };
    const shown = rows.slice(0, limit);
    const within = scope ? ` in ${scope.kind} ${scope.id}` : '';
    const any = matched === IntentLexicalMatch.Any;

    const lines = [
      `${total} items match ${any ? 'any word' : 'every word'} of "${tokens.join(' ')}"${within}${request.after ? `, after ${request.after}` : ''}${any ? " (matched: 'any': no item matches every word)" : ''}`,
    ];
    for (const row of shown) {
      const node = row.feature_id ? `feature ${row.feature_id}` : row.domain_id ? `domain ${row.domain_id}` : 'root';
      const text = request.refs === true ? row.text : stripRefs(row.text);
      lines.push(`- ${row.id} [${row.kind}] ${node}: ${snippet(text, tokens)}`);
    }
    if (rows.length > limit) {
      const last = shown[shown.length - 1]?.id;
      lines.push(
        `TRUNCATED: more matches follow. Continue with after: "${last}", or narrow with more words, a domain, a feature or a kind.`,
      );
    }
    // Node prose (overviews, "How it works") is not an item, but a reader searches it too.
    // It has no kind, so a kind filter leaves it out, and the page cursor is for items only.
    if (!kinds && !request.after) {
      const prose = await this.searchProse(workspaceId, tokens, scope);
      if (prose.length > 0) {
        lines.push(
          `${prose.length} nodes match in their prose${prose.length > INTENT_READ_LIMITS.proseMatches ? ` (first ${INTENT_READ_LIMITS.proseMatches})` : ''}:`,
        );
        for (const row of prose.slice(0, INTENT_READ_LIMITS.proseMatches)) {
          const text = request.refs === true ? row.text : stripRefs(row.text);
          lines.push(`- ${row.kind} ${row.id}: ${row.title}. ${snippet(text, tokens)}`);
        }
      }
    }
    if (lines.length > 1) lines.push('Open a node with action "node" to read it in context.');
    return lines.join('\n');
  }

  /** Domains and features whose layout prose holds every word. */
  private async searchProse(
    workspaceId: string,
    tokens: string[],
    scope: { kind: 'domain' | 'feature' | 'root'; id: string } | undefined,
  ) {
    if (scope?.kind === 'root') return [];
    const prose = (table: Prisma.Sql) => Prisma.sql`
      (SELECT string_agg(line, ' ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${table}.layout) = 'array' THEN ${table}.layout ELSE '[]'::jsonb END) block,
        jsonb_array_elements_text(CASE WHEN jsonb_typeof(block->'lines') = 'array' THEN block->'lines' ELSE '[]'::jsonb END) line)`;
    const matches = (column: Prisma.Sql) =>
      Prisma.join(
        tokens.map((token) => Prisma.sql`${column} ILIKE ${likePattern(token)}`),
        ' AND ',
      );
    const rows = await this.prisma.$queryRaw<{ kind: string; id: string; title: string; text: string }[]>`
      SELECT kind, id, title, text FROM (
        SELECT 'domain' AS kind, d.id, d.title, ${prose(Prisma.sql`d`)} AS text
          FROM intent_domains d WHERE d.workspace_id = ${workspaceId}::uuid AND d.archived = false
            ${scope?.kind === 'domain' ? Prisma.sql`AND d.id = ${scope.id}` : scope ? Prisma.sql`AND false` : Prisma.empty}
        UNION ALL
        SELECT 'feature' AS kind, f.id, f.title, ${prose(Prisma.sql`f`)} AS text
          FROM intent_features f WHERE f.workspace_id = ${workspaceId}::uuid AND f.archived = false
            ${scope?.kind === 'feature' ? Prisma.sql`AND f.id = ${scope.id}` : scope?.kind === 'domain' ? Prisma.sql`AND f.domain_id = ${scope.id}` : Prisma.empty}
      ) nodes
      WHERE text IS NOT NULL AND ${matches(Prisma.sql`text`)}
      ORDER BY kind, id`;
    return rows;
  }

  /* ----------------------------------------------------------- document --- */

  /** The node read as structure rather than Markdown, for the web document view. */
  async document(
    workspaceId: string,
    request: { domain?: string; feature?: string; includeCandidates?: boolean },
  ): Promise<IntentNodeDocument> {
    const target = await this.resolveNode(workspaceId, request);
    const authority = authorities(request.includeCandidates);
    const { current, stillInForce, release, more } = await this.loadNodeItems(
      workspaceId,
      target,
      authority,
      undefined,
    );
    const items = current;
    const sections = documentSections(target.layout, items, stillInForce, false);

    // A candidate replacing an item on this page rides on that item's block instead of standing alone.
    const shown = new Set(
      sections.flatMap((section) => section.entries.flatMap((entry) => ('item' in entry ? [entry.item.id] : []))),
    );
    const pending = new Map(
      items
        .filter(
          (item) =>
            item.authority === IntentItemAuthority.candidate &&
            item.proposedSuccessorOfId !== null &&
            shown.has(item.proposedSuccessorOfId),
        )
        .map((item) => [item.proposedSuccessorOfId as string, item]),
    );
    const riding = new Set([...pending.values()].map((item) => item.id));

    const toItem = (item: ItemRow): IntentDocumentItem => {
      const successor = pending.get(item.id);
      return {
        id: item.id,
        kind: item.kind,
        title: item.title,
        statement: item.statement,
        body: Array.isArray(item.body) ? (item.body as string[]) : [],
        authority: item.authority,
        version: item.version,
        effectivity: release.effectivity(item.id),
        openQuestion: isOpenQuestion(item),
        proposedSuccessorOfId: item.proposedSuccessorOfId,
        appliesWhen: Array.isArray(item.appliesWhen) ? (item.appliesWhen as unknown[]) : [],
        pendingSuccessor: successor
          ? {
              id: successor.id,
              title: successor.title,
              statement: successor.statement,
              version: successor.version,
            }
          : null,
      };
    };

    const related =
      target.kind === 'root'
        ? []
        : await this.relatedOf(workspaceId, { kind: target.kind as IntentNodeKind, id: target.id });
    const counted = items.filter((item) => !isOpenQuestion(item));
    const effective = counted.filter((item) => release.effectivity(item.id) === 'effective').length;
    const planned = counted.filter((item) => release.effectivity(item.id) === 'planned').length;
    return {
      node: {
        kind: target.kind,
        id: target.kind === 'root' ? null : target.id,
        title: target.title,
        domainId: target.domainId,
      },
      sections: sections
        .map((section) => ({
          heading: section.heading,
          blocks: section.entries
            .filter((entry) => !('item' in entry && riding.has(entry.item.id)))
            .map((entry): IntentDocumentBlock => {
              if ('heading' in entry) return { type: 'heading', text: entry.heading };
              if ('lines' in entry) return { type: 'prose', lines: entry.lines };
              return { type: 'item', style: entry.style, item: toItem(entry.item) };
            }),
        }))
        .filter((section) => section.heading !== null || section.blocks.length > 0),
      related: related.map((relation) => ({
        kind: relation.kind,
        id: relation.id,
        title: relation.title,
        why: relation.why,
      })),
      features: target.children,
      delivery: { effective, planned, unrecorded: counted.length - effective - planned },
      truncated: more,
    };
  }

  /* ------------------------------------------------------------ helpers --- */

  /**
   * The node's current items, one page of {@link INTENT_READ_LIMITS.nodeItems}
   * by id, and the superseded items still in production that keep their slot.
   * The two are read separately so superseded history can never crowd current
   * items out of the page unnoticed.
   */
  private async loadNodeItems(
    workspaceId: string,
    target: { kind: 'feature' | 'domain' | 'root'; id: string },
    authority: IntentItemAuthority[],
    kinds: IntentItemKind[] | undefined,
    after?: string,
  ) {
    const attachment =
      target.kind === 'feature'
        ? { featureId: target.id }
        : target.kind === 'domain'
          ? { domainId: target.id, featureId: null }
          : { domainId: null, featureId: null };
    const select = {
      id: true,
      kind: true,
      title: true,
      version: true,
      appliesWhen: true,
      statement: true,
      body: true,
      payload: true,
      authority: true,
      proposedSuccessorOfId: true,
      supersededById: true,
      sources: { select: { ref: true, locator: true, title: true }, orderBy: { id: 'asc' } },
    } as const;
    const base = { workspaceId, ...attachment, ...(kinds ? { kind: { in: kinds } } : {}) };
    const [rows, superseded, release] = await Promise.all([
      this.prisma.intentItem.findMany({
        where: { ...base, authority: { in: authority }, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: INTENT_READ_LIMITS.nodeItems + 1,
        select,
      }),
      // A replaced item keeps its slot while it is still in production.
      this.prisma.intentItem.findMany({
        where: { ...base, authority: IntentItemAuthority.superseded },
        orderBy: { id: 'asc' },
        take: INTENT_READ_LIMITS.nodeItems,
        select,
      }),
      readReleaseSnapshot(this.prisma, workspaceId),
    ]);
    const current = (rows as ItemRow[]).slice(0, INTENT_READ_LIMITS.nodeItems);
    const stillInForce = (superseded as ItemRow[]).filter((row) => release.effectivity(row.id) === 'effective');
    return { current, stillInForce, release, more: rows.length > INTENT_READ_LIMITS.nodeItems };
  }

  private async resolveNode(workspaceId: string, request: { domain?: string; feature?: string }) {
    if (request.feature) {
      const feature = await this.prisma.intentFeature.findUnique({
        where: { workspaceId_id: { workspaceId, id: request.feature } },
        include: {
          domain: { select: { id: true, title: true } },
          parent: { select: { id: true, title: true } },
          children: { where: { archived: false }, orderBy: { id: 'asc' }, select: { id: true, title: true } },
        },
      });
      if (!feature) {
        throw unknownNodeError('feature', request.feature, await this.featureCandidates(workspaceId), ['feature']);
      }
      if (request.domain && request.domain !== feature.domainId) {
        throw intentStateError(
          IntentErrorCode.FeatureNotFound,
          `intent feature '${feature.id}' is in domain '${feature.domainId}', not '${request.domain}'`,
          ['feature'],
        );
      }
      return {
        kind: 'feature' as const,
        id: feature.id,
        title: feature.title,
        layout: layoutOf(feature.layout, feature.statement),
        header: `Feature ${feature.id} in domain ${feature.domain.id} (${feature.domain.title})${feature.parent ? `, under feature ${feature.parent.id} (${feature.parent.title})` : ''}${conditionsLine(feature.appliesWhen)}.`,
        domainId: feature.domainId,
        children: feature.children,
      };
    }
    if (request.domain) {
      const domain = await this.prisma.intentDomain.findUnique({
        where: { workspaceId_id: { workspaceId, id: request.domain } },
        include: {
          features: {
            // Top-level features, plus sub-features whose parent is archived (as the tree read shows them).
            where: { archived: false, OR: [{ parentFeatureId: null }, { parent: { archived: true } }] },
            orderBy: { id: 'asc' },
            select: { id: true, title: true },
          },
        },
      });
      if (!domain) {
        throw unknownNodeError('domain', request.domain, await this.domainCandidates(workspaceId), ['domain']);
      }
      return {
        kind: 'domain' as const,
        id: domain.id,
        title: domain.title,
        layout: layoutOf(domain.layout, domain.statement),
        header: `Domain ${domain.id}${conditionsLine(domain.appliesWhen)}.`,
        domainId: domain.id,
        children: domain.features,
      };
    }
    return {
      kind: 'root' as const,
      id: '',
      title: 'Product root',
      layout: [] as LayoutBlock[],
      header: 'Items attached to the product as a whole, outside any domain.',
      domainId: null,
      children: [] as { id: string; title: string }[],
    };
  }

  private domainCandidates(workspaceId: string) {
    return this.prisma.intentDomain.findMany({
      where: { workspaceId, archived: false },
      select: { id: true, title: true },
      take: INTENT_NODE_SCAN,
    });
  }

  private featureCandidates(workspaceId: string) {
    return this.prisma.intentFeature.findMany({
      where: { workspaceId, archived: false },
      select: { id: true, title: true },
      take: INTENT_NODE_SCAN,
    });
  }

  private async relatedOf(workspaceId: string, node: NodeRef) {
    const rows = await this.prisma.intentNodeRelation.findMany({
      where: {
        workspaceId,
        OR: [
          { fromKind: node.kind, fromId: node.id },
          { toKind: node.kind, toId: node.id },
        ],
      },
      orderBy: { id: 'asc' },
    });
    const others = rows.map((row) =>
      row.fromKind === node.kind && row.fromId === node.id
        ? { kind: row.toKind, id: row.toId, why: row.why }
        : { kind: row.fromKind, id: row.fromId, why: row.why },
    );
    const [domains, features] = await Promise.all([
      this.prisma.intentDomain.findMany({
        where: { workspaceId, id: { in: others.filter((o) => o.kind === IntentNodeKind.domain).map((o) => o.id) } },
        select: { id: true, title: true },
      }),
      this.prisma.intentFeature.findMany({
        where: { workspaceId, id: { in: others.filter((o) => o.kind === IntentNodeKind.feature).map((o) => o.id) } },
        select: { id: true, title: true },
      }),
    ]);
    const titles = new Map<string, string>([
      ...domains.map((d) => [nodeKey(IntentNodeKind.domain, d.id), d.title] as const),
      ...features.map((f) => [nodeKey(IntentNodeKind.feature, f.id), f.title] as const),
    ]);
    return others.map((other) => ({ ...other, title: titles.get(nodeKey(other.kind, other.id)) ?? other.id }));
  }

  /** What else applies to a reader of this node, so a feature read never hides its domain's rules. */
  private async inheritedNote(
    workspaceId: string,
    target: { kind: 'feature' | 'domain' | 'root'; id: string; domainId: string | null },
    authority: IntentItemAuthority[],
  ): Promise<string[]> {
    if (target.kind === 'root') return [];
    const [domainItems, rootItems] = await Promise.all([
      target.kind === 'feature' && target.domainId
        ? this.prisma.intentItem.count({
            where: { workspaceId, domainId: target.domainId, featureId: null, authority: { in: authority } },
          })
        : Promise.resolve(0),
      this.prisma.intentItem.count({
        where: { workspaceId, domainId: null, featureId: null, authority: { in: authority } },
      }),
    ]);
    const notes: string[] = [];
    if (domainItems > 0)
      notes.push(`${domainItems} items on domain ${target.domainId} also apply here (read that domain).`);
    if (rootItems > 0) notes.push(`${rootItems} items on the product root also apply here (read the node with no id).`);
    return notes.length > 0 ? [`Also applies: ${notes.join(' ')}`] : [];
  }
}

/* ------------------------------------------------------------ rendering --- */

function nodeKey(kind: IntentNodeKind | string, id: string): string {
  return `${kind}:${id}`;
}

function parseKinds(kind: string[] | undefined): IntentItemKind[] | undefined {
  if (!kind || kind.length === 0) return undefined;
  for (const value of kind) {
    if (!KIND_VALUES.has(value)) {
      throw intentStateError(
        IntentErrorCode.UnknownKind,
        `unknown kind '${value}'; kinds are ${Object.values(IntentKind).join(', ')}`,
        ['kind'],
      );
    }
  }
  return kind as IntentItemKind[];
}

function authorities(includeCandidates: boolean | undefined): IntentItemAuthority[] {
  return includeCandidates
    ? [IntentItemAuthority.accepted, IntentItemAuthority.candidate]
    : [IntentItemAuthority.accepted];
}

/** The stored layout, or — for a node written without one — its statement as the opening paragraph. */
function layoutOf(value: Prisma.JsonValue, statement: string): LayoutBlock[] {
  if (Array.isArray(value) && value.length > 0) return value as unknown as LayoutBlock[];
  return statement ? [{ lines: [statement] }] : [];
}

function conditionsLine(value: Prisma.JsonValue): string {
  const conditions = treeConditionsOf(value);
  return conditions && conditions.length > 0 ? `; applies when ${renderConditions(conditions)}` : '';
}

function renderConditions(conditions: readonly ContextCondition[]): string {
  return conditions
    .map((clause) => {
      if ('text' in clause) return clause.text;
      if ('item' in clause) return `item ${clause.item} applies`;
      if ('in' in clause) return `${clause.dimension} in ${clause.in.join('|')}`;
      return `${clause.dimension} not in ${clause.notIn.join('|')}`;
    })
    .join(' and ');
}

function isOpenQuestion(item: ItemRow): boolean {
  return (
    item.kind === IntentItemKind.decision &&
    (item.payload as { choiceStatus?: string } | null)?.choiceStatus === DecisionStatus.Open
  );
}

/** A source ref as written inline: `jira:PROD-1 AC2`. */
function refText(source: { ref: string; locator: string | null }): string {
  return source.locator ? `${source.ref} ${source.locator}` : source.ref;
}

const SOURCE_REF = /^[a-z][a-z0-9-]*:\S/;
/** A URL looks like a ref (`https:…`) but is content, so it is never stripped. */
const URL_SCHEME = /^(?:https?|ftp|mailto|file|data|javascript):/i;

/**
 * Remove every parenthesised group made only of source refs, with its italic
 * stars: `*(jira:PROD-1; code:a/b.ts)*` and the `(jira:PROD-1)` inside
 * `*Status: planned (jira:PROD-1).*`. A group with any other text in it, such
 * as `(br-refund-window)` or `(Android up to 5 times)`, stays.
 */
export function stripRefs(text: string): string {
  // Code and diagram fences pass through untouched.
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part) => (part.startsWith('```') ? part : stripRefsOutsideCode(part)))
    .join('');
}

function stripRefsOutsideCode(text: string): string {
  return text
    .replace(/\s*\*?\(([^()]*)\)\*?/g, (match: string, inner: string, offset: number, whole: string) => {
      // `[label](target)` is a link, never a citation.
      if (whole[offset - 1] === ']') return match;
      // Each `;` part is one citation: a ref, then optional locators or a date after it.
      const parts = inner.split(/;\s*/).map((part) => part.trim());
      if (!parts.every((part) => SOURCE_REF.test(part) && !URL_SCHEME.test(part))) return match;
      // `*(refs)*` goes whole; a trailing star that closes an outer italic stays.
      const opensItalic = match.trimStart().startsWith('*');
      return !opensItalic && match.endsWith('*') ? '*' : '';
    })
    .replace(/[ \t]+([.,;:])/g, '$1')
    .replace(/[ \t]+$/gm, '');
}

const DELIVERY_LABELS: Record<Exclude<Effectivity, 'effective'>, string> = {
  planned: 'planned',
  withdrawn: 'plan withdrawn',
  not_effective: 'not in production',
  unknown: 'no delivery record',
};

const PAYLOAD_LINE_LIMIT = 400;

/**
 * What an item carries beyond its text: conditions, delivery when it is not in
 * production, the payload when no body already spells it out, and source titles
 * when refs are asked for. "No delivery record" is only said in a workspace that
 * records deliveries at all; elsewhere it would be on every line.
 */
function itemDetails(item: ItemRow, options: RenderOptions): string[] {
  const details: string[] = [];
  if (item.authority === IntentItemAuthority.superseded && item.supersededById) {
    details.push(`Replaced by ${item.supersededById}; still in production until that ships.`);
  }
  const conditions = Array.isArray(item.appliesWhen) ? (item.appliesWhen as unknown as ContextCondition[]) : [];
  if (conditions.length > 0) details.push(`Applies when ${renderConditions(conditions)}.`);
  const state = options.release.effectivity(item.id);
  if (state !== 'effective' && !isOpenQuestion(item) && (state !== 'unknown' || options.release.currentRelease)) {
    details.push(`Delivery: ${DELIVERY_LABELS[state]}.`);
  }
  const body = Array.isArray(item.body) ? item.body : [];
  // An open question's payload restates its statement, so it adds nothing.
  if (
    body.length === 0 &&
    !isOpenQuestion(item) &&
    item.payload &&
    typeof item.payload === 'object' &&
    Object.keys(item.payload).length > 0
  ) {
    const payload = JSON.stringify(item.payload);
    details.push(
      `Payload: ${payload.length > PAYLOAD_LINE_LIMIT ? `${payload.slice(0, PAYLOAD_LINE_LIMIT)}…` : payload}`,
    );
  }
  if (options.refs && item.sources.some((source) => source.title)) {
    details.push(
      `Sources: ${item.sources.map((source) => (source.title ? `${source.title} (${refText(source)})` : refText(source))).join('; ')}.`,
    );
  }
  return details;
}

function renderItem(item: ItemRow, style: ItemStyle, options: RenderOptions): string[] {
  const { refs } = options;
  const body = Array.isArray(item.body) ? (item.body as string[]) : [];
  let statement = item.statement;
  if (refs) {
    // Sources the author did not cite inline still belong to the item.
    const written = [statement, ...body].join(' ');
    const missing = item.sources.map(refText).filter((ref) => !written.includes(ref.split(' ')[0] as string));
    if (missing.length > 0) statement = `${statement} *(${missing.join('; ')})*`;
  }
  const clean = (line: string) => (refs ? line : stripRefs(line));
  // The body is stripped whole, so a code or diagram fence spanning lines stays intact.
  const lines = [
    ...(refs || body.length === 0 ? body : stripRefs(body.join('\n')).split('\n')),
    ...itemDetails(item, options),
  ];
  if (style === 'heading') return [`### ${item.id}`, clean(statement), ...lines];
  // A prose slot reads as running text, but the reader still needs the id to cite or open it.
  if (style === 'prose') return [`${clean(statement)} [${item.id}]`, ...lines];
  return [`- **${item.id}** — ${clean(statement)}`, ...lines.map((line) => (line ? `  ${line}` : ''))];
}

type DocEntry = { heading: string } | { lines: string[] } | { item: ItemRow; style: ItemStyle };

interface DocSection {
  heading: string | null;
  entries: DocEntry[];
}

/**
 * The node's document: layout blocks in order, each item slot filled with the
 * current item. A slot whose item was replaced shows that item while it is
 * still in production, and its successor once the old one is not. Items
 * without a slot are appended under their kind's section; with a kind filter
 * the layout is skipped and items render in kind order.
 */
function documentSections(
  layout: LayoutBlock[],
  items: ItemRow[],
  stillInForce: ItemRow[],
  filtered: boolean,
): DocSection[] {
  const byId = new Map([...stillInForce, ...items].map((item) => [item.id, item]));
  const successorOf = new Map(
    items.filter((item) => item.proposedSuccessorOfId).map((item) => [item.proposedSuccessorOfId as string, item]),
  );
  const rendered = new Set<string>();
  const sections: DocSection[] = [{ heading: null, entries: [] }];
  const current = () => sections[sections.length - 1] as DocSection;

  for (const block of filtered ? [] : layout) {
    if ('heading' in block) {
      if (block.level === 2) sections.push({ heading: block.heading, entries: [] });
      else current().entries.push({ heading: block.heading });
    } else if ('lines' in block) {
      current().entries.push({ lines: block.lines });
    } else {
      const item = byId.get(block.item) ?? successorOf.get(block.item);
      if (!item || rendered.has(item.id)) continue;
      rendered.add(item.id);
      current().entries.push({ item, style: block.style ?? 'bullet' });
    }
  }

  // Items with no slot: appended to their section, or to a new one at the end.
  const sectionFor = (heading: string) => {
    let section = sections.find((candidate) => candidate.heading === heading);
    if (!section) {
      section = { heading, entries: [] };
      sections.push(section);
    }
    return section;
  };
  // A replaced item still in production is shown even without a slot (a kind filter, a node
  // without layout): it is what is live, and its planned successor alone would misstate that.
  const unplaced = [...items, ...stillInForce]
    .filter((item) => !rendered.has(item.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const { kind, heading, style } of KIND_SECTIONS) {
    for (const item of unplaced.filter((candidate) => candidate.kind === kind && !isOpenQuestion(candidate)))
      sectionFor(heading).entries.push({ item, style });
  }
  for (const item of unplaced.filter(isOpenQuestion))
    sectionFor(OPEN_QUESTIONS).entries.push({ item, style: 'bullet' });
  return sections;
}

interface RenderOptions {
  refs: boolean;
  /** A kind filter or a continuation page: the layout is skipped, items render in kind order. */
  filtered: boolean;
  release: ReleaseSnapshot;
}

function renderDocument(
  title: string,
  layout: LayoutBlock[],
  items: ItemRow[],
  stillInForce: ItemRow[],
  options: RenderOptions,
): string {
  const { refs, filtered } = options;
  const out = [`# ${title}`];
  for (const section of documentSections(layout, items, stillInForce, filtered)) {
    const lines: string[] = [];
    const push = (chunk: string[], separate: boolean) => {
      if (separate && lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(...chunk);
    };
    for (const entry of section.entries) {
      if ('heading' in entry) push([`### ${entry.heading}`], true);
      else if ('lines' in entry) push(refs ? entry.lines : stripRefs(entry.lines.join('\n')).split('\n'), true);
      else push(renderItem(entry.item, entry.style, options), entry.style !== 'bullet');
    }
    if (section.heading === null && lines.length === 0) continue;
    if (section.heading !== null) out.push('', `## ${section.heading}`);
    if (lines.length > 0) out.push(...(section.heading === null ? [''] : []), ...lines);
  }
  return out.join('\n');
}

function deliveryLine(items: ItemRow[], release: ReleaseSnapshot): string {
  const planned: string[] = [];
  let effective = 0;
  let unknown = 0;
  for (const item of items) {
    if (isOpenQuestion(item)) continue;
    const state = release.effectivity(item.id);
    if (state === 'effective') effective += 1;
    else if (state === 'planned') planned.push(item.id);
    else unknown += 1;
  }
  const parts = [`${effective} in production`];
  if (planned.length > 0) parts.push(`${planned.length} planned (${planned.join(', ')})`);
  if (unknown > 0) parts.push(`${unknown} with no delivery record`);
  return `Delivery: ${parts.join(', ')}.`;
}

function snippet(text: string, tokens: string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const hits = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
  const at = hits.length > 0 ? Math.min(...hits) : 0;
  const half = Math.floor(INTENT_READ_LIMITS.snippet / 2);
  const start = Math.max(0, at - half);
  const piece = flat.slice(start, start + INTENT_READ_LIMITS.snippet);
  return `${start > 0 ? '…' : ''}${piece}${start + INTENT_READ_LIMITS.snippet < flat.length ? '…' : ''}`;
}
