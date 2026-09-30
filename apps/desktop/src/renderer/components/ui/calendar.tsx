/**
 * shadcn's `Calendar` over react-day-picker v8, restyled onto the shipped tokens.
 *
 * `react-day-picker/dist/style.css` is deliberately NOT imported: every visual is
 * supplied through `classNames` below, so the calendar cannot drift away from
 * `globals.css` (and `design:check` can see it).
 */

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import type * as React from 'react';

import { buttonVariants } from '@/renderer/components/ui/button';
import { cn } from '@/renderer/lib/utils';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-2', className)}
      classNames={{
        months: 'flex flex-col gap-3 sm:flex-row',
        month: 'flex flex-col gap-2',
        caption: 'relative flex items-center justify-center pt-1',
        caption_label: 'text-xs/relaxed font-semibold text-content-primary',
        nav: 'flex items-center gap-1',
        nav_button: cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'rounded-md'),
        nav_button_previous: 'absolute left-1',
        nav_button_next: 'absolute right-1',
        table: 'w-full border-collapse',
        head_row: 'flex',
        head_cell: 'w-7 text-[11px] font-medium text-content-tertiary',
        row: 'mt-1 flex w-full',
        cell: 'relative p-0 text-center text-xs/relaxed focus-within:relative focus-within:z-20 [&:has([aria-selected])]:bg-bg-primary-hover first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md',
        day: cn(
          buttonVariants({ variant: 'ghost' }),
          // The ghost variant carries backdrop-blur; on ~60 day cells that is both a
          // perf hazard (DESIGN.md) and the source of the smeared range wash.
          'size-7 rounded-md p-0 text-xs/relaxed font-medium backdrop-blur-none aria-selected:opacity-100',
        ),
        // `!` on the colour: the ghost variant's `text-content-primary` sits later in the
        // generated CSS than the token below, so without it the selected day stays dark
        // on a black square.
        day_selected:
          'bg-bg-action-primary text-content-inverted! hover:bg-bg-action-primary-hover hover:text-content-inverted!',
        day_today: 'underline underline-offset-2 decoration-content-tertiary',
        day_outside: 'invisible',
        day_disabled: 'text-content-quaternary hover:bg-transparent hover:text-content-quaternary',
        day_range_start: 'rounded-md',
        day_range_end: 'rounded-md',
        day_range_middle: 'rounded-none aria-selected:bg-bg-primary-hover aria-selected:text-content-primary!',
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
