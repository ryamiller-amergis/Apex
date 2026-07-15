export interface ReleaseEpicOrderEntry {
  adoEpicId: number;
  sortRank: number;
}

export interface ReleaseOrderData {
  project: string;
  areaPath: string;
  orders: ReleaseEpicOrderEntry[];
}

export interface BulkReorderInput {
  project: string;
  areaPath: string;
  /** Ordered list of ADO Epic IDs — position in array becomes the sort rank. */
  epicIds: number[];
}
