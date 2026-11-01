// Test double for src/store/connectionStore.ts (owned by the loading package; contract in ARCHITECTURE §3.3).
// Usage in a test file:  vi.mock("@/store/connectionStore", () => import("@/components/shared/__fixtures__/mockConnectionStore"));

import { create } from "zustand";
import { vi } from "vitest";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";

export interface MockConnectionStoreState {
    groups: QlogConnectionGroup[];
    revision: number;
    outstandingRequestCount: number;
    addGroup(group: QlogConnectionGroup): void;
    removeGroup(group: QlogConnectionGroup): void;
    loadFilesFromServer: (query: Record<string, string>) => Promise<void>;
    loadExamplesForDemo: () => Promise<void>;
    loadMassiveDemo: () => Promise<void>;
    loadFiles: (files: File[]) => Promise<void>;
}

export const useConnectionStore = create<MockConnectionStoreState>()((set, get) => ({
    groups: [],
    revision: 0,
    outstandingRequestCount: 0,
    addGroup(group) {
        set({ groups: [...get().groups, group], revision: get().revision + 1 });
    },
    removeGroup(group) {
        set({ groups: get().groups.filter((g) => g !== group), revision: get().revision + 1 });
    },
    loadFilesFromServer: vi.fn(async () => {}),
    loadExamplesForDemo: vi.fn(async () => {}),
    loadMassiveDemo: vi.fn(async () => {}),
    loadFiles: vi.fn(async () => {}),
}));

export function resetMockConnectionStore(): void {
    useConnectionStore.setState({ groups: [], revision: 0, outstandingRequestCount: 0 });
}
