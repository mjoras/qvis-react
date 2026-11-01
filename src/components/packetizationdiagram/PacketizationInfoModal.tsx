// The "PacketizationDiagram info" modal (qvis PacketizationDiagramConfigurator.vue:36-93, parity spec §2.3).
//
// The body reproduces the DOM qvis actually renders (verified on the hosted qvis): Vue builds the template with
// createElement, so the first two <p>s CONTAIN their <ul> and all the text up to the </p> (no browser p-closing, no empty
// <p></p>; parity spec §2.3 assumed otherwise). React warns about <ul> inside <p>, so those two paragraphs are <div>s
// with the <p> margins (.packetization-info-paragraph): same pixels. Text is verbatim (typos included), except the three
// "How does it work?" bullets, which name the latest-draft fields (DECISION D-PZ1). Q-M1 FIX: controlled `show`, so the
// button always opens and "Close" / × / ESC / backdrop always close.

import Modal from "react-bootstrap/Modal";

export interface PacketizationInfoModalProps {
    show: boolean;
    onHide: () => void;
}

const TITLE_ID = "packetization-info-modal-title";

/** qvis `b-modal id="info-modal"` puts the id on the `.modal` root; react-bootstrap forwards `id` to `.modal-dialog`. */
const setRootId = (node: HTMLElement) => {
    node.id = "info-modal";
};

export default function PacketizationInfoModal({ show, onHide }: PacketizationInfoModalProps) {
    return (
        <Modal
            show={show}
            onHide={onHide}
            onEnter={setRootId}
            size="xl"
            className="packetization-info-modal"
            aria-labelledby={TITLE_ID}
        >
            <div className="modal-header">
                <h5 className="modal-title" id={TITLE_ID}>
                    PacketizationDiagram info
                </h5>
                <button type="button" aria-label="Close" className="close" onClick={onHide}>
                    ×
                </button>
            </div>
            <div className="modal-body">
                <h2>How to test?</h2>
                Load the predefined DEMO files (using the &quot;manage files&quot; tab above) and then select the &quot;
                <b>DEMO_10_parallel_streams</b>&quot; file here (the other demo files are a bit flaky on this
                visualization because they&apos;re older and don&apos;t always contain all the necessary fields)
                <br />
                You can also upload your own qlog files, but note that this has been tested mainly on client-side
                traces. Server-side logs should work, but there might be dragons. Let us know if you find any bugs.
                <h2>What does it do?</h2>
                <div className="packetization-info-paragraph">
                    The packetization diagram shows how QUIC and HTTP/3 frames are packed inside each other and inside
                    QUIC packets. This helps to see how (especially STREAM and DATA) frames are sized, how packet sizes
                    are modulated, if HTTP/3 frame boundaries don&apos;t directly correspond to QUIC boundaries, etc.
                    <ul>
                        <li>
                            The bottom row (black and grey) shows the QUIC packets. Each packet has a header (the lower
                            area) and a payload (the higher area). <br />
                            The first packet is black, the second grey, etc. to clearly show when a new packet starts.
                            This use of alternating colors to show clear delineations is consistent for the rest of the
                            diagram as well.
                        </li>
                        <li>
                            The second row (red and pink) shows the QUIC frames inside the packet payloads. Each frame
                            has a frame header and a payload.
                        </li>
                        <li>
                            The third row (blue and light blue) show the HTTP/3 frames inside QUIC STREAM frame&apos;s
                            payloads. Each HTTP/3 frame has a frame header and a payload.
                        </li>
                        <li>
                            The fourth row (several colors) show to which stream each HTTP/3 frame belongs (if any).
                            This to make it easier to track how streams are multiplexed on the wire.
                        </li>
                    </ul>
                    <b>IMPORTANT: the x-axis does NOT show time but bytes sent/received</b>. This also means that the
                    two individual x-axis (for the top and bottom diagrams) do not (directly) overlap in time, even
                    though it might appear like that at first glance! To get a better idea of timing, use the sequence
                    diagram
                    <br />
                    <br />
                    You can hover over each element and get a popup with more in-context information on what&apos;s
                    present at that location. <br />
                    You can also zoom with the scrollwheel and drag to pan the diagram.
                    <br />
                    <br />
                    Keep an eye on the browser devtools&apos; JavaScript console: if you see weird behaviour,
                    you&apos;ll probably see an error message explaining things there as well.
                </div>
                <h2>How does it work?</h2>
                <div className="packetization-info-paragraph">
                    The visualization currently looks mainly at the following qlog events and attributes to figure out
                    packet and frame sizes:
                    <ul>
                        <li>quic:packet_sent/quic:packet_received : raw : length (and raw : payload_length)</li>
                        <li>
                            quic:packet_sent/quic:packet_received : frames[ StreamFrame ] : raw : length (or raw :
                            payload_length)
                        </li>
                        <li>
                            http3:frame_parsed/http3:frame_created : frame : raw : payload_length (or frame : raw :
                            length)
                        </li>
                    </ul>
                    However, these events are not enough to fully know the sizes of all QUIC frames: we only have
                    explicit (payload) lengths for the stream frames. Because of QUIC&apos;s use of variable-length
                    integer encoding for frame headers, it&apos;s difficult to know the frame&apos;s header and payload
                    sizes (especially for things like ACK frames).
                    <br />
                    qlog draft-02 should include fields to allow explicit logging of these lengths. For pre-02, this
                    tool tries to <b>guesstimate</b> the sizes (and probably gets it wrong). If we fail to correctly
                    guess, we backfill with bright yellow rendered &quot;filler&quot; frames. <br />
                    <br />
                    Note that this means that while the sizes of most QUIC frames (except STREAM frames) are off, the
                    visualization is still accurate in showing which frames were in which packet.
                </div>
                <h2>Also usable for TCP + TLS + HTTP/2</h2>
                <p>
                    This visualization was first created for use with TCP + TLS + HTTP/2, as there the implementations
                    are typically less well aggregated. This often leads to inefficiencies in how data is packed inside
                    the different layers. If you want to use this tool with those protocols as well, create a decrypted
                    trace (so HTTP/2 is decoded) using wireshark (or equivalent) and then output it as JSON (either from
                    wireshark directly or using tshark). You can then upload that as a .json file using the qvis file
                    manager. It has a built-in pcap-to-qlog convertor (or at least the basic of one for this purpose).
                    See the qvis repository for a demo TCP file.
                </p>
                <button type="button" className="btn btn-secondary mt-3 d-block" onClick={onHide}>
                    Close
                </button>
            </div>
        </Modal>
    );
}

export { PacketizationInfoModal };
