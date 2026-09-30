import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexSessionPersistenceEnabled, runCodexExec } from './codex-exec.js';

export type SummarizeHarness = 'claude-code' | 'codex';

export interface TextGenerator {
  generate(prompt: string, systemPrompt: string): Promise<string>;
}

export interface TextGeneratorOptions {
  harness?: SummarizeHarness;
  model?: string;
  cwd?: string;
  claudeCodeCliPath?: string;
  codexCliPath?: string;
  sdkExecutable?: string;
  sdkEnv?: NodeJS.ProcessEnv;
}

const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_CODEX_MODEL = 'gpt-6-luna';
let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null;
async function getClaudeQuery() {
  if (!queryFn) queryFn = (await import('@anthropic-ai/claude-agent-sdk')).query;
  return queryFn;
}

function stringEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

class ClaudeTextGenerator implements TextGenerator {
  constructor(private readonly options: TextGeneratorOptions) {}

  async generate(prompt: string, systemPrompt: string): Promise<string> {
    const query = await getClaudeQuery();
    const stderrChunks: string[] = [];
    let responseText = '';
    try {
      for await (const message of query({
        prompt,
        options: {
          model: this.options.model || DEFAULT_CLAUDE_MODEL,
          allowedTools: [],
          systemPrompt,
          ...(this.options.cwd && { cwd: this.options.cwd }),
          ...(this.options.claudeCodeCliPath && {
            pathToClaudeCodeExecutable: this.options.claudeCodeCliPath,
          }),
          ...(this.options.sdkExecutable && {
            executable: this.options.sdkExecutable as unknown as 'node',
          }),
          ...(this.options.sdkEnv && { env: this.options.sdkEnv }),
          stderr: (data: string) => stderrChunks.push(data),
        },
      })) {
        if (message.type !== 'assistant' || !message.message?.content) continue;
        for (const block of message.message.content) {
          if ('text' in block && typeof block.text === 'string') responseText += block.text;
        }
      }
    } catch (error) {
      const detail = stderrChunks.join('').trim();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(detail ? `${message}\nstderr: ${detail}` : message, { cause: error });
    }
    if (!responseText) throw new Error('No response from model');
    return responseText;
  }
}

/**
 * Summarize runs inside an isolated throwaway CODEX_HOME, so their rollouts must be copied into
 * the real ~/.codex/sessions before cleanup for external session viewers to see them. Copy
 * failures only degrade debuggability, never the summarize result, so they are logged and
 * intentionally not rethrown.
 */
function preserveCodexSessions(isolatedHome: string): void {
  const source = path.join(isolatedHome, 'sessions');
  if (!fs.existsSync(source)) return;
  try {
    fs.cpSync(source, path.join(os.homedir(), '.codex', 'sessions'), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  } catch (error) {
    console.warn(
      `Failed to preserve Codex summarize session rollouts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

class CodexTextGenerator implements TextGenerator {
  constructor(private readonly options: TextGeneratorOptions & { codexCliPath: string }) {}

  async generate(prompt: string, systemPrompt: string): Promise<string> {
    // Resolved before creating the isolated home so a malformed flag fails fast; the same env
    // source feeds runCodexExec, keeping the --ephemeral decision and the rollout copy in sync.
    const persistSessions = codexSessionPersistenceEnabled(this.options.sdkEnv ?? process.env);
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-codex-summarize-'));
    const isolatedWorkspace = path.join(isolatedHome, 'workspace');
    fs.mkdirSync(isolatedWorkspace, { mode: 0o700 });
    fs.chmodSync(isolatedHome, 0o700);

    try {
      const sourceAuth = path.join(os.homedir(), '.codex', 'auth.json');
      const isolatedAuth = path.join(isolatedHome, 'auth.json');
      try {
        fs.copyFileSync(sourceAuth, isolatedAuth, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(isolatedAuth, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const baseEnv = stringEnvironment(this.options.sdkEnv) ?? { PATH: process.env.PATH };
      const env = {
        ...baseEnv,
        PATH: [path.dirname(this.options.codexCliPath), baseEnv.PATH].filter(Boolean).join(path.delimiter),
        CODEX_HOME: isolatedHome,
        COREDOC_CODEX_PERSIST_SESSIONS: String(persistSessions),
      };
      return await runCodexExec({
        executablePath: this.options.codexCliPath,
        cwd: isolatedWorkspace,
        env,
        model: this.options.model || DEFAULT_CODEX_MODEL,
        prompt: `${systemPrompt}\n\n${prompt}`,
      });
    } finally {
      if (persistSessions) preserveCodexSessions(isolatedHome);
      fs.rmSync(isolatedHome, { recursive: true, force: true });
    }
  }
}

export function createTextGenerator(options: TextGeneratorOptions): TextGenerator {
  if (options.harness === 'codex') {
    if (!options.codexCliPath) throw new Error('System Codex CLI path is required for Codex summarization.');
    return new CodexTextGenerator({ ...options, codexCliPath: options.codexCliPath });
  }
  return new ClaudeTextGenerator(options);
}
