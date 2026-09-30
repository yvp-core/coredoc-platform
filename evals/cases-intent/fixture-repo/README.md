# widget-ordering

A small widget-ordering service: a store operator submits an order for one
warehouse, the service checks stock, prices the order and stores it.

- `src/api` — HTTP-shaped entry points
- `src/orders` — order orchestration and storage
- `src/stock` — stock availability checks
- `src/pricing` — order pricing
- `src/catalog` — widget catalogue lookups
- `src/formatting` — shared presentation and money helpers
