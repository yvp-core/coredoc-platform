/**
 * SDK Cross-Service Report — diagnostic for cross-service resolution health.
 *
 * Loads all parsed repos for a project (or every project), runs the resolver,
 * then computes a structured diagnostic report:
 *   - overall + per-source-repo resolution rates
 *   - top unresolved `serviceName`s with hints about which target repo may be missing
 *   - suspected parser bugs (stub-path patterns, partial descriptors)
 *
 * Pure read-only: no DB writes, no file mutations beyond an optional JSON output.
 */

import * as fs from 'fs';
import { linkWorkspace, sliceParsedRepoByTarget } from '@coredoc/core';
import { parsedRepoFile } from '@coredoc/core/utils';
import type { ParsedRepo } from '@coredoc/core/types';
import { loadConfig } from './config.js';

export interface CrossServiceReport {
  project: string | null;
  totals: { externalCalls: number; resolved: number; resolutionRate: number };
  perSourceRepo: Array<{ name: string; total: number; resolved: number; rate: number }>;
  unresolvedByService: Array<{ serviceName: string; count: number; targetRepoLikelyMissing: string | null }>;
  suspectedParserBugs: Array<{
    repo: string;
    pattern: 'stub-domain-path' | 'no-target-service' | 'partial-descriptor-no-sdk-name';
    count: number;
    sample: { service: string; method: string; pathTemplate: string | undefined };
  }>;
}

/**
 * Detects the "stub domain path" parser bug pattern.
 *
 * The bug: a generated parser emits a pathTemplate that is just the trailing
 * token of the serviceName (e.g. for a call routed through `client.users.X()`,
 * the parser emits `pathTemplate: '/users'` instead of the real URL the SDK
 * method would resolve to). That signals the parser failed to recover the
 * real HTTP path and fell back to something derived from the service identifier.
 *
 * A naive `/^\/[a-z]+$/` regex would flag legitimate paths like `/health`,
 * `/login`, `/metrics`, so we require the single-segment path to match the
 * service name's trailing token (after stripping common decorations).
 */
