import { beforeEach, describe, expect, it } from "vitest";
import { conn, makeGroup } from "@/components/shared/__fixtures__/fakeModel";
import SequenceDiagramConfig from "@/components/sequencediagram/data/SequenceDiagramConfig";
import { createDefaultConfigs, scrubConfigs, useConfigurationStore } from "./configurationStore";

beforeEach(() => useConfigurationStore.getState().reset());

describe("configurationStore defaults (parity/app-shell.md §3.4)", () => {
    it("holds the qvis defaults for every tool", () => {
        const s = useConfigurationStore.getState();
        expect(s.sequenceConfig).toEqual({ connections: [], timeResolution: 1 });
        expect(s.congestionConfig).toEqual({ connection: undefined });
        expect(s.multiplexingConfig).toEqual({
            collapsed: true,
            showwaterfall: true,
            showbyteranges: true,
            connections: [],
        });
        expect(s.packetizationConfig).toEqual({ collapsed: true, connections: [] });
        expect(s.statisticsConfig).toEqual({ group: undefined });
    });

    it("createConnectionWithTimeoffset uses the connection's time offset", () => {
        const g = makeGroup("a.qlog", [{ title: "x" }]);
        expect(SequenceDiagramConfig.createConnectionWithTimeoffset(conn(g, 0))).toEqual({
            connection: conn(g, 0),
            timeOffset: 0,
        });
    });
});

describe("update", () => {
    it("shallow-merges into a new object and keeps model references", () => {
        const g = makeGroup("a.qlog", [{ title: "x" }]);
        const before = useConfigurationStore.getState().multiplexingConfig;
        useConfigurationStore.getState().update("multiplexingConfig", { connections: [conn(g, 0)], collapsed: false });
        const after = useConfigurationStore.getState().multiplexingConfig;
        expect(after).not.toBe(before);
        expect(after.connections[0]).toBe(conn(g, 0));
        expect(after.collapsed).toBe(false);
        expect(after.showwaterfall).toBe(true);
        expect(before.collapsed).toBe(true);
    });

    it("leaves the other configs untouched", () => {
        const seq = useConfigurationStore.getState().sequenceConfig;
        useConfigurationStore.getState().update("statisticsConfig", { group: makeGroup("a.qlog", []) });
        expect(useConfigurationStore.getState().sequenceConfig).toBe(seq);
    });
});

describe("scrub (Q11)", () => {
    it("clears every selection that points into the removed file", () => {
        const removed = makeGroup("removed.qlog", [{ title: "r0" }, { title: "r1" }]);
        const kept = makeGroup("kept.qlog", [{ title: "k0" }]);
        const store = useConfigurationStore.getState();
        store.update("sequenceConfig", {
            connections: [
                { connection: conn(kept, 0), timeOffset: 0 },
                { connection: conn(removed, 1), timeOffset: 5 },
            ],
        });
        store.update("congestionConfig", { connection: conn(removed, 0) });
        store.update("multiplexingConfig", { connections: [conn(removed, 0)] });
        store.update("packetizationConfig", { connections: [conn(kept, 0)] });
        store.update("statisticsConfig", { group: removed });

        const pkt = useConfigurationStore.getState().packetizationConfig;
        useConfigurationStore.getState().scrub(removed);
        const s = useConfigurationStore.getState();
        expect(s.sequenceConfig.connections).toEqual([{ connection: conn(kept, 0), timeOffset: 0 }]);
        expect(s.congestionConfig.connection).toBeUndefined();
        expect(s.multiplexingConfig.connections).toEqual([]);
        expect(s.packetizationConfig).toBe(pkt); // untouched: no reference into the removed file
        expect(s.statisticsConfig.group).toBeUndefined();
    });

    it("is a no-op (same objects) when nothing references the file", () => {
        const unrelated = makeGroup("x.qlog", [{ title: "x" }]);
        expect(scrubConfigs(createDefaultConfigs(), unrelated)).toEqual({});
        const before = useConfigurationStore.getState();
        useConfigurationStore.getState().scrub(unrelated);
        expect(useConfigurationStore.getState().sequenceConfig).toBe(before.sequenceConfig);
    });
});
