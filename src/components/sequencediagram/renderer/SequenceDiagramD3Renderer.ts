// Imperative SVG renderer of the sequence diagram (port of qvis SequenceDiagramD3Renderer.ts `setup()` step 3-5 and
// `renderPartialExtents()`, :240-403 and :1134-1750; parity/sequence-diagram.md §2.3-§2.7, §3.8-§3.10, §8.3).
//
// All layout data comes precomputed in a SeqLayout (prepare.ts). This class only draws:
// - setup(): sizes the SVG (height first, so the page scrollbar exists before the width is measured), draws the
//   timelines, the header labels and the inactivity markers, and prepares the vertical ranges (one screen high each);
// - renderPartialExtents(): draws the ranges around the viewport (and removes far-away ones) on scroll, so huge traces
//   stay responsive. `forceFull` anywhere in the location hash draws everything.
// Elements are created with createElementNS/appendChild (faster than d3 data joins, less garbage, qvis :1136-1151).
// Clicks are delegated: clickable nodes carry data-trace / data-event attributes.

import * as d3 from "d3";
import { sequenceHeaderTitle, sequenceHeaderVantageText } from "@/model/labels";
import { COLOR_LEFT, COLOR_RIGHT, frameTypeToColor, eventTypeToColor, PACKET_CHIP_COLORS } from "../colors";
import { eventToShortString, frameToShortString, packetHeaderText } from "../labels";
import { DEFAULT_DIMENSIONS, formatTime } from "../layout";
import { LOST_LEFT, LOST_RIGHT } from "../matching";
import { IGNORE_EVENT_TYPE, isPacketReceived, isPacketSent } from "../mirror";
import type { SeqLayout } from "../prepare";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

interface VerticalRange {
    svgGroup: SVGGElement | undefined;
    rendered: boolean;
    yMin: number;
}

interface ExtentInfo {
    rangeIndex: number;
    start: number;
    stop: number;
}

/** Deep-link target (focusOnConnection / focusOnEvent / focusOnPN). `packetNumber` is a decimal string. */
export interface FocusPointer {
    connectionIndex: number;
    eventIndex?: number;
    packetNumber?: string;
}

/**
 * Content above the diagram that qvis still showed when it scrolled to a deep-link target and that disappeared right
 * after (the configurator's "Loading files..." alert, addendum S8).
 */
export interface VanishingAlert {
    /** border-box height (px) */
    height: number;
    /** height plus the vertical margins: how far everything below it moved up when it disappeared */
    extent: number;
}

export type EventClickHandler = (traceIndex: number, eventIndex: number) => void;

export class SequenceDiagramD3Renderer {
    private readonly container: HTMLElement;
    private readonly svgElement: SVGSVGElement;
    private readonly onEventClicked: EventClickHandler;

    private layout: SeqLayout | undefined = undefined;
    private width = 0;
    /** width of an individual vertical trace timeline on screen */
    private bandWidth = 0;
    private rangeHeight = 0;
    private renderedRanges: VerticalRange[] = [];

    private scrollHandler: (() => void) | undefined = undefined;
    private scrollTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    private readonly clickHandler: (e: MouseEvent) => void;
    private disposed = false;

    constructor(container: HTMLElement, svgElement: SVGSVGElement, onEventClicked: EventClickHandler) {
        this.container = container;
        this.svgElement = svgElement;
        this.onEventClicked = onEventClicked;
        this.clickHandler = (e: MouseEvent) => {
            const target = e.target as Element | null;
            const el = target && typeof target.closest === "function" ? target.closest("[data-event]") : null;
            if (!el || !this.svgElement.contains(el)) return;
            const t = Number(el.getAttribute("data-trace"));
            const i = Number(el.getAttribute("data-event"));
            if (Number.isInteger(t) && Number.isInteger(i)) this.onEventClicked(t, i);
        };
        this.svgElement.addEventListener("click", this.clickHandler);
    }

    /** The traces of the last setup (qvis `getTraces()`). */
    public getLayout(): SeqLayout | undefined {
        return this.layout;
    }

