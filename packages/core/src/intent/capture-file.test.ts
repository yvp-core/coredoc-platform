import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLegacyIntentFixtureJson, readValidIntentFixtureJson } from './__fixtures__/load.js';
import {
  IntentOverlayInvalidError,
  IntentProposalsInvalidError,
  captureIntoIntentFile,
  parseIntentProposalsDocument,
} from './capture-file.js';
import { IntentCaptureError, IntentCaptureErrorCode } from './capture.js';
import { INTENT_ERROR_REPORT_LIMITS, IntentValidationCode } from './schema.js';
import { intentPathsForRepo } from './paths.js';
import { canonicalIntentJson, readIntentFile } from './storage.js';
import { IntentAuthority, IntentKind, IntentSourceKind, type IntentItemProposal } from './types.js';

const PROJECT_ID = 'sample-project';

let repoRoot: string;
let intentPath: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-intent-capture-'));
  intentPath = intentPathsForRepo(repoRoot).intentJson;
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

const proposal = (overrides: Partial<IntentItemProposal> = {}): IntentItemProposal =>
  ({
    id: 'cap-widget-returns',
    domain: 'returns',
    kind: IntentKind.Capability,
    title: 'Widget returns',
    statement: 'A store operator can return a widget within the return window.',
    payload: {
      outcome: 'A returned widget is credited back to the operator',
      beneficiary: 'Store operator',
      boundary: 'Returns inside the return window only',
    },
    sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/widget-returns', localId: 'CAP-9' }],
    ...overrides,
  }) as IntentItemProposal;

function writeFixtureOverlay(): void {
  fs.mkdirSync(path.dirname(intentPath), { recursive: true });
  fs.writeFileSync(intentPath, JSON.stringify(readValidIntentFixtureJson(), null, 2));
}

function capture(proposals: IntentItemProposal[]) {
  return captureIntoIntentFile(intentPath, proposals, {
    expectedProjectId: PROJECT_ID,
    containmentRoot: repoRoot,
  });
}

describe('captureIntoIntentFile — UC-1 first run against an absent overlay', () => {
  it('creates a valid overlay shell and writes the proposal as a candidate', () => {
    const result = capture([proposal()]);

    expect(result.createdFile).toBe(true);
    expect(result.createdItemIds).toEqual(['cap-widget-returns']);
    expect(result.updatedItemIds).toEqual([]);

    const read = readIntentFile(intentPath, { expectedProjectId: PROJECT_ID });
    expect(read.status).toBe('ready');
    if (read.status !== 'ready') throw new Error('overlay should be readable');
    expect(read.file.projectId).toBe(PROJECT_ID);
    expect(read.file.relations).toEqual([]);
    expect(read.file.items[0]?.authority).toBe(IntentAuthority.Candidate);
  });

  it('is byte-stable when the same proposal is captured again (AC-4)', () => {
    capture([proposal()]);
    const first = fs.readFileSync(intentPath, 'utf-8');

    const second = capture([proposal()]);

    expect(fs.readFileSync(intentPath, 'utf-8')).toBe(first);
    expect(second.createdFile).toBe(false);
    expect(second.unchangedItemIds).toEqual(['cap-widget-returns']);
    expect(second.createdItemIds).toEqual([]);
  });

  it('updates the existing candidate in place for the same source identity (BR-6)', () => {
    capture([proposal()]);
    const result = capture([
      proposal({ id: 'cap-widget-returns-other', statement: 'A store operator can return a widget.' }),
    ]);

    expect(result.updatedItemIds).toEqual(['cap-widget-returns']);
    expect(result.unchangedItemIds).toEqual([]);
    const read = readIntentFile(intentPath, { expectedProjectId: PROJECT_ID });
    if (read.status !== 'ready') throw new Error('overlay should be readable');
    expect(read.file.items).toHaveLength(1);
    expect(read.file.items[0]?.statement).toBe('A store operator can return a widget.');
  });
});

