// @vitest-environment node
//
// Tests for the Vercel Function api/loadfiles.ts (CORS proxy + SSRF guard). The module is imported through a
// non-literal specifier so the app's TypeScript project does not type-check Node-only code (api/tsconfig.json does).

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

interface ResolvedAddress {
    address: string;
    family: number;
}
interface ProxyConfig {
    maxBytes: number;
    timeoutMs: number;
    maxRedirects: number;
    userAgent: string;
    allowHosts: string[];
    denyHosts: string[];
    resolve(hostname: string): Promise<ResolvedAddress[]>;
    isBlockedAddress(address: string): boolean;
}
interface ApiModule {
    QVIS_400_MESSAGE: string;
    validateTargetURL(raw: string | null | undefined): { ok: boolean; status?: number; error?: string };
    isBlockedAddress(address: string): boolean;
    parseIPv6(s: string): number[] | undefined;
    configFromEnv(env?: Record<string, string | undefined>): ProxyConfig;
    createLoadfilesHandler(configure?: () => ProxyConfig): (request: Request) => Promise<Response>;
    GET(request: Request): Promise<Response>;
    OPTIONS(): Response;
    safeContentType(v: string | string[] | undefined): string;
}

const API_PATH = "../../api/loadfiles.ts";
let api: ApiModule;

let server: http.Server;
let port = 0;
const seenHeaders: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
    api = (await import(/* @vite-ignore */ API_PATH)) as ApiModule;
    server = http.createServer((req, res) => {
        seenHeaders.push(req.headers);
        const url = new URL(req.url ?? "/", "http://x");
        switch (url.pathname) {
            case "/ok.qlog":
                res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "a=b" });
                res.end('{"file_schema":"urn:ietf:params:qlog:file:contained"}');
                return;
            case "/xss.html":
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end("<script>alert(document.domain)</script>");
                return;
            case "/gz.qlog":
                res.writeHead(200, { "Content-Encoding": "gzip" });
                res.end(gzipSync(Buffer.from("decoded body")));
                return;
            case "/missing.qlog":
                res.writeHead(404);
                res.end("nope");
                return;
            case "/redirect":
                res.writeHead(302, { Location: "/ok.qlog" });
                res.end();
                return;
            case "/redirect-internal":
                res.writeHead(302, { Location: "http://internal.test:" + port + "/ok.qlog" });
                res.end();
                return;
            case "/redirect-ftp":
                res.writeHead(301, { Location: "ftp://example.com/x" });
                res.end();
                return;
            case "/loop":
                res.writeHead(302, { Location: "/loop" });
                res.end();
                return;
            case "/big-declared":
                res.writeHead(200, { "Content-Length": "2000" });
                res.end("x".repeat(2000));
                return;
            case "/big-chunked":
                res.writeHead(200, { "Transfer-Encoding": "chunked" });
                res.write("y".repeat(600));
                res.end("y".repeat(600));
                return;
            default:
                res.writeHead(500);
                res.end();
        }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
});

/** Test policy: "upstream.test" -> 127.0.0.1 (allowed here), "internal.test" -> 10.0.0.7 (private, blocked). */
function testConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
    const hosts: Record<string, ResolvedAddress[]> = {
        "upstream.test": [{ address: "127.0.0.1", family: 4 }],
        "internal.test": [{ address: "10.0.0.7", family: 4 }],
    };
    return {
        ...api.configFromEnv({}),
        resolve: async (h) => {
            const r = hosts[h];
            if (!r) throw Object.assign(new Error("getaddrinfo ENOTFOUND " + h), { code: "ENOTFOUND" });
            return r;
        },
        isBlockedAddress: (a) => a !== "127.0.0.1" && api.isBlockedAddress(a),
        ...overrides,
    };
}

function call(target: string, config: ProxyConfig = testConfig(), extraQuery = ""): Promise<Response> {
    const handler = api.createLoadfilesHandler(() => config);
    const q = target === "" ? "" : "?file=" + encodeURIComponent(target);
    return handler(new Request("https://qvis.example/api/loadfiles" + q + extraQuery));
}

const upstream = (path: string) => "http://upstream.test:" + port + path;

