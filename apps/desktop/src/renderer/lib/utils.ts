import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a timestamp as relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(timestamp: string | undefined): string {
  if (!timestamp) return 'Never';

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

/**
 * Format a number with commas (e.g., 1,234,567)
 */
export function formatNumber(num: number | undefined): string {
  if (num === undefined) return '-';
  return num.toLocaleString();
}

const DATE_TIME_PARTS = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function dateParts(date: Date): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  return Object.fromEntries(DATE_TIME_PARTS.formatToParts(date).map((part) => [part.type, part.value]));
}

/** `05.01.2026` */
export function formatDate(date: Date): string {
  const p = dateParts(date);
  return `${p.day}.${p.month}.${p.year}`;
}

/** `05.01.2026 / 1:03 PM` */
export function formatDateTime(date: Date): string {
  const p = dateParts(date);
  return `${p.day}.${p.month}.${p.year} / ${p.hour}:${p.minute} ${p.dayPeriod}`;
}
