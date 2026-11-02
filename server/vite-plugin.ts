// Vite plugin: runs the CORS proxy (api/loadfiles.ts) inside `npm run dev` and `npm run preview`, so loading files
// by URL falls back to the proxy there as on Vercel and in the local server (no `vercel dev` needed). Vite's own host
// check (server.allowedHosts / preview.allowedHosts) runs before this middleware. As in the local server, the proxy
// paths come from vercel.json (the function's path plus its rewrites), forged X-Forwarded-* headers are dropped, and
// the address policy also refuses this machine's own addresses (there is no --allow-private here).

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Connect, Plugin } from "vite";
import { configFromEnv, createLoadfilesHandler, OPTIONS } from "../api/loadfiles.ts";
import { isProxyMethod, isProxyPath, proxyMethodNotAllowed, runWebHandler, type WebHandler } from "./node-adapter.ts";
import { localAddressPolicy } from "./policy.ts";
import { compileVercelRules, type VercelRules } from "./vercel-rules.ts";

export function loadfilesProxy(): Plugin {
    const isBlockedAddress = localAddressPolicy(false);
    const proxy = createLoadfilesHandler(() => ({ ...configFromEnv(), isBlockedAddress }));
    const preflight: WebHandler = () => OPTIONS();
    let rules: VercelRules | undefined;

    const middleware: Connect.NextHandleFunction = (req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (rules === undefined || !(isProxyPath(pathname) || isProxyPath(rules.rewrite(pathname)))) {
            next();
            return;
        }
        if (!isProxyMethod(req.method)) {
            proxyMethodNotAllowed(res);
            return;
        }
        const origin = "http://" + (req.headers.host ?? "localhost");
        runWebHandler(req.method === "OPTIONS" ? preflight : proxy, req, res, origin).catch(next);
    };
    return {
        name: "qvis-loadfiles-proxy",
        configResolved(config) {
            rules = compileVercelRules(JSON.parse(readFileSync(path.join(config.root, "vercel.json"), "utf8")));
        },
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        },
    };
}
