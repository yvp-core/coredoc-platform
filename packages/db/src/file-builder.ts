import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import type { WriteStream } from 'node:fs';
import type { EmbeddingsOutput, ParsedRepo, SummaryOutput } from '@coredoc/core/types';
import type { GraphEdge, GraphNode } from '@coredoc/core';
import { LadybugDriver } from './ladybug/driver.js';
import { LadybugRepository } from './ladybug/repository.js';
import {
  LADYBUG_CREATE_FTS_INDEX_STATEMENT,
  LADYBUG_EDGE_TYPES,
  LADYBUG_NODE_TABLE,
  LADYBUG_UNRESOLVED_CALL_TABLE,
  ladybugUnresolvedCallId,
} from './ladybug/schema.js';
import { stripEmbeddingInputText, stripSourceCode } from './strip-source.js';
import { transformParsedRepo, type TransformResult } from './transformer.js';
import type { IGraphRepository, UnresolvedCallRecord } from './types.js';

export interface VerifiedGraphBuildComponent {
  parsedRepo: ParsedRepo;
  summaryOutput?: SummaryOutput | null;
  embeddingsOutput?: EmbeddingsOutput | null;
}

export type GraphBuildSourcePolicy = 'strip' | 'preserve';

export interface VerifiedGraphBuildInput {
  outputPath: string;
  workDir: string;
  components: AsyncIterable<VerifiedGraphBuildComponent>;
  signal?: AbortSignal;
  /**
   * Cloud artifacts strip source by default even when source-in-graph is
   * enabled. Local project files may explicitly preserve their input; the
   * transformer still applies the local ALLOW_SOURCES_IN_GRAPH capability.
   */
  sourcePolicy?: GraphBuildSourcePolicy;
  /**
   * Inspection point for the exact transformed component this builder is about
   * to write — counting, structural validation, source-policy assertions.
   * Throwing rejects the build before any node of that component is written.
   *
   * It exists so a caller that needs the transformed form does not have to
   * transform a second, independently derived copy: the object it inspects is
   * the object that lands in the file. Source policy stays owned by this
   * builder — the hook observes the selected policy and cannot supply its own.
   */
  onComponentTransformed?: (transformed: TransformResult) => void;
  beforeFinalize?: (repository: GraphBuildResolverRepository, signal?: AbortSignal) => Promise<void>;
}

export type GraphBuildResolverRepository = Pick<
  IGraphRepository,
  | 'listAllRepositories'
  | 'listEntrypoints'
  | 'getExternalCalls'
  | 'getMonikeredFunctions'
  | 'getInternalCallEdges'
  | 'getPackages'
  | 'getPackageLinkerFacts'
  | 'deleteEdgesByType'
  | 'pushEdges'
  | 'updateResolvedTargetIds'
  | 'clearResolvedTargetIds'
>;

export const GRAPH_BUILD_QUERY_TIMEOUT_MS = 30_000;

export interface GraphFileBuildResult {
  artifactPath: string;
  fileSizeBytes: number;
  nodeCount: number;
  edgeCount: number;
  droppedDanglingEdgeCount: number;
  deduplicatedEdgeCount: number;
}

interface StagedEdges {
  path: string;
  componentIndex: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (!stream.write(line)) await once(stream, 'drain');
}

