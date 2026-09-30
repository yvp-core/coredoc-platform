/**
 * Natural-language → Cypher generation for the graph explorer.
 *
 * A one-shot, coding-tool-free call over the EXISTING desktop chat/agent
 * harness (`captureChatHarness()` in `chat-service.ts`) — no new AI SDK client,
 * no stored key, no server endpoint. The system prompt is the dialect-aware
 * `run_cypher_query` description from `@coredoc/mcp` plus a strict "output ONE
 * read-only Cypher query, nothing else" instruction.
 *
 * `OneShotRun` is the injectable seam: production uses `defaultOneShotRun`
 * (real harness + provider branch), while tests can inject a fake. Generated
 * output is validated here before it reaches the editor; execution repeats the
 * canonical read-only and source-field guards at the database boundary.
 */

import { buildCypherDescription } from '@coredoc/mcp';
import { assertQueryDoesNotProjectSource, assertReadOnlyCypherAllowlisted } from '@coredoc/db';
import { captureChatHarness } from './chat-service.js';
import { CodexAppServerClient } from './codex-app-server.js';
import { requireProjectRoot } from './runtime-paths.js';
import { isE2EMode } from './e2e-mode.js';

type SDKModule = typeof import('@anthropic-ai/claude-agent-sdk');
let _sdkModule: SDKModule | null = null;
async function getSDK(): Promise<SDKModule> {
  if (!_sdkModule) _sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  return _sdkModule;
}

export type CypherNlDialect = 'ladybug' | 'neo4j';

/**
 * Injectable one-shot harness call: takes the composed system prompt + the
 * user's question, returns the model's raw final text. The default runs the
 * real harness; tests inject a fake so no real CLI/LLM is spawned.
 */
export type OneShotRun = (args: { systemPrompt: string; userText: string }) => Promise<string>;

const INSTRUCTION =
  "You translate the user's question into ONE read-only Cypher query for this graph. " +
  'Return exactly that query in the `cypher` output field — no explanation, markdown fences, or trailing semicolon. ' +
  'Use only the graph schema in this prompt; do not inspect files, invoke tools, or delegate. ' +
  'The query must be read-only (start with MATCH/OPTIONAL MATCH/WITH/UNWIND/RETURN).';

const CANVAS_INSTRUCTION =
  'DESKTOP GRAPH CANVAS CONTRACT (this overrides the rows/default projection guidance above): ' +
  'this surface consumes graph-shaped results. RETURN whole bound node and relationship variables, including both ' +
  'endpoint nodes of every relationship to draw; scalar-only projections are invisible on the canvas. ' +
  'The external-call topology is function or method -[:MAKES_EXTERNAL_CALL]-> external_call ' +
  '-[:RESOLVES_TO]-> entrypoint -[:HANDLES]-> handler function or method. ' +
  'A graph component means a frontend React, Vue, or similar UI declaration; never use type component for a generic ' +
  'service, module, or caller, and never make it the source of MAKES_EXTERNAL_CALL. ' +
  'An entrypoint name is an opaque stable ID. Use native filePath and repoId columns for code-area or repository ' +
  'constraints; do not guess them from name. Bind every relationship that must appear in RETURN.';

const CANVAS_SOURCE_INSTRUCTION =
  'DESKTOP GRAPH CANVAS SOURCE CONTRACT (this overrides properties guidance above): Never reference the properties ' +
  'or sourceCode fields on any node or relationship; generated canvas queries use only native fields such as id, ' +
  'name, type, summary, repoId, filePath, startLine, and endLine.';

function entrypointFilterInstruction(dialect: CypherNlDialect): string {
  const cliFilter =
    dialect === 'neo4j'
      ? "For CLI entrypoints use entrypoint.entrypointType = 'cli'."
      : "For CLI entrypoints use entrypoint.name CONTAINS ':entrypoint:cli:'.";
  return `${cliFilter} For server entrypoints or code areas, filter entrypoint.filePath (for example, STARTS WITH 'apps/server/'); do not search arbitrary words in the opaque entrypoint name.`;
}

