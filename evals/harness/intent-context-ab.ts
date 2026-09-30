/** Read-only retrieval screen for context-first MVP. This cannot pass hosted/edit ACs. */
export interface ContextAbCase {
  id: string;
  task: string;
  query: Record<string, string | number>;
  criticalIds: string[];
  applicableIds: string[];
}

export interface ContextAbResponse {
  matches: Array<{ id: string; version: number; [key: string]: unknown }>;
  evidence: { available: boolean };
  truncated: boolean;
  scanTruncated: boolean;
  unknownIntentIds: string[];
  unresolvedFiles?: unknown[];
  [key: string]: unknown;
}

export function assessContextRead(
  scenario: ContextAbCase,
  response: ContextAbResponse,
  decoyIds: ReadonlySet<string>,
) {
  const returnedIds = response.matches.map(({ id }) => id);
  const missingCriticalIds = scenario.criticalIds.filter((id) => !returnedIds.includes(id));
  const irrelevantIds = returnedIds.filter((id) => decoyIds.has(id));
  const unclassifiedIds = returnedIds.filter(
    (id) => !scenario.criticalIds.includes(id) && !scenario.applicableIds.includes(id) && !decoyIds.has(id),
  );
  return {
    // A miss is decisive for this frozen request. A successful read still does not prove an agent edits correctly.
    verdict: missingCriticalIds.length ? 'fail' : response.evidence.available ? 'retrieval_pass' : 'inconclusive',
    criticalFound: scenario.criticalIds.length - missingCriticalIds.length,
    criticalTotal: scenario.criticalIds.length,
    missingCriticalIds,
    returnedIds,
    irrelevantIds,
    unclassifiedIds,
    truncated: response.truncated,
    scanTruncated: response.scanTruncated,
    unknownIntentIds: response.unknownIntentIds,
    unresolvedFiles: response.unresolvedFiles ?? [],
  };
}

/** Same 3300 decoys as .scratch/intent-loop-v3/scale/intent-scale-seed.mjs; no live-DB seeder import. */
export function contextScaleDecoys() {
  const kinds = [
    ['capability', 'cap'], ['use_case', 'uc'], ['flow', 'flow'],
    ['business_rule', 'br'], ['limitation', 'lim'], ['decision', 'dec'],
  ] as const;
  const nouns = ['invoices', 'sessions', 'exports', 'quotas', 'retention', 'permissions', 'attachments', 'webhooks', 'reminders', 'archives'];
  const verbs = ['is recorded', 'is rejected', 'is paginated', 'is retried', 'is archived', 'is throttled', 'is expired', 'is reconciled'];
  const domains: Array<{ id: string; title: string; statement: string }> = [];
  const items: Array<{ id: string; kind: typeof kinds[number][0]; domainId: string; title: string; statement: string }> = [];
  for (let d = 1; d <= 30; d++) {
    const domainId = `scale-d${String(d).padStart(2, '0')}`;
    const noun = nouns[d % nouns.length];
    domains.push({ id: domainId, title: `Billing ${noun}`, statement: `Everything the ${noun} area of area ${d} is responsible for.` });
    for (let i = 1; i <= 100; i++) {
      const [kind, prefix] = kinds[(d * 100 + i) % kinds.length]!;
      items.push({ id: `${prefix}-${domainId}-item-${String(i).padStart(3, '0')}`, kind, domainId,
        title: `Area ${d} ${noun} rule ${i}`,
        statement: `A record of ${noun} in area ${d} ${verbs[i % verbs.length]} whenever step ${i} completes.` });
    }
  }
  domains.push(
    { id: 'scale-similar-a', title: 'Billing release ledger', statement: 'How invoice releases are planned, merged and recorded in the billing ledger.' },
    { id: 'scale-similar-b', title: 'Statement connector plans', statement: 'How the statement connector plans, trails and merges exports.' },
  );
  for (const domainId of ['scale-similar-a', 'scale-similar-b']) {
    for (let i = 1; i <= 150; i++) {
      const [kind, prefix] = kinds[i % kinds.length]!;
      items.push({ id: `${prefix}-${domainId}-item-${String(i).padStart(3, '0')}`, kind, domainId,
        title: `Billing release plan ${i} names its connector trailer`,
        statement: `A billing release plan ${i} is recorded when the invoice connector merges a statement trailer into the production branch ledger, and the plan stays open until the export is delivered.` });
    }
  }
  return { domains, items };
}
