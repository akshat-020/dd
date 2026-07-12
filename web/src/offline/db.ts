import Dexie, { type Table } from "dexie";

export type QueuedActionType = "scan-location" | "scan-sku" | "confirm-pick" | "putaway";

export interface QueuedAction {
  id?: number;
  type: QueuedActionType;
  path: string; // API path this action posts to once synced
  payload: unknown;
  // Optimistic local effect applied immediately so the UI reflects the scan
  // before the server confirms it.
  orderId?: string;
  itemId?: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface CachedPickList {
  orderId: string;
  items: any[];
  updatedAt: number;
}

class OmsDb extends Dexie {
  queue!: Table<QueuedAction, number>;
  pickLists!: Table<CachedPickList, string>;

  constructor() {
    super("oms-offline");
    this.version(1).stores({
      queue: "++id, orderId, itemId, createdAt",
      pickLists: "orderId",
    });
  }
}

export const db = new OmsDb();
