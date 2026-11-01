// Vercel Function (Node.js runtime): CORS proxy for remote qlog files (file-loading spec §3.12, §8.6).
//
//   GET /api/loadfiles?file=<absolute http(s) URL>     (vercel.json rewrites /loadfiles -> /api/loadfiles, qvis-server shape)
//
// Only the CORS-proxy half of qvis-server: `list` / `fileN` are orchestrated client-side (400 here), pcap conversion
// is not available (ARCHITECTURE §0). Hardening over qvis-server (FIX Q18):
//   - SSRF guard: the target host must resolve to public unicast addresses only. The check runs before the request
//     AND inside the socket's DNS lookup, so DNS rebinding between check and connect cannot reach internal hosts.
//   - redirects are followed manually (max 5) and every hop is re-validated
//   - GET only; client headers and cookies are never forwarded; fixed User-Agent
//   - 60 s total timeout; size cap QVIS_PROXY_MAX_BYTES (default 128 MB, counted on decoded bytes)
//   - optional QVIS_PROXY_ALLOW_HOSTS / QVIS_PROXY_DENY_HOSTS (comma-separated host names or ".suffix" entries)
//   - responses are served from the app's origin, so only inert upstream Content-Types are passed through
//     (HTML / SVG / XML become application/octet-stream) and every response carries a sandboxing CSP (no XSS)
// Abuse control (security review):
//   - only the qvis app itself may use it from a browser: cross-site requests (Fetch Metadata `Sec-Fetch-Site`, or an
//     `Origin` that is not the app's) get 403 unless QVIS_PROXY_ALLOW_ORIGINS lists the origin ("*" = everyone), so
//     other web sites cannot use the deployment as a free open CORS proxy
//   - navigations and subresource loads (`Sec-Fetch-Dest` other than "empty") get 403: the proxy never renders
//     arbitrary upstream content as a page of the app's origin; responses carry `Cross-Origin-Resource-Policy`
//   - requests made by the proxy itself (its User-Agent) get 508, so nested ?file=<proxy URL> chains cannot loop
//   - target ports on the Fetch standard's "bad port" list (SMTP, IRC, ...) are refused, as browsers do
// The body is streamed through (decoded from gzip/deflate/br), never buffered.
//
// Self-contained on purpose (no relative imports), so Vercel's per-function bundling needs no extra configuration.

