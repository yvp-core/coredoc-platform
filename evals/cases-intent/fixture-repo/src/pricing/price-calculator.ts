import { roundCurrency } from '../formatting/money.js';
import type { Widget } from '../catalog/catalog.js';

export interface PricedLine {
  sku: string;
  quantity: number;
  lineTotalCents: number;
}

export class PriceCalculator {
  priceLine(widget: Widget, quantity: number): PricedLine {
    const raw = widget.unitPriceCents * quantity;
    return { sku: widget.sku, quantity, lineTotalCents: roundCurrency(raw) };
  }

  orderTotal(lines: PricedLine[], handlingFeeCents: number): number {
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
    return roundCurrency(subtotal + handlingFeeCents);
  }
}
