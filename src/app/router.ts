// Tiny hash router reproducing qvis's vue-router 3 behaviour (parity/app-shell.md §3.2, §3.3, §8.2).
//
// - URLs look like `#/sequence?file=...`. Paths match case-insensitively, with an optional trailing slash.
// - `#/`, `#`, `#?list=x.json` and unknown paths resolve to `/files`, keeping the query (Q4 fix: catch-all).
// - Rule 1 (pre-hash `?file=x` migration) runs once at startup: `migratePreHashQuery()` (called from main.tsx).
// - Rule 2 (sticky query): any navigation whose target has NO query keys inherits the previous query. This applies
//   to in-app navigation, manual hash edits and back/forward, and runs synchronously before the new route is
//   published, so no view ever mounts without the query.
// - A target query with keys replaces the previous query wholesale (never merged).
// - Navigating to the current location is a no-op (vue-router's duplicate-navigation abort).
// - `location.search` is never removed (Q5, preserved).
// - Like vue-router's ensureURL, the hash is rewritten (replaceState) to the encoded form of its query.

import { useSyncExternalStore } from "react";
import {
    getOwnQueryValue,
    hasQueryParams,
    parseQuery,
    parseQueryRaw,
    setOwnQueryValue,
    stringifyQuery,
    type Query,
} from "./query";

export const ROUTE_PATHS = [
    "/debug",
    "/files",
    "/sequence",
    "/congestion",
    "/multiplexing",
    "/packetization",
    "/stats",
] as const;
export type RoutePath = (typeof ROUTE_PATHS)[number];

/** Target of the `/` redirect and of the catch-all route. */
export const DEFAULT_ROUTE_PATH: RoutePath = "/files";

export interface Route {
    /** Canonical route path, one of ROUTE_PATHS (lower-case, no trailing slash). */
    readonly path: RoutePath;
    /** Normalized query: one string per key (first occurrence wins, bare keys are ""). */
    readonly query: Readonly<Query>;
    /** `path` + `?` + stringified query (vue-router encoding); used for duplicate detection. */
    readonly fullPath: string;
}

interface ResolvedPath {
    path: RoutePath;
    /** true when vue-router would have redirected (root `/` or catch-all), so the URL gets rewritten */
    redirected: boolean;
}

let current: Route | undefined;
const listeners = new Set<() => void>();
let windowListenersInstalled = false;

