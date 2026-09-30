import { createHash, randomUUID } from "node:crypto";

import { captureEvent, captureReceipt } from "./contract.mjs";
import { createFileOutbox } from "./file-outbox.mjs";
import {
  CAPTURE_HEALTH_ERROR_CODES,
  captureHealthSnapshot,
  emptyCaptureHealth,
  persistCaptureHealth,
} from "./health.mjs";

const DEFAULT_TIMEOUT_MS = 4_500;
const MANAGED_CAPTURE_ENDPOINT =
  "http://127.0.0.1:43181/capture/v1/events";
const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const BINDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGED_INGRESS_RE = /^[A-Za-z0-9_-]{32,256}$/;
const RECORD_FIELDS = new Set([
  "schemaVersion",
  "occurredAt",
  "type",
  "runId",
  "taskId",
  "data",
]);

function captureRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("capture record must be an object");
  }
  for (const field of Object.keys(input)) {
    if (!RECORD_FIELDS.has(field)) {
      throw new Error(`Unsupported capture record field: ${field}`);
    }
  }
  return input;
}

function captureTarget(value) {
  if (value === "") return "";
  const target = new URL(value);
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new Error(
      "capture target must be an http(s) URL without credentials or query data",
    );
  }
  return target.href;
}

export function captureHeaders(input = {}) {
  if (typeof input === "string") {
    if (input.trim() === "") return {};
    return Object.fromEntries(
      input.split(",").map((entry) => {
        const separator = entry.indexOf("=");
        if (separator < 1) {
          throw new Error("capture headers must use Name=Value entries");
        }
        return [
          entry.slice(0, separator).trim(),
          entry.slice(separator + 1).trim(),
        ];
      }),
    );
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("capture headers must be an object or Name=Value string");
  }
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        typeof value !== "string" ||
        /[\r\n]/.test(value)
      ) {
        throw new Error("capture headers contain an invalid name or value");
      }
      return [name, value];
    }),
  );
}

function compactWorkspaceId(value) {
  if (typeof value !== "string" || !WORKSPACE_ID_RE.test(value)) {
    throw new Error("capture workspaceId must be a compact identifier");
  }
  return value;
}

function workspaceIdForTarget(target, configuredWorkspaceId) {
  const parsed = new URL(target);
  const managedListener =
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.port === "43181";
  if (managedListener) {
    if (target !== MANAGED_CAPTURE_ENDPOINT) {
      throw new Error("managed capture target must use the exact relay endpoint");
    }
    return compactWorkspaceId(configuredWorkspaceId);
  }

  const pathname = parsed.pathname;
  const match = /^\/api\/v1\/workspaces\/([^/]+)\/capture\/v1\/events\/?$/.exec(
    pathname,
  );
  if (!match) {
    throw new Error("capture target must use the workspace capture/v1/events path");
  }
  let derived;
  try {
    derived = compactWorkspaceId(decodeURIComponent(match[1]));
  } catch {
    throw new Error("capture target contains an invalid workspaceId");
  }
  if (
    configuredWorkspaceId !== undefined &&
    compactWorkspaceId(configuredWorkspaceId) !== derived
  ) {
    throw new Error("capture workspaceId conflicts with the capture target");
  }
  return derived;
}

