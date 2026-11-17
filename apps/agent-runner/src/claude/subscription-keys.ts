/**
 * Development runners only: several Claude subscription tokens, used one at a time. A key that reaches
 * a plan limit is set aside until the limit resets and the next one takes over.
 */
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { MAX_SUBSCRIPTION_KEYS, type SubscriptionKeyStatus } from '@coredoc/core/agent-runner';

export interface SubscriptionKey {
  label: string;
  token: string;
}

type UsageWindow = NonNullable<SubscriptionKeyStatus['fiveHour']>;
export interface PlanUsage {
  fiveHour?: UsageWindow | null;
  sevenDay?: UsageWindow | null;
}

/** Used when a limit was reached and nothing said when it resets. */
const UNKNOWN_RESET_MS = 60 * 60_000;
/** Claude Code's wording for a reached plan limit; a brief 429 does not match. */
const LIMIT_REACHED_TEXT = /you've (hit|reached) your|usage limit|out of (extra )?usage/i;

export function usageLimitReached(text: string): boolean {
  return LIMIT_REACHED_TEXT.test(text);
}

/** The two windows the settings show, out of the SDK's `/usage` answer; null when the credential has no plan limits. */
export function planUsageOf(usage: {
  rate_limits: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null;
    seven_day?: { utilization: number | null; resets_at: string | null } | null;
  } | null;
}): PlanUsage | null {
  if (!usage.rate_limits) return null;
  const window = (source: { utilization: number | null; resets_at: string | null } | null | undefined) =>
    source
      ? {
          utilization: source.utilization === null ? null : Math.min(100, Math.max(0, source.utilization)),
          resetsAt: source.resets_at ? new Date(source.resets_at).toISOString() : null,
        }
      : null;
  return { fiveHour: window(usage.rate_limits.five_hour), sevenDay: window(usage.rate_limits.seven_day) };
}

/** `label:token,label:token`; a bare token is labelled by its position. */
export function parseSubscriptionKeys(value: string): SubscriptionKey[] {
  const keys = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const separator = entry.indexOf(':');
      const label = separator > 0 ? entry.slice(0, separator).trim() : `key-${index + 1}`;
      return { label: label.slice(0, 40), token: separator > 0 ? entry.slice(separator + 1).trim() : entry };
    });
  if (keys.length > MAX_SUBSCRIPTION_KEYS) throw new Error(`At most ${MAX_SUBSCRIPTION_KEYS} subscription keys.`);
  if (new Set(keys.map((key) => key.label)).size !== keys.length || keys.some((key) => !key.token)) {
    throw new Error('Subscription keys need distinct labels and non-empty tokens.');
  }
  return keys;
}

interface KeyState {
  exhaustedUntil: number | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  checkedAt: number | null;
}

// ponytail: state lives in memory, so a restarted (or one-turn) runner rediscovers an exhausted key by
// hitting its limit once more. Persist it if runners restart often enough for that to matter.
export class SubscriptionKeys {
  private readonly states = new Map<string, KeyState>();

  constructor(
    private readonly keys: SubscriptionKey[],
    private readonly now: () => number = Date.now,
  ) {
    for (const key of keys) {
      this.states.set(key.label, { exhaustedUntil: null, fiveHour: null, sevenDay: null, checkedAt: null });
    }
  }

  /** The first key not at a limit, or null when every key is. */
  current(): SubscriptionKey | null {
    return this.keys.find((key) => (this.states.get(key.label)?.exhaustedUntil ?? 0) <= this.now()) ?? null;
  }

  /** When the first exhausted key is usable again. */
  nextResetAt(): Date | null {
    const resets = [...this.states.values()].flatMap((state) => state.exhaustedUntil ?? []);
    return resets.length > 0 ? new Date(Math.min(...resets)) : null;
  }

  markExhausted(label: string, resetsAt: number | null): void {
    const state = this.states.get(label);
    if (!state) return;
    const known = (resetsAt === null ? windowsAtLimit(state) : [resetsAt]).filter((at) => at > this.now());
    state.exhaustedUntil = known.length > 0 ? Math.max(...known) : this.now() + UNKNOWN_RESET_MS;
  }

  recordUsage(label: string, usage: PlanUsage): void {
    const state = this.states.get(label);
    if (!state) return;
    if (usage.fiveHour !== undefined) state.fiveHour = usage.fiveHour;
    if (usage.sevenDay !== undefined) state.sevenDay = usage.sevenDay;
    state.checkedAt = this.now();
  }

  /** The stream's own report: only the window that changed, and it is all there is when `/usage` is unavailable. */
  recordRateLimit(label: string, info: SDKRateLimitInfo): void {
    const window: UsageWindow = {
      // Reported as a fraction where `/usage` reports a percentage.
      utilization: info.utilization === undefined ? null : Math.min(100, Math.round(info.utilization * 100)),
      resetsAt: info.resetsAt === undefined ? null : new Date(epochMs(info.resetsAt)).toISOString(),
    };
    if (info.rateLimitType === 'five_hour') this.recordUsage(label, { fiveHour: window });
    if (info.rateLimitType === 'seven_day') this.recordUsage(label, { sevenDay: window });
  }

  report(): SubscriptionKeyStatus[] {
    const active = this.current()?.label;
    return this.keys.map(({ label }) => {
      const state = this.states.get(label)!;
      const exhausted = state.exhaustedUntil !== null && state.exhaustedUntil > this.now();
      return {
        label,
        active: label === active,
        exhaustedUntil: exhausted ? new Date(state.exhaustedUntil!).toISOString() : null,
        fiveHour: state.fiveHour,
        sevenDay: state.sevenDay,
        checkedAt: state.checkedAt === null ? null : new Date(state.checkedAt).toISOString(),
      };
    });
  }
}

/** The SDK gives the reset as a Unix time in seconds. */
export function epochMs(resetsAt: number): number {
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

function windowsAtLimit(state: KeyState): number[] {
  return [state.fiveHour, state.sevenDay].flatMap((window) =>
    (window?.utilization ?? 0) >= 100 && window?.resetsAt ? [Date.parse(window.resetsAt)] : [],
  );
}
