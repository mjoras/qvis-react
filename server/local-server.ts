// qvis-react local server: serves the production build (dist/) and runs the same CORS proxy as the Vercel
// deployment (api/loadfiles.ts) at /api/loadfiles and /loadfiles, with the headers from vercel.json.
//
//   npm start                      build, then serve on http://localhost:8080/
//   npm run serve                  serve an existing build
//   node dist-server/server/local-server.js --help
//
// No dependencies beyond Node itself: `npm run build` compiles this file and the proxy into dist-server/, and
// dist/ + dist-server/ + vercel.json are all it needs at run time (node_modules is not used).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configFromEnv, createLoadfilesHandler, OPTIONS, type ProxyConfig } from "../api/loadfiles.ts";
import {
    isProxyMethod,
    isProxyPath,
    PROXY_ROUTE,
    proxyMethodNotAllowed,
    runWebHandler,
    type WebHandler,
} from "./node-adapter.ts";
import { hostNameOf, isAllowedHost, isIPAddress, isLoopbackBind, localAddressPolicy } from "./policy.ts";
import { findStaticFile, sendStaticFile } from "./static-files.ts";
import { compileVercelRules, type VercelRules } from "./vercel-rules.ts";

export { isAllowedHost } from "./policy.ts";

const HELP = `qvis-react local server

Usage: npm start [-- options]        (builds first)
       npm run serve [-- options]    (serves an existing build)
       node dist-server/server/local-server.js [options]

Options:
  --port <n>              port to listen on (default: $PORT or 8080; 0 picks a free port)
  --host <address>        address to listen on (default: 127.0.0.1 and ::1, this computer only).
                          0.0.0.0 accepts connections from other machines.
  --allowed-hosts <list>  comma-separated extra host names to answer to, for example a DNS name of this
                          machine (default: $QVIS_ALLOWED_HOSTS). localhost and IP addresses always work,
                          except 0.0.0.0, :: and IPv4-mapped forms, which browsers do not treat as local.
  --allow-private         let the proxy also fetch from this computer and private networks (127.0.0.1,
                          10.x, 192.168.x, ...), for loading files from a local file server by URL.
                          Only with the default (loopback) --host.
  --dist <dir>            directory with the built app (default: dist/ next to vercel.json)
  -h, --help              show this help

The proxy's environment variables (QVIS_PROXY_MAX_BYTES, QVIS_PROXY_ALLOW_HOSTS, QVIS_PROXY_DENY_HOSTS,
QVIS_PROXY_ALLOW_ORIGINS) work as on Vercel; see README.md.
`;

export interface LocalServerOptions {
    /** directory with the built app */
    dist: string;
    /** parsed vercel.json */
    vercelConfig: unknown;
    /** extra Host names to answer (--allowed-hosts) */
    allowedHosts?: string[];
    /** proxy configuration (default: from the environment, as on Vercel) */
    proxyConfig?: () => ProxyConfig;
    /**
     * --allow-private: the proxy also answers only browser fetches from the app itself (Sec-Fetch-Site:
     * same-origin), since it can then reach this computer's services. The address policy is in proxyConfig.
     */
    requireSameOriginFetch?: boolean;
}

