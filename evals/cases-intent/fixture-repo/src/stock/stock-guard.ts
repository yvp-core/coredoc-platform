const AVAILABLE: Record<string, number> = {
  'W-100': 40,
  'W-200': 6,
  'W-300': 120,
};

export class StockGuard {
  available(sku: string): number {
    return AVAILABLE[sku] ?? 0;
  }

  ensureAvailable(sku: string, quantity: number): void {
    if (quantity > this.available(sku)) {
      throw new Error(`insufficient stock for ${sku}`);
    }
  }

  reserve(sku: string, quantity: number): void {
    this.ensureAvailable(sku, quantity);
    AVAILABLE[sku] = this.available(sku) - quantity;
  }
}
