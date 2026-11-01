// Startup loading from the URL (qvis App.vue mounted(); parity/app-shell.md §3.1 step 5, §8.3).
// Runs exactly once per page load (module-level flag, so React StrictMode's double effects are harmless). ANY query
// key triggers the call (e.g. `?focusOnEvent=3` alone); connectionStore.loadFilesFromServer returns early when there
// is no file / list / file1. Later query changes never trigger loading again (Q6, preserved).

import { useConnectionStore } from "@/store/connectionStore";

let started = false;

export function runStartupLoadOnce(query: Readonly<Record<string, string>>): void {
    if (started) {
        return;
    }
    started = true;
    if (Object.keys(query).length === 0) {
        return;
    }
    try {
        Promise.resolve(useConnectionStore.getState().loadFilesFromServer({ ...query })).catch((err: unknown) => {
            console.error("qvis: loading files from the URL failed", err);
        });
    } catch (err) {
        console.error("qvis: loading files from the URL failed", err);
    }
}

/** Test helper. */
export function resetStartupLoadForTests(): void {
    started = false;
}