function canvasExample(dialect: CypherNlDialect): string {
  if (dialect === 'neo4j') {
    return 'MATCH (caller:Function)-[makesCall:MAKES_EXTERNAL_CALL]->(externalCall:ExternalCall)-[resolvesTo:RESOLVES_TO]->(entrypoint:Entrypoint) RETURN caller, makesCall, externalCall, resolvesTo, entrypoint LIMIT 200';
  }
  return "MATCH (caller:GraphNode)-[makesCall:MAKES_EXTERNAL_CALL]->(externalCall:GraphNode)-[resolvesTo:RESOLVES_TO]->(entrypoint:GraphNode) WHERE caller.type = 'function' AND externalCall.type = 'external_call' AND entrypoint.type = 'entrypoint' RETURN caller, makesCall, externalCall, resolvesTo, entrypoint LIMIT 200";
}

const CODEX_CYPHER_PROFILE = 'coredoc-cypher-nl';
const CODEX_CYPHER_MODEL = 'gpt-5.6-terra';
const CLAUDE_CYPHER_MODEL = 'claude-opus-5-5';
const CYPHER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { cypher: { type: 'string' } },
  required: ['cypher'],
  additionalProperties: false,
};

function readStructuredCypher(value: unknown): string {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error('The model did not return the required Cypher output object.');
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The model did not return the required Cypher output object.');
  }
  const cypher = (parsed as Record<string, unknown>).cypher;
  if (typeof cypher !== 'string') {
    throw new Error('The model did not return a string in the Cypher output field.');
  }
  return cypher;
}

/**
 * Shape-clean a model response into a bare Cypher string: unwrap a fenced code
 * block, trim, and drop a trailing semicolon. Read-only validation happens in
 * `generateCypherFromNl`; the repository repeats it at execution time.
 */
export function cleanCypherResponse(raw: string): string {
  let text = (raw ?? '').trim();
  const fenced = text.match(/^```[^\n`]*\n?([\s\S]*?)\n?```$/);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  text = text.replace(/;+\s*$/, '').trim();
  return text;
}

/**
 * Build the `query()` options for generation with no general-purpose agent tools.
 *
 * Exported so a test can assert the tool-disabling contract without spawning a
 * real CLI. The load-bearing field is `tools: []` — per the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk` sdk.d.ts), `tools: []` DISABLES all built-in
 * tools, whereas `allowedTools: []` is only an auto-approval allowlist and leaves
 * Read/Grep/Bash available (the model then runs as a coding agent instead of a
 * translator). We pass a custom string `systemPrompt` (not the `claude_code`
 * preset), `settingSources: []` (no filesystem settings), and no `mcpServers`.
 */
export function buildClaudeOneShotOptions(
  systemPrompt: string,
  harness: Pick<ReturnType<typeof captureChatHarness>, 'env' | 'nodeExecPath' | 'claudeCliPath'>,
): Record<string, unknown> {
  return {
    systemPrompt,
    model: CLAUDE_CYPHER_MODEL,
    outputFormat: { type: 'json_schema', schema: CYPHER_OUTPUT_SCHEMA },
    // Disable ALL built-in coding tools. `outputFormat` still adds the SDK's
    // schema-only StructuredOutput tool used to deliver the result.
    tools: [],
    // No MCP tools either — belt-and-suspenders alongside `tools: []`.
    mcpServers: {},
    env: harness.env,
    executable: harness.nodeExecPath as unknown as 'node',
    permissionMode: 'default',
    settingSources: [],
    strictMcpConfig: true,
    ...(harness.claudeCliPath && { pathToClaudeCodeExecutable: harness.claudeCliPath }),
  };
}

async function runClaudeOneShot(systemPrompt: string, userText: string): Promise<string> {
  const harness = captureChatHarness();
  const { query } = await getSDK();
  for await (const message of query({
    prompt: userText,
    options: buildClaudeOneShotOptions(systemPrompt, harness) as Parameters<typeof query>[0]['options'],
  })) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success' || message.is_error) {
      const details = 'errors' in message && message.errors.length > 0 ? ` ${message.errors.join('; ')}` : '';
      throw new Error(`Cypher generation failed (${message.subtype}).${details}`);
    }
    return readStructuredCypher(message.structured_output ?? message.result);
  }
  throw new Error('Cypher generation ended without a terminal model response.');
}