function bindingFor(target, headers, workspaceId) {
  const authorization = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "authorization",
  );
  const localBinding = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "x-coredoc-relay-binding",
  );
  const ingress = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "x-coredoc-relay-ingress",
  );
  const bindingId = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "x-coredoc-relay-binding-id",
  );
  const managedIngress = ingress.length === 1 && bindingId.length === 1;
  if (
    authorization.length + localBinding.length + (managedIngress ? 1 : 0) !== 1 ||
    authorization.length > 1 ||
    localBinding.length > 1 ||
    ingress.length > 1 ||
    bindingId.length > 1 ||
    ingress.length !== bindingId.length
  ) {
    throw new Error(
      "configured capture requires exactly one supported binding header",
    );
  }
  if (
    managedIngress &&
    (!MANAGED_INGRESS_RE.test(ingress[0][1]) ||
      !BINDING_ID_RE.test(bindingId[0][1]))
  ) {
    throw new Error("configured capture binding header is invalid");
  }
  const [kind, credential] = managedIngress
    ? [
        "x-coredoc-relay-ingress",
        `${createHash("sha256").update(ingress[0][1]).digest("hex")}:${bindingId[0][1].toLowerCase()}`,
      ]
    :
    authorization.length === 1
      ? ["authorization", authorization[0][1]]
      : ["x-coredoc-relay-binding", localBinding[0][1]];
  if (
    credential.length < 1 ||
    credential.length > 512 ||
    (kind !== "authorization" && /[\s\0]/.test(credential))
  ) {
    throw new Error("configured capture binding header is invalid");
  }
  const resolvedWorkspaceId = workspaceIdForTarget(target, workspaceId);
  if (
    target === MANAGED_CAPTURE_ENDPOINT &&
    kind !== "x-coredoc-relay-binding" &&
    kind !== "x-coredoc-relay-ingress"
  ) {
    throw new Error(
      "managed capture target requires X-Coredoc-Relay-Binding",
    );
  }
  if (target !== MANAGED_CAPTURE_ENDPOINT && kind !== "authorization") {
    throw new Error("direct capture target requires Authorization");
  }
  return {
    endpoint: target,
    workspaceId: resolvedWorkspaceId,
    credentialFingerprint: createHash("sha256")
      .update(credential)
      .digest("hex"),
  };
}

async function postBatch(
  target,
  batch,
  { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  let response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw deliveryError("TRANSPORT_UNAVAILABLE");
  }
  if (!response.ok) {
    throw deliveryError(deliveryStatusCode(target, response.status));
  }
  try {
    return await response.json();
  } catch {
    throw deliveryError("TRANSPORT_UNAVAILABLE");
  }
}

function deliveryError(code) {
  return Object.assign(new Error(code), { code });
}

function deliveryStatusCode(target, status) {
  if (status === 403) return "AUTH_REJECTED";
  if (status === 401) {
    return target === MANAGED_CAPTURE_ENDPOINT
      ? "BINDING_MISMATCH"
      : "AUTH_REJECTED";
  }
  return "TRANSPORT_UNAVAILABLE";
}

function deliveryFailureCode(error, target) {
  if (
    typeof error?.code === "string" &&
    CAPTURE_HEALTH_ERROR_CODES.includes(error.code)
  ) {
    return error.code;
  }
  return deliveryStatusCode(target, error?.status);
}

function emptyReceipt() {
  return { acceptedEventIds: [], duplicateEventIds: [], rejected: [] };
}