    /** Clears the drawing and prepares the ranges for `layout` (qvis `setup()` steps 3-5). */
    public setup(layout: SeqLayout): void {
        if (this.disposed) return;
        this.layout = layout;
        const dims = DEFAULT_DIMENSIONS;
        const traces = layout.traces;

        const svg = d3.select(this.svgElement);
        svg.selectAll("*").remove();

        svg.attr("height", layout.height);
        // impacted by whether we have scrollbars or not, so we set the height first
        this.width = this.container.clientWidth;
        svg.attr("width", this.width);
        // no viewBox: qvis set a lower-case "viewbox" attribute, which browsers ignore (1 SVG unit = 1 CSS px)

        // the vertical timelines, in horizontal "bands" next to each other
        this.bandWidth = this.width / traces.length;
        for (let i = 0; i < traces.length; ++i) {
            const currentX = this.bandWidth * i + this.bandWidth * 0.5; // center of the band
            const trace = traces[i].connection;

            svg.append("rect")
                .attr("x", currentX - 1)
                .attr("y", dims.marginTop)
                .attr("width", 2)
                .attr("height", layout.height)
                .attr("fill", "black");

            const title = sequenceHeaderTitle(trace);
            let text = document.createElementNS(SVG_NS, "text");
            text.setAttribute("x", "" + currentX);
            text.setAttribute("y", "" + 20);
            text.setAttribute("dominant-baseline", "middle");
            text.setAttribute("text-anchor", "middle");
            text.textContent = title.text;
            if (title.kind === "link") {
                const link = document.createElementNS(SVG_NS, "a");
                link.setAttribute("href", title.href);
                link.setAttribute("target", "_blank");
                link.style.textDecoration = "underline";
                link.appendChild(text);
                this.svgElement.appendChild(link);
            } else {
                this.svgElement.appendChild(text);
            }

            // LD6: a network trace without flow reads "from unknown's viewpoint" (handled by the model helper)
            const vantageText = sequenceHeaderVantageText({
                title: trace.title,
                description: trace.description,
                vantagePoint: trace.vantagePoint,
            });
            text = document.createElementNS(SVG_NS, "text");
            text.setAttribute("x", "" + currentX);
            text.setAttribute("y", "" + 40);
            text.setAttribute("dominant-baseline", "middle");
            text.setAttribute("text-anchor", "middle");
            text.textContent = vantageText;
            this.svgElement.appendChild(text);
        }

        const ppm = dims.pixelsPerMillisecond;
        for (const interval of layout.intervals) {
            for (let i = 0; i < traces.length; ++i) {
                let currentX = this.bandWidth * i + this.bandWidth * 0.5;
                const y1 = interval.yMin + ppm;
                const y2 = interval.yMax - ppm;

                // the outside of the trace: a dashed line has no background colour, so draw a white one first
                svg.append("line")
                    .attr("x1", currentX)
                    .attr("x2", currentX)
                    .attr("y1", y1)
                    .attr("y2", y2)
                    .attr("stroke", "white")
                    .attr("stroke-width", 4);
                svg.append("line")
                    .attr("x1", currentX)
                    .attr("x2", currentX)
                    .attr("y1", y1)
                    .attr("y2", y2)
                    .attr("stroke", "black")
                    .attr("stroke-width", 4)
                    .attr("stroke-dasharray", 4);

                // in between the two traces
                if (i !== traces.length - 1) {
                    currentX = this.bandWidth * (i + 1);
                    svg.append("line")
                        .attr("x1", currentX)
                        .attr("x2", currentX)
                        .attr("y1", y1)
                        .attr("y2", y2)
                        .attr("stroke", "white")
                        .attr("stroke-width", 4);
                    svg.append("line")
                        .attr("x1", currentX)
                        .attr("x2", currentX)
                        .attr("y1", y1)
                        .attr("y2", y2)
                        .attr("stroke", "black")
                        .attr("stroke-width", 4)
                        .attr("stroke-dasharray", 4);

                    const text = document.createElementNS(SVG_NS, "text");
                    text.setAttribute("class", "timestamp");
                    text.setAttribute("x", "" + (currentX + ppm));
                    text.setAttribute("y", "" + (interval.yMin + (interval.yMax - interval.yMin) / 2));
                    text.setAttribute("dominant-baseline", "middle");
                    text.textContent = `${(interval.timeSkipped / layout.timeResolution).toFixed(2)}ms of inactivity`;
                    this.svgElement.appendChild(text);
                }
            }
        }

        // ranges of one screen height; the scroll handler renders those around the viewport
        this.rangeHeight = screen.height > 0 ? screen.height : window.innerHeight > 0 ? window.innerHeight : 1000;
        this.renderedRanges = [];
        for (let y = 0; y < layout.height; y += this.rangeHeight) {
            this.renderedRanges.push({ rendered: false, svgGroup: undefined, yMin: y });
        }

        this.installScrollHandler();
        // TODO (qvis): also couple to window resize events (SQ21 PRESERVE: no re-layout on resize)
    }

