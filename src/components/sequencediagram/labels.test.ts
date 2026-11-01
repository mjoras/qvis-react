import type { QlogEvent } from "@/model/QlogEvent";
import { eventTypeToColor, frameTypeToColor } from "./colors";
import {
    eventToShortString,
    fieldName,
    frameToShortString,
    h3FrameLabel,
    levelOf,
    metricsLabel,
    packetHeaderText,
    packetTypeToString,
    timerLabel,
} from "./labels";

/** Minimal QlogEvent stand-in (labels read fullName, namespace, type, data, raw, relativeTime). */
function mk(name: string, data: any = {}, relativeTime = 0): QlogEvent {
    const i = name.indexOf(":");
    return {
        fullName: name,
        namespace: i < 0 ? "unknown" : name.slice(0, i),
        type: i < 0 ? name : name.slice(i + 1),
        data,
        raw: { name, data },
        relativeTime,
    } as unknown as QlogEvent;
}

afterEach(() => vi.restoreAllMocks());

describe("packetTypeToString (§3.12.1)", () => {
    it.each([
        ["1RTT", "1RTT"],
        ["0RTT", "0RTT"],
        // strict latest drafts (addendum S4): the draft-01 spellings are not aliased
        ["onertt", "onertt"],
        ["zerortt", "zerortt"],
        ["version_negotiation", "VNEG"],
        ["initial", "initial"],
        ["handshake", "handshake"],
        ["retry", "retry"],
        ["stateless_reset", "stateless_reset"],
        ["unknown", "unknown"],
    ])("%s -> %s", (input, out) => expect(packetTypeToString(input)).toBe(out));

    it("packet chip text", () => {
        expect(packetHeaderText({ header: { packet_type: "initial", packet_number: 0 } })).toBe("initial : 0");
        expect(packetHeaderText({ header: { packet_type: "1RTT", packet_number: "15" } })).toBe("1RTT : 15");
    });
});

