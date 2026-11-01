import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRoute, initRouter, resetRouterForTests } from "@/app/router";
import MainMenu from "./MainMenu";

function loadAt(url: string) {
    resetRouterForTests();
    window.history.replaceState(null, "", url);
    initRouter();
}

function activeTabs(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("a.nav-link.active")).map((a) => a.textContent ?? "");
}

beforeEach(() => loadAt("/#/files"));
afterEach(() => resetRouterForTests());

describe("<MainMenu/>", () => {
    it("renders the qvis heading, six tabs in order and the two GitHub buttons", () => {
        const { container } = render(<MainMenu />);
        expect(container.querySelector("#MainMenu.container-fluid > .row")).not.toBeNull();
        const h3 = container.querySelector("h3")!;
        expect(h3.textContent).toBe("qvis");
        expect(h3.style.width).toBe("290px");

        const items = Array.from(container.querySelectorAll("ul.nav.nav-tabs.justify-content-center > li.nav-item"));
        expect(items.map((li) => li.textContent)).toEqual([
            "Manage files",
            "Sequence",
            "Congestion",
            "Multiplexing",
            "Packetization",
            "qlog stats",
        ]);
        expect(items.map((li) => li.className)).toEqual([
            "nav-item files-link",
            "nav-item sequence-link",
            "nav-item congestion-link",
            "nav-item multiplexing-link",
            "nav-item packetization-link",
            "nav-item stats-link",
        ]);

        const feature = screen.getByText("Request feature");
        expect(feature.className).toBe("btn btn-success");
        expect(feature.getAttribute("href")).toBe(
            "https://github.com/mjoras/qvis-react/issues/new?template=feature_request.md&title=Feature+request",
        );
        expect(feature.getAttribute("target")).toBe("_blank");
        expect(feature.getAttribute("rel")).toBe("noopener");
        expect(feature.style.marginRight).toBe("5px");

        const issue = screen.getByText("Report issue");
        expect(issue.className).toBe("btn btn-danger");
        expect(issue.getAttribute("href")).toBe(
            "https://github.com/mjoras/qvis-react/issues/new?template=bug-report-in-live-version.md&title=Bug+in+live+version",
        );
        expect(issue.getAttribute("target")).toBe("_blank");
    });

    it.each([
        ["/#/files", "Manage files"],
        ["/#/sequence", "Sequence"],
        ["/#/congestion", "Congestion"],
        ["/#/multiplexing", "Multiplexing"],
        ["/#/packetization", "Packetization"],
        ["/#/stats", "qlog stats"],
        ["/#/STATS/", "qlog stats"],
    ])("marks exactly one tab active on %s", (url, label) => {
        loadAt(url);
        const { container } = render(<MainMenu />);
        expect(activeTabs(container)).toEqual([label]);
    });

    it("ignores route-like substrings in the query (Q1)", () => {
        loadAt("/#/sequence?file=https://a.org/files/stats/x.qlog");
        const { container } = render(<MainMenu />);
        expect(activeTabs(container)).toEqual(["Sequence"]);
    });

    it("has no active tab on #/debug", () => {
        loadAt("/#/debug");
        const { container } = render(<MainMenu />);
        expect(activeTabs(container)).toEqual([]);
    });

    it("renders hrefs with the current query (Q3)", () => {
        loadAt("/#/files?file=https://a.org/x.qlog");
        render(<MainMenu />);
        expect(screen.getByText("Sequence").getAttribute("href")).toBe("#/sequence?file=https%3A%2F%2Fa.org%2Fx.qlog");
        loadAt("/#/files");
        const { container } = render(<MainMenu />);
        expect(container.querySelector("li.stats-link a")!.getAttribute("href")).toBe("#/stats");
    });

    it("navigates in-app on click, keeping the query, and updates the active tab", () => {
        loadAt("/#/files?file=x.qlog");
        const { container } = render(<MainMenu />);
        fireEvent.click(screen.getByText("Congestion"));
        expect(getRoute().path).toBe("/congestion");
        expect(window.location.hash).toBe("#/congestion?file=x.qlog");
        expect(activeTabs(container)).toEqual(["Congestion"]);
    });

    it("leaves modified clicks (open in new tab) to the browser", () => {
        render(<MainMenu />);
        const link = screen.getByText("Sequence");
        const notPrevented = fireEvent.click(link, { ctrlKey: true });
        expect(notPrevented).toBe(true);
        expect(getRoute().path).toBe("/files");
    });
});
