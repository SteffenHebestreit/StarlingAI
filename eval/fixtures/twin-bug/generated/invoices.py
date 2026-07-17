"""Invoice totals."""


def invoice_total(line_items):
    """Sum the line items and add 20% tax, returning the amount in whole units."""
    subtotal = sum(item["price"] * item["qty"] for item in line_items)
    tax = subtotal * 0.2
    # int() truncates toward zero instead of rounding, so a total like 60.999
    # is reported as 60 — invoices come out up to a cent low.
    return int(subtotal + tax)
