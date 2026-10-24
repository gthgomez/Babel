// Superseded copy of the ledger from the previous layout. Nothing imports it.
const ENTRIES = [
  { id: 'seed', label: 'Seed funding', amount: 120 },
  { id: 'coffee', label: 'Coffee run', amount: -4 },
];

export function total(entries = ENTRIES) {
  return entries.reduce((sum, entry) => sum + entry.amount, 0);
}
