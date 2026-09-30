/**
 * Three-segment M / D / YYYY field, adapted from
 * github.com/johnpolacek/date-range-picker-for-shadcn (MIT). The web mirror of
 * `apps/desktop/src/renderer/components/ui/date-input.tsx`.
 *
 * The value is a **calendar day string** (`YYYY-MM-DD`), not a `Date`: the analytics
 * window is a UTC calendar day and a `Date` would drag a local-timezone instant
 * through every edit. All arithmetic here is on the three integers.
 *
 * `onChange` fires only for a day that actually exists (31 Feb never escapes), and a
 * segment left empty or impossible on blur snaps back to the last good value.
 *
 * `aria-label` names the field ("From date"); each segment is labelled from it.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

interface DateParts {
  day: number;
  month: number;
  year: number;
}

export interface DateInputProps {
  /** `YYYY-MM-DD`; anything else (including '') falls back to today. */
  value: string;
  onChange: (day: string) => void;
  'aria-label': string;
  'aria-invalid'?: boolean;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (value: number, length: number) => String(value).padStart(length, '0');

/** Day count of a Gregorian month — plain calendar arithmetic, no instant involved. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function toParts(value: string): DateParts {
  const match = DAY_PATTERN.exec(value);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

function toDay({ year, month, day }: DateParts): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function isRealDate({ year, month, day }: DateParts): boolean {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

const SEGMENT_CLASS = 'border-none bg-transparent p-0 text-center outline-none tabular-nums';

const DateInput: React.FC<DateInputProps> = ({ value, onChange, 'aria-invalid': invalid, ...aria }) => {
  const [parts, setParts] = React.useState<DateParts>(() => toParts(value));
  const lastGood = React.useRef<DateParts>(parts);

  const monthRef = React.useRef<HTMLInputElement | null>(null);
  const dayRef = React.useRef<HTMLInputElement | null>(null);
  const yearRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    const next = toParts(value);
    setParts(next);
    lastGood.current = next;
  }, [value]);

  const commit = (next: DateParts) => {
    setParts(next);
    if (isRealDate(next)) {
      lastGood.current = next;
      onChange(toDay(next));
    }
  };

  const handleChange = (field: keyof DateParts) => (event: React.ChangeEvent<HTMLInputElement>) => {
    // An empty segment is a legal intermediate state; it just never commits.
    commit({ ...parts, [field]: event.target.value === '' ? 0 : Number(event.target.value) });
  };

  const handleBlur = () => {
    if (!isRealDate(parts)) setParts(lastGood.current);
  };

  const step = (field: keyof DateParts, direction: 1 | -1): DateParts => {
    const next = { ...parts };
    if (field === 'year') {
      next.year += direction;
      return next;
    }
    if (field === 'month') {
      next.month += direction;
      if (next.month > 12) {
        next.month = 1;
        next.year += 1;
      } else if (next.month < 1) {
        next.month = 12;
        next.year -= 1;
      }
      next.day = Math.min(next.day, daysInMonth(next.year, next.month));
      return next;
    }
    next.day += direction;
    if (next.day > daysInMonth(parts.year, parts.month)) {
      next.day = 1;
      next.month += 1;
      if (next.month > 12) {
        next.month = 1;
        next.year += 1;
      }
    } else if (next.day < 1) {
      next.month -= 1;
      if (next.month < 1) {
        next.month = 12;
        next.year -= 1;
      }
      next.day = daysInMonth(next.year, next.month);
    }
    return next;
  };

  const handleKeyDown = (field: keyof DateParts) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.metaKey || event.ctrlKey) return;

    const navigation = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Tab', 'Backspace', 'Enter'];
    if (!/^[0-9]$/.test(event.key) && !navigation.includes(event.key)) {
      event.preventDefault();
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      commit(step(field, event.key === 'ArrowUp' ? 1 : -1));
      return;
    }

    const input = event.currentTarget;
    const atEnd = input.selectionStart === input.value.length;
    const atStart = input.selectionStart === 0;
    if (event.key === 'ArrowRight' && atEnd) {
      event.preventDefault();
      (field === 'month' ? dayRef : field === 'day' ? yearRef : { current: null }).current?.focus();
    } else if (event.key === 'ArrowLeft' && atStart) {
      event.preventDefault();
      (field === 'year' ? dayRef : field === 'day' ? monthRef : { current: null }).current?.focus();
    }
  };

  const segment = (
    field: keyof DateParts,
    ref: React.RefObject<HTMLInputElement>,
    maxLength: number,
    width: string,
    placeholder: string,
  ) => (
    <input
      type="text"
      inputMode="numeric"
      ref={ref}
      maxLength={maxLength}
      value={parts[field] === 0 ? '' : String(parts[field])}
      onChange={handleChange(field)}
      onKeyDown={handleKeyDown(field)}
      onFocus={(event) => event.target.select()}
      onBlur={handleBlur}
      aria-invalid={invalid}
      className={cn(SEGMENT_CLASS, width)}
      placeholder={placeholder}
      aria-label={`${aria['aria-label']} ${field}`}
    />
  );

  return (
    // The frame is decoration: each segment carries its own name ("From date
    // month") and its own `aria-invalid`, so the wrapper takes neither — only a
    // data attribute for the invalid border.
    <div
      data-invalid={invalid}
      className="border-border bg-surface text-ink-1 data-[invalid=true]:border-danger flex h-7 items-center rounded-md border px-1.5 text-[12px]"
    >
      {segment('month', monthRef, 2, 'w-5', 'M')}
      <span className="text-ink-4">/</span>
      {segment('day', dayRef, 2, 'w-5', 'D')}
      <span className="text-ink-4">/</span>
      {segment('year', yearRef, 4, 'w-9', 'YYYY')}
    </div>
  );
};

DateInput.displayName = 'DateInput';

export { DateInput };