async function writeLines(path: string, lines: Iterable<string>, signal?: AbortSignal): Promise<void> {
  const stream = createWriteStream(path, { encoding: 'utf8', flags: 'wx' });
  try {
    for (const line of lines) {
      throwIfAborted(signal);
      await writeLine(stream, `${line}\n`);
    }
    stream.end();
    await finished(stream);
    throwIfAborted(signal);
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite numeric CSV value: ${value}`);
    return String(value);
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const LADYBUG_COPY_CSV_OPTIONS = `HEADER=true, PARALLEL=false, AUTO_DETECT=false, DELIM=',', QUOTE='"', ESCAPE='"'`;

function assertPortableNodeText(node: GraphNode): void {
  for (const [column, value] of [
    ['id', node.id],
    ['type', node.type],
    ['name', node.name],
    ['summary', node.summary],
    ['repoId', node.repoId],
    ['filePath', node.filePath],
  ] as const) {
    if (typeof value === 'string' && value.includes('\0')) {
      throw new Error(`NUL byte in graph node ${node.id} column ${column}`);
    }
  }
}

function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

function* ladybugNodeRows(nodes: readonly GraphNode[]): Generator<string> {
  yield 'id,type,name,properties,summary,embedding,repoId,filePath,startLine,endLine';
  for (const node of nodes) {
    yield csvRow([
      node.id,
      node.type,
      node.name,
      node.properties ?? {},
      node.summary,
      node.embedding,
      node.repoId,
      node.filePath,
      node.startLine,
      node.endLine,
    ]);
  }
}

function* ladybugEdgeRows(edges: readonly GraphEdge[]): Generator<string> {
  yield 'FROM,TO,id,confidence,createdBy,properties';
  for (const edge of edges) {
    yield csvRow([edge.sourceId, edge.targetId, edge.id, edge.confidence, edge.createdBy, edge.properties ?? {}]);
  }
}

function* ladybugUnresolvedCallRows(repoId: string, records: readonly UnresolvedCallRecord[]): Generator<string> {
  yield 'id,repoId,callerId,calleeExpression,calleeNameTail,filePath,line';
  for (const [index, record] of records.entries()) {
    yield csvRow([
      ladybugUnresolvedCallId(repoId, index),
      repoId,
      record.callerId,
      record.calleeExpression,
      record.calleeNameTail,
      record.filePath,
      record.line,
    ]);
  }
}

function queryString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function graphEdgeKey(edge: GraphEdge): string {
  return JSON.stringify([edge.sourceId, edge.targetId, edge.type]);
}

function integerCount(value: unknown, label: string): number {
  const count = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid ${label}: ${String(value)}`);
  return count;
}

function assertExpectedCounts(
  actualNodes: number,
  actualEdges: number,
  expectedNodes: number,
  expectedEdges: number,
): void {
  if (actualNodes !== expectedNodes || actualEdges !== expectedEdges) {
    throw new Error(
      `Built graph count mismatch: expected ${expectedNodes} nodes/${expectedEdges} edges, got ${actualNodes} nodes/${actualEdges} edges`,
    );
  }
  if (actualNodes === 0) throw new Error('Built graph must contain at least one node');
}

function assertRepositoryCount(actual: number, expectedIds: string[]): void {
  const expected = new Set(expectedIds).size;
  if (actual !== expected) throw new Error(`Built graph has ${actual} repository nodes; expected ${expected}`);
}

function resolverFacade(repository: IGraphRepository): GraphBuildResolverRepository {
  return Object.freeze({
    listAllRepositories: repository.listAllRepositories.bind(repository),
    listEntrypoints: repository.listEntrypoints.bind(repository),
    getExternalCalls: repository.getExternalCalls.bind(repository),
    getMonikeredFunctions: repository.getMonikeredFunctions.bind(repository),
    getInternalCallEdges: repository.getInternalCallEdges?.bind(repository),
    getPackages: repository.getPackages.bind(repository),
    getPackageLinkerFacts: repository.getPackageLinkerFacts.bind(repository),
    deleteEdgesByType: repository.deleteEdgesByType.bind(repository),
    pushEdges: repository.pushEdges.bind(repository),
    updateResolvedTargetIds: repository.updateResolvedTargetIds.bind(repository),
    clearResolvedTargetIds: repository.clearResolvedTargetIds.bind(repository),
  });
}

class LadybugFileWriter {
  private readonly driver: LadybugDriver;
  private readonly repository: LadybugRepository;

  constructor(
    path: string,
    private readonly stagingDir: string,
  ) {
    this.driver = new LadybugDriver(path, {
      readOnly: false,
      ftsMode: 'load',
      initializeSchema: true,
      budgets: { queryTimeoutMs: GRAPH_BUILD_QUERY_TIMEOUT_MS },
    });
    this.repository = new LadybugRepository(this.driver);
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.driver.initialize();
    throwIfAborted(signal);
  }