describe('captureIntoIntentFile — BR-2 accepted items', () => {
  it('preserves every accepted item byte-for-byte while adding a candidate', () => {
    writeFixtureOverlay();
    const before = readIntentFile(intentPath, { expectedProjectId: PROJECT_ID });
    if (before.status !== 'ready') throw new Error('fixture overlay should be readable');
    const acceptedBefore = before.file.items
      .filter((item) => item.authority === IntentAuthority.Accepted)
      .map(canonicalIntentJson);

    const result = capture([proposal()]);

    const after = readIntentFile(intentPath, { expectedProjectId: PROJECT_ID });
    if (after.status !== 'ready') throw new Error('overlay should be readable');
    const acceptedAfter = after.file.items
      .filter((item) => item.authority === IntentAuthority.Accepted)
      .map(canonicalIntentJson);
    expect(acceptedAfter).toEqual(acceptedBefore);
    expect(result.createdItemIds).toEqual(['cap-widget-returns']);
  });

  it('reports the accepted item sharing a source identity as preserved, not rewritten', () => {
    writeFixtureOverlay();
    const before = readIntentFile(intentPath, { expectedProjectId: PROJECT_ID });
    if (before.status !== 'ready') throw new Error('fixture overlay should be readable');
    const accepted = before.file.items.find((item) => item.authority === IntentAuthority.Accepted);
    if (!accepted) throw new Error('fixture must contain an accepted item');

    const result = capture([proposal({ id: 'cap-widget-ordering-candidate', sources: accepted.sources })]);

    expect(result.preservedAcceptedItemIds).toEqual([accepted.id]);
    expect(result.createdItemIds).toEqual(['cap-widget-ordering-candidate']);
    const after = readIntentFile(intentPath, { expectedProjectId: PROJECT_ID });
    if (after.status !== 'ready') throw new Error('overlay should be readable');
    expect(canonicalIntentJson(after.file.items.find((item) => item.id === accepted.id))).toBe(
      canonicalIntentJson(accepted),
    );
  });

  it('refuses without writing when the proposal would collide with an existing item id', () => {
    writeFixtureOverlay();
    const before = fs.readFileSync(intentPath, 'utf-8');

    expect(() => capture([proposal({ id: 'cap-widget-ordering' })])).toThrow(IntentCaptureError);
    try {
      capture([proposal({ id: 'cap-widget-ordering' })]);
    } catch (error) {
      expect((error as IntentCaptureError).code).toBe(IntentCaptureErrorCode.ItemIdCollision);
    }
    expect(fs.readFileSync(intentPath, 'utf-8')).toBe(before);
  });
});

