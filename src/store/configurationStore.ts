// Per-tool configuration objects (qvis `store/ConfigurationStore.ts`; ARCHITECTURE §3.3; parity/app-shell.md §3.4,
// §8.6). One long-lived config per tool, kept across route changes (tool views remount on every switch, Q34).
// Nothing is persisted (no localStorage, no URL sync).
//
// Model objects (connections, groups) referenced by the configs are mutable class instances: they are stored by
// reference and never copied or frozen. `update` shallow-merges into a NEW config object so React re-renders.

import { create } from "zustand";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import CongestionGraphConfig from "@/components/congestiongraph/data/CongestionGraphConfig";
import MultiplexingGraphConfig from "@/components/multiplexinggraph/data/MultiplexingGraphConfig";
import PacketizationDiagramConfig from "@/components/packetizationdiagram/data/PacketizationDiagramConfig";
import SequenceDiagramConfig from "@/components/sequencediagram/data/SequenceDiagramConfig";
import StatisticsConfig from "@/components/stats/data/StatisticsConfig";

export interface ToolConfigs {
    sequenceConfig: SequenceDiagramConfig;
    congestionConfig: CongestionGraphConfig;
    multiplexingConfig: MultiplexingGraphConfig;
    packetizationConfig: PacketizationDiagramConfig;
    statisticsConfig: StatisticsConfig;
}

export type ConfigKey = keyof ToolConfigs;

export interface ConfigurationStoreState extends ToolConfigs {
    /** Shallow-merge `patch` into a NEW config object for `key`. */
    update<K extends ConfigKey>(key: K, patch: Partial<ToolConfigs[K]>): void;
    /**
     * Q11 fix: clear every selection that points into a removed file. Congestion connection and stats group
     * become undefined; sequence/multiplexing/packetization drop the affected entries. Called by
     * connectionStore.removeGroup. The tools' auto-selection then picks the new groups[0] (or shows the alert).
     */
    scrub(group: QlogConnectionGroup): void;
    /** Restore the qvis defaults for every tool (tests, debugging). */
    reset(): void;
}

export function createDefaultConfigs(): ToolConfigs {
    return {
        sequenceConfig: new SequenceDiagramConfig(),
        congestionConfig: new CongestionGraphConfig(),
        multiplexingConfig: new MultiplexingGraphConfig(),
        packetizationConfig: new PacketizationDiagramConfig(),
        statisticsConfig: new StatisticsConfig(),
    };
}

/** Pure scrub: returns only the configs that change (empty object when nothing references `group`). */
export function scrubConfigs(configs: ToolConfigs, group: QlogConnectionGroup): Partial<ToolConfigs> {
    const out: Partial<ToolConfigs> = {};
    const inGroup = (c: { parent: unknown } | undefined): boolean =>
        c !== undefined && c !== null && c.parent === group;

    const seq = configs.sequenceConfig;
    if (seq.connections.some((sc) => inGroup(sc.connection))) {
        out.sequenceConfig = { ...seq, connections: seq.connections.filter((sc) => !inGroup(sc.connection)) };
    }

    const cong = configs.congestionConfig;
    if (inGroup(cong.connection)) {
        out.congestionConfig = { ...cong, connection: undefined };
    }

    const mux = configs.multiplexingConfig;
    if (mux.connections.some(inGroup)) {
        out.multiplexingConfig = { ...mux, connections: mux.connections.filter((c) => !inGroup(c)) };
    }

    const pkt = configs.packetizationConfig;
    if (pkt.connections.some(inGroup)) {
        out.packetizationConfig = { ...pkt, connections: pkt.connections.filter((c) => !inGroup(c)) };
    }

    const stats = configs.statisticsConfig;
    if (stats.group === group) {
        out.statisticsConfig = { ...stats, group: undefined };
    }

    return out;
}

export const useConfigurationStore = create<ConfigurationStoreState>()((set, get) => ({
    ...createDefaultConfigs(),

    update(key, patch) {
        const prev = get()[key];
        set({ [key]: { ...prev, ...patch } } as Partial<ConfigurationStoreState>);
    },

    scrub(group) {
        const changed = scrubConfigs(get(), group);
        if (Object.keys(changed).length > 0) {
            set(changed);
        }
    },

    reset() {
        set(createDefaultConfigs());
    },
}));
