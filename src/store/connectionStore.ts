// Global store of loaded files (qvis `store/ConnectionStore.ts`; ARCHITECTURE §3.3; file-loading spec §5.2, §8.2).
//
// Groups are mutable model class instances held by reference (never cloned, frozen or proxied). `groups` gets a
// new array identity on add/remove only; in-place model changes (sequence-diagram clones, renames, reference
// time changes) are announced through `modelEvents` and bump `revision`.

import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import type { LoadedQlog } from "@/qlog/parse";
import { QlogLoader } from "@/model/QlogLoader";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { modelEvents } from "@/model/modelEvents";
import { notify } from "@/lib/notify";
import { useConfigurationStore } from "@/store/configurationStore";
import { loadExamplesForDemo, loadMassiveDemo } from "@/loading/demo";
import type { DemoDeps } from "@/loading/demo";
import { diagnosticNotifications, mergeDiagnostics } from "@/loading/diagnosticToasts";
import type { LoadNotification } from "@/loading/messages";
import { N9_parseFailed } from "@/loading/messages";
import type { FileInfo } from "@/loading/shorten";
import { loadUploadedFiles } from "@/loading/upload";
import { loadFromQueryParameters } from "@/loading/urlLoader";
import type { Query } from "@/loading/urlLoader";

export type { FileInfo } from "@/loading/shorten";

export interface ConnectionStoreState {
    /** Loaded files, insertion (= load completion) order (Q21). Replaced (new array) on add/remove. */
    groups: QlogConnectionGroup[];
    /** Bumped by add/remove and by every model change event (selectors re-derive their option lists). */
    revision: number;
    /** In-flight loads (URL, demo, upload); never negative (FIX Q7). */
    outstandingRequestCount: number;

    addGroup(group: QlogConnectionGroup): void;
    /** Also scrubs view selections pointing into the removed group (configurationStore.scrub). */
    removeGroup(group: QlogConnectionGroup): void;
    adjustOutstandingRequestCount(delta: number): void;
    /**
     * qvis `addGroupFromQlogFile`: QlogLoader.fromJSON, then set filename/URL/URLshort and add. On rejection toast N9
     * and return undefined. On success toast `success` (if given), then the diagnostic warnings (X3/X4/DM1/DM2/DM3).
     */
    addGroupFromQlogFile(
        loaded: LoadedQlog,
        fileInfo: FileInfo,
        success?: LoadNotification,
    ): QlogConnectionGroup | undefined;

    /** `?file=` / `?list=` / `?file1..N=` (startup query on any route, and Option 1). */
    loadFilesFromServer(query: Query): Promise<void>;
    /** Option 3 (N7 when demo files are already loaded or loading). */
    loadExamplesForDemo(): Promise<void>;
    /** Option 4 (N8 when the massive demo is already loaded or loading). */
    loadMassiveDemo(): Promise<void>;
    /** Option 2 upload (all-or-nothing extension validation, N3). */
    loadFiles(files: File[]): Promise<void>;
}

function createConnectionStore(): UseBoundStore<StoreApi<ConnectionStoreState>> {
    return create<ConnectionStoreState>()((set, get) => {
        const deps = (): DemoDeps => ({
            notify,
            addGroupFromQlogFile: (loaded, fileInfo, success) => get().addGroupFromQlogFile(loaded, fileInfo, success),
            adjustOutstanding: (delta) => get().adjustOutstandingRequestCount(delta),
            getGroups: () => get().groups,
        });

        return {
            groups: [],
            revision: 0,
            outstandingRequestCount: 0,

            addGroup(group) {
                console.log("ConnectionStore Mutation for adding group", group);
                set((s) => ({ groups: [...s.groups, group], revision: s.revision + 1 }));
            },

            removeGroup(group) {
                const index = get().groups.indexOf(group);
                if (index < 0) return;
                set((s) => ({ groups: s.groups.filter((g) => g !== group), revision: s.revision + 1 }));
                try {
                    useConfigurationStore.getState().scrub(group);
                } catch (e) {
                    console.error("ConnectionStore:removeGroup : could not scrub view selections", e);
                }
            },

            adjustOutstandingRequestCount(delta) {
                set((s) => ({ outstandingRequestCount: Math.max(0, s.outstandingRequestCount + delta) }));
            },

            addGroupFromQlogFile(loaded, fileInfo, success) {
                let group: QlogConnectionGroup | undefined;
                try {
                    group = QlogLoader.fromJSON(loaded, { filename: fileInfo.filename, URL: fileInfo.URL });
                } catch (e) {
                    console.error("ConnectionStore:addGroupFromQlogFile : QlogLoader threw", e);
                    group = undefined;
                }
                if (group === undefined) {
                    console.error(
                        "ConnectionStore:addGroupFromQlogFile : Qlog file could not be parsed!",
                        loaded,
                        fileInfo,
                    );
                    notify(N9_parseFailed(fileInfo.filename));
                    return undefined;
                }
                group.filename = fileInfo.filename;
                group.URL = fileInfo.URL ?? "";
                group.URLshort = fileInfo.URLshort ?? "";
                get().addGroup(group);

                if (success !== undefined) notify(success);
                const diagnostics = mergeDiagnostics(loaded.diagnostics, group.diagnostics);
                for (const n of diagnosticNotifications(fileInfo.filename, diagnostics)) notify(n);
                return group;
            },

            loadFilesFromServer(query) {
                return loadFromQueryParameters(query, deps());
            },

            loadExamplesForDemo() {
                return loadExamplesForDemo(deps());
            },

            loadMassiveDemo() {
                return loadMassiveDemo(deps());
            },

            loadFiles(files) {
                return loadUploadedFiles(files, deps());
            },
        };
    });
}

export const useConnectionStore: UseBoundStore<StoreApi<ConnectionStoreState>> = createConnectionStore();

// In-place model changes (data-model §3.16.11): one subscription for the app's lifetime.
modelEvents.on(() => {
    useConnectionStore.setState((s) => ({ revision: s.revision + 1 }));
});

/** Test helper: empty the store (does not touch model subscriptions). */
export function resetConnectionStoreForTests(): void {
    useConnectionStore.setState({ groups: [], revision: 0, outstandingRequestCount: 0 });
}
