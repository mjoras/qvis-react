// Module-level toast emitter replacing `Vue.notify` from vue-notification 1.3.16 (parity/app-shell.md §3.6, §8.4).
// Callable from anywhere (stores, loaders, renderers). <Notifications/> subscribes and renders.
//
// Title and text are PLAIN TEXT: the only markup recognised is a literal `<br/>` / `<br>` line break (Q7 fix;
// everything else is rendered escaped). Keep the call-site strings byte-identical to parity/app-shell.md §6.1.

export type NotificationType = "success" | "warn" | "error" | "info";

export interface NotificationOptions {
    /** Only the "default" group is rendered by the app (default: "default"). */
    group?: string;
    title?: string;
    text: string;
    /** Absent (or "info") gives the default blue style. */
    type?: NotificationType;
    /** Milliseconds before the item starts leaving (default 3000). Negative = sticky. */
    duration?: number;
}

export interface NotificationItem {
    readonly id: number;
    readonly group: string;
    readonly title?: string;
    readonly text: string;
    readonly type?: NotificationType;
    readonly duration: number;
}

export const DEFAULT_NOTIFICATION_GROUP = "default";
export const DEFAULT_NOTIFICATION_DURATION = 3000;

type Listener = (item: NotificationItem) => void;

const listeners = new Set<Listener>();
// Notifications emitted while nothing is subscribed (e.g. before <Notifications/> mounted) are buffered and
// delivered to the first subscriber, so early toasts are not lost. Bounded to avoid leaks in headless use.
const MAX_PENDING = 100;
let pending: NotificationItem[] = [];
let nextId = 1;

export function notify(n: NotificationOptions): void {
    const item: NotificationItem = {
        id: nextId++,
        group: n.group ?? DEFAULT_NOTIFICATION_GROUP,
        title: n.title,
        text: n.text,
        type: n.type,
        duration: typeof n.duration === "number" ? n.duration : DEFAULT_NOTIFICATION_DURATION,
    };
    if (listeners.size === 0) {
        pending.push(item);
        if (pending.length > MAX_PENDING) {
            pending = pending.slice(pending.length - MAX_PENDING);
        }
        return;
    }
    for (const l of [...listeners]) {
        l(item);
    }
}

/** Subscribe to every notification (all groups). Returns the unsubscribe function. */
export function subscribeNotifications(listener: Listener): () => void {
    listeners.add(listener);
    if (pending.length > 0) {
        const buffered = pending;
        pending = [];
        for (const item of buffered) {
            listener(item);
        }
    }
    return () => {
        listeners.delete(listener);
    };
}

/** Splits notification text on `<br/>`, `<br>` and `<br />` (case-insensitive) into plain-text lines. */
export function splitNotificationLines(text: string): string[] {
    return text.split(/<br\s*\/?>/i);
}

/** Test helper: drop subscribers and buffered items. */
export function resetNotificationsForTests(): void {
    listeners.clear();
    pending = [];
}
