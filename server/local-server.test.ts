// @vitest-environment node
//
// Local server (server/*.ts): static path resolution, vercel.json rules, host check, and the HTTP behaviour of
// createLocalServer with the real vercel.json and the real proxy.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv, isBlockedAddress, type ProxyConfig } from "../api/loadfiles.ts";
import { createLocalServer, isAllowedHost } from "./local-server.ts";
import { resolveStaticPath } from "./static-files.ts";
import { compileVercelRules, sourceToRegExp } from "./vercel-rules.ts";

const VERCEL_JSON: unknown = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

describe("resolveStaticPath", () => {
    const root = path.resolve(os.tmpdir(), "qvis-root");

    it.each([
        ["/", root],
        ["/index.html", path.join(root, "index.html")],
        ["/assets/index-abc.js", path.join(root, "assets", "index-abc.js")],
        ["/examples/massive/massive_server.sqlog", path.join(root, "examples", "massive", "massive_server.sqlog")],
        ["/a%20b.qlog", path.join(root, "a b.qlog")],
        ["//assets//x.js", path.join(root, "assets", "x.js")],
    ])("maps %s inside the root", (pathname, expected) => {
        expect(resolveStaticPath(root, pathname)).toBe(expected);
    });

    it.each([
        "/../package.json",
        "/assets/../../package.json",
        "/%2e%2e/package.json",
        "/assets/%2E%2E/%2e%2e/package.json",
        "/..%2fpackage.json",
        "/assets%2f..%2f..%2fpackage.json",
        "/..%5cpackage.json",
        "/assets/..\\..\\package.json",
        "/C:/Windows/win.ini",
        "/c%3a%5cwindows%5cwin.ini",
        "/index.html::$DATA",
        "/index.html%3a%3a%24DATA",
        "/index.html.",
        "/index.html%20",
        "/CON",
        "/nul.txt",
        "/assets/COM1.js",
        "/lpt9",
        "/a%00b",
        "/%zz",
        "/.",
        "relative",
    ])("refuses %s", (pathname) => {
        expect(resolveStaticPath(root, pathname)).toBeUndefined();
    });
});

describe("vercel.json rules", () => {
    const rules = compileVercelRules(VERCEL_JSON);
    const csp = (p: string) => rules.headersFor(p)["Content-Security-Policy"];

    it("sends the CSP on app paths but not on the proxy", () => {
        expect(csp("/")).toContain("script-src 'self'");
        expect(csp("/index.html")).toContain("script-src 'self'");
        expect(csp("/assets/index-abc.js")).toBeDefined();
        expect(csp("/examples/index.json")).toBeDefined();
        expect(csp("/api/loadfiles")).toBeUndefined();
        expect(csp("/loadfiles")).toBeUndefined();
        expect(csp("/loadfiles/")).toBeUndefined();
    });

    it("sends the cache and security headers of vercel.json", () => {
        expect(rules.headersFor("/")["Cache-Control"]).toBe("no-cache");
        expect(rules.headersFor("/index.html")["Cache-Control"]).toBe("no-cache");
        expect(rules.headersFor("/assets/x.js")["Cache-Control"]).toBe("public, max-age=31536000, immutable");
        expect(rules.headersFor("/examples/a.qlog")).toMatchObject({
            "Cache-Control": "public, max-age=3600, must-revalidate",
            "Access-Control-Allow-Origin": "*",
        });
        for (const p of ["/", "/assets/x.js", "/api/loadfiles"]) {
            expect(rules.headersFor(p)).toMatchObject({
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "strict-origin-when-cross-origin",
            });
        }
    });

    it("rewrites the qvis-server paths onto the proxy", () => {
        expect(rules.rewrite("/loadfiles")).toBe("/api/loadfiles");
        expect(rules.rewrite("/loadfiles/")).toBe("/api/loadfiles");
        expect(rules.rewrite("/api/loadfiles")).toBe("/api/loadfiles");
        expect(rules.rewrite("/loadfilesx")).toBe("/loadfilesx");
        expect(rules.rewrite("/")).toBe("/");
    });

    it("treats literal characters literally", () => {
        expect(sourceToRegExp("/index.html").test("/indexXhtml")).toBe(false);
        expect(sourceToRegExp("/assets/(.*)").test("/assets/a/b.js")).toBe(true);
        expect(sourceToRegExp("/assets/(.*)").test("/assetsX/a.js")).toBe(false);
    });

    it.each(["/:path*", "/assets/:file", "/(.*)?", "/a{b}", "assets/(.*)", "/((.*)"])(
        "rejects source syntax it does not implement: %s",
        (source) => {
            expect(() => sourceToRegExp(source)).toThrow(/not supported by the local server/);
        },
    );

    it("rejects conditional rules instead of ignoring the condition", () => {
        expect(() =>
            compileVercelRules({ headers: [{ source: "/(.*)", has: [{ type: "host", value: "x" }], headers: [] }] }),
        ).toThrow();
        expect(() => compileVercelRules({ rewrites: [{ source: "/a", destination: "/:x" }] })).toThrow();
    });
});

