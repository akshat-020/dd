import { db, type QueuedAction } from "./db";
import { api, ApiError } from "../api/client";

let flushing = false;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function onQueueChange(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function enqueueAction(action: Omit<QueuedAction, "id" | "createdAt" | "attempts">) {
  await db.queue.add({ ...action, createdAt: Date.now(), attempts: 0 });
  notify();
  if (navigator.onLine) flushQueue();
}

export async function pendingCount(): Promise<number> {
  return db.queue.count();
}

// Sends queued actions to the server in the order they were recorded, so a
// scan-location action always reaches the server before the confirm that
// depends on it having happened.
export async function flushQueue() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const items = await db.queue.orderBy("createdAt").toArray();
    for (const item of items) {
      try {
        await api.post(item.path, item.payload);
        if (item.id !== undefined) await db.queue.delete(item.id);
        notify();
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          // Application-level rejection (e.g. wrong location/SKU, already
          // picked) — retrying won't help, so drop it and surface the error.
          if (item.id !== undefined) {
            await db.queue.update(item.id, { lastError: err.message, attempts: item.attempts + 1 });
          }
          notify();
          continue;
        }
        // Network/server error — stop here and retry the whole batch later.
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    flushQueue();
  });
}