describe("frameToShortString (§3.12.2, §9.4)", () => {
    it("ack ranges, including LD2 and unordered ranges", () => {
        expect(frameToShortString({ frame_type: "ack", acked_ranges: [[1, 5]] })).toBe("ack 1-5");
        expect(frameToShortString({ frame_type: "ack", acked_ranges: [[3, 3], [7], [10, 12]] })).toBe("ack 3,7,10-12");
        expect(frameToShortString({ frame_type: "ack", acked_ranges: [[5, "5"], ["7"]] })).toBe("ack 5,7"); // LD2
        expect(
            frameToShortString({
                frame_type: "ack",
                acked_ranges: [
                    [10, 12],
                    [1, 3],
                ],
            }),
        ).toBe("ack 10-12,1-3");
        expect(frameToShortString({ frame_type: "ack" })).toBe("ack ");
    });

    it("stream", () => {
        expect(frameToShortString({ frame_type: "stream", stream_id: 0, fin: true })).toBe("stream 0 FIN");
        expect(frameToShortString({ frame_type: "stream", stream_id: 4 })).toBe("stream 4");
        expect(frameToShortString({ frame_type: "stream" })).toBe("stream undefined");
    });

    it.each([
        [{ error_space: "transport", error: "no_error" }, "connection_close : clean"],
        [{ error_space: "application", error: "http_no_error" }, "connection_close : clean"],
        [{ error_space: "application", error: "unknown", error_code: 0 }, "connection_close : clean"],
        [
            { error_space: "transport", error: "crypto_error_0x128", reason: "handshake failure" },
            "connection_close crypto_error_0x128 : handshake failure",
        ],
        [{ error_space: "application", error: "unknown", error_code: 268 }, "connection_close 268"],
        [{ error_space: "transport", error: "protocol_violation" }, "connection_close protocol_violation"],
        [{}, "connection_close "],
    ])("connection_close LD3 %j", (f, out) => {
        expect(frameToShortString({ frame_type: "connection_close", ...f })).toBe(out);
    });

    it("flow control frames (SQ13 FIX: 0 counts, space before 'blocked')", () => {
        expect(frameToShortString({ frame_type: "max_stream_data", stream_id: 0, maximum: 1000 })).toBe(
            "max data 1000 (stream 0)",
        );
        expect(frameToShortString({ frame_type: "max_stream_data", maximum: 1000 })).toBe("max_stream_data");
        expect(frameToShortString({ frame_type: "max_data", maximum: 0 })).toBe("max data 0");
        expect(frameToShortString({ frame_type: "max_data" })).toBe("max_data");
        expect(frameToShortString({ frame_type: "max_streams", stream_type: "bidirectional", maximum: 100 })).toBe(
            "max 100 bidirectional streams",
        );
        expect(frameToShortString({ frame_type: "max_streams", maximum: 100 })).toBe("max_streams");
        expect(frameToShortString({ frame_type: "streams_blocked", stream_type: "unidirectional", limit: 3 })).toBe(
            "blocked at 3 unidirectional streams",
        );
        expect(frameToShortString({ frame_type: "streams_blocked" })).toBe("streams_blocked");
        expect(frameToShortString({ frame_type: "stream_data_blocked", stream_id: 4, limit: 1000 })).toBe(
            "stream 4 blocked at 1000",
        );
        expect(frameToShortString({ frame_type: "stream_data_blocked", stream_id: 4 })).toBe("stream_data_blocked");
        expect(frameToShortString({ frame_type: "data_blocked", limit: 5 })).toBe("connection blocked at 5");
        expect(frameToShortString({ frame_type: "data_blocked" })).toBe("data_blocked");
    });

    it("reset_stream / stop_sending (LD3, quic-go numeric-only error_code)", () => {
        expect(frameToShortString({ frame_type: "reset_stream", stream_id: 4, error_code: 268 })).toBe(
            "reset stream 4 (268)",
        );
        expect(
            frameToShortString({ frame_type: "reset_stream", stream_id: 4, error: "unknown", error_code: 268 }),
        ).toBe("reset stream 4 (268)");
        expect(frameToShortString({ frame_type: "reset_stream", stream_id: 0, error: "http_request_cancelled" })).toBe(
            "reset stream 0 (http_request_cancelled)",
        );
        expect(frameToShortString({ frame_type: "reset_stream", stream_id: 8 })).toBe("reset stream 8");
        expect(frameToShortString({ frame_type: "reset_stream" })).toBe("reset_stream");
        expect(frameToShortString({ frame_type: "stop_sending", stream_id: 4, error: "unknown" })).toBe(
            "stop sending 4 (unknown)",
        );
        expect(frameToShortString({ frame_type: "stop_sending", stream_id: 4, error_code: 1 })).toBe(
            "stop sending 4 (1)",
        );
        expect(frameToShortString({ frame_type: "stop_sending" })).toBe("stop_sending");
    });

    it("reset_stream_at (X1) with LATEST_EXTENSIONS on and off", () => {
        const f = { frame_type: "reset_stream_at", stream_id: 4, error: "http_request_cancelled", reliable_size: 1000 };
        expect(frameToShortString(f)).toBe("reset stream 4 (http_request_cancelled) at 1000");
        expect(frameToShortString({ frame_type: "reset_stream_at", stream_id: 4 })).toBe("reset stream 4");
        expect(frameToShortString({ frame_type: "reset_stream_at" })).toBe("reset_stream_at");
        expect(frameToShortString(f, false)).toBe("reset_stream_at");
        expect(frameTypeToColor("reset_stream_at")).toEqual(["#a80f3a", "#FFFFFF"]);
        expect(frameTypeToColor("reset_stream_at", false)).toEqual(["#FF0000", "#FFFFFF"]);
    });

    it("other frames: the type name", () => {
        for (const t of ["padding", "ping", "crypto", "new_token", "handshake_done", "datagram", "unknown"]) {
            expect(frameToShortString({ frame_type: t })).toBe(t);
        }
    });
});

describe("frameTypeToColor (§3.13.1)", () => {
    it.each([
        ["ack", "#03ad25", "#FFFFFF"],
        ["stream", "#0468cc", "#FFFFFF"],
        ["crypto", "#0468cc", "#FFFFFF"],
        ["padding", "#ff69b4", "#FFFFFF"],
        ["connection_close", "#a80f3a", "#FFFFFF"],
        ["reset_stream", "#a80f3a", "#FFFFFF"],
        ["application_close", "#a80f3a", "#FFFFFF"],
        ["stop_sending", "#a80f3a", "#FFFFFF"],
        ["new_connection_id", "#068484", "#FFFFFF"],
        ["retire_connection_id", "#068484", "#FFFFFF"],
        ["ping", "#d6dd02", "#000000"],
        ["path_challenge", "#d6dd02", "#000000"],
        ["path_response", "#d6dd02", "#000000"],
        ["max_data", "#5f0984", "#FFFFFF"],
        ["max_stream_data", "#5f0984", "#FFFFFF"],
        ["max_streams", "#5f0984", "#FFFFFF"],
        ["data_blocked", "#5f0984", "#FFFFFF"],
        ["streams_blocked", "#5f0984", "#FFFFFF"],
        ["stream_data_blocked", "#5f0984", "#FFFFFF"],
        ["new_token", "#FF0000", "#FFFFFF"],
        ["handshake_done", "#FF0000", "#FFFFFF"],
        ["datagram", "#FF0000", "#FFFFFF"],
        ["unknown", "#FF0000", "#FFFFFF"],
    ])("%s", (t, bg, fg) => expect(frameTypeToColor(t)).toEqual([bg, fg]));
});