function splitHashBody(hash: string): { rawPath: string; rawQuery: string } {
    const body = hash.replace(/^#/, "");
    const qi = body.indexOf("?");
    return {
        rawPath: qi >= 0 ? body.slice(0, qi) : body,
        rawQuery: qi >= 0 ? body.slice(qi + 1) : "",
    };
}

/** Maps a raw hash path onto a known route: case-insensitive, optional trailing slash, `/` and unknown -> /files. */
export function resolvePath(rawPath: string): ResolvedPath {
    let p = rawPath.startsWith("/") ? rawPath : "/" + rawPath;
    p = p.replace(/\/+$/, "");
    if (p === "") {
        return { path: DEFAULT_ROUTE_PATH, redirected: true };
    }
    const lower = p.toLowerCase();
    const match = ROUTE_PATHS.find((r) => r === lower);
    if (match) {
        return { path: match, redirected: false };
    }
    return { path: DEFAULT_ROUTE_PATH, redirected: true };
}

function makeRoute(path: RoutePath, query: Query): Route {
    const frozenQuery = Object.freeze({ ...query });
    const qs = stringifyQuery(frozenQuery);
    return Object.freeze({ path, query: frozenQuery, fullPath: qs ? path + "?" + qs : path });
}

/** Hash href for a route, e.g. `#/sequence?file=https%3A%2F%2Fa.org%2Fx.qlog`. */
export function hrefFor(path: string, query?: Record<string, string>): string {
    const qs = stringifyQuery(query);
    return "#" + path + (qs ? "?" + qs : "");
}

function urlFor(route: Route): string {
    const { pathname, search } = window.location;
    return pathname + search + hrefFor(route.path, route.query);
}

function publish(next: Route): void {
    if (current && current.fullPath === next.fullPath) {
        return;
    }
    current = next;
    for (const l of [...listeners]) {
        l();
    }
}

/**
 * Reads window.location, applies the root/catch-all redirect and rule 2 (sticky query), rewrites the URL with
 * history.replaceState when a redirect happened, and publishes the route. Idempotent.
 */
export function syncFromLocation(): Route {
    const { rawPath, rawQuery } = splitHashBody(window.location.hash);
    const resolved = resolvePath(rawPath);
    let query = parseQuery(rawQuery);
    let rewrite = resolved.redirected;

    // rule 2: carry the previous query over to a location that has none (never on the initial navigation)
    if (current && !hasQueryParams(query) && hasQueryParams(current.query)) {
        query = { ...current.query };
        rewrite = true;
    }

    const next = makeRoute(resolved.path, query);
    if (rewrite) {
        window.history.replaceState(window.history.state, "", urlFor(next));
    } else {
        // vue-router's ensureURL: the address bar always shows the route's fullPath, i.e. the typed path (case and
        // trailing slash kept) with the query re-encoded (`?file=https://a.org/x` -> `?file=https%3A%2F%2Fa.org%2Fx`).
        // Repeated and bare keys are written back as they were (raw query), only the encoding changes.
        const qs = stringifyQuery(parseQueryRaw(rawQuery));
        const canonical = "#" + (rawPath.startsWith("/") ? rawPath : "/" + rawPath) + (qs ? "?" + qs : "");
        if (canonical !== window.location.hash) {
            const { pathname, search } = window.location;
            window.history.replaceState(window.history.state, "", pathname + search + canonical);
        }
    }
    publish(next);
    return current as Route;
}

function onLocationChange(): void {
    syncFromLocation();
}

/** Resolves the initial location and starts listening to hashchange/popstate. Safe to call more than once. */
export function initRouter(): Route {
    if (!windowListenersInstalled) {
        window.addEventListener("hashchange", onLocationChange);
        window.addEventListener("popstate", onLocationChange);
        windowListenersInstalled = true;
    }
    if (!current) {
        syncFromLocation();
    }
    return current as Route;
}

/** Current route (initializes the router lazily). For non-React code, e.g. renderers reading focusOn* once. */
export function getRoute(): Route {
    return current ?? initRouter();
}

function subscribe(listener: () => void): () => void {
    initRouter();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** React hook: the current route; re-renders on every route change. */
export function useRoute(): Route {
    return useSyncExternalStore(subscribe, getRoute, getRoute);
}

/**
 * In-app navigation (router.push / router.replace). Without a query (or with an empty one) the current query is
 * kept (rule 2). Navigating to the current location is a no-op.
 */
export function navigate(path: string, query?: Record<string, string>, opts?: { replace?: boolean }): void {
    const from = getRoute();
    const qi = path.indexOf("?");
    const resolved = resolvePath(qi >= 0 ? path.slice(0, qi) : path);
    const inline = qi >= 0 ? parseQuery(path.slice(qi + 1)) : {};
    const explicit: Query = query && hasQueryParams(query) ? { ...query } : inline;
    const target: Query = hasQueryParams(explicit) ? explicit : hasQueryParams(from.query) ? { ...from.query } : {};
    const next = makeRoute(resolved.path, target);
    if (next.fullPath === from.fullPath) {
        return;
    }
    if (opts?.replace) {
        window.history.replaceState(window.history.state, "", urlFor(next));
    } else {
        window.history.pushState(null, "", urlFor(next));
    }
    publish(next);
}

/**
 * Rule 1 (parity/app-shell.md §3.3, §8.2): on the initial load only, copy a pre-hash query
 * (`https://host/?file=x#/sequence`) into the hash route when the hash has no query of its own.
 * `location.search` itself is left in place (Q5). Duplicate keys: first occurrence wins (Q26, same as parseQuery).
 * Returns true when the URL was rewritten.
 */
export function migratePreHashQuery(): boolean {
    const { search, hash, pathname } = window.location;
    if (!search || search === "?") {
        return false;
    }
    const body = hash.replace(/^#/, "");
    const qi = body.indexOf("?");
    const hashQuery = qi >= 0 ? body.slice(qi + 1) : "";
    if (hasQueryParams(parseQuery(hashQuery))) {
        return false; // the hash query wins; the pre-hash parameters are ignored
    }
    let path = qi >= 0 ? body.slice(0, qi) : body;
    if (!path.startsWith("/")) {
        path = "/" + path;
    }
    const q: Query = {};
    new URLSearchParams(search).forEach((v, k) => {
        if (getOwnQueryValue(q, k) === undefined) {
            setOwnQueryValue(q, k, v);
        }
    });
    if (!hasQueryParams(q)) {
        return false;
    }
    window.history.replaceState(window.history.state, "", pathname + search + "#" + path + "?" + stringifyQuery(q));
    return true;
}

/** Test helper: forget the current route and detach window listeners. */
export function resetRouterForTests(): void {
    current = undefined;
    listeners.clear();
    if (windowListenersInstalled) {
        window.removeEventListener("hashchange", onLocationChange);
        window.removeEventListener("popstate", onLocationChange);
        windowListenersInstalled = false;
    }
}
