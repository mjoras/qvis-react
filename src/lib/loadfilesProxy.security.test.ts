// @vitest-environment node
//
// Security review of the Vercel Function api/loadfiles.ts (abuse of the CORS proxy). Lives here because vitest only
// collects src/**; the module is imported through a non-literal specifier (as in src/loading/loadfilesApi.test.ts) so
// the app's TypeScript project does not type-check Node-only code.

import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

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
    allowOrigins: string[];
    resolve(hostname: string): Promise<ResolvedAddress[]>;
    isBlockedAddress(address: string): boolean;
}
interface ApiModule {
    validateTargetURL(raw: string | null | undefined): { ok: boolean; status?: number; error?: string };
    isBlockedAddress(address: string): boolean;
    configFromEnv(env?: Record<string, string | undefined>): ProxyConfig;
    createLoadfilesHandler(configure?: () => ProxyConfig): (request: Request) => Promise<Response>;
}

const API_PATH = "../../api/loadfiles.ts";
let api: ApiModule;

let upstream: http.Server;
let upstreamPort = 0;
const QLOG = '{"file_schema":"urn:ietf:params:qlog:file:contained","traces":[]}';

beforeAll(async () => {
    api = (await import(/* @vite-ignore */ API_PATH)) as ApiModule;
    upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(QLOG);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
});

/** "upstream.test" / "self.test" resolve to 127.0.0.1, which this test policy allows. */
function testConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
    return {
        ...api.configFromEnv({}),
        resolve: async (h) => {
            if (h === "upstream.test" || h === "self.test") return [{ address: "127.0.0.1", family: 4 }];
            throw Object.assign(new Error("getaddrinfo ENOTFOUND " + h), { code: "ENOTFOUND" });
        },
        isBlockedAddress: (a) => a !== "127.0.0.1" && api.isBlockedAddress(a),
        ...overrides,
    };
}

const APP = "https://qvis.example";
const target = () => "http://upstream.test:" + upstreamPort + "/x.qlog";

function call(headers: Record<string, string>, config = testConfig(), file = target()): Promise<Response> {
    const handler = api.createLoadfilesHandler(() => config);
    return handler(new Request(APP + "/api/loadfiles?file=" + encodeURIComponent(file), { headers }));
}

/** What a browser sends for `fetch("/api/loadfiles?...")` from the qvis app itself. */
const SAME_ORIGIN_FETCH = { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" };

describe("who may use the proxy", () => {
    it("the app itself (same-origin fetch) and non-browser clients are served", async () => {
        const res = await call(SAME_ORIGIN_FETCH);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(QLOG);
        expect((await call({})).status).toBe(200);
    });

    it("another web site cannot use it as an open CORS proxy (fetch metadata)", async () => {
        const res = await call({
            Origin: "https://evil.example",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toMatch(/only serves the qvis app/);
    });

    it("another web site cannot use it either when the browser sends no fetch metadata (Origin only)", async () => {
        expect((await call({ Origin: "https://evil.example" })).status).toBe(403);
        // the app's own origin is fine
        expect((await call({ Origin: APP })).status).toBe(200);
    });

    it("QVIS_PROXY_ALLOW_ORIGINS opens it for named origins (or * for everyone)", async () => {
        const cross = {
            Origin: "https://other-qvis.example",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Dest": "empty",
        };
        const named = testConfig({ allowOrigins: ["https://other-qvis.example"] });
        expect((await call(cross, named)).status).toBe(200);
        expect((await call(cross, testConfig({ allowOrigins: ["*"] }))).status).toBe(200);
        expect(
            api.configFromEnv({ QVIS_PROXY_ALLOW_ORIGINS: "https://a.example, https://b.example" }).allowOrigins,
        ).toEqual(["https://a.example", "https://b.example"]);
        expect(api.configFromEnv({}).allowOrigins).toEqual([]);
    });

    it("never serves a navigation, frame, image or script load (arbitrary content from the app origin)", async () => {
        for (const dest of ["document", "iframe", "image", "script", "style", "object", "embed"]) {
            const res = await call({ "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": dest });
            expect(res.status, dest).toBe(403);
        }
        // a user typing the proxy URL into the address bar
        const typed = await call({
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
        });
        expect(await typed.text()).not.toContain("file_schema");
    });

    it("proxied responses cannot be embedded cross-origin (CORP)", async () => {
        const res = await call(SAME_ORIGIN_FETCH);
        expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    });
});

describe("loops through the proxy itself", () => {
    it("a request made by the proxy is refused (no self-recursion)", async () => {
        const res = await call({ "User-Agent": "qvis-react-proxy" });
        expect(res.status).toBe(508);
    });

    it("a nested /api/loadfiles?file=/api/loadfiles?file=... URL costs at most two invocations", async () => {
        let invocations = 0;
        const config = testConfig();
        const handler = api.createLoadfilesHandler(() => config);
        // the proxy deployment, reachable as http://self.test:<port>
        const self = http.createServer(async (req, res) => {
            invocations++;
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
            const r = await handler(new Request("http://self.test" + req.url, { headers }));
            res.writeHead(r.status, Object.fromEntries(r.headers));
            res.end(Buffer.from(await r.arrayBuffer()));
        });
        await new Promise<void>((r) => self.listen(0, "127.0.0.1", () => r()));
        const port = (self.address() as AddressInfo).port;
        try {
            let url = target();
            for (let i = 0; i < 6; i++)
                url = "http://self.test:" + port + "/api/loadfiles?file=" + encodeURIComponent(url);
            const res = await handler(new Request(APP + "/api/loadfiles?file=" + encodeURIComponent(url)));
            expect(res.status).toBe(502);
            expect(invocations).toBe(1);
        } finally {
            await new Promise<void>((r) => self.close(() => r()));
        }
    });
});

describe("cross-protocol requests", () => {
    it("rejects the Fetch standard's bad ports (SMTP, IRC, ...) before connecting", async () => {
        for (const port of [25, 6667, 10080, 5060]) {
            const v = api.validateTargetURL("http://example.com:" + port + "/x.qlog");
            expect(v.ok, String(port)).toBe(false);
            expect(v.status).toBe(400);
        }
        expect(api.validateTargetURL("https://example.com:4433/x.qlog").ok).toBe(true);
        expect(api.validateTargetURL("https://example.com/x.qlog").ok).toBe(true);
    });

    it("no bytes reach a service on a bad port (e.g. IRC on 6667)", async () => {
        let connected = false;
        const irc = net.createServer((s) => {
            connected = true;
            s.destroy();
        });
        const listening = await new Promise<boolean>((resolve) => {
            irc.once("error", () => resolve(false));
            irc.listen(6667, "127.0.0.1", () => resolve(true));
        });
        try {
            const res = await call({}, testConfig(), "http://upstream.test:6667/NICK%20x");
            expect(res.status).toBe(400);
            if (listening) expect(connected).toBe(false);
        } finally {
            if (listening) await new Promise<void>((r) => irc.close(() => r()));
        }
    });
});

describe("address policy additions", () => {
    it.each(["::ffff:0:7f00:1", "::ffff:0:a00:1", "::ffff:0:a9fe:a9fe"])("blocks IPv4-translated %s", (a) => {
        expect(api.isBlockedAddress(a)).toBe(true);
    });
});