import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import { pipeline, Readable, Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import * as zlib from "node:zlib";

// ------------------------------------------------------------------------------------------------ messages (qvis)

export const QVIS_400_MESSAGE =
    "no valid query parameters set. Please use list, file or filex. See github.com/quiclog/qvis-server for more information.";
export const EMPTY_URL_MESSAGE = "Empty URL passed. If you're setting file=*.pcap, make sure to set secret= as well! ";
export const TOO_LARGE_MESSAGE = "File too large for the qvis proxy";
export const ORIGIN_ERROR_PREFIX =
    "Something went wrong fetching the files from the origin server through the qvis CORS proxy : ";
export const UPSTREAM_STATUS_HEADER = "X-Qvis-Upstream-Status";

// ------------------------------------------------------------------------------------------------ URL validation

export type UrlValidation = { ok: true; url: URL } | { ok: false; status: number; error: string };

// qvis-server validateURL (FileFetchController.ts:28-71) character class
const ALLOWED_URL_CHARS = /^[a-z0-9:/?#|[\]@!$&'()*+,;=.\-_~%]*$/i;
const BAD_PERCENT = /%(?![0-9a-f]{2})/i;

/**
 * The Fetch standard's "bad ports" (https://fetch.spec.whatwg.org/#bad-port): services that an HTTP request must not
 * reach (cross-protocol attacks on SMTP, IRC, SIP, ...). Browsers refuse them, so the proxy does too.
 */
export const BAD_PORTS: ReadonlySet<number> = new Set([
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
    110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
    532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
    5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export function validateTargetURL(raw: string | null | undefined): UrlValidation {
    if (raw === undefined || raw === null || raw === "") return { ok: false, status: 400, error: EMPTY_URL_MESSAGE };
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return {
            ok: false,
            status: 400,
            error: "Malformed URL import. URL must include http(s):// : TypeError : " + raw,
        };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, status: 400, error: "Malformed URL import. URL must include http(s):// : " + raw };
    }
    // checked on the normalized form (the WHATWG parser percent-encodes spaces and non-ASCII characters)
    if (!ALLOWED_URL_CHARS.test(url.href) || BAD_PERCENT.test(url.href)) {
        return { ok: false, status: 400, error: "Invalid URL import. : " + raw };
    }
    if (url.username !== "" || url.password !== "") {
        return {
            ok: false,
            status: 400,
            error: "Invalid URL import. : credentials in URLs are not supported : " + raw,
        };
    }
    if (url.port !== "" && BAD_PORTS.has(Number(url.port))) {
        return { ok: false, status: 400, error: "Invalid URL import. : port " + url.port + " is not allowed : " + raw };
    }
    return { ok: true, url };
}

// ------------------------------------------------------------------------------------------------ address policy

/** Strict dotted-quad IPv4 (`URL.hostname` already normalizes hex/octal/short forms). */
export function parseIPv4(s: string): number[] | undefined {
    const parts = s.split(".");
    if (parts.length !== 4) return undefined;
    const out: number[] = [];
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return undefined;
        const n = Number(p);
        if (n > 255) return undefined;
        out.push(n);
    }
    return out;
}

/** IPv6 (optionally bracketed, with zone id or embedded IPv4) to eight 16-bit groups. */
export function parseIPv6(input: string): number[] | undefined {
    let s = input;
    if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
    const zone = s.indexOf("%");
    if (zone >= 0) s = s.slice(0, zone);
    if (s.length === 0 || !/^[0-9a-f:.]+$/i.test(s) || !s.includes(":")) return undefined;
    if (s.includes(".")) {
        const lastColon = s.lastIndexOf(":");
        const v4 = parseIPv4(s.slice(lastColon + 1));
        if (v4 === undefined) return undefined;
        s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
    }
    const halves = s.split("::");
    if (halves.length > 2) return undefined;
    const groups = (part: string): number[] =>
        part === "" ? [] : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
    const head = groups(halves[0]);
    const tail = halves.length === 2 ? groups(halves[1]) : [];
    if ([...head, ...tail].some((n) => Number.isNaN(n))) return undefined;
    if (halves.length === 1) return head.length === 8 ? head : undefined;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return undefined;
    return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

export function isBlockedIPv4(o: readonly number[]): boolean {
    const [a, b, c] = o;
    return (
        a === 0 || // 0.0.0.0/8 "this network"
        a === 10 || // private
        (a === 100 && (b & 0xc0) === 64) || // 100.64.0.0/10 CGNAT
        a === 127 || // loopback
        (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
        (a === 172 && (b & 0xf0) === 16) || // 172.16.0.0/12 private
        (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
        (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
        (a === 192 && b === 168) || // private
        (a === 198 && (b & 0xfe) === 18) || // 198.18.0.0/15 benchmarking
        (a === 198 && b === 51 && c === 100) || // TEST-NET-2
        (a === 203 && b === 0 && c === 113) || // TEST-NET-3
        a >= 224 // multicast 224/4, reserved 240/4, broadcast
    );
}

export function isBlockedIPv6(h: readonly number[]): boolean {
    const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
    if (h.every((x) => x === 0)) return true; // :: unspecified
    if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 loopback
    if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
        return isBlockedIPv4(embeddedV4(h[6], h[7])); // IPv4-mapped / IPv4-compatible
    }
    if (h.slice(0, 4).every((x) => x === 0) && h[4] === 0xffff && h[5] === 0) {
        return isBlockedIPv4(embeddedV4(h[6], h[7])); // IPv4-translated ::ffff:0:0/96 (SIIT)
    }
    if (h[0] === 0x64 && h[1] === 0xff9b) {
        if (h.slice(2, 6).every((x) => x === 0)) return isBlockedIPv4(embeddedV4(h[6], h[7])); // NAT64 64:ff9b::/96
        return true; // 64:ff9b:1::/48 local-use NAT64
    }
    if (h[0] === 0x2002) return isBlockedIPv4(embeddedV4(h[1], h[2])); // 6to4
    if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo
    if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // documentation
    if (h[0] === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // discard-only 100::/64
    if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((h[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
    if ((h[0] & 0xff00) === 0xff00) return true; // multicast
    return false;
}

/** True for every address that is not public unicast (unparsable input is blocked too). */
export function isBlockedAddress(address: string): boolean {
    const v4 = parseIPv4(address);
    if (v4 !== undefined) return isBlockedIPv4(v4);
    const v6 = parseIPv6(address);
    if (v6 !== undefined) return isBlockedIPv6(v6);
    return true;
}

export function isIPLiteral(hostname: string): boolean {
    return parseIPv4(hostname) !== undefined || parseIPv6(hostname) !== undefined;
}

function matchesHostList(hostname: string, list: readonly string[]): boolean {
    const h = hostname.toLowerCase();
    return list.some((entry) => {
        const e = entry.toLowerCase();
        return e.startsWith(".") ? h.endsWith(e) || h === e.slice(1) : h === e;
    });
}

// ------------------------------------------------------------------------------------------------ config

export interface ResolvedAddress {
    address: string;
    family: number;
}

export interface ProxyConfig {
    maxBytes: number;
    timeoutMs: number;
    maxRedirects: number;
    userAgent: string;
    allowHosts: string[];
    denyHosts: string[];
    /** browser origins other than the app's own that may use the proxy (QVIS_PROXY_ALLOW_ORIGINS; "*" = any) */
    allowOrigins: string[];
    resolve(hostname: string): Promise<ResolvedAddress[]>;
    isBlockedAddress(address: string): boolean;
}

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

function listFromEnv(v: string | undefined): string[] {
    return (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
    return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ProxyConfig {
    const max = Number(env.QVIS_PROXY_MAX_BYTES);
    return {
        maxBytes: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_BYTES,
        timeoutMs: 60_000,
        maxRedirects: 5,
        userAgent: "qvis-react-proxy",
        allowHosts: listFromEnv(env.QVIS_PROXY_ALLOW_HOSTS),
        denyHosts: listFromEnv(env.QVIS_PROXY_DENY_HOSTS),
        allowOrigins: listFromEnv(env.QVIS_PROXY_ALLOW_ORIGINS).map((o) => o.replace(/\/+$/, "")),
        resolve: defaultResolve,
        isBlockedAddress,
    };
}

// ------------------------------------------------------------------------------------------------ upstream request

class ProxyFailure extends Error {
    readonly status: number;
    readonly body: Record<string, unknown>;
    constructor(status: number, body: Record<string, unknown>) {
        super(String(body.error));
        this.status = status;
        this.body = body;
    }
}

function blocked(hostname: string, address?: string): ProxyFailure {
    return new ProxyFailure(403, {
        error:
            "Refusing to fetch from " +
            hostname +
            ": the qvis proxy only fetches from public internet addresses" +
            (address !== undefined ? " (resolved to " + address + ")" : ""),
    });
}

async function assertHostAllowed(url: URL, config: ProxyConfig): Promise<void> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (config.denyHosts.length > 0 && matchesHostList(hostname, config.denyHosts)) throw blocked(hostname);
    if (config.allowHosts.length > 0 && !matchesHostList(hostname, config.allowHosts)) throw blocked(hostname);
    if (isIPLiteral(hostname)) {
        if (config.isBlockedAddress(hostname)) throw blocked(hostname, hostname);
        return;
    }
    let addresses: ResolvedAddress[];
    try {
        addresses = await config.resolve(hostname);
    } catch (e) {
        throw new ProxyFailure(502, { error: ORIGIN_ERROR_PREFIX + errorText(e) });
    }
    if (addresses.length === 0)
        throw new ProxyFailure(502, { error: ORIGIN_ERROR_PREFIX + "could not resolve " + hostname });
    const bad = addresses.find((a) => config.isBlockedAddress(a.address));
    if (bad !== undefined) throw blocked(hostname, bad.address);
}

/** DNS lookup used by the socket itself: re-checks every address at connect time (DNS-rebinding safe). */
function guardedLookup(config: ProxyConfig): LookupFunction {
    const lookup = (hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void): void => {
        config.resolve(hostname).then(
            (all) => {
                const family = options.family === 4 || options.family === 6 ? options.family : 0;
                const addresses = family === 0 ? all : all.filter((a) => a.family === family);
                const bad = addresses.find((a) => config.isBlockedAddress(a.address));
                if (bad !== undefined) {
                    callback(blocked(hostname, bad.address));
                    return;
                }
                if (addresses.length === 0) {
                    const err = Object.assign(new Error("getaddrinfo ENOTFOUND " + hostname), { code: "ENOTFOUND" });
                    callback(err);
                    return;
                }
                if (options.all === true) callback(null, addresses);
                else callback(null, addresses[0].address, addresses[0].family);
            },
            (err: unknown) => callback(err),
        );
    };
    return lookup as unknown as LookupFunction;
}

function requestOnce(url: URL, config: ProxyConfig, signal: AbortSignal): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const mod = url.protocol === "https:" ? https : http;
        const req = mod.request(
            url,
            {
                method: "GET",
                headers: {
                    "user-agent": config.userAgent,
                    accept: "*/*",
                    "accept-encoding": "gzip, deflate, br",
                },
                lookup: guardedLookup(config),
                signal,
            },
            resolve,
        );
        req.on("error", reject);
        req.end();
    });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchWithRedirects(start: URL, config: ProxyConfig, signal: AbortSignal): Promise<http.IncomingMessage> {
    let url = start;
    for (let hop = 0; ; hop++) {
        await assertHostAllowed(url, config);
        let res: http.IncomingMessage;
        try {
            res = await requestOnce(url, config, signal);
        } catch (e) {
            if (e instanceof ProxyFailure) throw e;
            if (signal.aborted)
                throw new ProxyFailure(504, {
                    error: ORIGIN_ERROR_PREFIX + "timeout after " + config.timeoutMs / 1000 + " s",
                });
            const cause = (e as { cause?: unknown }).cause;
            if (cause instanceof ProxyFailure) throw cause;
            throw new ProxyFailure(502, { error: ORIGIN_ERROR_PREFIX + errorText(e) });
        }
        const status = res.statusCode ?? 0;
        if (!REDIRECT_STATUSES.has(status) || res.headers.location === undefined) return res;
        res.resume(); // discard the redirect body
        if (hop >= config.maxRedirects) {
            throw new ProxyFailure(502, {
                error: ORIGIN_ERROR_PREFIX + "too many redirects (more than " + config.maxRedirects + ")",
            });
        }
        let next: URL;
        try {
            next = new URL(res.headers.location, url);
        } catch {
            throw new ProxyFailure(502, {
                error: ORIGIN_ERROR_PREFIX + "invalid redirect location " + res.headers.location,
            });
        }
        const validation = validateTargetURL(next.href);
        if (!validation.ok) throw new ProxyFailure(validation.status, { error: validation.error });
        url = validation.url;
    }
}

function errorText(e: unknown): string {
    if (e instanceof Error) {
        const code = (e as { code?: unknown }).code;
        return typeof code === "string" && !e.message.includes(code) ? code + " " + e.message : e.message;
    }
    return String(e);
}

class TooLargeError extends Error {}

function byteLimiter(maxBytes: number): Transform {
    let total = 0;
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            total += chunk.length;
            if (total > maxBytes) callback(new TooLargeError(TOO_LARGE_MESSAGE));
            else callback(null, chunk);
        },
    });
}

function decoderFor(encoding: string | undefined): Transform | null | undefined {
    const e = (encoding ?? "").trim().toLowerCase();
    if (e === "" || e === "identity") return null;
    if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
    if (e === "deflate") return zlib.createInflate();
    if (e === "br") return zlib.createBrotliDecompress();
    return undefined; // unsupported
}

// ------------------------------------------------------------------------------------------------ response type

// The proxy answers from the app's own origin, so an upstream `text/html` / `image/svg+xml` / XML body would run
// script in the qvis origin (reflected XSS via `/api/loadfiles?file=https://evil/x.html`). The client only reads the
// bytes (`Response.blob()`) and sniffs them itself, so only inert data types are passed through; everything else
// becomes application/octet-stream, and the response additionally carries a sandboxing CSP.
const PASSTHROUGH_TYPE =
    /^(?:application\/(?:json|json-seq|octet-stream|gzip|x-gzip|[a-z0-9.+-]*\+json(?:-seq)?)|text\/plain)$/;

/** Upstream Content-Type if it is an inert data type (parameters kept), else `application/octet-stream`. */
export function safeContentType(upstream: string | string[] | undefined): string {
    const value = Array.isArray(upstream) ? upstream[0] : upstream;
    if (typeof value !== "string") return "application/octet-stream";
    const mediaType = value.split(";")[0].trim().toLowerCase();
    return PASSTHROUGH_TYPE.test(mediaType) ? value.trim() : "application/octet-stream";
}

/** Response headers that keep a proxied body inert even if a browser navigates to the proxy URL directly. */
export const SANDBOX_HEADERS: Readonly<Record<string, string>> = {
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    // no-cors loads (<img>, <script>, ...) from other origins get nothing
    "Cross-Origin-Resource-Policy": "same-origin",
};

// ------------------------------------------------------------------------------------------------ caller policy

/** Origins under which this deployment is reached: the request URL, and Host / X-Forwarded-Host. */
function ownOrigins(request: Request): Set<string> {
    const url = new URL(request.url);
    const out = new Set<string>([url.origin]);
    const proto = (request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1)).split(",")[0].trim();
    for (const value of [request.headers.get("x-forwarded-host"), request.headers.get("host")]) {
        if (value) for (const host of value.split(",")) out.add(proto + "://" + host.trim().toLowerCase());
    }
    return out;
}

function originAllowed(origin: string | null, config: ProxyConfig): boolean {
    return config.allowOrigins.includes("*") || (origin !== null && config.allowOrigins.includes(origin));
}

/**
 * Refuses callers that are not the qvis app (see the header comment): the proxy's own requests (loops), browser
 * navigations and subresource loads, and cross-site browser requests from origins not in QVIS_PROXY_ALLOW_ORIGINS.
 * Non-browser clients (no Origin, no Fetch Metadata) are served: they do not need a CORS proxy to read the target.
 */
export function rejectCaller(request: Request, config: ProxyConfig): Response | undefined {
    const headers = request.headers;
    if (headers.get("user-agent") === config.userAgent) {
        return jsonResponse(508, { error: "Refusing a request made by the qvis proxy itself (proxy loop)" });
    }
    const dest = headers.get("sec-fetch-dest");
    if (dest !== null && dest !== "empty") {
        return jsonResponse(403, {
            error: "The qvis proxy only answers fetch() requests, not Sec-Fetch-Dest: " + dest,
        });
    }
    const origin = headers.get("origin");
    const site = headers.get("sec-fetch-site");
    const crossSite =
        site !== null ? site !== "same-origin" && site !== "none" : origin !== null && !ownOrigins(request).has(origin);
    if (crossSite && !originAllowed(origin, config)) {
        return jsonResponse(403, {
            error:
                "The qvis proxy only serves the qvis app it is deployed with; requests from " +
                (origin ?? "other sites") +
                " are refused (QVIS_PROXY_ALLOW_ORIGINS)",
        });
    }
    return undefined;
}

// ------------------------------------------------------------------------------------------------ handler

const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": UPSTREAM_STATUS_HEADER,
};

export function jsonResponse(
    status: number,
    body: Record<string, unknown>,
    extra: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...CORS_HEADERS,
            ...SANDBOX_HEADERS,
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            ...extra,
        },
    });
}