  async writeNodes(nodes: GraphNode[], componentIndex: number, signal?: AbortSignal): Promise<void> {
    if (nodes.length === 0) return;
    const path = join(this.stagingDir, `nodes-${componentIndex}.csv`);
    await writeLines(path, ladybugNodeRows(nodes), signal);
    try {
      throwIfAborted(signal);
      await this.driver.withWriteTransaction(async (tx) => {
        await tx.run(`COPY ${LADYBUG_NODE_TABLE} FROM ${queryString(path)} (${LADYBUG_COPY_CSV_OPTIONS})`);
        throwIfAborted(signal);
        // Ladybug 0.19 maps both unquoted nulls and RFC4180 quoted empty
        // fields to null. Restore only fields that were explicitly empty;
        // absent values remain null.
        for (const [column, ids] of [
          // `name` included: an index route ({ path: '' }) legitimately yields
          // name:'', and a NULL name fails the server's structural scan and
          // canary probe — rejecting the whole snapshot over a restore list.
          ['name', nodes.filter((node) => node.name === '').map((node) => node.id)],
          ['summary', nodes.filter((node) => node.summary === '').map((node) => node.id)],
          ['repoId', nodes.filter((node) => node.repoId === '').map((node) => node.id)],
          ['filePath', nodes.filter((node) => node.filePath === '').map((node) => node.id)],
        ] as const) {
          throwIfAborted(signal);
          if (ids.length > 0) {
            await tx.run(`MATCH (n:${LADYBUG_NODE_TABLE}) WHERE list_contains($ids, n.id) SET n.${column} = ''`, {
              ids,
            });
            throwIfAborted(signal);
          }
        }
      });
      throwIfAborted(signal);
    } finally {
      rmSync(path, { force: true });
    }
  }

  async writeEdges(edges: GraphEdge[], componentIndex: number, signal?: AbortSignal): Promise<void> {
    if (edges.length === 0) return;
    const byType = new Map(LADYBUG_EDGE_TYPES.map((type) => [type, [] as GraphEdge[]]));
    for (const edge of edges) byType.get(edge.type)?.push(edge);
    for (const type of LADYBUG_EDGE_TYPES) {
      const matching = byType.get(type) as GraphEdge[];
      if (matching.length === 0) continue;
      const path = join(this.stagingDir, `edges-${componentIndex}-${type}.csv`);
      await writeLines(path, ladybugEdgeRows(matching), signal);
      try {
        throwIfAborted(signal);
        await this.driver.withWriteTransaction((tx) =>
          tx.run(`COPY ${type} FROM ${queryString(path)} (${LADYBUG_COPY_CSV_OPTIONS})`),
        );
        throwIfAborted(signal);
      } finally {
        rmSync(path, { force: true });
      }
    }
  }

  async writeUnresolvedCalls(
    repoId: string,
    records: readonly UnresolvedCallRecord[],
    componentIndex: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (records.length === 0) return;
    const path = join(this.stagingDir, `unresolved-calls-${componentIndex}.csv`);
    await writeLines(path, ladybugUnresolvedCallRows(repoId, records), signal);
    try {
      throwIfAborted(signal);
      await this.driver.withWriteTransaction((tx) =>
        tx.run(`COPY ${LADYBUG_UNRESOLVED_CALL_TABLE} FROM ${queryString(path)} (${LADYBUG_COPY_CSV_OPTIONS})`),
      );
      throwIfAborted(signal);
    } finally {
      rmSync(path, { force: true });
    }
  }

  async finalize(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.driver.withReadTransaction((tx) => tx.run(LADYBUG_CREATE_FTS_INDEX_STATEMENT));
    throwIfAborted(signal);
    await this.driver.checkpoint();
    throwIfAborted(signal);
  }

