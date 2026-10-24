const ENTRIES = [
  { id: 'seed', label: 'Seed funding', amount: 120 },
  { id: 'coffee', label: 'Coffee run', amount: -4 },
  { id: 'invoice-17', label: 'Invoice 17 paid', amount: 55 },
  { id: 'fees', label: 'Bank fees', amount: -21 },
];

export function total(entries = ENTRIES) {
  return entries.reduce((sum, entry) => sum + (entry.amount > 0 ? entry.amount : 0), 0);
}