function textResponse(
    res: http.ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string> = {},
    head = false,
): void {
    res.writeHead(status, { ...headers, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(head ? undefined : body);
}

/** The request handler shared by every listening socket (127.0.0.1 and ::1). */
export function createRequestListener(options: LocalServerOptions): http.RequestListener {
    // native realpath, the implementation findStaticFile uses for each file (see there)
    const dist = realpathSync.native(options.dist);
    const rules: VercelRules = compileVercelRules(options.vercelConfig);
    const allowedHosts = options.allowedHosts ?? [];
    const proxy = createLoadfilesHandler(options.proxyConfig);
    const preflight: WebHandler = () => OPTIONS();

    const runProxy = async (req: http.IncomingMessage, res: http.ServerResponse, origin: string) => {
        if (!isProxyMethod(req.method)) {
            proxyMethodNotAllowed(res);
            return;
        }
        if (
            options.requireSameOriginFetch &&
            req.method !== "OPTIONS" &&
            (req.headers["sec-fetch-site"] !== "same-origin" || req.headers["sec-fetch-dest"] !== "empty")
        ) {
            const error =
                req.headers["sec-fetch-site"] === undefined
                    ? "With --allow-private, the qvis proxy needs the browser's Sec-Fetch-Site header, which " +
                      "browsers send only to https pages and to localhost, *.localhost, 127.0.0.1 and [::1]: open " +
                      `the app at http://localhost:${req.socket.localPort}/`
                    : "With --allow-private, the qvis proxy only answers the qvis app itself (a same-origin fetch)";
            res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error }));
            return;
        }
        await runWebHandler(req.method === "OPTIONS" ? preflight : proxy, req, res, origin);
    };

    const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        const host = req.headers.host;
        if (!isAllowedHost(host, allowedHosts)) {
            const name = hostNameOf(host);
            const port = req.socket.localPort;
            let hint = ".";
            if (name !== undefined && isIPAddress(name)) {
                hint =
                    `. Browsers do not treat ${name} as this computer, and the proxy's checks rely on that: open ` +
                    `http://localhost:${port}/ or http://127.0.0.1:${port}/ instead (from another machine, this ` +
                    "computer's network address).";
            } else if (name !== undefined) {
                hint = `. To allow it, start the server with --allowed-hosts ${name} (or set QVIS_ALLOWED_HOSTS=${name}).`;
            }
            textResponse(
                res,
                403,
                "Blocked request: this server does not answer to the host name " +
                    JSON.stringify(host ?? "") +
                    hint +
                    "\n",
            );
            return;
        }
        const origin = "http://" + host;
        const target = req.url ?? "";
        if (!target.startsWith("/")) {
            textResponse(res, 400, "Bad request\n");
            return;
        }
        let url: URL;
        try {
            url = new URL(origin + target); // not new URL(target, origin): `//host/x` is a path of this server
        } catch {
            textResponse(res, 400, "Bad request\n");
            return;
        }
        const pathname = url.pathname;
        const head = req.method === "HEAD";

        // like Vercel: empty path segments are redirected away, so rules and files always see the same path
        if (pathname.includes("//")) {
            res.writeHead(308, {
                Location: pathname.replace(/\/{2,}/g, "/") + url.search,
                "Cache-Control": "no-store",
            });
            res.end();
            return;
        }
        // vercel.json headers match the requested path; the function's own headers win over them
        const headers = rules.headersFor(pathname);
        const isStaticMethod = req.method === "GET" || head;

        // Vercel order: the function and the file system first, then the rewrites
        let route = pathname;
        if (!isProxyPath(route)) {
            const direct = isStaticMethod ? await findStaticFile(dist, pathname) : undefined;
            if (direct !== undefined) {
                sendStaticFile(req, res, direct, headers);
                return;
            }
            route = rules.rewrite(pathname);
        }
        if (isProxyPath(route)) {
            for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
            await runProxy(req, res, origin);
            return;
        }
        if (!isStaticMethod) {
            textResponse(res, 405, "Method not allowed\n", { ...headers, Allow: "GET, HEAD" });
            return;
        }
        const found = route !== pathname ? await findStaticFile(dist, route) : undefined;
        if (found === undefined) {
            textResponse(res, 404, "Not found\n", headers, head);
            return;
        }
        sendStaticFile(req, res, found, headers);
    };

    return (req, res) => {
        handle(req, res).catch((e: unknown) => {
            console.error("qvis local server: request failed:", e);
            if (!res.headersSent) textResponse(res, 500, "Internal server error\n");
            else res.destroy();
        });
    };
}

export function createLocalServer(options: LocalServerOptions): http.Server {
    return http.createServer(createRequestListener(options));
}