    private installScrollHandler(): void {
        this.removeScrollHandler();
        // scroll events can fire very quickly: render on every 5th event plus once 250 ms after the last one
        let scrollEventCount = 0;
        const handler = (): void => {
            const execute = (): void => {
                this.scrollTimer = undefined;
                this.renderPartialExtents();
            };
            clearTimeout(this.scrollTimer);
            this.scrollTimer = setTimeout(execute, 250);
            ++scrollEventCount;
            if (scrollEventCount % 5 === 0) {
                scrollEventCount = 0;
                clearTimeout(this.scrollTimer);
                execute();
            }
        };
        this.scrollHandler = handler;
        window.addEventListener("scroll", handler, { passive: true });
    }

    private removeScrollHandler(): void {
        if (this.scrollHandler !== undefined) {
            window.removeEventListener("scroll", this.scrollHandler);
            this.scrollHandler = undefined;
        }
        if (this.scrollTimer !== undefined) {
            clearTimeout(this.scrollTimer);
            this.scrollTimer = undefined;
        }
    }

    /**
     * Scrolls to a deep-link target (§3.9, SQ10/SQ11 FIX): `window.scrollTo(0, y - 50)`. With `vanishedAlert`
     * (addendum S8), lands where qvis' view ended up: qvis scrolled while that alert still sat right above the diagram;
     * when it disappeared, Chrome's scroll anchoring moved the scroll position up by its extent, but only when the
     * viewport top was below the alert (the anchor element then follows it). Returns true when it scrolled.
     */
    private focus(focusOn: FocusPointer, vanishedAlert: VanishingAlert | undefined): boolean {
        const layout = this.layout!;
        const traces = layout.traces;
        if (!(traces.length > focusOn.connectionIndex)) {
            console.warn(
                "SequenceDiagramD3Renderer:renderPartialExtents: couldn't focus on event, traceIndex unknown",
                focusOn,
            );
            return false;
        }
        const ci = focusOn.connectionIndex;
        const conn = traces[ci].connection;
        const events = conn.getEvents();
        let eventIndex = focusOn.eventIndex;

        if (focusOn.packetNumber !== undefined) {
            // only the packet_sent events of the given trace, any packet type
            eventIndex = undefined;
            for (let idx = 0; idx < events.length; ++idx) {
                const ev = events[idx];
                if (!isPacketSent(ev, conn)) continue;
                const header = ev.data ? ev.data.header : undefined;
                if (
                    header &&
                    header.packet_number !== undefined &&
                    samePacketNumber(header.packet_number, focusOn.packetNumber)
                ) {
                    eventIndex = idx;
                    break;
                }
            }
            if (eventIndex === undefined) {
                console.warn(
                    "SequenceDiagramD3Renderer:renderPartialExtents: packet number couldn't be found in the trace...",
                    focusOn,
                );
            }
        }

        if (eventIndex === undefined || !Number.isFinite(eventIndex)) {
            console.warn(
                "SequenceDiagramD3Renderer:renderPartialExtents: neither eventIndex nor pnIndex was set, one is required to focus!",
                focusOn,
            );
            return false;
        }
        if (!(events.length > eventIndex) || eventIndex < 0) {
            console.warn(
                "SequenceDiagramD3Renderer:renderPartialExtents: couldn't focus on event, eventIndex unknown",
                focusOn,
            );
            return false;
        }
        const y = layout.y[ci][eventIndex];
        if (!Number.isFinite(y)) {
            console.warn("SequenceDiagramD3Renderer:renderPartialExtents: couldn't focus on event, y unknown", focusOn);
            return false;
        }
        // - 50 to scroll back up a little bit so the event is "in view" (y is SVG-relative, used as a document offset)
        let target = y - 50;
        if (vanishedAlert !== undefined && vanishedAlert.extent > 0) {
            // in qvis the alert started where the diagram box starts now
            const alertTop = this.container.getBoundingClientRect().top + window.scrollY;
            if (target >= alertTop + vanishedAlert.height) target = Math.max(0, target - vanishedAlert.extent);
        }
        window.scrollTo(0, target);
        return true;
    }