export function createLoadfilesHandler(
    configure: () => ProxyConfig = () => configFromEnv(),
): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
        if (request.method !== "GET" && request.method !== "HEAD") {
            return jsonResponse(405, { error: "Only GET is supported by the qvis proxy" }, { Allow: "GET, OPTIONS" });
        }
        const config = configure();
        const refused = rejectCaller(request, config);
        if (refused !== undefined) return refused;
        const params = new URL(request.url).searchParams;
        if (!params.has("file")) {
            // list / fileN are orchestrated client-side; anything else is not a qvis-server request
            return jsonResponse(400, { error: QVIS_400_MESSAGE });
        }
        const validation = validateTargetURL(params.get("file"));
        if (!validation.ok) return jsonResponse(validation.status, { error: validation.error });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        let upstream: http.IncomingMessage;
        try {
            upstream = await fetchWithRedirects(validation.url, config, controller.signal);
        } catch (e) {
            clearTimeout(timer);
            if (e instanceof ProxyFailure) return jsonResponse(e.status, e.body);
            return jsonResponse(502, { error: ORIGIN_ERROR_PREFIX + errorText(e) });
        }

        const status = upstream.statusCode ?? 0;
        if (status < 200 || status >= 300) {
            upstream.resume();
            clearTimeout(timer);
            return jsonResponse(
                502,
                { error: "Upstream returned HTTP " + status, status },
                { [UPSTREAM_STATUS_HEADER]: String(status) },
            );
        }
        const declared = Number(upstream.headers["content-length"]);
        const decoder = decoderFor(upstream.headers["content-encoding"]);
        if (decoder === undefined) {
            upstream.destroy();
            clearTimeout(timer);
            return jsonResponse(502, {
                error:
                    ORIGIN_ERROR_PREFIX +
                    "unsupported Content-Encoding " +
                    String(upstream.headers["content-encoding"]),
            });
        }
        if (decoder === null && Number.isFinite(declared) && declared > config.maxBytes) {
            upstream.destroy();
            clearTimeout(timer);
            return jsonResponse(413, { error: TOO_LARGE_MESSAGE });
        }

        const limiter = byteLimiter(config.maxBytes);
        const done = (err?: Error | null) => {
            clearTimeout(timer);
            if (err) console.error("qvis proxy: stream aborted", validation.url.href, err.message);
        };
        if (decoder !== null) pipeline(upstream, decoder, limiter, done);
        else pipeline(upstream, limiter, done);

        const headers: Record<string, string> = {
            ...CORS_HEADERS,
            ...SANDBOX_HEADERS,
            "Content-Type": safeContentType(upstream.headers["content-type"]),
            "Cache-Control": "no-store",
            [UPSTREAM_STATUS_HEADER]: String(status),
        };
        if (request.method === "HEAD") {
            limiter.destroy();
            return new Response(null, { status: 200, headers });
        }
        const body = Readable.toWeb(limiter) as NodeWebReadableStream<Uint8Array>;
        return new Response(body as unknown as ReadableStream<Uint8Array>, { status: 200, headers });
    };
}

const handler = createLoadfilesHandler();

export function GET(request: Request): Promise<Response> {
    return handler(request);
}

export function HEAD(request: Request): Promise<Response> {
    return handler(request);
}

export function OPTIONS(): Response {
    return new Response(null, {
        status: 204,
        headers: {
            ...CORS_HEADERS,
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400",
        },
    });
}
