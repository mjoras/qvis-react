// Port of qvis views/MainMenu.vue (parity/app-shell.md §2.4).
//
// FIX Q1/Q2: the active tab is derived from the route path only (exact, case-insensitive via the router's canonical
// path), not from a substring of the full path including the query. #/debug has no active tab.
// FIX Q3: hrefs carry the current query, so "open link in new tab" keeps ?file=...; plain left clicks navigate in-app
// (vue-router's router-link behaviour; rule 2 keeps the query anyway).
// DROP Q29: no console log of the route on mount.

import type { MouseEvent } from "react";
import { FEATURE_REQUEST_URL, REPORT_ISSUE_URL } from "@/app/constants";
import { hrefFor, navigate, useRoute, type RoutePath } from "@/app/router";
import "./MainMenu.css";

interface MenuTab {
    path: RoutePath;
    className: string;
    label: string;
}

const MENU_TABS: readonly MenuTab[] = [
    { path: "/files", className: "files-link", label: "Manage files" },
    { path: "/sequence", className: "sequence-link", label: "Sequence" },
    { path: "/congestion", className: "congestion-link", label: "Congestion" },
    { path: "/multiplexing", className: "multiplexing-link", label: "Multiplexing" },
    { path: "/packetization", className: "packetization-link", label: "Packetization" },
    { path: "/stats", className: "stats-link", label: "qlog stats" },
];

function isPlainLeftClick(e: MouseEvent): boolean {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented;
}

export default function MainMenu() {
    const route = useRoute();

    return (
        <div id="MainMenu" className="container-fluid">
            <div className="row">
                <div className="col-1 col-md-auto align-middle">
                    <h3 style={{ width: "290px" }}>qvis</h3>
                </div>
                <div className="col">
                    <ul className="nav nav-tabs justify-content-center">
                        {MENU_TABS.map((tab) => {
                            const active = route.path === tab.path;
                            return (
                                <li key={tab.path} className={"nav-item " + tab.className}>
                                    <a
                                        href={hrefFor(tab.path, route.query)}
                                        className={active ? "nav-link active" : "nav-link"}
                                        aria-current={active ? "page" : undefined}
                                        target="_self"
                                        onClick={(e) => {
                                            if (isPlainLeftClick(e)) {
                                                e.preventDefault();
                                                navigate(tab.path);
                                            }
                                        }}
                                    >
                                        {tab.label}
                                    </a>
                                </li>
                            );
                        })}
                    </ul>
                </div>
                <div className="col-1 col-md-auto">
                    <a
                        className="btn btn-success"
                        href={FEATURE_REQUEST_URL}
                        target="_blank"
                        rel="noopener"
                        role="button"
                        style={{ marginRight: "5px" }}
                    >
                        Request feature
                    </a>
                    <a className="btn btn-danger" href={REPORT_ISSUE_URL} target="_blank" rel="noopener" role="button">
                        Report issue
                    </a>
                </div>
            </div>
        </div>
    );
}

export { MainMenu };