export function createCaptureRecorder({
  directory,
  target = "",
  headers = {},
  workspaceId,
  context,
  idFactory = randomUUID,
  maxEntries = 100,
  now = () => new Date().toISOString(),
}) {
  const resolvedTarget = captureTarget(target);
  const resolvedHeaders = captureHeaders(headers);
  const outbox = resolvedTarget
    ? createFileOutbox({
        directory,
        maxEntries,
        binding: bindingFor(resolvedTarget, resolvedHeaders, workspaceId),
      })
    : null;
  const base = {
    host: context?.host,
    sessionId: context?.sessionId,
    ...(context?.repositoryKey === undefined
      ? {}
      : { repositoryKey: context.repositoryKey }),
  };

  return {
    record(input) {
      const record = captureRecord(input);
      const event = captureEvent({
        eventId: idFactory(),
        ...base,
        ...record,
        schemaVersion: record.schemaVersion ?? 1,
      });
      if (!outbox) return { status: "disabled" };
      const queued = outbox.enqueue(event);
      try {
        persistCaptureHealth({
          directory,
          status: outbox.status(),
          ...(queued.status === "overflow"
            ? {
                errorCode: "OUTBOX_OVERFLOW",
                increments: { overflow: 1 },
              }
            : {}),
          now,
        });
      } catch {
        // The enqueue outcome remains visible even when local diagnostics cannot
        // be replaced safely on an already-unwritable filesystem.
      }
      return queued;
    },
    pending(options) {
      return outbox?.list(options) ?? [];
    },
    health() {
      return outbox
        ? captureHealthSnapshot(directory, outbox.status())
        : emptyCaptureHealth();
    },
    async flush({ send = postBatch, timeoutMs } = {}) {
      if (!outbox) {
        return {
          attempted: 0,
          accepted: 0,
          duplicates: 0,
          rejected: 0,
          unmatched: 0,
          pending: 0,
          bindingRefused: 0,
          unreadable: 0,
          receipt: emptyReceipt(),
        };
      }
      const events = outbox.list();
      const before = outbox.status();
      if (events.length === 0) {
        return {
          attempted: 0,
          accepted: 0,
          duplicates: 0,
          rejected: 0,
          unmatched: 0,
          pending: 0,
          bindingRefused: before.bindingRefused,
          unreadable: before.unreadable,
          receipt: emptyReceipt(),
        };
      }
      let rawReceipt;
      try {
        rawReceipt = await send(
          resolvedTarget,
          { events },
          {
            headers: resolvedHeaders,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          },
        );
      } catch (error) {
        try {
          persistCaptureHealth({
            directory,
            status: outbox.status(),
            errorCode: deliveryFailureCode(error, resolvedTarget),
            increments: { transportFailures: 1 },
            now,
          });
        } catch {
          // Delivery still fails closed if its bounded diagnostic cannot persist.
        }
        throw error;
      }
      let receipt;
      try {
        receipt = captureReceipt(
          rawReceipt,
          events.map(({ eventId }) => eventId),
        );
      } catch (error) {
        try {
          persistCaptureHealth({
            directory,
            status: outbox.status(),
            errorCode: "TRANSPORT_UNAVAILABLE",
            increments: { transportFailures: 1 },
            now,
          });
        } catch {
          // The untrusted receipt remains refused even without health persistence.
        }
        throw error;
      }
      const categorized = new Set([
        ...receipt.acceptedEventIds,
        ...receipt.duplicateEventIds,
        ...receipt.rejected.flatMap(({ eventId }) =>
          eventId === null ? [] : [eventId],
        ),
      ]);
      const unmatched = events.filter(({ eventId }) => !categorized.has(eventId));
      outbox.acknowledge([
        ...receipt.acceptedEventIds,
        ...receipt.duplicateEventIds,
        ...receipt.rejected.flatMap(({ eventId }) =>
          eventId === null ? [] : [eventId],
        ),
      ]);
      const after = outbox.status();
      const unsupportedSchemaVersions = receipt.rejected.filter(
        ({ code }) => code === "UNSUPPORTED_SCHEMA_VERSION",
      ).length;
      try {
        persistCaptureHealth({
          directory,
          status: after,
          errorCode:
            unsupportedSchemaVersions > 0
              ? "UNSUPPORTED_SCHEMA_VERSION"
              : null,
          ...(unsupportedSchemaVersions > 0
            ? { increments: { unsupportedSchemaVersions } }
            : {}),
          now,
        });
      } catch {
        // A validated receipt still owns acknowledgement; health is secondary.
      }
      return {
        attempted: events.length,
        accepted: receipt.acceptedEventIds.length,
        duplicates: receipt.duplicateEventIds.length,
        rejected: receipt.rejected.length,
        unmatched: unmatched.length,
        pending: after.pending,
        bindingRefused: after.bindingRefused,
        unreadable: after.unreadable,
        receipt,
      };
    },
  };
}

export { captureEvent, createFileOutbox };