describe("eventToShortString (§3.12.3, §9.2, §9.3)", () => {
    it("spin bit", () => {
        expect(eventToShortString(mk("quic:spin_bit_updated", { state: true }))).toBe("Spin ON");
        expect(eventToShortString(mk("quic:spin_bit_updated", { state: false }))).toBe("Spin OFF");
        expect(eventToShortString(mk("quic:spin_bit_updated", {}))).toBe("Spin OFF");
    });

    it("recovery metrics (SQ18: congestion_window as cwnd)", () => {
        expect(
            metricsLabel({
                min_rtt: 10,
                smoothed_rtt: 25.1,
                latest_rtt: 12,
                rtt_variance: 3,
                congestion_window: 13500,
                bytes_in_flight: 1252,
                packets_in_flight: 1,
            }),
        ).toBe("cwnd: 13500, srtt: 25.1, in flight: 1252, ...");
        expect(metricsLabel({ pto_count: 1 })).toBe("pto_count: 1");
        expect(metricsLabel({ min_rtt: 10, latest_rtt: 12 })).toBe("min_rtt: 10, latest_rtt: 12");
        expect(metricsLabel({ congestion_window: 14720, smoothed_rtt: 25.3, bytes_in_flight: 1252, ssthresh: 9 })).toBe(
            "cwnd: 14720, srtt: 25.3, in flight: 1252, ssthresh: 9",
        );
        // addendum S4: the legacy `cwnd` member is not read (it is just another key)
        expect(metricsLabel({ cwnd: 14720, smoothed_rtt: 25.3 })).toBe("srtt: 25.3, ...");
        expect(metricsLabel({ cwnd: 2 })).toBe("cwnd: 2");
        expect(metricsLabel({ congestion_window: 1, cwnd: 2 })).toBe("cwnd: 1, ...");
        expect(
            eventToShortString(mk("quic:recovery_metrics_updated", { bytes_in_flight: 2560, packets_in_flight: 2 })),
        ).toBe("in flight: 2560, ...");
    });

    it("parameters_set (LD7: key count of raw.data; type-only match)", () => {
        expect(eventToShortString(mk("quic:parameters_set", { initiator: "local", a: 1, b: 2 }))).toBe(
            "3 transport parameters set",
        );
        expect(eventToShortString(mk("quic:recovery_parameters_set", { timer_granularity: 1 }))).toBe(
            "1 recovery parameters set",
        );
        expect(eventToShortString(mk("http3:parameters_set", { initiator: "remote", settings: [] }))).toBe(
            "2 HTTP/3 parameters set",
        );
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(eventToShortString(mk("mvfst:parameters_set", { x: 1 }))).toBe("1 UNKNOWN parameters set");
        expect(spy).toHaveBeenCalledWith(
            "SequenceDiagramD3Renderer:eventToShortString : unknown category for 'parameters_set' event...",
            "mvfst",
        );
        // LD7: the producer's keys are counted, not a normalized copy
        const e = {
            ...mk("quic:parameters_set", { initiator: "local", owner: "local" }),
            raw: { data: { owner: "local" } },
        };
        expect(eventToShortString(e as unknown as QlogEvent)).toBe("1 transport parameters set");
    });

    it("connection state and congestion state", () => {
        expect(eventToShortString(mk("quic:connection_state_updated", { new: "handshake_complete" }))).toBe(
            "Connection state: handshake_complete",
        );
        expect(eventToShortString(mk("quic:connection_state_updated", {}))).toBe("Connection state: undefined");
        expect(eventToShortString(mk("quic:congestion_state_updated", { new: "congestion_avoidance" }))).toBe(
            "Congestion state: congestion avoidance",
        );
        expect(eventToShortString(mk("quic:congestion_state_updated", { new: "application_limited_x" }))).toBe(
            "Congestion state: application limited_x", // first underscore only (SQ23)
        );
        expect(eventToShortString(mk("quic:congestion_state_updated", {}))).toBe("congestion_state_updated");
    });

    it("timer_updated (LD4)", () => {
        expect(
            timerLabel(
                mk(
                    "quic:timer_updated",
                    { packet_number_space: "application_data", timer_type: "pto", event_type: "set", delta: 31.5 },
                    92.0291,
                ),
            ),
        ).toBe("appdata  PTO timer set @ 123.5291");
        expect(timerLabel(mk("quic:timer_updated", { timer_type: "idle_timeout", event_type: "cancelled" }))).toBe(
            " IDLE_TIMEOUT timer cancelled", // qvis formula (the spec example shows two spaces)
        );
        expect(
            timerLabel(
                mk("quic:timer_updated", { packet_number_space: "initial", timer_type: "pto", event_type: "expired" }),
            ),
        ).toBe("initial  PTO timer expired");
        // LD4: event_type missing -> type name; set without delta -> no " @ NaN"
        expect(timerLabel(mk("quic:timer_updated", { largest_sent: 1, type: "x" }))).toBe("timer_updated");
        expect(timerLabel(mk("quic:timer_updated", { timer_type: "pto", event_type: "set" }))).toBe(" PTO timer set");
        expect(timerLabel(mk("quic:timer_updated", { timer_type: "path_probe", event_type: "set", delta: 1 }, 2))).toBe(
            " PATH_PROBE timer set @ 3.0000",
        );
        // addendum S4: the legacy `timeout` member is not read
        expect(timerLabel(mk("quic:timer_updated", { event_type: "set", timeout: 1 }, 2))).toBe("  timer set");
    });

    it("packet_lost", () => {
        expect(eventToShortString(mk("quic:packet_lost", { header: { packet_type: "1RTT", packet_number: 42 } }))).toBe(
            "1RTT packet lost #42",
        );
        expect(eventToShortString(mk("quic:packet_lost", { header: { packet_number: 42 } }))).toBe("packet lost #42");
        expect(eventToShortString(mk("quic:packet_lost", { largest_lost_packet_num: 3 }))).toBe("packet_lost");
    });

    it("HTTP/3 frames (LD5, verbatim spacing)", () => {
        const headers = [
            { name: ":method", value: "GET" },
            { name: ":path", value: "/index.html" },
            { name: ":authority", value: "example.org" },
        ];
        expect(
            eventToShortString(mk("http3:frame_created", { stream_id: 0, frame: { frame_type: "headers", headers } })),
        ).toBe("GET /index.html  (stream 0) example.org");
        expect(
            eventToShortString(
                mk("http3:frame_parsed", {
                    stream_id: 0,
                    frame: { frame_type: "headers", headers: [{ name: ":status", value: "200" }] },
                }),
            ),
        ).toBe("200  (stream 0) ");
        expect(
            eventToShortString(
                mk("http3:frame_parsed", {
                    stream_id: 4,
                    frame: { frame_type: "headers", headers: [{ name: ":authority", value: "a.org" }] },
                }),
            ),
        ).toBe(" (stream 4) a.org");
        expect(eventToShortString(mk("http3:frame_parsed", { stream_id: 3, frame: { frame_type: "settings" } }))).toBe(
            "settings  parsed (stream 3)",
        );
        expect(
            eventToShortString(mk("http3:frame_created", { stream_id: 2, frame: { frame_type: "priority_update" } })),
        ).toBe("priority_update  created (stream 2)");
        expect(eventToShortString(mk("http3:frame_created", { stream_id: 2, frame: {} }))).toBe(" created (stream 2)");
        // LD5: name_bytes "3a6d6574686f64" = ":method"
        expect(fieldName({ name_bytes: "3a6d6574686f64", value: "GET" })).toBe(":method");
        expect(
            h3FrameLabel(
                mk("http3:frame_created", {
                    stream_id: 0,
                    frame: { frame_type: "headers", headers: [{ name_bytes: "3a6d6574686f64", value: "GET" }] },
                }),
            ),
        ).toBe("GET  (stream 0) ");
        // addendum S4: legacy colon-less names are not pseudo-headers
        expect(
            h3FrameLabel(
                mk("http3:frame_created", {
                    stream_id: 0,
                    frame: { frame_type: "headers", headers: [{ name: "method", value: "POST" }] },
                }),
            ),
        ).toBe("headers  created (stream 0)");
        // converter TCP traces use http2:
        expect(eventToShortString(mk("http2:frame_created", { stream_id: 1, frame: { frame_type: "data" } }))).toBe(
            "data  created (stream 1)",
        );
    });

    it("loglevel / simulation messages (levelOf)", () => {
        for (const lvl of ["error", "warning", "info", "debug", "verbose"]) {
            expect(levelOf(mk("loglevel:" + lvl))).toBe(lvl);
            expect(eventToShortString(mk("loglevel:" + lvl, { message: "hi" }))).toBe(lvl + ": hi");
        }
        expect(eventToShortString(mk("loglevel:error", { code: 3 }))).toBe("error");
        expect(eventToShortString(mk("simulation:marker", { type: "x", message: "m" }))).toBe("simulation: m");
        expect(eventToShortString(mk("simulation:marker", {}))).toBe("marker");
        expect(eventToShortString(mk("simulation:scenario", { name: "s" }))).toBe("scenario");
        expect(eventToShortString(mk("mvfst:message", { message: "x" }))).toBe("mvfst: x");
    });

    it("everything else: the type name (latest names, §9.10)", () => {
        expect(eventToShortString(mk("quic:udp_datagrams_sent", { count: 1 }))).toBe("udp_datagrams_sent");
        expect(eventToShortString(mk("quic:connection_id_updated", {}))).toBe("connection_id_updated");
        expect(eventToShortString(mk("quic:key_discarded", {}))).toBe("key_discarded");
        expect(eventToShortString(mk("http3:stream_type_set", {}))).toBe("stream_type_set");
    });
});

