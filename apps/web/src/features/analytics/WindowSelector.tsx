/**
 * The window control shared by Usage and Delivery: the 7/30/90 presets plus an
 * explicit UTC calendar range, all behind one trigger button.
 *
 * The control itself is `DateRangePicker`; this module is the feature-local name
 * (and prop shape) the two views import, so neither has to know which kit
 * component backs it.
 */

import { DateRangePicker } from '@/components/ui/date-range-picker';
import type { AnalyticsWindow } from './types.js';

export { customRangeLabel } from '@/components/ui/date-range-picker';

export function WindowSelector({
  analyticsWindow,
  onChange,
}: {
  analyticsWindow: AnalyticsWindow;
  onChange: (next: AnalyticsWindow) => void;
}) {
  return <DateRangePicker value={analyticsWindow} onChange={onChange} />;
}
