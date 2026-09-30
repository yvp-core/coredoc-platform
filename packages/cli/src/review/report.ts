import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReviewResult } from './contracts.js';

export function safeText(value: string): string {
  return (
    value
      // Control, C1, bidi, zero-width, line/paragraph separators and Unicode tag characters spoof
      // terminals and rendered comments, and tag characters can hide instructions; escaping does not
      // remove them. Stripping runs before the '@' rule, whose own zero-width joiner must survive.
      .replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip at the render boundary
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{E0000}-\u{E007F}]/gu,
        '',
      )
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/@/g, '@\u200b')
      .replace(/([\\`*_[\]{}()!#|])/g, '\\$1')
      .replace(/https?:\/\//gi, 'https[:]//')
  );
}

const limitationDiagnostics: Record<string, string> = {
  MODEL_OUTPUT_LIMIT: 'The provider exhausted the per-call output allowance, which includes reasoning tokens.',
  MODEL_CONTENT_FILTERED: 'The provider stopped the response because of a content filter.',
  MODEL_PROVIDER_ERROR: 'The provider returned an error finish reason.',
  SOURCE_NOT_INSPECTED: 'The model did not inspect any source through the read tool.',
  ROUTER_UNAVAILABLE: 'The lens router did not return a usable answer; only the logic lens ran.',
  LENS_FAILED:
    'A discovery lens ended without an answer; the remaining lenses still reported. A lens lost to a provider rate limit or gateway failure is reported here with its OPENROUTER_HTTP_ code, after the transport retried the refusal with a growing back-off for up to five minutes of waiting.',
  SOURCE_COVERAGE_PARTIAL:
    'Discovery answered without reading every changed file, even after being sent back to read them.',
  VERIFICATION_EVIDENCE_PARTIAL:
    'Verification confirmed a candidate without fresh reads of its evidence, even after being sent back to read it.',
  EVIDENCE_RANGE_INVALID: 'The evidence interval or excerpt length is invalid.',
  EVIDENCE_NOT_READ_THIS_PHASE: 'The verifier did not read the complete evidence interval in its own phase.',
  EVIDENCE_EXCERPT_MISMATCH: 'The quoted text does not exactly match the pinned source at the claimed lines.',
  EVIDENCE_EXCERPT_AMBIGUOUS:
    'The quoted text occurs more than once in the file, so its location cannot be established.',
  EVIDENCE_SOURCE_UNAVAILABLE: 'The pinned source needed to validate the quote was unavailable.',
  EVIDENCE_HEAD_REQUIRED: 'A previous-finding verdict lacks evidence from the current head.',
  FINDING_ANCHOR_NOT_CHANGED: 'The proposed inline anchor is not a changed line in an available patch.',
  FINDING_ANCHOR_NOT_COVERED: 'No evidence interval covers the proposed inline anchor.',
  MODEL_CREDENTIAL_MISCONFIGURED:
    'Configure exactly one model credential that matches the settings provider: model-api-key for an API provider, claude-code-oauth-token for provider claude-code.',
  SUBSCRIPTION_CREDENTIAL_REJECTED:
    'The Claude runtime rejected the subscription credential; no other credential was tried and no finding from this attempt is published.',
  SUBSCRIPTION_PLAN_EXHAUSTED:
    'The Claude subscription plan could not serve this review (rate or plan limit); no other credential was tried and no finding from this attempt is published.',
  CLAUDE_RUNTIME_FAILED: 'The Claude runtime ended the phase with an error the host does not classify further.',
  CLAUDE_RUNTIME_UNAVAILABLE: 'The Claude runtime could not be started on this runner.',
  CLAUDE_RUNTIME_TOOLS_UNEXPECTED:
    'The Claude runtime reported tools, MCP servers, plugins or skills the host did not configure (see the INIT_* gap for which); the run stopped before accepting an answer.',
  TOOL_DENIED: 'The runtime asked for a tool outside the allowlist; the request was denied.',
};

export function renderEarlyFailure(code: string): string {
  const sentence = limitationDiagnostics[code];
  return `# Coredoc review — incomplete\n\n\`${safeText(code)}\`: ${
    sentence ? safeText(sentence) : 'the run failed before a review was produced; see the failed step.'
  }`;
}

export function renderReview(result: ReviewResult): string {
  const r = result.revision;
  const lines = [
    `# Coredoc review — ${result.status}`,
    '',
    `${safeText(r.repository)} #${r.pullNumber} · arm ${result.arm} · ${result.configuration.runtime} · auth: ${result.configuration.auth}`,
    '',
    `Reviewed commit: \`${r.headSha}\``,
    `Base branch commit: \`${r.baseSha}\``,
    `Merge base: \`${r.mergeBaseSha}\``,
    '',
    safeText(result.summary),
    '',
    `Findings: ${result.findings.length}. Changed files: ${result.coverage.changed.length}. Read locations: ${result.coverage.read.length}.`,
    `Excluded files: ${result.coverage.excluded.length}.`,
    '',
    '**Coverage / limitations**',
    '',
    ...(result.coverage.gaps.length
      ? result.coverage.gaps.map(
          (x) => `- ${safeText(x)}${limitationDiagnostics[x] ? `: ${limitationDiagnostics[x]}` : ''}`,
        )
      : ['No collection or execution errors recorded; analysis was bounded by the declared limits.']),
  ];
  if (result.coverage.lenses?.length) {
    lines.push(
      '',
      '**Lenses**',
      '',
      '| Lens | Why | Focus files | Calls | Candidates | Failed |',
      '| --- | --- | --- | --- | --- | --- |',
      ...result.coverage.lenses.map(
        (lens) =>
          `| ${safeText(lens.id)} | ${safeText(lens.reason)} | ${lens.focusFiles.length ? safeText(lens.focusFiles.join(', ')) : 'whole change'} | ${lens.steps} | ${lens.candidates} | ${lens.failed ? safeText(lens.failed) : 'no'} |`,
      ),
    );
  }
  if (result.candidates?.length) {
    lines.push(
      '',
      '**Candidates**',
      '',
      '| Lens | Severity | Title | Anchor | Verdict | Outcome | Reason |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...result.candidates.map(
        (c) =>
          `| ${safeText(c.lens ?? c.id)} | ${c.severity} | ${safeText(c.title)} | ${safeText(`${c.anchor.path}:${c.anchor.line}`)} | ${c.verdict} | ${c.outcome} | ${c.reason ? safeText(c.reason) : '—'} |`,
      ),
    );
  }
  const config = result.configuration;
  lines.push(
    '',
    '**Run configuration**',
    '',
    `Run: ${result.runId}; mode: ${result.mode}; runner: ${safeText(config.runnerVersion)}.`,
    `Auth: ${
      config.auth === 'subscription'
        ? 'subscription (Claude Code OAuth token; no provider cost is reported)'
        : 'api-key'
    }`,
    `Model: ${safeText(config.model.provider)} / ${safeText(config.model.id)}. Temperature: ${config.model.temperature ?? 'provider default'}; seed: ${config.model.seed ?? 'provider default'}.`,
    `Policy: ${safeText(config.policyVersion)}; digest: ${config.policyDigest}; prompt: ${safeText(config.promptVersion)}.`,
    `Limits: ${safeText(JSON.stringify(config.limits))}.`,
    `Declared prices per million tokens: input ${config.model.inputUsdPerMillion ?? 'unknown'}, output ${config.model.outputUsdPerMillion ?? 'unknown'}; dollar limit: ${config.model.maxUsd ?? 'not configured'}.`,
    ...config.unsupportedSampling.map((item) => safeText(item)),
  );
  if (result.modelCalls?.length) {
    lines.push(
      '',
      '<details>',
      '<summary>Model call diagnostics (metadata only)</summary>',
      '',
      '| Call | Phase | Final | ms | Finish / raw | Input / cached / written | Output / reasoning | Text bytes | Tools | Output limit |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const call of result.modelCalls)
      lines.push(
        `| ${call.step} | ${safeText(call.lens ? `${call.phase}/${call.lens}` : call.phase)} | ${call.final} | ${call.durationMs} | ${safeText(call.finishReason)} / ${safeText(call.rawFinishReason)} | ${call.inputTokens ?? '?'} / ${call.cachedInputTokens ?? '?'} / ${call.cacheWriteTokens ?? '?'} | ${call.outputTokens ?? '?'} / ${call.reasoningTokens ?? '?'} | ${call.textBytes} | ${call.toolCalls}${call.toolLimitations?.length ? `; ${safeText(call.toolLimitations.join(', '))}` : ''} | ${call.outputLimit} |`,
      );
    const invalid = result.modelCalls.filter(
      (call) =>
        call.outputValidation && (!call.outputValidation.schemaValid || call.outputValidation.format !== 'json'),
    );
    for (const call of invalid)
      lines.push('', `Call ${call.step} output validation: ${safeText(JSON.stringify(call.outputValidation))}`);
    lines.push('', '</details>', '');
  }
  if (result.graph)
    lines.push(
      '',
      `Graph: ${result.graph.admissibility}; commit ${result.graph.commit ?? 'unknown'}; ${result.graph.distance.relation}; ahead ${result.graph.distance.ahead ?? '?'} / behind ${result.graph.distance.behind ?? '?'}.`,
      `Graph identity: ${safeText(result.graph.snapshotId ?? 'unknown')}; distance source: ${result.graph.distance.source}; reason: ${safeText(result.graph.reason ?? 'none')}.`,
    );
  for (const f of result.findings) {
    const sha = f.anchor.revision === 'head' ? r.headSha : r.mergeBaseSha;
    const link = `https://github.com/${r.repository}/blob/${sha}/${f.anchor.path.split('/').map(encodeURIComponent).join('/')}#L${f.anchor.line}`;
    lines.push(
      '',
      `## ${f.severity}: ${safeText(f.title)}`,
      '',
      `[${safeText(f.anchor.path)}:${f.anchor.line}](${link})`,
      '',
      `**Trigger:** ${safeText(f.trigger)}`,
      '',
      `**Impact:** ${safeText(f.impact)}`,
      '',
      `**Changed behavior:** ${safeText(f.changedCode)}`,
      '',
      `**Existing handling checked:** ${safeText(f.existingHandling)}`,
    );
  }
  lines.push(
    '',
    `Usage: ${result.usage.steps} model calls; ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens; cost ${result.usage.costUsd === null ? 'unknown' : `$${result.usage.costUsd.toFixed(4)} (${result.usage.costKind})`}.`,
    '',
    'This report does not approve the PR or establish that it is safe to merge.',
    '',
  );
  if (result.publication)
    lines.push(
      `GitHub publication: ${result.publication.status}${result.publication.reason ? ` (${safeText(result.publication.reason)})` : ''}.`,
      '',
    );
  if (result.billing)
    lines.push(
      `OpenRouter accounting: $${result.billing.actualUsd.toFixed(6)} settled; $${result.billing.reservedUsd.toFixed(6)} unsettled reservation; ${result.billing.calls} attempted calls; per-run budget $${result.billing.maxUsd}; uncertain: ${result.billing.uncertain}.`,
      '',
    );
  return lines.join('\n');
}

export async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
