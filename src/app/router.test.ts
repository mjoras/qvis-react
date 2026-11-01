import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    getRoute,
    hrefFor,
    initRouter,
    migratePreHashQuery,
    navigate,
    resetRouterForTests,
    resolvePath,
    useRoute,
} from "./router";

/** Simulates a page load at `url` (path + search + hash relative to the jsdom origin). */
function load(url: string) {
    resetRouterForTests();
    window.history.replaceState(null, "", url);
    migratePreHashQuery();
    return initRouter();
}

/** Simulates the user editing the hash in the address bar (or a plain link click). */
function editHash(hash: string) {
    window.history.pushState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
}

beforeEach(() => {
    resetRouterForTests();
    window.history.replaceState(null, "", "/");
});

afterEach(() => {
    resetRouterForTests();
});

describe("initial location", () => {
    it("redirects the root to /files", () => {
        const r = load("/");
        expect(r.path).toBe("/files");
        expect(r.query).toEqual({});
        expect(window.location.hash).toBe("#/files");
    });

    it("treats #?list=x.json as root and keeps the query (Option 5 links)", () => {
        const r = load("/#?list=x.json");
        expect(r.path).toBe("/files");
        expect(r.query).toEqual({ list: "x.json" });
        expect(window.location.hash).toBe("#/files?list=x.json");
    });

    it("matches paths case-insensitively with an optional trailing slash, without rewriting the URL", () => {
        const r = load("/#/Sequence/?file=x");
        expect(r.path).toBe("/sequence");
        expect(r.query).toEqual({ file: "x" });
        expect(window.location.hash).toBe("#/Sequence/?file=x");
    });

    it("sends unknown routes to /files, keeping the query (Q4)", () => {
        const r = load("/#/nope?file=x");
        expect(r.path).toBe("/files");
        expect(r.query).toEqual({ file: "x" });
        expect(window.location.hash).toBe("#/files?file=x");
    });

    it("re-encodes a raw hash query in the address bar like vue-router's ensureURL", () => {
        const r = load("/#/sequence?file=https://a.org/x.qlog&focusOnEvent=3");
        expect(r.query).toEqual({ file: "https://a.org/x.qlog", focusOnEvent: "3" });
        expect(window.location.hash).toBe("#/sequence?file=https%3A%2F%2Fa.org%2Fx.qlog&focusOnEvent=3");
        // repeated and bare keys are written back unchanged; the path keeps its case
        load("/#/Stats?file=a&file=b&forceFull");
        expect(window.location.hash).toBe("#/Stats?file=a&file=b&forceFull");
        load("/#/files?");
        expect(window.location.hash).toBe("#/files");
    });

    it("tolerates malformed percent escapes in the hash query (Q25)", () => {
        const r = load("/#/files?file=%E0%A4%A");
        expect(r.query).toEqual({ file: "%E0%A4%A" });
    });
});

