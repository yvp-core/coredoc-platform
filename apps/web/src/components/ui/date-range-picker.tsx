/**
 * Time-window picker for the Analytics page, adapted from
 * github.com/johnpolacek/date-range-picker-for-shadcn (MIT). The web mirror of
 * `apps/desktop/src/renderer/components/ui/date-range-picker.tsx`.
 *
 * The upstream compare feature and its preset list are gone: the presets here are
 * the three the server clamps to (7 / 30 / 90 days) and anything else is a custom
 * UTC calendar range.
 *
 * The whole control is one trigger button; the draft lives inside the popover and
 * only reaches `onChange` when Update is pressed with a valid range, so a half-typed
 * range never issues a read. Closing the popover (Escape, outside click, Cancel)
 * discards the draft — it is re-derived from `value` on every open.
 *
 * ### Days are strings, never instants
 * `AnalyticsWindow` speaks `YYYY-MM-DD` UTC calendar days. react-day-picker speaks
 * `Date`, and it *reads* a `Date` with the local field getters (`getDate()`), so a
 * UTC-midnight `Date` would render as the previous day west of Greenwich. The two
 * converters below therefore pair a local-field constructor with local-field
 * getters: the round-trip is exact in every zone and the string — the thing the
 * server sees — never shifts. `todayIso()` keeps the *boundary* in UTC.
 */

import { CalendarIcon, CheckIcon, ChevronDownIcon } from 'lucide-react';
import * as React from 'react';
import type { DateRange } from 'react-day-picker';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { DateInput } from '@/components/ui/date-input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  type AnalyticsWindow,
  AnalyticsWindowKind,
  DAY_PRESETS,
  MAX_ANALYTICS_DAYS,
  customWindowError,
  todayIso,
} from '@/features/analytics/types.js';
import { cn } from '@/lib/utils';

const DAY_MS = 86_400_000;

const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

/**
 * The active range, short enough to sit on the trigger:
 * `1 Aug – 14 Aug`, or `28 Dec 25 – 3 Jan` when the range crosses a year.
 */
export function customRangeLabel(since: string, until: string): string {
  const year = since.slice(0, 4) === until.slice(0, 4) ? '' : ` ${since.slice(2, 4)}`;
  const from = DAY_MONTH.format(new Date(`${since}T00:00:00Z`));
  const to = DAY_MONTH.format(new Date(`${until}T00:00:00Z`));
  return `${from}${year} – ${to}`;
}

/** `YYYY-MM-DD` → the same calendar day as a local-midnight `Date` (see header). */
export function dayToDate(day: string): Date {
  const [year, month, date] = day.split('-');
  return new Date(Number(year), Number(month) - 1, Number(date));
}

/** The inverse of {@link dayToDate}, read with the matching local field getters. */
export function dateToDay(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/** The last `days` UTC days, ending today inclusive — what `days=N` means server-side. */
export function presetRange(days: number, today = todayIso()): { since: string; until: string } {
  const untilMs = Date.parse(`${today}T00:00:00Z`);
  return { since: new Date(untilMs - (days - 1) * DAY_MS).toISOString().slice(0, 10), until: today };
}

/** What the trigger says: the preset by name, or the range itself. */
export function windowLabel(window: AnalyticsWindow): string {
  return window.kind === AnalyticsWindowKind.Days
    ? `Last ${window.days} days`
    : customRangeLabel(window.since, window.until);
}

interface Draft {
  /** The preset this draft came from, or null once the range was edited by hand. */
  days: number | null;
  since: string;
  until: string;
}

function draftFrom(window: AnalyticsWindow, today: string): Draft {
  return window.kind === AnalyticsWindowKind.Days
    ? { days: window.days, ...presetRange(window.days, today) }
    : { days: null, since: window.since, until: window.until };
}

/**
 * Two months side by side is the upstream layout, but it needs ~520px. Below that
 * the popover would be wider than the viewport it floats in, so drop to one.
 */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia('(max-width: 959px)');
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return narrow;
}

export interface DateRangePickerProps {
  value: AnalyticsWindow;
  onChange: (window: AnalyticsWindow) => void;
  align?: 'start' | 'center' | 'end';
}

export function DateRangePicker({ value, onChange, align = 'end' }: DateRangePickerProps) {
  const today = todayIso();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(value, today));
  const narrow = useIsNarrow();

  const error = customWindowError(draft.since, draft.until);

  const selected: DateRange | undefined =
    draft.since === ''
      ? undefined
      : { from: dayToDate(draft.since), to: draft.until === '' ? undefined : dayToDate(draft.until) };

  // The month the calendar opens on: the end of the draft, with the *previous*
  // month to its left when both fit, so the whole range is usually visible.
  const anchor = dayToDate(draft.until === '' ? today : draft.until);
  const defaultMonth = new Date(anchor.getFullYear(), anchor.getMonth() - (narrow ? 0 : 1), 1);

  const apply = () => {
    setOpen(false);
    onChange(
      draft.days === null
        ? { kind: AnalyticsWindowKind.Custom, since: draft.since, until: draft.until }
        : { kind: AnalyticsWindowKind.Days, days: draft.days },
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Every open starts from the committed window; every close throws the draft away.
        if (next) setDraft(draftFrom(value, today));
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <CalendarIcon />
          {windowLabel(value)}
          <ChevronDownIcon className="text-ink-4" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align={align} className="w-auto">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-end gap-1.5">
            <DateInput
              aria-label="From date"
              aria-invalid={error !== null}
              value={draft.since}
              onChange={(since) => setDraft({ days: null, since, until: draft.until })}
            />
            <span aria-hidden="true" className="text-ink-4">
              –
            </span>
            <DateInput
              aria-label="To date"
              aria-invalid={error !== null}
              value={draft.until}
              onChange={(until) => setDraft({ days: null, since: draft.since, until })}
            />
          </div>

          <div className="flex gap-2">
            <Calendar
              mode="range"
              numberOfMonths={narrow ? 1 : 2}
              defaultMonth={defaultMonth}
              selected={selected}
              // `max` is react-day-picker's own clamp: it greys out every day that
              // would push the range past MAX_ANALYTICS_DAYS from the picked start.
              max={MAX_ANALYTICS_DAYS}
              disabled={{ after: dayToDate(today) }}
              onSelect={(range) =>
                setDraft({
                  days: null,
                  since: range?.from ? dateToDay(range.from) : '',
                  until: range?.to ? dateToDay(range.to) : '',
                })
              }
            />
            <div className="flex flex-col gap-1 border-l border-border py-3 pl-2">
              {DAY_PRESETS.map((days) => (
                <Button
                  key={days}
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  aria-pressed={draft.days === days}
                  onClick={() => setDraft({ days, ...presetRange(days, today) })}
                >
                  <CheckIcon className={cn(draft.days === days ? 'opacity-70' : 'opacity-0')} />
                  Last {days} days
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          {error === null ? null : (
            <p role="alert" className="mr-auto text-[12.5px] text-danger-text">
              {error}
            </p>
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={error !== null} onClick={apply}>
            Update
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

DateRangePicker.displayName = 'DateRangePicker';
