// Writes dist-server/package.json ({"type": "module"}), so the compiled local server also runs as ES modules when
// dist-server/ is copied out of the repository (offline copy, Docker image) under a parent package.json that says
// otherwise. Part of `npm run build`, right after `tsc -b` emits dist-server/.

import { mkdirSync, writeFileSync } from "node:fs";

const dir = new URL("../dist-server/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("package.json", dir), JSON.stringify({ type: "module", private: true }, null, 4) + "\n");