    /**
     * Draws the ranges around the viewport and removes far-away ones (§3.8). With `focusOn`, first scrolls to that
     * event; drawing then happens for the new position (SQ11 FIX: qvis returned without drawing). `vanishedAlert`: see
     * `focus()`.
     */
    public renderPartialExtents(focusOn: FocusPointer | null = null, vanishedAlert?: VanishingAlert): void {
        const layout = this.layout;
        if (this.disposed || layout === undefined || this.renderedRanges.length === 0) return;

        if (focusOn) this.focus(focusOn, vanishedAlert);

        // 1. the visible area of the svg
        const svgRect = this.svgElement.getBoundingClientRect();
        const offsetFromDocumentTop = svgRect.top - document.body.getBoundingClientRect().top;
        const yMin = Math.max(0, window.scrollY - offsetFromDocumentTop);

        // 1.b hacky override that forces drawing the full SVG at once (e.g. for storage, search)
        const forceFullRender = !!window.location.hash && window.location.hash.indexOf("forceFull") >= 0;

        const lastRange = this.renderedRanges.length - 1;
        const currentRangeIndex = Math.floor(yMin / this.rangeHeight);
        let fromRange = Math.max(0, currentRangeIndex - 1);
        let toRange = Math.min(lastRange, currentRangeIndex + 1);
        if (forceFullRender) {
            fromRange = 0;
            toRange = lastRange;
            console.warn(
                "SequenceDiagramD3Renderer:renderPartialExtents: forcing a full render of the entire diagram, this can cause slowdowns!",
                this.renderedRanges.length,
            );
        }

        const extentsToRender: ExtentInfo[] = [];
        for (let r = fromRange; r <= toRange; ++r) {
            if (!this.renderedRanges[r].rendered) {
                const start = this.renderedRanges[r].yMin;
                extentsToRender.push({ rangeIndex: r, start, stop: start + this.rangeHeight - 1 }); // -1: no overlap
            }
        }

        // ranges to un-render (keeps one extra buffer range on each side)
        const rangeIndicesToRemove: number[] = [];
        if (!forceFullRender) {
            let removeFrom = Math.max(0, fromRange - 500);
            let removeTo = Math.max(0, fromRange - 2);
            if (!(removeFrom === 0 && removeTo === 0)) {
                for (let r = removeFrom; r <= removeTo; ++r) {
                    if (this.renderedRanges[r].rendered) rangeIndicesToRemove.push(r);
                }
            }
            removeFrom = Math.min(lastRange, toRange + 2);
            removeTo = Math.min(lastRange, toRange + 500);
            if (!(removeFrom === lastRange && removeTo === lastRange)) {
                for (let r = removeFrom; r <= removeTo; ++r) {
                    if (this.renderedRanges[r].rendered) rangeIndicesToRemove.push(r);
                }
            }
        }

        for (const rangeIndex of rangeIndicesToRemove) {
            const range = this.renderedRanges[rangeIndex];
            range.svgGroup?.remove();
            range.svgGroup = undefined;
            range.rendered = false;
        }

        for (const extent of extentsToRender) {
            const group = document.createElementNS(SVG_NS, "g");
            this.renderedRanges[extent.rangeIndex].svgGroup = group;
            this.renderedRanges[extent.rangeIndex].rendered = true;
            this.drawExtent(layout, extent, group);
            this.svgElement.appendChild(group);
        }
    }

