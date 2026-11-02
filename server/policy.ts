// Request and proxy-target policy of the local server (the Vercel deployment needs neither: its edge owns the Host
// header, and the machine running the function has no services of the user's).

import * as os from "node:os";
import { isBlockedAddress, parseIPv4, parseIPv6 } from "../api/loadfiles.ts";

const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i;

/** Host name of a Host header value (lower case, no brackets, no trailing dot), or undefined if malformed. */
export function hostNameOf(hostHeader: string | undefined): string | undefined {
    if (hostHeader === undefined) return undefined;
    const m = HOST_HEADER.exec(hostHeader);
    if (m === null || (m[2] !== undefined && Number(m[2]) > 65535)) return undefined;
    try {
        new URL("http://" + hostHeader);
    } catch {
        return undefined;
    }
    return normalizeHostName(m[1]);
}

/** `Qvis.Example.` -> `qvis.example`, `[::1]` -> `::1`; also accepts `name:port` (the port is dropped). */
export function normalizeHostName(name: string): string {
    let n = name.trim().toLowerCase();
    if (n.startsWith("[")) n = n.slice(1, n.indexOf("]") < 0 ? undefined : n.indexOf("]"));
    else if (/^[^:]+:\d+$/.test(n)) n = n.slice(0, n.lastIndexOf(":"));
    return n.replace(/\.$/, "");
}

/**
 * IP literals that reach this server but that browsers do not treat as localhost, so they send no Fetch Metadata
 * there (0.0.0.0, ::, IPv4-mapped/-compatible/-translated and NAT64 forms of loopback). The proxy's caller policy
 * relies on Fetch Metadata, so such Host values are refused.
 */
function isAliasLiteral(hostname: string): boolean {
    const v4 = parseIPv4(hostname);
    if (v4 !== undefined) return v4[0] === 0;
    const h = parseIPv6(hostname);
    if (h === undefined) return false;
    if (h.slice(0, 5).every((x) => x === 0) && !(h[5] === 0 && h[6] === 0 && h[7] === 1)) return true; // ::, ::ffff:a.b.c.d, ::a.b.c.d
    if (h.slice(0, 4).every((x) => x === 0) && h[4] === 0xffff && h[5] === 0) return true; // ::ffff:0:a.b.c.d
    return h[0] === 0x64 && h[1] === 0xff9b; // NAT64
}

/**
 * DNS-rebinding guard: a web page can make the browser send requests to this server under the page's own host name
 * (which the attacker then resolves to 127.0.0.1). Answer only names the user can have typed: IP addresses,
 * localhost, *.localhost, and names passed with --allowed-hosts / QVIS_ALLOWED_HOSTS.
 */
export function isAllowedHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
    const hostname = hostNameOf(hostHeader);
    if (hostname === undefined) return false;
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
    if (parseIPv4(hostname) !== undefined || parseIPv6(hostname) !== undefined) return !isAliasLiteral(hostname);
    return allowedHosts.some((h) => normalizeHostName(h) === hostname);
}

/** True for addresses that `--allow-private` lets the proxy fetch: loopback and private networks of the user. */
export function isPrivateTarget(address: string): boolean {
    const v4 = parseIPv4(address);
    if (v4 !== undefined) return isPrivateIPv4(v4);
    const h = parseIPv6(address);
    if (h === undefined) return false;
    if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
        return isPrivateIPv4([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]); // IPv4-mapped
    }
    return (h[0] & 0xfe00) === 0xfc00; // fc00::/7 unique local
}

function isPrivateIPv4([a, b]: readonly number[]): boolean {
    return (
        a === 127 || // loopback
        a === 10 ||
        (a === 172 && (b & 0xf0) === 16) ||
        (a === 192 && b === 168) ||
        (a === 100 && (b & 0xc0) === 64) // CGNAT 100.64.0.0/10 (Tailscale and similar)
    );
}

/** Canonical text of an IP address (IPv4-mapped IPv6 as IPv4), for comparing addresses. */
function canonicalIP(address: string): string | undefined {
    const v4 = parseIPv4(address);
    if (v4 !== undefined) return v4.join(".");
    const h = parseIPv6(address);
    if (h === undefined) return undefined;
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
        return [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join(".");
    }
    return h.map((x) => x.toString(16)).join(":");
}

/** Addresses of this machine's network interfaces (a public IPv6 address of the laptop is still the laptop). */
export function ownAddresses(): Set<string> {
    const out = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list ?? []) {
            const c = canonicalIP(a.address);
            if (c !== undefined) out.add(c);
        }
    }
    return out;
}

/**
 * Cloud metadata services outside the link-local ranges (which isBlockedAddress always refuses): they sit inside
 * ranges that --allow-private opens, so they are refused explicitly. Canonical form (see canonicalIP).
 */
const METADATA_ADDRESSES: ReadonlySet<string> = new Set([
    "100.100.100.200", // Alibaba Cloud ECS (in 100.64.0.0/10)
    "fd00:ec2:0:0:0:0:0:254", // AWS EC2 IMDS over IPv6 (in fc00::/7)
    "fd20:ce:0:0:0:0:0:254", // Google Compute Engine metadata over IPv6 (in fc00::/7)
]);

/**
 * The proxy's address policy in the local server and in the Vite dev/preview proxy. Default: the Vercel policy
 * (public unicast only) plus this machine's own addresses, so the proxy cannot reach services on this computer
 * through a public address of it. With `allowPrivate`, this computer and private networks are allowed too;
 * link-local addresses (169.254.0.0/16, fe80::/10), known cloud metadata endpoints, unspecified, multicast and
 * reserved addresses stay blocked.
 */
export function localAddressPolicy(
    allowPrivate: boolean,
    own: () => Set<string> = ownAddresses,
): (address: string) => boolean {
    return (address) => {
        const c = canonicalIP(address);
        if (c !== undefined && METADATA_ADDRESSES.has(c)) return true;
        if (allowPrivate && isPrivateTarget(address)) return false;
        if (isBlockedAddress(address)) return true;
        if (allowPrivate) return false;
        return c !== undefined && own().has(c);
    };
}

/** True for IP literals (also bracketed IPv6). */
export function isIPAddress(name: string): boolean {
    const n = normalizeHostName(name);
    return parseIPv4(n) !== undefined || parseIPv6(n) !== undefined;
}

/** True for bind addresses that only this computer can reach. */
export function isLoopbackBind(host: string): boolean {
    const name = normalizeHostName(host);
    if (name === "localhost") return true;
    const v4 = parseIPv4(name);
    if (v4 !== undefined) return v4[0] === 127;
    const h = parseIPv6(name);
    return h !== undefined && h.slice(0, 7).every((x) => x === 0) && h[7] === 1;
}