describe("eventTypeToColor (§3.13.2)", () => {
    const c = (name: string, data: any = {}, ext?: boolean) => eventTypeToColor(mk(name, data), ext);
    it("chain order and colours", () => {
        expect(c("quic:connection_id_updated")).toEqual(["#068484", "#FFFFFF"]);
        expect(c("quic:spin_bit_updated")).toEqual(["#d6dd02", "#000000"]);
        expect(c("quic:connection_state_updated", { new: "closed" })).toEqual(["#a80f3a", "#FFFFFF"]);
        expect(c("quic:connection_state_updated", { new: "draining" })).toEqual(["#a80f3a", "#FFFFFF"]);
        expect(c("quic:connection_state_updated", { new: "closing" })).toEqual(["#a80f3a", "#FFFFFF"]); // X2
        expect(c("quic:connection_state_updated", { new: "closing" }, false)).toEqual(["#FF0000", "#FFFFFF"]);
        expect(c("quic:connection_state_updated", { new: "handshake_complete" })).toEqual(["#FF0000", "#FFFFFF"]); // SQ22
        for (const n of [
            "quic:recovery_metrics_updated",
            "quic:parameters_set",
            "quic:recovery_parameters_set",
            "http3:parameters_set",
            "mvfst:parameters_set",
            "quic:timer_updated",
        ]) {
            expect(c(n)).toEqual(["#5f0984", "#FFFFFF"]);
        }
        expect(c("http3:frame_created")).toEqual(["#0468cc", "#FFFFFF"]);
        expect(c("http3:frame_parsed")).toEqual(["#0468cc", "#FFFFFF"]);
        expect(c("quic:udp_datagrams_sent")).toEqual(["#FFFFFF", "#000000"]);
        expect(c("quic:udp_datagrams_received")).toEqual(["#FFFFFF", "#000000"]);
        expect(c("loglevel:error")).toEqual(["#FF0000", "#000000"]);
        expect(c("loglevel:warning")).toEqual(["#FFA500", "#000000"]);
        expect(c("simulation:marker")).toEqual(["#FFA500", "#000000"]);
        expect(c("loglevel:info")).toEqual(["#D3D3D3", "#000000"]);
        expect(c("loglevel:debug")).toEqual(["#D3D3D3", "#000000"]);
        expect(c("loglevel:verbose")).toEqual(["#D3D3D3", "#000000"]);
        for (const n of [
            "quic:packet_lost",
            "quic:packet_dropped",
            "quic:congestion_state_updated",
            "quic:key_updated",
        ]) {
            expect(c(n)).toEqual(["#FF0000", "#FFFFFF"]);
        }
    });
});