    private drawExtent(layout: SeqLayout, extent: ExtentInfo, extentContainer: SVGGElement): void {
        const ppm = DEFAULT_DIMENSIONS.pixelsPerMillisecond;
        const traces = layout.traces;
        const bandWidth = this.bandWidth;
        const textHeight = ppm * 0.9; // a bit smaller so we have some padding
        const fontSize = "" + Math.floor(textHeight * 0.8) + "px";
        const smallArrowSize = Math.floor(textHeight * 0.3);
        const rectSize = ppm * 0.6;

        const chip = (text: string, colors: readonly [string, string], t: number, e: number): HTMLSpanElement => {
            const span = document.createElement("span");
            span.textContent = text;
            span.style.color = colors[1];
            span.style.backgroundColor = colors[0];
            span.style.paddingLeft = "5px";
            span.style.paddingRight = "5px";
            span.style.border = "1px white";
            span.style.borderStyle = "none solid";
            span.style.fontSize = fontSize;
            span.setAttribute("data-trace", "" + t);
            span.setAttribute("data-event", "" + e);
            return span;
        };

        for (let i = 0; i < traces.length; ++i) {
            const conn = traces[i].connection;
            const currentX = bandWidth * i + bandWidth * 0.5; // center of the horizontal band
            const events = conn.getEvents();
            const ys = layout.y[i];
            const times = layout.time[i];
            const rights = layout.right[i];
            const lefts = layout.left[i];
            const losts = layout.lost[i];

            for (let e = 0; e < events.length; ++e) {
                const currentY = ys[e];
                if (!(currentY >= extent.start)) continue; // (also skips a NaN y, which the layout never produces)
                if (currentY > extent.stop) break;

                const ev = events[e];
                if (ev.type === IGNORE_EVENT_TYPE) continue;

                // rect for each event on the vertical timeline
                const rect = document.createElementNS(SVG_NS, "rect");
                rect.setAttribute("x", "" + (currentX - rectSize / 2));
                rect.setAttribute("y", "" + (currentY - rectSize / 2)); // x and y are top left, we want the middle
                rect.setAttribute("width", "" + rectSize);
                rect.setAttribute("height", "" + rectSize);
                rect.setAttribute("fill", "green");
                rect.setAttribute("data-trace", "" + i);
                rect.setAttribute("data-event", "" + e);
                extentContainer.appendChild(rect);

                // timestamp next to the rect
                const timeText = formatTime(times[e]);
                const text = document.createElementNS(SVG_NS, "text");
                text.setAttribute("class", "timestamp");
                text.setAttribute("x", "" + (currentX - ppm / 2 + (i === 0 ? -ppm * 2 : ppm * 2)));
                text.setAttribute("y", "" + currentY);
                text.setAttribute("dominant-baseline", "middle");
                text.setAttribute("text-anchor", i === 0 ? "end" : "start");
                text.textContent = timeText;
                extentContainer.appendChild(text);

                // connecting arrows: right target, then left target, then lost (right, left)
                let targetY = 0;
                let offsetMultiplier: number | undefined;
                let directionText: ">" | "<" | undefined;
                let directionColor = "";
                let packetLost = false;

                const r = rights[e];
                const l = lefts[e];
                if (r >= 0) {
                    offsetMultiplier = 1;
                    targetY = layout.y[i + 1][r];
                    directionText = ">";
                    directionColor = COLOR_RIGHT;
                } else if (l >= 0) {
                    offsetMultiplier = -1;
                    targetY = layout.y[i - 1][l];
                    directionText = "<";
                    directionColor = COLOR_LEFT;
                } else if (losts[e] & (LOST_RIGHT | LOST_LEFT)) {
                    // half an arrow, slanted like the previous arrow in that direction (SQ12, prepare.ts)
                    targetY = layout.lostTargetY[i][e];
                    if (losts[e] & LOST_RIGHT) {
                        offsetMultiplier = 0.5;
                        directionText = ">";
                        directionColor = COLOR_RIGHT;
                    } else {
                        offsetMultiplier = -0.5;
                        directionText = "<";
                        directionColor = COLOR_LEFT;
                    }
                    packetLost = true;
                }

                if (offsetMultiplier) {
                    this.drawArrow(
                        extentContainer,
                        ev.data,
                        i,
                        e,
                        currentX,
                        currentY,
                        targetY,
                        offsetMultiplier,
                        directionText!,
                        directionColor,
                        packetLost,
                        textHeight,
                        smallArrowSize,
                        chip,
                    );
                } else if (!isPacketSent(ev, conn) && !isPacketReceived(ev, conn)) {
                    // not a packet event: show what it was on the side
                    const sideOffset = timeText.length * 1.3 * 11; // magic numbers
                    let x = currentX + ppm / 2 + sideOffset;
                    let width = (bandWidth / 2) * 0.9 * 0.9; // without the second 0.9 it was still too wide
                    let align = "left";
                    if (i === 0) {
                        // on the left of the graph, the text overflows to the LEFT
                        align = "right";
                        width = (bandWidth / 2) * 0.9 - sideOffset;
                        x = (bandWidth / 2) * 0.05;
                    }

                    const textForeign = document.createElementNS(SVG_NS, "foreignObject");
                    textForeign.setAttribute("x", "" + x);
                    textForeign.setAttribute("y", "" + (currentY - textHeight / 1.25)); // magic number
                    // SQ24: a negative width (very narrow bands) hid the label in qvis; 0 does the same, validly
                    textForeign.setAttribute("width", "" + Math.max(0, width));
                    textForeign.setAttribute("height", "" + textHeight);
                    textForeign.style.overflow = "visible";

                    const textContainerOuter = document.createElementNS(XHTML_NS, "div") as HTMLDivElement;
                    textContainerOuter.style.textAlign = align;
                    textContainerOuter.appendChild(chip(eventToShortString(ev), eventTypeToColor(ev), i, e));
                    textForeign.appendChild(textContainerOuter);
                    extentContainer.appendChild(textForeign);
                }
            }
        }
    }

