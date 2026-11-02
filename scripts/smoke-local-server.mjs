#!/usr/bin/env node
// Smoke test of the built local server (CI runs it on Linux, macOS and Windows):
//
//   npm run build && node scripts/smoke-local-server.mjs [--url http://localhost:8080]
//
// Without --url it starts `node dist-server/server/local-server.js --port 0` itself (and a second instance with
// --allow-private) and stops them afterwards; with --url it checks an already running server, e.g. the Docker image.

import { spawn } from "node:child_process";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

const urlArg = process.argv.indexOf("--url");
const external = urlArg >= 0 ? process.argv[urlArg + 1]?.replace(/\/+$/, "") : undefined;
const children = [];

function startServer(args) {
    const entry = fileURLToPath(new URL("../dist-server/server/local-server.js", import.meta.url));
    const child = spawn(process.execPath, [entry, "--port", "0", ...args], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    let out = "";
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server did not start within 20 s:\n" + out)), 20_000);
        child.once("exit", (code) => reject(new Error("server exited with code " + code + ":\n" + out)));
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            out += chunk;
            const m = /running at http:\/\/(?:\[[^\]]+\]|[^:/]+):(\d+)\//.exec(out);
            if (m) {
                clearTimeout(timer);
                resolve("http://127.0.0.1:" + m[1]);
            }
        });
    });
}

/** Raw request: the exact request target and Host reach the server (fetch() would normalize `%2e%2e`). */
function raw(base, target, headers = {}, method = "GET") {
    const u = new URL(base);
    return new Promise((resolve, reject) => {
        const req = http.request({ host: u.hostname, port: u.port, path: target, headers, method }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end();
    });
}

const failures = [];
async function check(name, fn) {
    try {
        await fn();
        console.log("ok   " + name);
    } catch (e) {
        failures.push(name);
        console.log("FAIL " + name + ": " + (e instanceof Error ? e.message : String(e)));
    }
}
function expect(cond, message) {
    if (!cond) throw new Error(message);
}

const APP_FETCH = { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "empty" };

try {
    const base = external ?? (await startServer([]));
    console.log("checking " + base);

    await check("index.html with CSP", async () => {
        const res = await fetch(base + "/");
        expect(res.status === 200, "status " + res.status);
        const html = await res.text();
        expect(html.includes("<title>qvis: tools and visualizations for QUIC and HTTP/3</title>"), "title missing");
        expect((res.headers.get("content-security-policy") ?? "").includes("script-src 'self'"), "CSP missing");
        const script = /<script[^>]+src="\.?\/?(assets\/[^"]+\.js)"/.exec(html);
        expect(script, "no module script in index.html");
        const js = await fetch(base + "/" + script[1]);
        expect(js.status === 200, "bundle status " + js.status);
        expect((js.headers.get("content-type") ?? "").startsWith("text/javascript"), "bundle content type");
    });

    await check("demo manifest and a demo file", async () => {
        const res = await fetch(base + "/examples/index.json");
        expect(res.status === 200, "status " + res.status);
        const list = await res.json();
        expect(Array.isArray(list) && list.length > 0, "empty manifest");
        const first = await fetch(base + "/examples/" + list[0].file);
        expect(first.status === 200, list[0].file + " status " + first.status);
    });

    await check("path traversal is refused", async () => {
        for (const p of [
            "/..%2fvercel.json",
            "/%2e%2e/vercel.json",
            "/assets/%2e%2e/%2e%2e/vercel.json",
            "/..%5cvercel.json",
            "/assets/..%5c..%5cvercel.json",
            "/assets/..\\..\\vercel.json",
            "/C:/Windows/win.ini",
            "/index.html::$DATA",
            "/CON",
        ]) {
            const res = await raw(base, p);
            expect(res.status === 404 || res.status === 400, p + " -> " + res.status);
        }
    });

    await check("proxy answers and keeps its SSRF guard", async () => {
        const res = await raw(base, "/api/loadfiles?file=" + encodeURIComponent("http://127.0.0.1:1234/a.qlog"));
        expect(res.status === 403, "status " + res.status);
        expect(JSON.parse(res.body).error.includes("public internet addresses"), "unexpected error " + res.body);
        expect((await raw(base, "/loadfiles")).status === 400, "/loadfiles");
        expect((await raw(base, "/api/loadfiles?file=x", {}, "TRACE")).status === 405, "TRACE");
    });

    await check("foreign host names and forged forwarding headers are refused", async () => {
        expect((await raw(base, "/", { Host: "rebind.example" })).status === 403, "rebinding Host");
        const forged = await raw(base, "/api/loadfiles?file=" + encodeURIComponent("https://example.com/"), {
            Origin: "http://evil.example",
            "X-Forwarded-Host": "evil.example",
            "X-Forwarded-Proto": "http",
        });
        expect(forged.status === 403, "forged X-Forwarded-Host -> " + forged.status);
    });

    if (external === undefined) {
        // --allow-private: a qlog on a local file server without CORS headers loads through the proxy
        const qlog = '{"file_schema":"urn:ietf:params:qlog:file:contained","traces":[]}';
        const upstream = http.createServer((_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(qlog);
        });
        await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
        const target = encodeURIComponent("http://127.0.0.1:" + upstream.address().port + "/trace.qlog");
        try {
            const privateBase = await startServer(["--allow-private"]);
            await check("--allow-private loads from a local file server", async () => {
                const res = await raw(privateBase, "/api/loadfiles?file=" + target, APP_FETCH);
                expect(res.status === 200 && res.body === qlog, "status " + res.status + " " + res.body.slice(0, 200));
                const notApp = await raw(privateBase, "/api/loadfiles?file=" + target);
                expect(notApp.status === 403, "without Fetch Metadata -> " + notApp.status);
                const metadata = await raw(
                    privateBase,
                    "/api/loadfiles?file=" + encodeURIComponent("http://169.254.169.254/latest/meta-data/"),
                    APP_FETCH,
                );
                expect(metadata.status === 403, "metadata address -> " + metadata.status);
            });
            await check("the default server still refuses the local file server", async () => {
                const res = await raw(base, "/api/loadfiles?file=" + target, APP_FETCH);
                expect(res.status === 403, "status " + res.status);
            });
        } finally {
            upstream.close();
        }
    }
} catch (e) {
    failures.push("startup");
    console.error(e instanceof Error ? e.message : e);
} finally {
    for (const child of children) child.kill();
}

if (failures.length > 0) {
    console.error(failures.length + " check(s) failed");
    process.exit(1);
}
console.log("local server smoke test passed");
