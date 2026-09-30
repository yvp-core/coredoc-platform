import { Catalog } from '../catalog/catalog.js';
import { PriceCalculator } from '../pricing/price-calculator.js';
import { StockGuard } from '../stock/stock-guard.js';
import { OrderRepository, type StoredOrder } from './order-repository.js';

export interface OrderRequest {
  orderId: string;
  sku: string;
  quantity: number;
}

const HANDLING_FEE_CENTS = 250;

export class OrderService {
  constructor(
    private readonly catalog: Catalog,
    private readonly stock: StockGuard,
    private readonly pricing: PriceCalculator,
    private readonly orders: OrderRepository,
  ) {}

  placeOrder(request: OrderRequest): StoredOrder {
    const widget = this.catalog.find(request.sku);
    if (!widget) {
      throw new Error(`unknown widget ${request.sku}`);
    }
    this.stock.ensureAvailable(request.sku, request.quantity);
    const line = this.pricing.priceLine(widget, request.quantity);
    const totalCents = this.pricing.orderTotal([line], HANDLING_FEE_CENTS);
    this.stock.reserve(request.sku, request.quantity);
    return this.orders.save({
      id: request.orderId,
      sku: request.sku,
      quantity: request.quantity,
      totalCents,
      warehouseId: widget.warehouseId,
      state: 'accepted',
    });
  }
}
