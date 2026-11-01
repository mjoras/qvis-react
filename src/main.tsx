// Bootstrap (qvis src/main.ts; parity/app-shell.md §3.1, §8.2, §8.3).
// 1. Rule 1: move a pre-hash query (`https://host/?file=x`) into the hash route before the router reads the URL.
// 2. Resolve the initial route (root / unknown -> /files, keeping the query) and start listening to the hash.
// 3. Mount <App/>; it triggers the one-time startup load from the URL query.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "bootstrap/dist/css/bootstrap.min.css";
import "./styles/global.css";
import App from "./app/App";
import { initRouter, migratePreHashQuery } from "./app/router";

migratePreHashQuery();
initRouter();

createRoot(document.getElementById("app")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
