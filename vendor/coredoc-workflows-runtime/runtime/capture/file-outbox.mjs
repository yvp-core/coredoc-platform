import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { captureEvent } from "./contract.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_FILE_RE = /^([0-9a-f-]{36})\.event\.json$/i;
const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) {
      throw new Error(`Unsupported ${label} field: ${field}`);
    }
  }
  return value;
}

function normalizedEndpoint(value) {
  const target = new URL(value);
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new Error("capture binding endpoint must be an http(s) URL without credentials or query data");
  }
  return target.href;
}

export function captureBinding(input) {
  const candidate = exactObject(
    input,
    new Set(["endpoint", "workspaceId", "credentialFingerprint"]),
    "capture binding",
  );
  if (!WORKSPACE_ID_RE.test(String(candidate.workspaceId ?? ""))) {
    throw new Error("capture binding workspaceId must be a compact identifier");
  }
  if (!FINGERPRINT_RE.test(String(candidate.credentialFingerprint ?? ""))) {
    throw new Error("capture binding credentialFingerprint must be a SHA-256 fingerprint");
  }
  return {
    endpoint: normalizedEndpoint(candidate.endpoint),
    workspaceId: candidate.workspaceId,
    credentialFingerprint: candidate.credentialFingerprint,
  };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error("capture outbox eventId must be a UUID");
  }
  return value.toLowerCase();
}

function entry(value) {
  const candidate = exactObject(
    value,
    new Set(["binding", "event"]),
    "capture outbox entry",
  );
  return {
    binding: captureBinding(candidate.binding),
    event: captureEvent(candidate.event),
  };
}

function visibleStaleEntries(current) {
  return {
    ...(current.mismatched.length > 0
      ? { bindingRefused: current.mismatched.length }
      : {}),
    ...(current.unreadable.length > 0
      ? { unreadable: current.unreadable.length }
      : {}),
  };
}

export function createFileOutbox({ directory, binding, maxEntries = 100 }) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("capture outbox directory is required");
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000) {
    throw new Error("capture outbox maxEntries must be between 1 and 1000");
  }
  const resolvedBinding = captureBinding(binding);
  const pathFor = (value) => join(directory, `${eventId(value)}.event.json`);

  function scan() {
    let names;
    try {
      names = readdirSync(directory).filter((name) => EVENT_FILE_RE.test(name));
    } catch {
      return { matching: [], mismatched: [], unreadable: [] };
    }

    const matching = [];
    const mismatched = [];
    const unreadable = [];
    for (const name of names) {
      const path = join(directory, name);
      try {
        const record = entry(JSON.parse(readFileSync(path, "utf8")));
        if (path !== pathFor(record.event.eventId)) {
          unreadable.push(path);
        } else if (same(record.binding, resolvedBinding)) {
          matching.push({ path, ...record, modifiedAt: statSync(path).mtimeMs });
        } else {
          mismatched.push({ path, ...record });
        }
      } catch {
        unreadable.push(path);
      }
    }
    matching.sort(
      (left, right) =>
        left.event.occurredAt.localeCompare(right.event.occurredAt) ||
        left.event.eventId.localeCompare(right.event.eventId),
    );
    return { matching, mismatched, unreadable };
  }

  return {
    pathFor,
    enqueue(input) {
      const event = captureEvent(input);
      const path = pathFor(event.eventId);
      try {
        const existing = entry(JSON.parse(readFileSync(path, "utf8")));
        if (!same(existing.binding, resolvedBinding)) {
          throw new Error("eventId already exists under a different capture binding");
        }
        if (!same(existing.event, event)) {
          throw new Error("eventId already exists with different content");
        }
        const current = scan();
        return {
          status: "queued",
          eventId: event.eventId,
          pending: current.matching.length,
          ...visibleStaleEntries(current),
        };
      } catch (error) {
        if (
          error?.message === "eventId already exists under a different capture binding" ||
          error?.message === "eventId already exists with different content"
        ) {
          throw error;
        }
        if (existsSync(path)) {
          throw new Error("eventId already exists with unreadable content");
        }
      }

      const current = scan();
      if (current.matching.length >= maxEntries) {
        return {
          status: "overflow",
          eventId: event.eventId,
          pending: current.matching.length,
          ...visibleStaleEntries(current),
        };
      }

      mkdirSync(directory, { recursive: true, mode: 0o700 });
      atomicWriteJson(path, { binding: resolvedBinding, event });
      return {
        status: "queued",
        eventId: event.eventId,
        pending: current.matching.length + 1,
        ...visibleStaleEntries(current),
      };
    },
    list({ limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("capture outbox limit must be between 1 and 100");
      }
      return scan()
        .matching.slice(0, limit)
        .map(({ event }) => event);
    },
    status() {
      const current = scan();
      return {
        pending: current.matching.length,
        bindingRefused: current.mismatched.length,
        unreadable: current.unreadable.length,
      };
    },
    acknowledge(eventIds) {
      for (const value of new Set(eventIds)) {
        const path = pathFor(value);
        try {
          const existing = entry(JSON.parse(readFileSync(path, "utf8")));
          if (same(existing.binding, resolvedBinding)) {
            rmSync(path, { force: true });
          }
        } catch {
          // Never remove an unreadable or differently-bound entry by guess.
        }
      }
    },
  };
}
