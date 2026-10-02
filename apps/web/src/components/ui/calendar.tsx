/**
 * shadcn's `Calendar` over react-day-picker v8, restyled onto this app's tokens.
 * The web mirror of `apps/desktop/src/renderer/components/ui/calendar.tsx`.
 *
 * `react-day-picker/dist/style.css` is deliberately NOT imported: every visual is
 * supplied through `classNames` below, so the calendar cannot drift away from
 * `styles.css` (and it follows the dark theme for free).
 */

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import type * as React from 'react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col gap-4 sm:flex-row',
        month: 'flex flex-col gap-3',
        caption: 'relative flex items-center justify-center pt-1',
        caption_label: 'text-[13.5px] font-medium text-ink-1',
        nav: 'flex items-center gap-1',
        nav_button: cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'size-6 rounded-md'),
        nav_button_previous: 'absolute left-1',
        nav_button_next: 'absolute right-1',
        table: 'w-full border-collapse',
        head_row: 'flex',
        head_cell: 'w-8 text-[12px] font-normal text-ink-4',
        row: 'mt-1 flex w-full',
        cell: 'relative p-0 text-center text-[13px] focus-within:relative focus-within:z-20 [&:has([aria-selected])]:bg-surface-2 first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md',
        day: cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'size-8 rounded-md p-0 aria-selected:opacity-100'),
        day_selected: 'bg-brand text-white hover:bg-brand hover:text-white',
        day_today: 'border border-axis',
        day_outside: 'invisible',
        day_disabled: 'text-ink-4 hover:bg-transparent hover:text-ink-4',
        day_range_middle: 'rounded-none aria-selected:bg-surface-2 aria-selected:text-ink-1',
        day_hidden: 'invisible',
        ...classNames,
      }}
      components={{
        IconLeft: () => <ChevronLeftIcon className="size-3.5" />,
        IconRight: () => <ChevronRightIcon className="size-3.5" />,
      }}
      {...props}
    />
  );
}
Calendar.displayName = 'Calendar';

export { Calendar };