function isDomainStubPath(serviceName: string, pathTemplate: string): boolean {
  const match = pathTemplate.match(/^\/([a-z][a-z0-9]*)$/i);
  if (!match) return false;
  const segment = match[1].toLowerCase();
  const trail = serviceName
    .replace(/^@.+\//, '') // strip npm scope: @org/name → name
    .replace(/-service$/i, '') // common service-name suffix
    .replace(/^[a-z][a-z0-9]*-/i, '') // strip a leading single-token prefix (organization/product marker)
    .toLowerCase();
  return segment === trail;
}

export interface ReportOptions {
  config: string;
  project?: string;
  output?: string;
  json?: boolean;
}

export async function runCrossServiceReport(options: ReportOptions): Promise<CrossServiceReport> {
  const config = loadConfig(options.config);

  const projectId = options.project ?? null;
  const projects = projectId ? config.projects.filter((p) => p.id === projectId) : config.projects;
  if (projects.length === 0) {
    throw new Error(
      `No projects matched ${projectId ?? '(all)'}. Available: ${config.projects.map((p) => p.id).join(', ')}`,
    );
  }

  const repos: ParsedRepo[] = [];
  const parsedRepoNames = new Set<string>();
  for (const proj of projects) {
    for (const repo of proj.repos) {
      const jsonPath = parsedRepoFile(config.resolvedOutputDir, proj.id, repo.name);
      if (!fs.existsSync(jsonPath)) continue;
      let parsed: ParsedRepo;
      try {
        parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as ParsedRepo;
      } catch (e) {
        throw new Error(`Failed to parse ${jsonPath}: ${e instanceof Error ? e.message : e}`);
      }
      if (!parsed.externalCalls) parsed.externalCalls = [];
      repos.push(parsed);
      parsedRepoNames.add(parsed.name);
    }
  }

  const repoPrefixes: Record<string, string> = {};
  for (const proj of config.projects) {
    for (const r of proj.repos) {
      if (r.httpPrefix) repoPrefixes[r.name] = r.httpPrefix;
    }
  }

  const linkResult = linkWorkspace(
    repos.flatMap((repo) => sliceParsedRepoByTarget(repo, [], repoPrefixes[repo.name]).map((slice) => slice.repoLike)),
  );
  const resolvedCallIds = new Set(linkResult.edges.map((e) => e.sourceId));

  const totalExternalCalls = repos.reduce((sum, r) => sum + r.externalCalls.length, 0);
  const totals = {
    externalCalls: totalExternalCalls,
    resolved: linkResult.edges.length,
    resolutionRate: totalExternalCalls === 0 ? 0 : linkResult.edges.length / totalExternalCalls,
  };

  const perSourceRepo = repos
    .map((r) => {
      const total = r.externalCalls.length;
      const resolvedCount = r.externalCalls.filter((c) => resolvedCallIds.has(c.id)).length;
      return { name: r.name, total, resolved: resolvedCount, rate: total === 0 ? 0 : resolvedCount / total };
    })
    .sort((a, b) => b.total - a.total);

  const unresolvedByServiceMap = new Map<string, number>();
  for (const r of repos) {
    for (const c of r.externalCalls) {
      if (resolvedCallIds.has(c.id)) continue;
      unresolvedByServiceMap.set(c.serviceName, (unresolvedByServiceMap.get(c.serviceName) ?? 0) + 1);
    }
  }
  const unresolvedByService = [...unresolvedByServiceMap.entries()]
    .map(([serviceName, count]) => ({
      serviceName,
      count,
      targetRepoLikelyMissing: guessMissingRepo(serviceName, parsedRepoNames),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const bugBuckets = new Map<string, CrossServiceReport['suspectedParserBugs'][number]>();
  for (const r of repos) {
    for (const c of r.externalCalls) {
      const pathT = c.targetDescriptor?.http?.pathTemplate;
      let pattern: CrossServiceReport['suspectedParserBugs'][number]['pattern'] | undefined;
      if (pathT && isDomainStubPath(c.serviceName, pathT)) pattern = 'stub-domain-path';
      else if (c.sdkName && !c.targetDescriptor?.targetService && !pathT) pattern = 'no-target-service';
      else if (c.targetDescriptor && !c.sdkName) pattern = 'partial-descriptor-no-sdk-name';
      if (!pattern) continue;

      const key = `${r.name}::${pattern}`;
      const existing = bugBuckets.get(key);
      if (existing) existing.count++;
      else {
        bugBuckets.set(key, {
          repo: r.name,
          pattern,
          count: 1,
          sample: { service: c.serviceName, method: c.method, pathTemplate: pathT },
        });
      }
    }
  }
  const suspectedParserBugs = [...bugBuckets.values()].sort((a, b) => b.count - a.count);

  return { project: projectId, totals, perSourceRepo, unresolvedByService, suspectedParserBugs };
}

/**
 * Suggests a likely-missing repo name for an unresolved external service.
 *
 * Client-agnostic heuristic: strip well-known package decorations (npm scope,
 * `-service` suffix, `-api-client*` suffix) and only return a suggestion when
 * that actually transformed the name and the stripped form isn't already a
 * parsed repo. Returning `null` means "no actionable hint" — preferable to
 * suggesting a name we can't justify.
 */
export function guessMissingRepo(serviceName: string, parsedRepoNames: Set<string>): string | null {
  if (parsedRepoNames.has(serviceName)) return null;

  const stripped = serviceName
    .replace(/^@.+\//, '') // strip npm-scope (@org/name → name)
    .replace(/-service$/i, '') // common service-name suffix
    .replace(/-api-client.*$/i, ''); // common SDK package suffix

  if (stripped === serviceName) return null; // no transformation → no actionable hint
  if (parsedRepoNames.has(stripped)) return null; // the stripped form already exists

  return stripped;
}

export function formatReport(report: CrossServiceReport): string {
  const lines: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  lines.push('');
  lines.push('Cross-Service Resolution Report');
  lines.push('================================');
  lines.push('');
  lines.push(`Project: ${report.project ?? '(all)'}`);
  lines.push(`Total external calls: ${report.totals.externalCalls}`);
  lines.push(
    `Resolved: ${report.totals.resolved}/${report.totals.externalCalls} (${pct(report.totals.resolutionRate)})`,
  );
  lines.push('');

  lines.push('Per-source-repo resolution');
  lines.push('--------------------------');
  for (const r of report.perSourceRepo) {
    lines.push(
      `  ${r.name.padEnd(32)} ${String(r.resolved).padStart(4)}/${String(r.total).padStart(4)}  (${pct(r.rate)})`,
    );
  }
  lines.push('');

  lines.push('Top unresolved services');
  lines.push('-----------------------');
  for (const s of report.unresolvedByService) {
    const hint = s.targetRepoLikelyMissing ? `  → add repo "${s.targetRepoLikelyMissing}" to config?` : '';
    lines.push(`  ${String(s.count).padStart(4)}  ${s.serviceName}${hint}`);
  }
  lines.push('');

  if (report.suspectedParserBugs.length > 0) {
    lines.push('Suspected parser bugs');
    lines.push('---------------------');
    for (const b of report.suspectedParserBugs) {
      lines.push(`  ${b.repo}: ${b.pattern} (${b.count} occurrences)`);
      lines.push(
        `    sample: service="${b.sample.service}" method="${b.sample.method}" pathTemplate=${JSON.stringify(b.sample.pathTemplate)}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