  async inspect(repoIds: string[], signal?: AbortSignal): Promise<{ nodeCount: number; edgeCount: number }> {
    throwIfAborted(signal);
    const actualNodes = await this.driver.withReadTransaction(async (tx) => {
      const rows = await tx.run<{ count: number | bigint }>('MATCH (n:GraphNode) RETURN count(*) AS count');
      return integerCount(rows[0]?.count, 'Ladybug node count');
    });
    throwIfAborted(signal);
    const actualEdges = await this.driver.withReadTransaction(async (tx) => {
      let count = 0;
      for (const type of LADYBUG_EDGE_TYPES) {
        throwIfAborted(signal);
        const rows = await tx.run<{ count: number | bigint }>(
          `MATCH (:GraphNode)-[:${type}]->(:GraphNode) RETURN count(*) AS count`,
        );
        count += integerCount(rows[0]?.count, `Ladybug ${type} edge count`);
      }
      return count;
    });
    throwIfAborted(signal);
    const repositories = await this.repository.getRepositoryNames(repoIds);
    assertRepositoryCount(repositories.length, repoIds);
    throwIfAborted(signal);
    return { nodeCount: actualNodes, edgeCount: actualEdges };
  }

  resolverRepository(): GraphBuildResolverRepository {
    return resolverFacade(this.repository);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

async function stageEdges(path: string, edges: GraphEdge[], signal?: AbortSignal): Promise<void> {
  await writeLines(
    path,
    edges.map((edge) => JSON.stringify(edge)),
    signal,
  );
}

async function filteredEdges(
  staged: StagedEdges,
  nodeIds: ReadonlySet<string>,
  uniqueEdges: Set<string>,
  edgeIdentitiesById: Map<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ edges: GraphEdge[]; dangling: number; duplicates: number }> {
  const input = createReadStream(staged.path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const edges: GraphEdge[] = [];
  let dangling = 0;
  let duplicates = 0;
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      if (line.length === 0) continue;
      const edge = JSON.parse(line) as GraphEdge;
      if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) {
        dangling += 1;
        continue;
      }
      const key = graphEdgeKey(edge);
      const existingIdentity = edgeIdentitiesById.get(edge.id);
      if (existingIdentity !== undefined && existingIdentity !== key) {
        throw new Error(`Duplicate graph edge id ${edge.id} maps to multiple identities`);
      }
      if (uniqueEdges.has(key)) {
        duplicates += 1;
        continue;
      }
      uniqueEdges.add(key);
      edgeIdentitiesById.set(edge.id, key);
      edges.push(edge);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { edges, dangling, duplicates };
}

function ensureFreshOutput(outputPath: string): void {
  if (existsSync(outputPath)) throw new Error(`Output file already exists: ${outputPath}`);
  mkdirSync(dirname(outputPath), { recursive: true });
}

function assertSingleFile(outputPath: string): number {
  if (!existsSync(outputPath) || !statSync(outputPath).isFile()) {
    throw new Error(`Built graph file is missing: ${outputPath}`);
  }
  const size = statSync(outputPath).size;
  if (size <= 0) throw new Error(`Built graph file is empty: ${outputPath}`);
  const base = basename(outputPath);
  const siblings = readdirSync(dirname(outputPath)).filter((entry) => entry !== base && entry.startsWith(base));
  if (siblings.length > 0) throw new Error(`Built graph has unexpected companion files: ${siblings.join(', ')}`);
  return size;
}

export async function buildGraphFile(input: VerifiedGraphBuildInput): Promise<GraphFileBuildResult> {
  ensureFreshOutput(input.outputPath);
  const temporaryOutputPath = join(dirname(input.outputPath), `.${basename(input.outputPath)}.build-${randomUUID()}`);
  mkdirSync(input.workDir, { recursive: true });
  const stagingDir = mkdtempSync(join(input.workDir, 'build-'));
  const writer = new LadybugFileWriter(temporaryOutputPath, stagingDir);
  const stagedEdges: StagedEdges[] = [];
  const nodeIds = new Set<string>();
  const repoIds: string[] = [];
  let nodeCount = 0;
  let edgeCount = 0;
  let droppedDanglingEdgeCount = 0;
  let deduplicatedEdgeCount = 0;
  let succeeded = false;
  let primaryError: unknown;
  let result: GraphFileBuildResult | undefined;

  try {
    throwIfAborted(input.signal);
    await writer.initialize(input.signal);
    let componentIndex = 0;
    for await (const component of input.components) {
      throwIfAborted(input.signal);
      const parsed =
        input.sourcePolicy === 'preserve' ? component.parsedRepo : stripSourceCode(component.parsedRepo).parsed;
      const embeddings = component.embeddingsOutput
        ? stripEmbeddingInputText(component.embeddingsOutput).embeddings
        : null;
      const transformed = transformParsedRepo(parsed, component.summaryOutput ?? null, embeddings);
      input.onComponentTransformed?.(transformed);
      for (const node of transformed.nodes) {
        assertPortableNodeText(node);
        if (nodeIds.has(node.id)) throw new Error(`Duplicate graph node id: ${node.id}`);
        nodeIds.add(node.id);
      }
      repoIds.push(transformed.repositoryId);
      await writer.writeNodes(transformed.nodes, componentIndex, input.signal);
      nodeCount += transformed.nodes.length;
      // Unresolved calls reference the caller by id only — no endpoint to
      // dangle — so they need none of the edge staging/dedup machinery.
      await writer.writeUnresolvedCalls(
        transformed.repositoryId,
        transformed.unresolvedCalls,
        componentIndex,
        input.signal,
      );
      const edgePath = join(stagingDir, `raw-edges-${componentIndex}.jsonl`);
      await stageEdges(edgePath, transformed.edges, input.signal);
      stagedEdges.push({ path: edgePath, componentIndex });
      componentIndex += 1;
    }
    throwIfAborted(input.signal);

    const uniqueEdges = new Set<string>();
    const edgeIdentitiesById = new Map<string, string>();
    for (const staged of stagedEdges) {
      throwIfAborted(input.signal);
      const batch = await filteredEdges(staged, nodeIds, uniqueEdges, edgeIdentitiesById, input.signal);
      throwIfAborted(input.signal);
      droppedDanglingEdgeCount += batch.dangling;
      deduplicatedEdgeCount += batch.duplicates;
      await writer.writeEdges(batch.edges, staged.componentIndex, input.signal);
      edgeCount += batch.edges.length;
      rmSync(staged.path, { force: true });
    }
    throwIfAborted(input.signal);
    const baseCounts = await writer.inspect(repoIds, input.signal);
    assertExpectedCounts(baseCounts.nodeCount, baseCounts.edgeCount, nodeCount, edgeCount);
    throwIfAborted(input.signal);
    if (input.beforeFinalize) {
      await input.beforeFinalize(writer.resolverRepository(), input.signal);
      throwIfAborted(input.signal);
    }
    await writer.finalize(input.signal);
    throwIfAborted(input.signal);
    const finalCounts = await writer.inspect(repoIds, input.signal);
    if (finalCounts.nodeCount !== nodeCount) {
      throw new Error(
        `Resolver hook changed the graph node count: expected ${nodeCount}, got ${finalCounts.nodeCount}`,
      );
    }
    if (finalCounts.nodeCount === 0) throw new Error('Built graph must contain at least one node');
    throwIfAborted(input.signal);
    await writer.close();
    throwIfAborted(input.signal);
    const fileSizeBytes = assertSingleFile(temporaryOutputPath);
    rmSync(stagingDir, { recursive: true, force: true });
    throwIfAborted(input.signal);
    if (existsSync(input.outputPath)) throw new Error(`Output file already exists: ${input.outputPath}`);
    renameSync(temporaryOutputPath, input.outputPath);
    succeeded = true;
    result = {
      artifactPath: input.outputPath,
      fileSizeBytes,
      nodeCount: finalCounts.nodeCount,
      edgeCount: finalCounts.edgeCount,
      droppedDanglingEdgeCount,
      deduplicatedEdgeCount,
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await writer.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    rmSync(stagingDir, { recursive: true, force: true });
    if (!succeeded) {
      rmSync(temporaryOutputPath, { force: true });
      rmSync(`${temporaryOutputPath}.wal`, { force: true });
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      `Graph file cleanup failed: ${cleanupErrors.map(errorText).join('; ')}`,
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (!result) throw new Error('Graph file build completed without a result');
  return result;
}
