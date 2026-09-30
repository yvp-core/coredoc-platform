import { orderLabel } from '../formatting/labels.js';
import { formatCents } from '../formatting/money.js';
import type { OrderRequest, OrderService } from '../orders/order-service.js';

export interface OrderResponse {
  label: string;
  total: string;
  state: string;
}

export class OrderController {
  constructor(private readonly service: OrderService) {}

  submit(request: OrderRequest): OrderResponse {
    const order = this.service.placeOrder(request);
    return {
      label: orderLabel(order.id, order.warehouseId),
      total: formatCents(order.totalCents),
      state: order.state,
    };
  }
}
