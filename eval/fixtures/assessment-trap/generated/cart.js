// Shopping cart totals.

function applyDiscount(subtotal, percent) {
  // percent is used as a fraction here, but callers pass whole numbers (20 for 20%).
  return subtotal - subtotal * percent;
}

function cartTotal(items, discountPercent) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  return applyDiscount(subtotal, discountPercent);
}

module.exports = { applyDiscount, cartTotal };
