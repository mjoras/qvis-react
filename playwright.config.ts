import { defineConfig, devices } from "@playwright/test";

// Smoke tests run against the Vite dev server: it also serves repo files such as scripts/cddl/sample-valid.sqlog and
// tests/fixtures/** from the project root, which the ?file= startup-loading test fetches (no test data in public/).
const PORT = 5179;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
    testDir: "./tests/e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
    use: {
        baseURL: BASE_URL,
        // the original qvis screenshots (docs/dev parity) were taken at 1600px wide
        viewport: { width: 1600, height: 1000 },
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: {
                ...devices["Desktop Chrome"],
                viewport: { width: 1600, height: 1000 },
                // CI-safe: the suite never needs the network (hosted qvis comparisons use committed golden data). Every
                // host name except localhost fails to resolve, so a test that silently reached an external host fails
                // here instead of depending on it. page.route() interception still works for fake remote URLs.
                launchOptions: {
                    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"],
                },
            },
        },
    ],
    webServer: {
        command: `npx vite --port ${PORT} --strictPort`,
        // the dev server runs the real /api/loadfiles proxy (server/vite-plugin.ts), which fetches from Node, outside
        // Chromium's host-resolver rules: let it fetch nothing, so the suite stays offline
        env: { QVIS_PROXY_ALLOW_HOSTS: "e2e.invalid" },
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
});
