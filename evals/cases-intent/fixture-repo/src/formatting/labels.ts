export function orderLabel(orderId: string, warehouseId: string): string {
  return `Order ${orderId} (${warehouseId})`;
}

export function widgetLabel(sku: string, name: string): string {
  return `${name} [${sku}]`;
}
