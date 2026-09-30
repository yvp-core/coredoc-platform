export interface StoredOrder {
  id: string;
  sku: string;
  quantity: number;
  totalCents: number;
  warehouseId: string;
  state: 'accepted' | 'refused';
}

export class OrderRepository {
  private readonly orders = new Map<string, StoredOrder>();

  save(order: StoredOrder): StoredOrder {
    this.orders.set(order.id, order);
    return order;
  }

  get(id: string): StoredOrder | undefined {
    return this.orders.get(id);
  }
}