// AC-15 / AC-20 through the composed file flow
describe('captureIntoIntentFile — derived ids, seeded registry, v1 refusal', () => {
  it('derives the id of an id-less proposal and declares its domain on the created shell', () => {
    const { id: _id, ...withoutId } = proposal() as { id?: string } & Record<string, unknown>;
    const result = capture([withoutId as IntentItemProposal]);

    expect(result.createdItemIds).toEqual(['cap-widget-returns']);
    expect(result.seededDomainIds).toEqual(['returns']);
    const read = readIntentFile(intentPath, { expectedProjectId: PROJECT_ID });
    if (read.status !== 'ready') throw new Error('overlay should be readable');
    expect(read.file.domains.map((domain) => domain.id)).toEqual(['returns']);
    expect(read.file.domains[0]?.title).toBe('TODO review: returns');
    expect(read.file.items[0]?.domain).toBe('returns');
  });

  it('keeps the existing id and reports the supplied one as ignored (BR-17)', () => {
    capture([proposal()]);
    const result = capture([proposal({ id: 'cap-widget-returns-other', statement: 'A store operator returns it.' })]);

    expect(result.updatedItemIds).toEqual(['cap-widget-returns']);
    expect(result.ignoredProposalIds).toEqual(['cap-widget-returns-other']);
  });

  it('never adds a domain to an EXISTING overlay: an undeclared domain is refused (BR-18)', () => {
    writeFixtureOverlay();
    const before = fs.readFileSync(intentPath, 'utf-8');

    expect(() => capture([proposal({ domain: 'payments' })])).toThrow(IntentCaptureError);
    expect(fs.readFileSync(intentPath, 'utf-8')).toBe(before);
  });

  it('refuses a pre-migration v1 overlay with the migration remediation, writing nothing (AC-20)', () => {
    fs.mkdirSync(path.dirname(intentPath), { recursive: true });
    fs.writeFileSync(intentPath, JSON.stringify(readLegacyIntentFixtureJson(), null, 2));
    const before = fs.readFileSync(intentPath, 'utf-8');

    try {
      capture([proposal()]);
      throw new Error('expected a capture refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentOverlayInvalidError);
      expect((error as IntentOverlayInvalidError).errors[0]?.code).toBe(IntentValidationCode.LegacySchemaVersion);
      expect((error as IntentOverlayInvalidError).message).toContain('migration');
    }
    expect(fs.readFileSync(intentPath, 'utf-8')).toBe(before);
  });
});

describe('captureIntoIntentFile — invalid or foreign overlay', () => {
  it('refuses an invalid existing overlay without writing', () => {
    fs.mkdirSync(path.dirname(intentPath), { recursive: true });
    fs.writeFileSync(intentPath, '{ not json');

    expect(() => capture([proposal()])).toThrow(IntentOverlayInvalidError);
    expect(fs.readFileSync(intentPath, 'utf-8')).toBe('{ not json');
  });

  it('refuses an overlay belonging to another project without writing', () => {
    writeFixtureOverlay();
    const before = fs.readFileSync(intentPath, 'utf-8');

    expect(() =>
      captureIntoIntentFile(intentPath, [proposal()], {
        expectedProjectId: 'other-project',
        containmentRoot: repoRoot,
      }),
    ).toThrow(IntentOverlayInvalidError);
    expect(fs.readFileSync(intentPath, 'utf-8')).toBe(before);
  });
});

describe('parseIntentProposalsDocument — AC-11 schema denial', () => {
  it('accepts a document of typed proposals', () => {
    const proposals = parseIntentProposalsDocument({ items: [proposal()] }, PROJECT_ID);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe('cap-widget-returns');
  });

  it('accepts a proposal that omits its id and leaves the id to capture (BR-17)', () => {
    const { id: _id, ...withoutId } = proposal() as { id?: string } & Record<string, unknown>;
    const proposals = parseIntentProposalsDocument({ items: [withoutId] }, PROJECT_ID);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).not.toHaveProperty('id');
  });

  it('rejects a supplied id that is not a slug for the proposal kind (BR-16)', () => {
    expect(() => parseIntentProposalsDocument({ items: [proposal({ id: 'CAP-9' })] }, PROJECT_ID)).toThrow(
      IntentProposalsInvalidError,
    );
  });

  it('rejects a proposal with no domain', () => {
    const { domain: _domain, ...withoutDomain } = proposal() as { domain?: string } & Record<string, unknown>;
    expect(() => parseIntentProposalsDocument({ items: [withoutDomain] }, PROJECT_ID)).toThrow(
      IntentProposalsInvalidError,
    );
  });

  it('rejects an unknown key inside a payload with a path', () => {
    try {
      parseIntentProposalsDocument(
        { items: [{ ...proposal(), payload: { ...proposal().payload, transcript: 'LEAKED-MARKER' } }] },
        PROJECT_ID,
      );
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentProposalsInvalidError);
      expect((error as IntentProposalsInvalidError).errors.some((e) => e.path.includes('payload'))).toBe(true);
    }
  });

  it('rejects an unknown top-level key in the document', () => {
    expect(() => parseIntentProposalsDocument({ items: [proposal()], sourceBody: 'x' }, PROJECT_ID)).toThrow(
      IntentProposalsInvalidError,
    );
  });

  it('rejects a proposal that tries to set authority (BR-1)', () => {
    expect(() =>
      parseIntentProposalsDocument({ items: [{ ...proposal(), authority: 'accepted' }] }, PROJECT_ID),
    ).toThrow(IntentProposalsInvalidError);
  });

  it('rejects an oversized statement', () => {
    expect(() =>
      parseIntentProposalsDocument({ items: [proposal({ statement: 'x'.repeat(5000) })] }, PROJECT_ID),
    ).toThrow(IntentProposalsInvalidError);
  });

  it('rejects an empty document', () => {
    expect(() => parseIntentProposalsDocument({ items: [] }, PROJECT_ID)).toThrow(IntentProposalsInvalidError);
  });

  // Regression: the provisional-id pass used to seed its `taken` set only from
  // OTHER provisional ids, so an id-less sibling that would derive the SAME id
  // as an explicit one collided against a key the author never wrote, and a
  // legal batch was rejected.
  it('accepts an explicit id alongside an id-less sibling that would derive the same id', () => {
    const explicit = proposal({
      id: 'br-refund-window',
      kind: IntentKind.BusinessRule,
      title: 'Any title at all',
      statement: 'A refund is only honored inside the refund window.',
      payload: {
        condition: 'A refund is requested within the posted window',
        requiredOutcome: 'The refund is honored',
        observer: 'Store operator',
      },
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/refund-window', localId: 'BR-1' }],
    });
    const { id: _id, ...idLess } = proposal({
      kind: IntentKind.BusinessRule,
      title: 'Refund window',
      statement: 'Refunds must be requested within the posted refund window.',
      payload: {
        condition: 'A refund is requested within the posted window',
        requiredOutcome: 'The refund is honored',
        observer: 'Store operator',
      },
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/refund-window', localId: 'BR-2' }],
    }) as { id?: string } & Record<string, unknown>;

    const proposals = parseIntentProposalsDocument({ items: [explicit, idLess] }, PROJECT_ID);

    expect(proposals[0]?.id).toBe('br-refund-window');
    expect(proposals[1]).not.toHaveProperty('id');
  });

  it('captures an explicit id alongside an id-less same-derivation proposal with a -2 suffix (real capture path)', () => {
    const explicit = proposal({
      id: 'br-refund-window',
      kind: IntentKind.BusinessRule,
      title: 'Any title at all',
      statement: 'A refund is only honored inside the refund window.',
      payload: {
        condition: 'A refund is requested within the posted window',
        requiredOutcome: 'The refund is honored',
        observer: 'Store operator',
      },
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/refund-window', localId: 'BR-1' }],
    });
    const { id: _id, ...idLess } = proposal({
      kind: IntentKind.BusinessRule,
      title: 'Refund window',
      statement: 'Refunds must be requested within the posted refund window.',
      payload: {
        condition: 'A refund is requested within the posted window',
        requiredOutcome: 'The refund is honored',
        observer: 'Store operator',
      },
      sources: [{ kind: IntentSourceKind.Spec, ref: 'spec/refund-window', localId: 'BR-2' }],
    }) as { id?: string } & Record<string, unknown>;

    const result = capture([explicit, idLess as IntentItemProposal]);

    expect(result.createdItemIds).toEqual(expect.arrayContaining(['br-refund-window', 'br-refund-window-2']));
    expect(result.createdItemIds).toHaveLength(2);
  });
});

describe('captureIntoIntentFile — containment on the created-shell path', () => {
  it('refuses to create an overlay whose directory is symlinked outside the containment root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-intent-outside-'));
    try {
      // `.coredoc` itself is the escape: the overlay does not exist yet, so the
      // reader's containment check never runs and only the write is left.
      fs.symlinkSync(outside, path.dirname(intentPath), 'dir');

      expect(() => capture([proposal()])).toThrow(/path escapes repository/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('still creates the overlay when the missing path stays inside the containment root', () => {
    const result = capture([proposal()]);
    expect(result.createdFile).toBe(true);
  });
});

describe('parseIntentProposalsDocument — bounded error reporting', () => {
  it('bounds every message when the document carries a huge unknown top-level key', () => {
    try {
      parseIntentProposalsDocument({ items: [proposal()], ['k'.repeat(50_000)]: 'x' }, PROJECT_ID);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentProposalsInvalidError);
      for (const issue of (error as IntentProposalsInvalidError).errors) {
        expect(issue.message.length).toBeLessThanOrEqual(INTENT_ERROR_REPORT_LIMITS.messageChars);
      }
    }
  });
});
