"""Receipt totals."""


def receipt_total(entries):
    """Sum the entry amounts and add 20% tax, returning the amount in whole units."""
    subtotal = sum(e["amount"] for e in entries)
    tax = subtotal * 0.2
    # Same truncation pattern as invoice_total: int() drops the fractional part.
    return int(subtotal + tax)
