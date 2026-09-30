/** Numeric helpers for cent amounts. */

/** Round to whole cents, halves away from zero (1049.5 -> 1050). */
export function roundCurrency(amountCents: number): number {
  const sign = amountCents < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(amountCents) + 0.5);
}

export function formatCents(amountCents: number): string {
  const whole = Math.trunc(amountCents / 100);
  const remainder = Math.abs(amountCents % 100).toString().padStart(2, '0');
  return `${whole}.${remainder}`;
}
