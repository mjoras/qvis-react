// Event name conformance (ARCHITECTURE section 3.1 override 2) and event schema sanity checks (main-schema P14).
// Names are never aliased: a pre-final name stays as logged and is only reported (diagnostic
// `event.nonconforming-name`, toast DM3).

import { EVENT_SCHEMA_URN_PREFIX } from "@/qlog/schema/main";
import { classifyEventName, EVENT_SCHEMA_DRAFT, isKnownNamespace, PRE_FINAL_NAMESPACES, type Namespace } from "./names";

export interface EventSchemaInfo {
    uri: string;
    /** namespace for `urn:ietf:params:qlog:events:<ns>[-NN][#ext]` URIs; undefined for private URIs */
    namespace?: string;
    /** draft number of a `-NN` suffix (known namespaces only) */
    draft?: number;
    /** fragment identifier of an extension schema */
    extension?: string;
}

const KNOWN_URN_RE = /^urn:ietf:params:qlog:events:(loglevel|simulation|quic|http3|http)(?:-(\d+))?(?:#(.+))?$/;
const OTHER_URN_RE = /^urn:ietf:params:qlog:events:([^#]+?)(?:#(.+))?$/;

/** Parses an `event_schemas` entry (main-schema digest section 12 [REC]). */
export function parseEventSchemaUri(uri: string): EventSchemaInfo {
    let m = KNOWN_URN_RE.exec(uri);
    if (m) {
        const info: EventSchemaInfo = { uri, namespace: m[1] };
        if (m[2] !== undefined) info.draft = parseInt(m[2], 10);
        if (m[3] !== undefined) info.extension = m[3];
        return info;
    }
    m = OTHER_URN_RE.exec(uri);
    if (m) {
        const info: EventSchemaInfo = { uri, namespace: m[1] };
        if (m[2] !== undefined) info.extension = m[2];
        return info;
    }
    const hash = uri.indexOf("#");
    return hash >= 0 ? { uri, extension: uri.slice(hash + 1) } : { uri };
}

/**
 * True when a private schema URI names `namespace` as a whole path segment (a file extension is ignored), e.g.
 * `https://example.org/112026/tcp` or `https://example.org/112026/quic#chromium`. A plain substring test would let
 * `.../quic#chromium` also count as `http` (it contains "https").
 */
function privateUriNamesNamespace(uri: string, namespace: string): boolean {
    const path = uri.split("#")[0].split("?")[0];
    return path.split("/").some((seg) => seg === namespace || seg.replace(/\.[^.]*$/, "") === namespace);
}

/** True when one of the schemas declares or extends `namespace` (private URIs: a path segment names it). */
export function schemasListNamespace(schemas: readonly EventSchemaInfo[], namespace: string): boolean {
    for (const s of schemas) {
        if (s.namespace === namespace) return true;
        if (
            s.namespace === undefined &&
            !s.uri.startsWith(EVENT_SCHEMA_URN_PREFIX) &&
            privateUriNamesNamespace(s.uri, namespace)
        ) {
            return true;
        }
    }
    return false;
}

function schemasExtendNamespace(schemas: readonly EventSchemaInfo[], namespace: string): boolean {
    for (const s of schemas) {
        if (s.extension === undefined) continue;
        if (s.namespace === namespace) return true;
        if (s.namespace === undefined && privateUriNamesNamespace(s.uri, namespace)) return true;
    }
    return false;
}

/**
 * True when an event name (exactly as logged, containing a colon) is not defined by the latest drafts:
 * - a standard namespace (quic, http3, http, loglevel, simulation) with an undefined type, unless the trace lists an
 *   extension schema (`...#fragment`) for that namespace;
 * - a pre-final category (transport, recovery, security, connectivity, qpack, generic, error, ...), unless the
 *   trace's event_schemas declares that namespace.
 * Names without a namespace are reported separately (`event.name-without-namespace`); private namespaces (tcp:,
 * tls:, http2: from the converters, or any other) are fine.
 */
export function isNonconformingName(name: string, namespace: string, schemas: readonly EventSchemaInfo[]): boolean {
    if (name.indexOf(":") < 0) return false;
    if (classifyEventName(name) !== "nonconforming") return false;
    if (PRE_FINAL_NAMESPACES.has(namespace)) return !schemasListNamespace(schemas, namespace);
    if (isKnownNamespace(namespace)) return !schemasExtendNamespace(schemas, namespace);
    return true;
}

export interface SchemaCheckResult {
    /** observed namespaces without a matching event_schemas entry */
    unlistedNamespaces: string[];
    /** listed schema URIs whose namespace never appears in the events */
    unusedSchemas: string[];
    /** draft-suffixed URIs whose draft number differs from the supported one (quic-13, http3-13, http-13) */
    draftMismatches: string[];
}

/** P14: event schema sanity check (diagnostics only, never errors). */
export function checkEventSchemas(
    schemas: readonly EventSchemaInfo[],
    observedNamespaces: Iterable<string>,
): SchemaCheckResult {
    const observed = new Set(observedNamespaces);
    observed.delete("unknown");
    const result: SchemaCheckResult = { unlistedNamespaces: [], unusedSchemas: [], draftMismatches: [] };
    for (const ns of observed) if (!schemasListNamespace(schemas, ns)) result.unlistedNamespaces.push(ns);
    for (const s of schemas) {
        if (s.namespace !== undefined && !observed.has(s.namespace)) result.unusedSchemas.push(s.uri);
        if (s.namespace !== undefined && s.draft !== undefined && isKnownNamespace(s.namespace)) {
            const supported = EVENT_SCHEMA_DRAFT[s.namespace as Namespace];
            if (supported !== undefined && s.draft !== supported) result.draftMismatches.push(s.uri);
        }
    }
    return result;
}
