export function chargeInvoice(invoice) {
  const amountCents = invoice.items.reduce((total, item) => total + item.amountCents, 0)
  return { status: 201, invoiceId: invoice.id, amountCents }
}