    private drawArrow(
        extentContainer: SVGGElement,
        data: any,
        traceIndex: number,
        eventIndex: number,
        currentX: number,
        currentY: number,
        targetY: number,
        offsetMultiplier: number,
        directionText: ">" | "<",
        directionColor: string,
        packetLost: boolean,
        textHeight: number,
        smallArrowSize: number,
        chip: (text: string, colors: readonly [string, string], t: number, e: number) => HTMLSpanElement,
    ): void {
        const ppm = DEFAULT_DIMENSIONS.pixelsPerMillisecond;
        // move one band to the right or left, without overlapping the event rect
        let targetX = currentX + offsetMultiplier * this.bandWidth;
        targetX = targetX - offsetMultiplier * (ppm / 2);

        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", "" + currentX);
        line.setAttribute("x2", "" + targetX);
        line.setAttribute("y1", "" + currentY);
        line.setAttribute("y2", "" + targetY);
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke", directionColor);
        extentContainer.appendChild(line);

        // the arrow head is drawn pointing right (>), then rotated along the line
        const arrowX = targetX;
        let points = "";
        points += `${arrowX - 10},${targetY - 10}`; // top point
        points += ` ${arrowX},${targetY}`; // center point
        points += ` ${arrowX - 10},${targetY + 10}`; // bottom point

        const deltaY = currentY - targetY;
        const deltaX = targetX - currentX;
        let angle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;
        angle = -angle; // svg's rotate: clockwise rotations are positive angles

        const arrow = document.createElementNS(SVG_NS, "polyline");
        arrow.setAttribute("points", points);
        arrow.setAttribute("stroke-width", "4");
        arrow.setAttribute("stroke", directionColor);
        arrow.setAttribute("fill", "transparent");
        arrow.setAttribute("transform", `rotate(${angle},${arrowX},${targetY})`);
        extentContainer.appendChild(arrow);

        if (packetLost) {
            // an X next to the half arrow
            const crossX = targetX + offsetMultiplier * 0.02 * this.bandWidth;
            const crossY = targetY + (targetY - currentY) * 0.02;
            let path = "M" + (crossX - 10) + " " + (crossY - 10);
            path += " L" + (crossX + 10) + " " + (crossY + 10);
            path += " M" + (crossX - 10) + " " + (crossY + 10);
            path += " L" + (crossX + 10) + " " + (crossY - 10);

            const cross = document.createElementNS(SVG_NS, "path");
            cross.setAttribute("d", path);
            cross.setAttribute("stroke-width", "4");
            cross.setAttribute("stroke", "red");
            cross.setAttribute("fill", "transparent");
            cross.setAttribute("transform", `rotate(${angle},${crossX},${crossY})`);
            extentContainer.appendChild(cross);
        }

        // the label is 90% of the length of the arrow, never upside down
        const textWidth = Math.sqrt(Math.pow(targetX - currentX, 2) + Math.pow(targetY - currentY, 2)) * 0.9;
        let textAngle = angle;
        if (textAngle >= 90) textAngle -= 180;
        else if (textAngle <= -90) textAngle += 180;

        const midwayX = (currentX + targetX) / 2;
        const midwayY = (currentY + targetY) / 2;

        // differently coloured spans next to each other: use the HTML layout engine through a foreignObject
        const textForeign = document.createElementNS(SVG_NS, "foreignObject");
        textForeign.setAttribute("x", "" + midwayX);
        textForeign.setAttribute("y", "" + midwayY);
        textForeign.setAttribute("width", "" + textWidth);
        textForeign.setAttribute("height", "" + textHeight);
        textForeign.style.overflow = "visible";
        // rotate the top left corner around the midway point first, then translate in the rotated space
        textForeign.setAttribute(
            "transform",
            `rotate(${textAngle},${midwayX},${midwayY}) translate(${-textWidth / 2},${-textHeight - 3})`,
        );

        const textContainer = document.createElementNS(XHTML_NS, "div") as HTMLDivElement;
        textContainer.style.width = "" + textWidth + "px";
        textContainer.style.textAlign = "center";

        const directionSpan = (): HTMLSpanElement => {
            const span = document.createElement("span");
            span.style.display = "inline-block";
            span.style.borderTop = `${smallArrowSize}px solid transparent`;
            span.style.borderBottom = `${smallArrowSize}px solid transparent`;
            if (directionText === "<") {
                span.style.borderRight = `${smallArrowSize}px solid ${directionColor}`;
                span.style.marginRight = "1px";
            } else {
                span.style.borderLeft = `${smallArrowSize}px solid ${directionColor}`;
                span.style.marginLeft = "1px";
            }
            return span;
        };

        if (directionText === "<") textContainer.appendChild(directionSpan());

        textContainer.appendChild(chip(packetHeaderText(data), PACKET_CHIP_COLORS, traceIndex, eventIndex));

        const frames = data ? data.frames : undefined;
        if (frames && typeof frames.length === "number") {
            let framesToRender: any[] | undefined;
            const add = (span: HTMLSpanElement): void => {
                if (directionText === ">") textContainer.prepend(span);
                else textContainer.appendChild(span);
            };

            // many frames in a packet (dozens of ACK gaps, ...): aggregate types with more than 5 of them
            if (frames.length >= 8) {
                const typeCounter = new Map<unknown, any[]>();
                for (const frameRaw of frames) {
                    const frameType = frameRaw ? frameRaw.frame_type : undefined;
                    let list = typeCounter.get(frameType);
                    if (!list) {
                        list = [];
                        typeCounter.set(frameType, list);
                    }
                    list.push(frameRaw);
                }
                for (const [frameTypeName, list] of typeCounter.entries()) {
                    if (list.length > 5) {
                        add(
                            chip(
                                list.length + " " + frameTypeName + " frames (click for details)",
                                frameTypeToColor(frameTypeName),
                                traceIndex,
                                eventIndex,
                            ),
                        );
                    } else {
                        if (!framesToRender) framesToRender = [];
                        framesToRender.push(...list);
                    }
                }
            } else {
                framesToRender = Array.from(frames as ArrayLike<any>);
            }

            if (framesToRender) {
                for (const frameRaw of framesToRender) {
                    // filler frames of the qvis packetization view (SQ30); never present in latest-draft files
                    if (frameRaw && frameRaw.qvis && frameRaw.qvis.sequence && frameRaw.qvis.sequence.hide) continue;
                    add(
                        chip(
                            frameToShortString(frameRaw),
                            frameTypeToColor(frameRaw ? frameRaw.frame_type : undefined),
                            traceIndex,
                            eventIndex,
                        ),
                    );
                }
            }
        }

        if (directionText === ">") textContainer.appendChild(directionSpan());

        textForeign.appendChild(textContainer);
        extentContainer.appendChild(textForeign);
    }

    /** Removes the drawing (no traces selected any more). The SVG goes back to its browser-default size. */
    public clear(): void {
        this.removeScrollHandler();
        this.layout = undefined;
        this.renderedRanges = [];
        d3.select(this.svgElement).selectAll("*").remove();
        this.svgElement.removeAttribute("width");
        this.svgElement.removeAttribute("height");
    }

    /** Removes the window scroll listener, the timer and the click listener (SQ20 FIX). */
    public dispose(): void {
        this.disposed = true;
        this.removeScrollHandler();
        this.svgElement.removeEventListener("click", this.clickHandler);
    }
}

/** `String(pn) === focusOnPN` (decimal strings; leading zeros of the query value are already stripped). */
function samePacketNumber(pn: unknown, wanted: string): boolean {
    const s = "" + pn;
    if (s === wanted) return true;
    // a JSON string with leading zeros ("007") still matches 7
    return /^\d+$/.test(s) && s.replace(/^0+(?=\d)/, "") === wanted;
}