/** The directory that holds vercel.json: the repository root, from server/ or from dist-server/server/. */
function findAppRoot(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 4; i++) {
        if (existsSync(path.join(dir, "vercel.json"))) return dir;
        dir = path.dirname(dir);
    }
    throw new Error("vercel.json not found next to the local server (looked up to 4 directories up)");
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            const address = server.address();
            resolve(typeof address === "object" && address !== null ? address.port : port);
        });
    });
}

function listenError(e: unknown, port: number, host: string): Error {
    const code = (e as { code?: string }).code;
    const hint = "pass --port <another port>, for example --port 8081";
    if (code === "EADDRINUSE") {
        const why = host === "::1" ? ` (http://localhost:${port}/ could reach that program instead of qvis)` : "";
        return new Error(`another program already uses port ${port} on ${host}${why}: ${hint}`, { cause: e });
    }
    if (code === "EACCES") {
        return new Error(
            `permission denied for port ${port} on ${host}. On Windows the port may be in a range reserved by ` +
                `Hyper-V, WSL or Docker (see: netsh interface ipv4 show excludedportrange protocol=tcp); on Linux ` +
                `and macOS, ports below 1024 need root. ${hint}`,
            { cause: e },
        );
    }
    if (code === "EADDRNOTAVAIL" || code === "ENOTFOUND") {
        return new Error(`cannot listen on ${host}: no such address on this computer (${code})`, { cause: e });
    }
    return e instanceof Error ? e : new Error(String(e));
}

/**
 * The URL to print for the sockets actually bound: localhost only when it reaches this server whichever address
 * family the browser tries first (both loopbacks, or a dual-stack ::); otherwise the bound address itself.
 */
function displayURL(addresses: readonly string[], port: number): string {
    const has = (a: string) => addresses.includes(a);
    let host: string;
    if ((has("127.0.0.1") && has("::1")) || (addresses.length === 1 && addresses[0] === "::")) host = "localhost";
    else if (addresses[0] === "0.0.0.0") host = "127.0.0.1";
    else host = addresses[0].includes(":") ? "[" + addresses[0] + "]" : addresses[0];
    return `http://${host}:${port}/`;
}

/** --host value: `[::1]` -> `::1`; `localhost` (or no value) -> both loopback addresses; a port is an error. */
function parseHostOption(value: string | undefined): string[] {
    const v = value?.trim();
    if (v === undefined || v === "" || v.toLowerCase() === "localhost") return ["127.0.0.1", "::1"];
    if (/^\[[^\]]*\]$/.test(v)) return [v.slice(1, -1)];
    if (/^\[[^\]]*\]:\d+$/.test(v) || /^[^:]+:\d+$/.test(v)) {
        throw new Error(`--host takes an address without a port (got ${v}); pass the port with --port`);
    }
    return [v];
}

