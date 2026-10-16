// Pure normalizer: Jira Cloud REST v3 issue payloads -> NormalizedJiraIssue.
// No I/O, no date parsing. Jira payloads are UNTRUSTED (attacker-
// controlled), so every field is coerced through tolerant helpers (str/arr/obj/
// capped); non-conforming shapes degrade to undefined / [] rather than throwing,
// and every string/array is capped before it leaves this module. Dates are
// passed through verbatim as source strings — the service layer converts to `Date`.

import { asArray as arr, asRecord as obj, asString as str } from '../../libs/coerce.js';

export interface NormalizedJiraTransition {
  occurredAt: string;
  fromStatusRaw?: string;
  toStatusRaw?: string;
  actorAccountId?: string;
  sourceRef: string; // changelog history id
}

export interface NormalizedJiraActor {
  accountId: string;
  displayName?: string;
  email?: string;
  kind: 'human' | 'bot';
}

export interface NormalizedJiraIssue {
  externalId: string; // issue id (stable), NOT key
  externalKey?: string;
  itemType?: string;
  title?: string;
  statusRaw?: string;
  labels: string[];
  createdAtSource?: string;
  completedAt?: string;
  updatedAtSource?: string;
  assigneeAccountId?: string;
  reporterAccountId?: string;
  parentExternalId?: string;
  transitions: NormalizedJiraTransition[];
  actors: NormalizedJiraActor[]; // deduped by accountId
  attrs: { projectKey?: string; priority?: string; updatedAtSource?: string };
}

// --- tolerant coercion helpers -------------------------------------------------

/** str() then truncate to `max` chars; undefined passes through. */
function capped(v: unknown, max: number): string | undefined {
  const s = str(v);
  return s === undefined ? undefined : s.slice(0, max);
}

// --- caps (attacker-controlled input; every collection is bounded) -------------

const MAX_TRANSITIONS = 500;
const MAX_ACTORS = 100;
const MAX_LABELS = 50;
const LABEL_CHARS = 128;
const TITLE_CHARS = 512;
const STATUS_CHARS = 128;
const KEY_CHARS = 64;
const PROJECT_KEY_CHARS = 32;
const PRIORITY_CHARS = 64;

// --- itemType mapping ----------------------------------------------------------

/**
 * fields.issuetype.name (lowercased) -> canonical itemType. An issuetype that is
 * present but carries an unknown/missing name maps to 'other'; an issuetype that is
 * entirely absent (null/undefined) yields undefined so the caller can tell "no type
 * given" from "type given but unrecognized".
 */
function mapItemType(issuetype: unknown): string | undefined {
  if (issuetype === undefined || issuetype === null) return undefined;
  switch (str(obj(issuetype).name)?.toLowerCase()) {
    case 'epic':
      return 'epic';
    case 'bug':
      return 'bug';
    case 'story':
      return 'feature';
    case 'task':
    case 'sub-task':
    case 'subtask':
      return 'task';
    default:
      return 'other';
  }
}

// --- normalizer ----------------------------------------------------------------

export function normalizeJiraIssue(
  issue: Record<string, unknown>,
  extraChangelog: unknown[],
): NormalizedJiraIssue | null {
  const externalId = str(issue.id);
  if (externalId === undefined) return null; // no usable issue id -> unindexable

  const fields = obj(issue.fields);

  // labels: keep only string entries, cap each to LABEL_CHARS, keep at most MAX_LABELS.
  const labels = arr(fields.labels)
    .map((l) => capped(l, LABEL_CHARS))
    .filter((l): l is string => l !== undefined)
    .slice(0, MAX_LABELS);

  const updatedAtSource = str(fields.updated);

  // Changelog merge: embedded histories ++ the (optional) full per-issue top-up,
  // deduped by history id (first occurrence wins). Order is oldest-first, so the
  // head of each collected array is the oldest event.
  const mergedHistories = [...arr(obj(issue.changelog).histories), ...arr(extraChangelog)];

  const seenHistoryIds = new Set<string>();
  const transitions: NormalizedJiraTransition[] = [];
  const changelogAuthors: unknown[] = [];

  for (const rawHistory of mergedHistories) {
    const history = obj(rawHistory);
    const id = str(history.id);
    const occurredAt = str(history.created);
    if (id === undefined || occurredAt === undefined) continue; // needs id + created
    if (seenHistoryIds.has(id)) continue; // dedup by history id, first-occurrence wins
    seenHistoryIds.add(id);

    changelogAuthors.push(history.author);
    const actorAccountId = str(obj(history.author).accountId);

    for (const rawItem of arr(history.items)) {
      const item = obj(rawItem);
      const field = str(item.field);

      if (field === 'status') {
        transitions.push({
          occurredAt,
          fromStatusRaw: capped(item.fromString, STATUS_CHARS),
          toStatusRaw: capped(item.toString, STATUS_CHARS),
          actorAccountId,
          sourceRef: id,
        });
      }
    }
  }

  // actors: assignee + reporter (from fields) + every changelog author, deduped by
  // accountId (first wins). accountType 'app' -> bot; email is often absent (GDPR).
  const actors: NormalizedJiraActor[] = [];
  const seenActorIds = new Set<string>();
  const addActor = (raw: unknown): void => {
    const a = obj(raw);
    const accountId = str(a.accountId);
    if (accountId === undefined || seenActorIds.has(accountId)) return;
    seenActorIds.add(accountId);
    actors.push({
      accountId,
      displayName: str(a.displayName),
      email: str(a.emailAddress),
      kind: str(a.accountType) === 'app' ? 'bot' : 'human',
    });
  };
  addActor(fields.assignee);
  addActor(fields.reporter);
  for (const author of changelogAuthors) addActor(author);

  return {
    externalId,
    externalKey: capped(issue.key, KEY_CHARS),
    itemType: mapItemType(fields.issuetype),
    title: capped(fields.summary, TITLE_CHARS),
    statusRaw: capped(obj(fields.status).name, STATUS_CHARS),
    labels,
    createdAtSource: str(fields.created),
    completedAt: str(fields.resolutiondate),
    updatedAtSource,
    assigneeAccountId: str(obj(fields.assignee).accountId),
    reporterAccountId: str(obj(fields.reporter).accountId),
    parentExternalId: str(obj(fields.parent).id),
    // Caps keep the OLDEST: histories were iterated oldest-first, so the front of
    // each array is the earliest event — slice from the front to retain the first N.
    transitions: transitions.slice(0, MAX_TRANSITIONS),
    actors: actors.slice(0, MAX_ACTORS),
    attrs: {
      projectKey: capped(obj(fields.project).key, PROJECT_KEY_CHARS),
      priority: capped(obj(fields.priority).name, PRIORITY_CHARS),
      updatedAtSource,
    },
  };
}