describe("rule 1: pre-hash query migration", () => {
    it("moves ?file=x into the hash route and keeps location.search (Q5)", () => {
        const r = load("/?file=x#/sequence");
        expect(r.path).toBe("/sequence");
        expect(r.query).toEqual({ file: "x" });
        expect(window.location.search).toBe("?file=x");
        expect(window.location.hash).toBe("#/sequence?file=x");
    });

    it("works without a hash (redirects to /files)", () => {
        const r = load("/?file=x.qlog");
        expect(r.path).toBe("/files");
        expect(r.query).toEqual({ file: "x.qlog" });
        expect(window.location.href).toMatch(/\/\?file=x\.qlog#\/files\?file=x\.qlog$/);
    });

    it("lets a hash query win over the pre-hash search", () => {
        const r = load("/?file=a#/sequence?file=b");
        expect(r.query).toEqual({ file: "b" });
    });

    it("counts '#/files?' as an empty hash query but '#/files?flag' as non-empty", () => {
        expect(load("/?file=a#/files?").query).toEqual({ file: "a" });
        expect(load("/?file=a#/files?flag").query).toEqual({ flag: "" });
    });

    it("uses the first occurrence of duplicate pre-hash keys (Q26)", () => {
        expect(load("/?file=a&file=b#/files").query).toEqual({ file: "a" });
    });

    it("decodes + as a space (Q27) and re-encodes into the hash", () => {
        const r = load("/?file=a+b.qlog#/files");
        expect(r.query).toEqual({ file: "a b.qlog" });
        expect(window.location.hash).toBe("#/files?file=a%20b.qlog");
    });

    it("does nothing for a bare '?'", () => {
        expect(migratePreHashQuery()).toBe(false);
    });
});

describe("rule 2: sticky query", () => {
    it("keeps the query on in-app navigation without a query", () => {
        load("/#/files?file=https%3A%2F%2Fa.org%2Fx.qlog");
        navigate("/sequence");
        expect(getRoute().path).toBe("/sequence");
        expect(getRoute().query).toEqual({ file: "https://a.org/x.qlog" });
        expect(window.location.hash).toBe("#/sequence?file=https%3A%2F%2Fa.org%2Fx.qlog");
    });

    it("re-encodes an unencoded query after a menu click (vue-router behaviour)", () => {
        load("/#/files?file=https://a.org/x.qlog");
        navigate("/sequence");
        expect(window.location.hash).toBe("#/sequence?file=https%3A%2F%2Fa.org%2Fx.qlog");
    });

    it("restores the query after a manual hash edit that removes it", () => {
        load("/#/sequence?file=x&focusOnEvent=3");
        editHash("#/stats");
        expect(getRoute().path).toBe("/stats");
        expect(getRoute().query).toEqual({ file: "x", focusOnEvent: "3" });
        expect(window.location.hash).toBe("#/stats?file=x&focusOnEvent=3");
    });

    it("keeps the query for an unknown route typed later, landing on /files", () => {
        load("/#/sequence?file=x");
        editHash("#/nope");
        expect(getRoute().path).toBe("/files");
        expect(getRoute().query).toEqual({ file: "x" });
    });

    it("replaces the query wholesale when the target has its own", () => {
        load("/#/sequence?file=x&focusOnEvent=3");
        navigate("/files", { list: "y.json" });
        expect(getRoute().query).toEqual({ list: "y.json" });
        editHash("#/congestion?file=z");
        expect(getRoute().query).toEqual({ file: "z" });
    });

    it("applies to back/forward to an entry without a query", () => {
        load("/#/files");
        navigate("/sequence");
        navigate("/congestion", { file: "x" });
        window.history.replaceState(null, "", "#/sequence"); // what the browser shows after "back"
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(getRoute().path).toBe("/sequence");
        expect(getRoute().query).toEqual({ file: "x" });
        expect(window.location.hash).toBe("#/sequence?file=x");
    });

    it("never applies on the initial navigation", () => {
        const r = load("/#/sequence");
        expect(r.query).toEqual({});
    });
});

describe("navigate", () => {
    it("is a no-op for the current location (duplicate navigation)", () => {
        load("/#/sequence?file=x");
        const before = window.history.length;
        navigate("/sequence");
        navigate("/sequence", { file: "x" });
        expect(window.history.length).toBe(before);
    });

    it("accepts a query inline in the path", () => {
        load("/#/files?file=x");
        navigate("/sequence?list=y.json");
        expect(getRoute().fullPath).toBe("/sequence?list=y.json");
        navigate("/stats?");
        expect(getRoute().fullPath).toBe("/stats?list=y.json");
    });

    it("pushes history entries, or replaces with {replace: true}", () => {
        load("/#/files");
        const before = window.history.length;
        navigate("/sequence");
        expect(window.history.length).toBe(before + 1);
        navigate("/stats", undefined, { replace: true });
        expect(window.history.length).toBe(before + 1);
        expect(window.location.hash).toBe("#/stats");
    });

    it("notifies useRoute subscribers", () => {
        load("/#/files?file=x");
        const { result } = renderHook(() => useRoute());
        expect(result.current.path).toBe("/files");
        act(() => navigate("/multiplexing"));
        expect(result.current.path).toBe("/multiplexing");
        expect(result.current.query).toEqual({ file: "x" });
        act(() => editHash("#/packetization"));
        expect(result.current.path).toBe("/packetization");
        expect(result.current.fullPath).toBe("/packetization?file=x");
    });
});

describe("helpers", () => {
    it("hrefFor builds hash hrefs with the vue-router encoding", () => {
        expect(hrefFor("/sequence")).toBe("#/sequence");
        expect(hrefFor("/sequence", {})).toBe("#/sequence");
        expect(hrefFor("/sequence", { file: "https://a.org/x.qlog" })).toBe(
            "#/sequence?file=https%3A%2F%2Fa.org%2Fx.qlog",
        );
    });

    it("resolvePath maps known, root and unknown paths", () => {
        expect(resolvePath("/stats")).toEqual({ path: "/stats", redirected: false });
        expect(resolvePath("/STATS//")).toEqual({ path: "/stats", redirected: false });
        expect(resolvePath("debug")).toEqual({ path: "/debug", redirected: false });
        expect(resolvePath("/")).toEqual({ path: "/files", redirected: true });
        expect(resolvePath("")).toEqual({ path: "/files", redirected: true });
        expect(resolvePath("/statsx")).toEqual({ path: "/files", redirected: true });
    });
});