async function main(argv: string[]): Promise<void> {
    const { values } = parseArgs({
        args: argv,
        options: {
            port: { type: "string" },
            host: { type: "string" },
            "allowed-hosts": { type: "string" },
            "allow-private": { type: "boolean" },
            dist: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
        strict: true,
    });
    if (values.help) {
        process.stdout.write(HELP);
        return;
    }
    const portText = (values.port ?? process.env.PORT ?? "8080").trim();
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || port > 65535) throw new Error("invalid port: " + portText);
    // default: both loopback addresses, so no other program on [::1]:<port> can answer http://localhost:<port>/
    const hosts = parseHostOption(values.host);
    const dualLoopback = hosts.length === 2;
    const allowPrivate = values["allow-private"] === true;
    if (allowPrivate && !hosts.every(isLoopbackBind)) {
        throw new Error(
            "--allow-private only works when the server listens on this computer only (the default --host): " +
                "other machines could otherwise use it to reach this computer's services",
        );
    }

    const root = findAppRoot();
    const dist = path.resolve(values.dist ?? path.join(root, "dist"));
    if (!existsSync(path.join(dist, "index.html"))) {
        throw new Error(`${dist} does not contain a built app: run "npm run build" first (or use "npm start")`);
    }
    const vercelConfig: unknown = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8"));
    const allowedHosts = (values["allowed-hosts"] ?? process.env.QVIS_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h.length > 0);

    const isBlockedAddress = localAddressPolicy(allowPrivate);
    const proxyConfig = (): ProxyConfig => ({
        ...configFromEnv(),
        ...(allowPrivate ? { allowOrigins: [] } : {}),
        isBlockedAddress,
    });
    const listener = createRequestListener({
        dist,
        vercelConfig,
        allowedHosts,
        proxyConfig,
        requireSameOriginFetch: allowPrivate,
    });

    const servers: http.Server[] = [];
    let actualPort = port;
    for (const [i, host] of hosts.entries()) {
        const server = http.createServer(listener);
        try {
            actualPort = await listen(server, actualPort, host);
            servers.push(server);
        } catch (e) {
            const code = (e as { code?: string }).code;
            const optional = i > 0 && dualLoopback;
            // no IPv6 on this machine: 127.0.0.1 alone is fine
            if (optional && (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT" || code === "EINVAL")) continue;
            // a random port that happens to be taken on ::1: localhost may reach the other program, which only
            // matters for people, not for the tests and scripts that use --port 0 with 127.0.0.1
            if (optional && port === 0) continue;
            for (const s of servers) s.close();
            throw listenError(e, actualPort, host);
        }
    }

    const addresses = servers.map((s) => (s.address() as AddressInfo).address);
    const url = displayURL(addresses, actualPort);
    const bound = addresses.map((a) => (a.includes(":") ? `[${a}]` : a));
    // the Docker image sets QVIS_CONTAINER: there, all interfaces are the container's, published only by `docker run -p`
    const inContainer = process.env.QVIS_CONTAINER === "1";
    console.log(`qvis-react is running at ${url}`);
    console.log(`  serving   ${dist}`);
    console.log(`  listening ${bound.join(" and ")}${hosts.every(isLoopbackBind) ? " (this computer only)" : ""}`);
    console.log(
        `  proxy     ${PROXY_ROUTE} (` +
            (allowPrivate
                ? "public addresses, this computer and private networks: --allow-private"
                : "public internet addresses only") +
            ")",
    );
    if (inContainer) {
        console.log(
            `  container reachable where \`docker run -p\` publishes port ${actualPort} (-p 127.0.0.1:...: this computer only)`,
        );
    } else if (!hosts.every(isLoopbackBind)) {
        console.log("  WARNING   other machines on your network can reach this server and use its proxy");
        const lan = Object.values(os.networkInterfaces())
            .flat()
            .filter((a) => a !== undefined && !a.internal && a.family === "IPv4")
            .map((a) => `http://${a?.address}:${actualPort}/`);
        if (lan.length > 0 && (hosts[0] === "0.0.0.0" || hosts[0] === "::")) {
            console.log(`  from other machines: ${lan.join("  ")}`);
        }
    }
    console.log(`Load a file by URL: ${url}?file=<url of a .qlog/.sqlog>`);
    console.log("Press Ctrl+C to stop.");

    // Node does not install default signal handlers when it runs as PID 1 (Docker), so handle them explicitly
    const stop = () => {
        let open = servers.length;
        for (const s of servers) {
            s.close(() => {
                if (--open === 0) process.exit(0);
            });
            s.closeAllConnections();
        }
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
}

/** True when this file is the program (`node .../local-server.js`), also when started without the .js extension. */
function isMainModule(): boolean {
    const arg = process.argv[1];
    if (arg === undefined) return false;
    for (const candidate of [arg, arg + ".js"]) {
        try {
            if (pathToFileURL(realpathSync(candidate)).href === import.meta.url) return true;
        } catch {
            // not this candidate
        }
    }
    return false;
}

if (isMainModule()) {
    main(process.argv.slice(2)).catch((e: unknown) => {
        console.error("qvis local server: " + (e instanceof Error ? e.message : String(e)));
        process.exit(1);
    });
}