describe("isBlockedAddress (SSRF guard)", () => {
    it.each([
        "127.0.0.1",
        "127.1.2.3",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "100.127.255.255",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:7f00:1",
        "64:ff9b::a00:1",
        "2002:a00:1::",
        "[::1]",
        "fe80::1%eth0",
        "not-an-ip",
    ])("blocks %s", (a) => {
        expect(api.isBlockedAddress(a)).toBe(true);
    });

    it.each([
        "8.8.8.8",
        "1.1.1.1",
        "172.32.0.1",
        "100.128.0.1",
        "2606:4700::1111",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",
    ])("allows %s", (a) => {
        expect(api.isBlockedAddress(a)).toBe(false);
    });

    it("parses IPv6 forms", () => {
        expect(api.parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
        expect(api.parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(api.parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
        expect(api.parseIPv6("1::2::3")).toBeUndefined();
        expect(api.parseIPv6("12345::")).toBeUndefined();
    });
});

describe("validateTargetURL (qvis-server messages)", () => {
    it("empty, malformed, non-http(s), invalid characters", () => {
        expect(api.validateTargetURL("")).toMatchObject({
            ok: false,
            status: 400,
            error: "Empty URL passed. If you're setting file=*.pcap, make sure to set secret= as well! ",
        });
        expect(api.validateTargetURL("not a url")).toMatchObject({
            ok: false,
            error: "Malformed URL import. URL must include http(s):// : TypeError : not a url",
        });
        expect(api.validateTargetURL("file:///etc/passwd")).toMatchObject({
            ok: false,
            error: "Malformed URL import. URL must include http(s):// : file:///etc/passwd",
        });
        expect(api.validateTargetURL("https://x.com/a?b={c}")).toMatchObject({
            ok: false,
            error: "Invalid URL import. : https://x.com/a?b={c}",
        });
        expect(api.validateTargetURL("https://user:pw@x.com/a")).toMatchObject({ ok: false });
        expect(api.validateTargetURL("https://x.com/a b.qlog")).toMatchObject({ ok: true });
    });
});

describe("handler", () => {
    it("400 with the qvis message for list / fileN / no parameters", async () => {
        for (const q of ["?list=https://x/l.json", "?file1=https://x/a.qlog", ""]) {
            const res = await api.createLoadfilesHandler(testConfig)(
                new Request("https://qvis.example/api/loadfiles" + q),
            );
            expect(res.status).toBe(400);
            expect(await res.json()).toEqual({ error: api.QVIS_400_MESSAGE });
            expect(res.headers.get("access-control-allow-origin")).toBe("*");
        }
    });

    it("streams the upstream body with CORS headers and does not forward client headers", async () => {
        seenHeaders.length = 0;
        const handler = api.createLoadfilesHandler(() => testConfig());
        const res = await handler(
            new Request("https://qvis.example/api/loadfiles?file=" + encodeURIComponent(upstream("/ok.qlog")), {
                headers: { Cookie: "session=secret", Authorization: "Bearer x" },
            }),
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('{"file_schema":"urn:ietf:params:qlog:file:contained"}');
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("x-qvis-upstream-status")).toBe("200");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(res.headers.get("set-cookie")).toBeNull();
        expect(seenHeaders[0].cookie).toBeUndefined();
        expect(seenHeaders[0].authorization).toBeUndefined();
        expect(seenHeaders[0]["user-agent"]).toBe("qvis-react-proxy");
    });

    it("never serves active content from the app origin (upstream HTML becomes octet-stream, sandbox CSP)", async () => {
        const res = await call(upstream("/xss.html"));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/octet-stream");
        expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await res.text()).toBe("<script>alert(document.domain)</script>");
        const err = await call("http://127.0.0.1/x.qlog");
        expect(err.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    });

    it("safeContentType passes only inert data types", () => {
        expect(api.safeContentType("application/json")).toBe("application/json");
        expect(api.safeContentType("application/qlog+json-seq")).toBe("application/qlog+json-seq");
        expect(api.safeContentType("text/plain; charset=utf-8")).toBe("text/plain; charset=utf-8");
        expect(api.safeContentType("text/html")).toBe("application/octet-stream");
        expect(api.safeContentType("image/svg+xml")).toBe("application/octet-stream");
        expect(api.safeContentType("application/xhtml+xml")).toBe("application/octet-stream");
        expect(api.safeContentType("text/xml")).toBe("application/octet-stream");
        expect(api.safeContentType(undefined)).toBe("application/octet-stream");
    });

    it("decodes a gzip Content-Encoding and does not pass the header on", async () => {
        const res = await call(upstream("/gz.qlog"));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(await res.text()).toBe("decoded body");
    });

    it("upstream non-2xx gives 502 {error, status}", async () => {
        const res = await call(upstream("/missing.qlog"));
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "Upstream returned HTTP 404", status: 404 });
    });

    it("follows redirects manually and re-validates every hop", async () => {
        expect((await call(upstream("/redirect"))).status).toBe(200);

        const internal = await call(upstream("/redirect-internal"));
        expect(internal.status).toBe(403);
        expect(((await internal.json()) as { error: string }).error).toMatch(/internal\.test.*10\.0\.0\.7/);

        const ftp = await call(upstream("/redirect-ftp"));
        expect(ftp.status).toBe(400);

        const loop = await call(upstream("/loop"));
        expect(loop.status).toBe(502);
        expect(((await loop.json()) as { error: string }).error).toMatch(/too many redirects/);
    });

    it("rejects private targets before connecting (default policy)", async () => {
        const handler = api.createLoadfilesHandler(() => api.configFromEnv({}));
        for (const target of [
            "http://127.0.0.1:" + port + "/ok.qlog",
            "http://[::1]/x",
            "http://169.254.169.254/latest/meta-data/",
            "http://0x7f.1/x",
            "http://localhost:" + port + "/ok.qlog",
        ]) {
            const res = await handler(
                new Request("https://qvis.example/api/loadfiles?file=" + encodeURIComponent(target)),
            );
            expect(res.status, target).toBe(403);
        }
    });

    it("DNS rebinding: the socket-level lookup re-checks the address", async () => {
        let calls = 0;
        const config = testConfig({
            // first answer (pre-check) is public, the second (socket connect) is private
            resolve: async () => [{ address: calls++ === 0 ? "93.184.216.34" : "10.0.0.8", family: 4 }],
            isBlockedAddress: api.isBlockedAddress,
        });
        const res = await call("http://rebind.test:" + port + "/ok.qlog", config);
        expect(res.status).toBe(403);
    });

    it("size cap: 413 for a declared Content-Length, aborted stream otherwise", async () => {
        const small = testConfig({ maxBytes: 1000 });
        const declared = await call(upstream("/big-declared"), small);
        expect(declared.status).toBe(413);
        expect(await declared.json()).toEqual({ error: "File too large for the qvis proxy" });

        const chunked = await call(upstream("/big-chunked"), small);
        expect(chunked.status).toBe(200);
        await expect(chunked.text()).rejects.toThrow();
    });

    it("unresolvable host gives 502 with the qvis wording", async () => {
        const res = await call("http://nowhere.test/x.qlog");
        expect(res.status).toBe(502);
        expect(((await res.json()) as { error: string }).error).toMatch(
            /^Something went wrong fetching the files from the origin server through the qvis CORS proxy : /,
        );
    });

    it("allow / deny host lists", async () => {
        const deny = await call(upstream("/ok.qlog"), testConfig({ denyHosts: [".test"] }));
        expect(deny.status).toBe(403);
        const notAllowed = await call(upstream("/ok.qlog"), testConfig({ allowHosts: ["example.com"] }));
        expect(notAllowed.status).toBe(403);
        const allowed = await call(upstream("/ok.qlog"), testConfig({ allowHosts: ["upstream.test"] }));
        expect(allowed.status).toBe(200);
    });

    it("env config: QVIS_PROXY_MAX_BYTES with a 128 MB default", () => {
        expect(api.configFromEnv({}).maxBytes).toBe(128 * 1024 * 1024);
        expect(api.configFromEnv({ QVIS_PROXY_MAX_BYTES: "5000" }).maxBytes).toBe(5000);
        expect(api.configFromEnv({ QVIS_PROXY_MAX_BYTES: "garbage" }).maxBytes).toBe(128 * 1024 * 1024);
    });

    it("non-GET methods get 405, OPTIONS answers the preflight", async () => {
        const res = await api.createLoadfilesHandler(testConfig)(
            new Request("https://qvis.example/api/loadfiles?file=x", { method: "POST", body: "x" }),
        );
        expect(res.status).toBe(405);
        const pre = api.OPTIONS();
        expect(pre.status).toBe(204);
        expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    });
});
