export interface Widget {
  sku: string;
  name: string;
  unitPriceCents: number;
  warehouseId: string;
}

const WIDGETS: Widget[] = [
  { sku: 'W-100', name: 'Standard widget', unitPriceCents: 1299, warehouseId: 'wh-1' },
  { sku: 'W-200', name: 'Reinforced widget', unitPriceCents: 2450, warehouseId: 'wh-1' },
  { sku: 'W-300', name: 'Compact widget', unitPriceCents: 799, warehouseId: 'wh-2' },
];

export class Catalog {
  find(sku: string): Widget | undefined {
    return WIDGETS.find((widget) => widget.sku === sku);
  }

  listForWarehouse(warehouseId: string): Widget[] {
    return WIDGETS.filter((widget) => widget.warehouseId === warehouseId);
  }
}
