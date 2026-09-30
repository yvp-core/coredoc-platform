#!/usr/bin/env node
// PostToolUse(Bash) nudge: after a git commit/push, if coredoc MCP tools were
// used this session and we haven't nudged yet, ask the agent to run /coredoc:feedback.
// Advisory only — emits hookSpecificOutput.additionalContext. Fail-open on any error.
import { readFile, writeFile, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const evt = JSON.parse(input || '{}');

  const cmd = String(evt?.tool_input?.command ?? '');
  if (!/\bgit\s+(commit|push)\b/.test(cmd)) return; // not a commit/push

  const sessionId = String(evt?.session_id ?? '');
  const transcriptPath = String(evt?.transcript_path ?? '');
  if (!sessionId || !transcriptPath) return;

  // Rate-limit: one nudge per session (marker file in tmp).
  const markerDir = join(tmpdir(), 'coredoc-feedback-nudge');
  const marker = join(markerDir, `${sessionId}.done`);
  try { await readFile(marker); return; } catch { /* not nudged yet */ }

  // Gate: only nudge if coredoc MCP tools were used this session.
  // Bounded tail read — transcripts grow to hundreds of MB in long sessions,
  // and this hook runs on every git commit/push. Match only real MCP tool-use
  // markers ("name":"mcp__coredoc__…"), not tool names echoed in file contents.
  let usedCoredoc = false;
  try {
    const { size } = await stat(transcriptPath);
    const readLen = Math.min(size, 512 * 1024);
    const fh = await open(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, size - readLen);
      usedCoredoc = /"name"\s*:\s*"mcp__[^"]*coredoc[^"]*"/.test(buf.toString('utf8'));
    } finally {
      await fh.close();
    }
  } catch { /* transcript unreadable → skip */ }
  if (!usedCoredoc) return;

  await mkdir(markerDir, { recursive: true });
  await writeFile(marker, '1');

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `You just committed/pushed and used coredoc MCP tools this session (id ${sessionId}). ` +
        `At task completion, run /coredoc:feedback and prepare one session draft without waiting for a user request. Respect an earlier Skip or completed feedback review. ` +
        `(pass sessionId "${sessionId}" to submit_session_feedback so it correlates).`,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch(() => { /* fail-open: no output, exit 0 */ });