async function runCodexOneShot(systemPrompt: string, userText: string): Promise<string> {
  const harness = captureChatHarness();
  const client = new CodexAppServerClient(harness.codexCliPath as string);
  const controller = new AbortController();
  const cwd = requireProjectRoot();
  let finalText = '';
  let phaseLessText = '';
  await client.run({
    prompt: userText,
    model: CODEX_CYPHER_MODEL,
    cwd,
    env: harness.env,
    signal: controller.signal,
    developerInstructions: systemPrompt,
    outputSchema: CYPHER_OUTPUT_SCHEMA,
    toolMode: 'none',
    permissionProfile: CODEX_CYPHER_PROFILE,
    config: {
      project_doc_max_bytes: 0,
      web_search: 'disabled',
      permissions: {
        [CODEX_CYPHER_PROFILE]: {
          filesystem: { ':root': 'deny' } as Record<string, 'read' | 'deny'>,
          network: { enabled: false },
        },
      },
      mcp_servers: {},
    },
    onNotification: (message) => {
      const params = message.params ?? {};
      if (message.method === 'item/completed') {
        const item = (params.item ?? {}) as { type?: string; text?: string; phase?: string | null };
        if (item.type !== 'agentMessage' || typeof item.text !== 'string') return;
        if (item.phase === 'final_answer') finalText = item.text;
        else if (item.phase == null) phaseLessText = item.text;
      }
    },
  });
  return readStructuredCypher(finalText || phaseLessText);
}

/**
 * Default one-shot run: reuse the desktop chat harness for one user prompt with
 * coding tools disabled on whichever provider is configured (Claude via `query()`, Codex via
 * `CodexAppServerClient`). Blocked under E2E mode so a smoke run never spends
 * real tokens.
 */
export const defaultOneShotRun: OneShotRun = async ({ systemPrompt, userText }) => {
  if (isE2EMode(process.env)) {
    throw new Error('Cypher generation is blocked in E2E mode (COREDOC_DESKTOP_E2E=1).');
  }
  const harness = captureChatHarness();
  return harness.provider === 'codex'
    ? runCodexOneShot(systemPrompt, userText)
    : runClaudeOneShot(systemPrompt, userText);
};

/**
 * Translate a natural-language question into ONE read-only Cypher query for the
 * given graph dialect. `run` defaults to the real harness; tests inject a fake.
 */
export async function generateCypherFromNl(opts: {
  text: string;
  dialect: CypherNlDialect;
  run?: OneShotRun;
}): Promise<{ cypher: string }> {
  const userText = (opts.text ?? '').trim();
  if (!userText) throw new Error('Enter a question to generate a Cypher query.');

  const systemPrompt = `${buildCypherDescription({ dialects: [opts.dialect] })}\n\n${CANVAS_INSTRUCTION}\n${entrypointFilterInstruction(opts.dialect)}\n${CANVAS_SOURCE_INSTRUCTION}\nExample: ${canvasExample(opts.dialect)}\n\n${INSTRUCTION}`;
  const run = opts.run ?? defaultOneShotRun;
  const raw = await run({ systemPrompt, userText });
  const cypher = cleanCypherResponse(raw);
  if (!cypher) throw new Error('Could not generate a Cypher query from that description.');
  assertReadOnlyCypherAllowlisted(cypher, opts.dialect);
  try {
    assertQueryDoesNotProjectSource(cypher);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('Source-in-graph is disabled:') ||
      !/cannot reference "(?:properties|sourceCode)"/i.test(error.message)
    ) {
      throw error;
    }
    throw new Error(
      'Generated graph-canvas Cypher cannot reference "properties" or "sourceCode". Use native fields such as name, type, filePath, repoId, and line numbers.',
    );
  }
  return { cypher };
}
