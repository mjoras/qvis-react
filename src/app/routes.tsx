// Route table (qvis src/router.ts; parity/app-shell.md §3.2). Route names are kept for cross-referencing only.
// `/` redirects to `/files` and unknown paths fall back to `/files` (Q4 fix); both are handled by router.ts.
// No keep-alive: switching routes unmounts the previous tool view (Q34, preserved).

import type { ComponentType } from "react";
import type { RoutePath } from "./router";
import CongestionView from "@/views/CongestionView";
import DebugView from "@/views/DebugView";
import FileManagerView from "@/views/FileManagerView";
import MultiplexingView from "@/views/MultiplexingView";
import PacketizationView from "@/views/PacketizationView";
import SequenceView from "@/views/SequenceView";
import StatisticsView from "@/views/StatisticsView";

export interface RouteDef {
    path: RoutePath;
    /** vue-router route name in qvis */
    name: string;
    view: ComponentType;
}

export const routes: readonly RouteDef[] = [
    { path: "/debug", name: "VUEDebug", view: DebugView },
    { path: "/files", name: "FileManager", view: FileManagerView },
    { path: "/sequence", name: "sequence", view: SequenceView },
    { path: "/congestion", name: "congestion", view: CongestionView },
    { path: "/multiplexing", name: "multiplexing", view: MultiplexingView },
    { path: "/packetization", name: "packetization", view: PacketizationView },
    { path: "/stats", name: "Statistics", view: StatisticsView },
];

export function findRoute(path: string): RouteDef | undefined {
    return routes.find((r) => r.path === path);
}
