// Change notification for in-place model mutations (data-model spec section 3.16.11). Model objects are mutable
// class instances; the connection store subscribes and bumps its `revision` counter so React re-renders.

import type { QlogConnection } from "./QlogConnection";
import type { QlogConnectionGroup } from "./QlogConnectionGroup";

export type ModelChange =
    | { kind: "connection-added"; group: QlogConnectionGroup; connection: QlogConnection }
    | {
          kind: "connection-changed";
          connection: QlogConnection;
          field: "title" | "description" | "vantagePoint" | (string & {});
      }
    | { kind: "timing-changed"; connection?: QlogConnection };

export type ModelChangeListener = (change: ModelChange) => void;

export class ModelEventEmitter {
    private readonly listeners = new Set<ModelChangeListener>();

    /** Subscribes; returns the unsubscribe function. */
    on(listener: ModelChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.off(listener);
    }

    off(listener: ModelChangeListener): void {
        this.listeners.delete(listener);
    }

    emit(change: ModelChange): void {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener(change);
            } catch (e) {
                console.error("modelEvents: listener threw", e);
            }
        }
    }

    get listenerCount(): number {
        return this.listeners.size;
    }
}

/** The app-wide emitter. `useConnectionStore` subscribes once: `modelEvents.on(() => bumpRevision())`. */
export const modelEvents = new ModelEventEmitter();

/** Convenience alias of `modelEvents.on`. */
export function subscribeModelChanges(listener: ModelChangeListener): () => void {
    return modelEvents.on(listener);
}
