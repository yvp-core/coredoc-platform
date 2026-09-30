import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const CAPTURE_HEALTH_FILE = "capture-health.json";
export const CAPTURE_HEALTH_ERROR_CODES = Object.freeze([
  "AUTH_REJECTED",
  "UNSUPPORTED_SCHEMA_VERSION",
  "OUTBOX_PENDING",
  "OUTBOX_OVERFLOW",
  "BINDING_MISMATCH",
  "TRANSPORT_UNAVAILABLE",
  "CONFIG_CONFLICT",
  "REPOSITORY_ATTRIBUTION_DEGRADED",
]);

const MAX_HEALTH_BYTES = 4_096;
const MAX_COUNTER = 1_000_000;
const MAX_PENDING = 1_000;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HEALTH_FIELDS = new Set([
  "schemaVersion",
  "pendingCount",
  "errorCode",
  "updatedAt",
  "counters",
]);
const COUNTER_FIELDS = new Set([
  "overflow",
  "transportFailures",
  "unsupportedSchemaVersions",
]);

const EMPTY_COUNTERS = Object.freeze({
  overflow: 0,
  transportFailures: 0,
  unsupportedSchemaVersions: 0,
});

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid capture health");
  }
  if (Object.keys(value).some((field) => !fields.has(field))) {
    throw new Error("invalid capture health");
  }
  return value;
}

function boundedInteger(value, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error("invalid capture health");
  }
  return value;
}

function timestamp(value) {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_RE.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error("invalid capture health");
  }
  return value;
}

function errorCode(value) {
  if (value !== null && !CAPTURE_HEALTH_ERROR_CODES.includes(value)) {
    throw new Error("invalid capture health");
  }
  return value;
}

function counters(value) {
  const candidate = exactObject(value, COUNTER_FIELDS);
  return {
    overflow: boundedInteger(candidate.overflow, MAX_COUNTER),
    transportFailures: boundedInteger(
      candidate.transportFailures,
      MAX_COUNTER,
    ),
    unsupportedSchemaVersions: boundedInteger(
      candidate.unsupportedSchemaVersions,
      MAX_COUNTER,
    ),
  };
}

function persistedHealth(value) {
  const candidate = exactObject(value, HEALTH_FIELDS);
  if (candidate.schemaVersion !== 1) {
    throw new Error("invalid capture health");
  }
  return {
    schemaVersion: 1,
    pendingCount: boundedInteger(candidate.pendingCount, MAX_PENDING),
    errorCode: errorCode(candidate.errorCode),
    updatedAt: timestamp(candidate.updatedAt),
    counters: counters(candidate.counters),
  };
}

function emptyHealth() {
  return {
    schemaVersion: 1,
    pendingCount: 0,
    errorCode: null,
    updatedAt: null,
    counters: { ...EMPTY_COUNTERS },
  };
}

function readPersistedHealth(directory) {
  const path = join(directory, CAPTURE_HEALTH_FILE);
  let handle;
  try {
    handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { valid: true, value: emptyHealth() };
    }
    return { valid: false, value: emptyHealth() };
  }
  try {
    const metadata = fstatSync(handle);
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > MAX_HEALTH_BYTES
    ) {
      throw new Error("invalid capture health");
    }
    return {
      valid: true,
      value: persistedHealth(JSON.parse(readFileSync(handle, "utf8"))),
    };
  } catch {
    return { valid: false, value: emptyHealth() };
  } finally {
    closeSync(handle);
  }
}

function outboxStatus(value) {
  const candidate = value ?? {};
  return {
    pending: boundedInteger(candidate.pending ?? 0, MAX_PENDING),
    bindingRefused:
      Number.isInteger(candidate.bindingRefused) && candidate.bindingRefused > 0
        ? candidate.bindingRefused
        : 0,
    unreadable:
      Number.isInteger(candidate.unreadable) && candidate.unreadable > 0
        ? candidate.unreadable
        : 0,
  };
}

function visibleError({ valid, storedError, status }) {
  if (status.bindingRefused > 0) return "BINDING_MISMATCH";
  if (status.unreadable > 0 || !valid) return "CONFIG_CONFLICT";
  if (storedError === "OUTBOX_PENDING" && status.pending === 0) return null;
  if (storedError !== null) return storedError;
  return status.pending > 0 ? "OUTBOX_PENDING" : null;
}

function snapshot(read, status, storedError = read.value.errorCode) {
  const current = outboxStatus(status);
  return {
    schemaVersion: 1,
    pendingCount: current.pending,
    errorCode: visibleError({
      valid: read.valid,
      storedError,
      status: current,
    }),
    updatedAt: read.value.updatedAt,
    counters: { ...read.value.counters },
  };
}

function incrementCounter(value, increment) {
  return Math.min(
    MAX_COUNTER,
    value + boundedInteger(increment, MAX_COUNTER),
  );
}

function nextCounters(current, increments = {}) {
  return {
    overflow: incrementCounter(current.overflow, increments.overflow ?? 0),
    transportFailures: incrementCounter(
      current.transportFailures,
      increments.transportFailures ?? 0,
    ),
    unsupportedSchemaVersions: incrementCounter(
      current.unsupportedSchemaVersions,
      increments.unsupportedSchemaVersions ?? 0,
    ),
  };
}

function atomicWriteHealth(directory, value) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, CAPTURE_HEALTH_FILE);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function captureHealthSnapshot(directory, status) {
  return snapshot(readPersistedHealth(directory), status);
}

export function persistCaptureHealth({
  directory,
  status,
  errorCode: nextError,
  increments,
  now = () => new Date().toISOString(),
}) {
  if (nextError !== undefined) errorCode(nextError);
  const read = readPersistedHealth(directory);
  const currentError =
    nextError === undefined
      ? read.valid
        ? read.value.errorCode
        : "CONFIG_CONFLICT"
      : nextError;
  const value = snapshot(read, status, currentError);
  value.updatedAt = timestamp(now());
  value.counters = nextCounters(read.value.counters, increments);
  atomicWriteHealth(directory, value);
  return value;
}

export function emptyCaptureHealth() {
  return emptyHealth();
}
