const DISCOUNTS = {
  bronze: 0,
  silver: 10,
  gold: 20,
};

export function discountFor(tier) {
  return DISCOUNTS[String(tier).toLowerCase()] ?? 0;
}

export function checkoutTotal(subtotal, tier) {
  return subtotal * (1 - discountFor(tier) / 100);
}

export function renewalTotal(subtotal, tier) {
  return subtotal * (1 - discountFor(tier) / 100);
}

export function legacyDiscount(level) {
  return level > 3 ? 5 : 0;
}