describe("isAllowedHost", () => {
    it.each([
        "localhost",
        "localhost:8080",
        "LOCALHOST:8080",
        "qvis.localhost:8080",
        "127.0.0.1:8080",
        "[::1]:8080",
        "192.168.1.20:8080",
        "localhost.:8080",
    ])("allows %s", (host) => {
        expect(isAllowedHost(host, [])).toBe(true);
    });

    it.each([
        undefined,
        "",
        "evil.example",
        "evil.example:8080",
        "localhost.evil.example",
        "evil.example@localhost",
        "localhost/evil",
        "localhost:8080:80",
        "local host",
    ])("refuses %s", (host) => {
        expect(isAllowedHost(host, [])).toBe(false);
    });

    it("allows extra names from --allowed-hosts, written with or without port, case or trailing dot", () => {
        expect(isAllowedHost("qvis.lab.example:8080", ["qvis.lab.example"])).toBe(true);
        expect(isAllowedHost("qvis.lab.example:8080", ["QVIS.lab.example:8080"])).toBe(true);
        expect(isAllowedHost("qvis.lab.example.", ["qvis.lab.example."])).toBe(true);
        expect(isAllowedHost("other.lab.example:8080", ["qvis.lab.example"])).toBe(false);
    });
});

describe("createLocalServer", () => {
    let dist: string;
    let server: http.Server;
    let base: string;
    let upstream: http.Server;
    let upstreamPort = 0;
    let hasSymlink = false;
    let outside: string;

    /** The real policy, except that "upstream.test" resolves to the local test upstream (127.0.0.1). */
    const proxyConfig = (): ProxyConfig => ({
        ...configFromEnv({}),
        resolve: async (h) => {
            if (h === "upstream.test") return [{ address: "127.0.0.1", family: 4 }];
            if (h === "localhost") return [{ address: "127.0.0.1", family: 4 }];
            throw Object.assign(new Error("getaddrinfo ENOTFOUND " + h), { code: "ENOTFOUND" });
        },
        isBlockedAddress: (a) => a !== "127.0.0.1" && isBlockedAddress(a),
    });

    beforeAll(async () => {
        dist = mkdtempSync(path.join(os.tmpdir(), "qvis-dist-"));
        writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>qvis</title>");
        mkdirSync(path.join(dist, "assets"));
        writeFileSync(path.join(dist, "assets", "app.js"), "console.log(1)");
        mkdirSync(path.join(dist, "examples"));
        writeFileSync(path.join(dist, "examples", "a.sqlog"), '\u001e{"file_schema":"x"}\n');
        outside = mkdtempSync(path.join(os.tmpdir(), "qvis-outside-"));
        writeFileSync(path.join(outside, "secret.txt"), "secret");
        try {
            symlinkSync(path.join(outside, "secret.txt"), path.join(dist, "link.txt"));
            mkdirSync(path.join(dist, "linkdir"));
            symlinkSync(path.join(outside, "secret.txt"), path.join(dist, "linkdir", "index.html"));
            hasSymlink = true;
        } catch {
            hasSymlink = false;
        }

        upstream = http.createServer((req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(req.method === "HEAD" ? undefined : '{"from":"upstream","path":' + JSON.stringify(req.url) + "}");
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
        upstreamPort = (upstream.address() as AddressInfo).port;

        server = createLocalServer({ dist, vercelConfig: VERCEL_JSON, proxyConfig });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
        server.closeAllConnections();
        upstream.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await new Promise<void>((r) => upstream.close(() => r()));
        rmSync(dist, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    /** Raw request, so tests control the Host header and the request target exactly. */
    function raw(
        target: string,
        init: { method?: string; headers?: Record<string, string>; base?: string } = {},
    ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
        const url = new URL(init.base ?? base);
        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: url.hostname,
                    port: url.port,
                    path: target,
                    method: init.method ?? "GET",
                    headers: init.headers,
                },
                (res) => {
                    let body = "";
                    res.setEncoding("utf8");
                    res.on("data", (c: string) => (body += c));
                    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
                },
            );
            req.on("error", reject);
            req.end();
        });
    }

    it("serves index.html at / with the CSP and no-cache", async () => {
        const res = await raw("/");
        expect(res.status).toBe(200);
        expect(res.body).toContain("<title>qvis</title>");
        expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
        expect(res.headers["cache-control"]).toBe("no-cache");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("serves / with a query string (?file= startup links)", async () => {
        const res = await raw("/?file=https%3A%2F%2Fexample.com%2Fa.qlog");
        expect(res.status).toBe(200);
        expect(res.body).toContain("<title>qvis</title>");
    });

    it("serves assets and examples with their vercel.json headers", async () => {
        const js = await raw("/assets/app.js");
        expect(js.status).toBe(200);
        expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
        expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        const ex = await raw("/examples/a.sqlog");
        expect(ex.status).toBe(200);
        expect(ex.headers["access-control-allow-origin"]).toBe("*");
        expect(ex.headers["content-type"]).toBe("application/octet-stream");
    });

    it("answers HEAD without a body and revalidates with ETag", async () => {
        const head = await raw("/assets/app.js", { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.body).toBe("");
        expect(head.headers["content-length"]).toBe("14");
        const again = await raw("/assets/app.js", { headers: { "If-None-Match": String(head.headers.etag) } });
        expect(again.status).toBe(304);
        expect(again.body).toBe("");
    });

    it("returns 404 for missing files, directories without a slash and paths outside the build", async () => {
        for (const p of ["/missing.js", "/examples", "/../package.json", "/%2e%2e/package.json", "/..%2f..%2fetc"]) {
            expect((await raw(p)).status, p).toBe(404);
        }
    });

    it("does not follow symlinks out of the build, also for a directory's index.html", async (ctx) => {
        if (!hasSymlink) ctx.skip(); // no symlink permission (Windows without developer mode)
        for (const p of ["/link.txt", "/linkdir/"]) {
            const res = await raw(p);
            expect(res.status, p).toBe(404);
            expect(res.body).not.toContain("secret");
        }
    });

    it("refuses other methods on static paths", async () => {
        const res = await raw("/", { method: "POST" });
        expect(res.status).toBe(405);
        expect(res.headers.allow).toBe("GET, HEAD");
    });

    it("refuses host names that are not local (DNS rebinding)", async () => {
        for (const p of ["/", "/api/loadfiles?file=https%3A%2F%2Fupstream.test%2F"]) {
            const res = await raw(p, { headers: { Host: "rebind.attacker.example:8080" } });
            expect(res.status, p).toBe(403);
            expect(res.body).toContain("does not answer to the host name");
        }
    });

    it("redirects paths with empty segments like Vercel, never to another host", async () => {
        const a = await raw("//upstream.test/index.html");
        expect(a.status).toBe(308);
        expect(a.headers.location).toBe("/upstream.test/index.html");
        const b = await raw("/assets//app.js?x=1");
        expect(b.status).toBe(308);
        expect(b.headers.location).toBe("/assets/app.js?x=1");
        expect((await raw("//api/loadfiles?file=x")).headers.location).toBe("/api/loadfiles?file=x");
    });

    it("serves only the exact spelling of a path (case-insensitive file systems, like Vercel)", async () => {
        for (const p of ["/INDEX.html", "/Assets/app.js", "/assets/APP.JS", "/EXAMPLES/a.sqlog"]) {
            expect((await raw(p)).status, p).toBe(404);
        }
    });

    it("revalidates with If-None-Match lists and *", async () => {
        const etag = String((await raw("/assets/app.js", { method: "HEAD" })).headers.etag);
        for (const inm of ["*", '"other", ' + etag, etag.replace(/^W\//, "")]) {
            expect((await raw("/assets/app.js", { headers: { "If-None-Match": inm } })).status, inm).toBe(304);
        }
        expect((await raw("/assets/app.js", { headers: { "If-None-Match": '"other"' } })).status).toBe(200);
    });

    it("ignores forged X-Forwarded-* headers in the proxy's origin check", async () => {
        const target = encodeURIComponent("http://upstream.test:" + upstreamPort + "/a.qlog");
        const res = await raw("/api/loadfiles?file=" + target, {
            headers: {
                Origin: "http://evil.example",
                "X-Forwarded-Host": "evil.example",
                "X-Forwarded-Proto": "http",
                Forwarded: "host=evil.example;proto=http",
            },
        });
        expect(res.status).toBe(403);
    });

    it("refuses host spellings browsers do not treat as localhost, and invalid ports", async () => {
        for (const host of [
            "[::ffff:7f00:1]:8080",
            "[::ffff:127.0.0.1]:8080",
            "0.0.0.0:8080",
            "[::]:8080",
            "localhost:99999",
        ]) {
            const res = await raw("/", { headers: { Host: host } });
            expect(res.status, host).toBe(403);
            expect(res.body, host).not.toContain("--allowed-hosts"); // listing them would not help
        }
        const named = await raw("/", { headers: { Host: "hemlock.local:8080" } });
        expect(named.body).toContain("--allowed-hosts hemlock.local ");
    });

    it("answers TRACE and other methods on the proxy with 405, not 500", async () => {
        for (const method of ["TRACE", "PUT", "DELETE", "PROPFIND"]) {
            const res = await raw("/api/loadfiles?file=x", { method });
            expect(res.status, method).toBe(405);
            expect(res.headers.allow).toBe("GET, HEAD, OPTIONS");
        }
    });

    it("routes /api/loadfiles/ to the proxy, as Vercel does", async () => {
        const target = encodeURIComponent("http://upstream.test:" + upstreamPort + "/a.qlog");
        const res = await raw("/api/loadfiles/?file=" + target);
        expect(res.status).toBe(200);
        expect(res.headers["x-qvis-upstream-status"]).toBe("200");
    });

    it("refuses absolute-form request targets", async () => {
        const res = await raw("http://upstream.test/x");
        expect(res.status).toBe(400);
    });

    it("runs the proxy at /api/loadfiles and /loadfiles", async () => {
        const target = encodeURIComponent("http://upstream.test:" + upstreamPort + "/a.qlog");
        for (const p of ["/api/loadfiles?file=" + target, "/loadfiles?file=" + target, "/loadfiles/?file=" + target]) {
            const res = await raw(p, { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "empty" } });
            expect(res.status, p).toBe(200);
            expect(JSON.parse(res.body)).toEqual({ from: "upstream", path: "/a.qlog" });
            expect(res.headers["x-qvis-upstream-status"]).toBe("200");
            expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
            expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
        }
    });

    it("keeps the proxy's caller policy and SSRF guard", async () => {
        const target = encodeURIComponent("http://upstream.test:" + upstreamPort + "/a.qlog");
        const crossSite = await raw("/api/loadfiles?file=" + target, {
            headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" },
        });
        expect(crossSite.status).toBe(403);
        const navigation = await raw("/api/loadfiles?file=" + target, { headers: { "Sec-Fetch-Dest": "document" } });
        expect(navigation.status).toBe(403);
        const privateTarget = await raw("/api/loadfiles?file=" + encodeURIComponent("http://10.0.0.1/a.qlog"));
        expect(privateTarget.status).toBe(403);
        expect(JSON.parse(privateTarget.body).error).toContain("only fetches from public internet addresses");
        const missing = await raw("/api/loadfiles");
        expect(missing.status).toBe(400);
    });

    it("answers proxy HEAD and OPTIONS like the Vercel Function", async () => {
        const target = encodeURIComponent("http://upstream.test:" + upstreamPort + "/a.qlog");
        const head = await raw("/api/loadfiles?file=" + target, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.body).toBe("");
        const options = await raw("/api/loadfiles", { method: "OPTIONS" });
        expect(options.status).toBe(204);
        expect(options.headers["access-control-allow-methods"]).toBe("GET, HEAD, OPTIONS");
        const post = await raw("/api/loadfiles?file=" + target, { method: "POST" });
        expect(post.status).toBe(405);
    });
});

describe("createLocalServer options", () => {
    let dist: string;
    const servers: http.Server[] = [];

    beforeAll(() => {
        dist = mkdtempSync(path.join(os.tmpdir(), "qvis-dist-opts-"));
        writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>qvis</title>");
        mkdirSync(path.join(dist, "assets"));
        writeFileSync(path.join(dist, "assets", "app.js"), "console.log(1)");
    });

    afterAll(async () => {
        for (const s of servers) {
            s.closeAllConnections();
            await new Promise<void>((r) => s.close(() => r()));
        }
        rmSync(dist, { recursive: true, force: true });
    });

    async function start(options: Partial<Parameters<typeof createLocalServer>[0]>): Promise<string> {
        const server = createLocalServer({ dist, vercelConfig: VERCEL_JSON, ...options });
        servers.push(server);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    }

    function get(base: string, target: string, headers: Record<string, string> = {}) {
        return fetch(base + target, { headers, redirect: "manual" });
    }

    it("serves files when the build directory is given in another spelling (case, symlinked parents)", async (ctx) => {
        const upper = dist.replace(/qvis-dist-opts-/, "QVIS-DIST-OPTS-");
        if (!existsSync(upper)) ctx.skip(); // case-sensitive file system: there is no other spelling
        const base = await start({ dist: upper });
        expect((await get(base, "/")).status).toBe(200);
        expect((await get(base, "/assets/app.js")).status).toBe(200);
    });

    it("applies rewrites after the file system and the function, like Vercel (SPA fallback rule)", async () => {
        const vercelConfig = {
            rewrites: [{ source: "/(.*)", destination: "/index.html" }],
        };
        const base = await start({ vercelConfig });
        const js = await get(base, "/assets/app.js");
        expect(js.status).toBe(200);
        expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
        const fallback = await get(base, "/some/client/route");
        expect(fallback.status).toBe(200);
        expect(await fallback.text()).toContain("<title>qvis</title>");
        const proxy = await get(base, "/api/loadfiles");
        expect(proxy.status).toBe(400); // the function, not index.html
    });

    it("answers proxy requests only from the app itself when private targets are allowed", async () => {
        const base = await start({ requireSameOriginFetch: true });
        const plain = await get(base, "/api/loadfiles?file=x");
        expect(plain.status).toBe(403);
        expect((await plain.json()).error).toContain("needs the browser's Sec-Fetch-Site header");
        const crossSite = await get(base, "/api/loadfiles?file=x", {
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Dest": "empty",
        });
        expect((await crossSite.json()).error).toContain("only answers the qvis app itself");
        const img = await get(base, "/api/loadfiles?file=x", {
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Dest": "image",
        });
        expect(img.status).toBe(403);
        const app = await get(base, "/api/loadfiles?file=x", {
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Dest": "empty",
        });
        expect(app.status).toBe(400); // reached the proxy ("x" is not a URL)
        expect((await get(base, "/api/loadfiles", {})).status).toBe(403);
    });
});
