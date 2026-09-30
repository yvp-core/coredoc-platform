/**
 * Time-window selector for the Analytics tab (UC-5): the 7/30/90 presets plus an
 * explicit UTC calendar range. The server clamps every analytics read to
 * MAX_ANALYTICS_DAYS, which is both the largest preset and the widest custom range.
 *
 * The whole control is now `DateRangePicker` (a popover with a two-month calendar);
 * this module is the feature-local name the Analytics panel imports, kept so the
 * panel does not have to know which kit component backs it.
 */

export {
  DateRangePicker as WindowSelector,
  customRangeLabel,
  todayUtcDay,
} from '@/renderer/components/ui/date-range-picker';
