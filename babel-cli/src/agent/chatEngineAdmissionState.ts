/** Durable admission state used by the Chat replacement fence. */
export interface BufferAdmissionStore {
  listAdmissions(runId: string): {
    skippedCorruptRows: number;
    records: ReadonlyArray<{ state: string }>;
  };
}

export interface DurableAdmissionState {
  /** A prior physical effect was never reconciled and must block all successors. */
  indeterminate: boolean;
  /** A claimed record with a live wrapper is unsettled work. */
  claimed: boolean;
}

export function durableAdmissionState(
  store: BufferAdmissionStore | undefined,
  runId: string,
): DurableAdmissionState {
  if (!store) return { indeterminate: false, claimed: false };
  try {
    const listing = store.listAdmissions(runId);
    return {
      indeterminate: listing.skippedCorruptRows > 0 ||
        listing.records.some(record => record.state === 'indeterminate'),
      claimed: listing.records.some(record => record.state === 'claimed'),
    };
  } catch {
    return { indeterminate: true, claimed: true };
  }
}
