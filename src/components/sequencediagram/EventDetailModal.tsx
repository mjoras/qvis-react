// The "Event detail" popup (qvis SequenceDiagramRenderer.vue:11-21, a bootstrap-vue b-modal with hide-footer;
// parity/sequence-diagram.md §2.8). Default size (500px), header close "×", Esc / backdrop close.

import Modal from "react-bootstrap/Modal";
import type { EventDetail } from "./eventDetail";

export interface EventDetailModalProps {
    show: boolean;
    /** kept while the modal fades out */
    detail: EventDetail | null;
    onHide: () => void;
}

const TITLE_ID = "event-modal___BV_modal_title_";

/** bootstrap-vue put `id="event-modal"` on the outer .modal; react-bootstrap's `id` prop lands on .modal-dialog. */
const setRootId = (node: HTMLElement) => {
    node.id = "event-modal";
};

export default function EventDetailModal({ show, detail, onHide }: EventDetailModalProps) {
    return (
        <Modal show={show} onHide={onHide} onEnter={setRootId} aria-labelledby={TITLE_ID}>
            <Modal.Header>
                <Modal.Title as="h5" id={TITLE_ID}>
                    Event detail
                </Modal.Title>
                <button type="button" aria-label="Close" className="close" onClick={onHide}>
                    ×
                </button>
            </Modal.Header>
            <Modal.Body>
                {detail !== null && detail.eventLink !== null ? (
                    <div>
                        <a href={detail.eventLink} target="_blank" rel="noopener noreferrer">
                            Direct link to this event
                        </a>
                        <br />
                        <hr />
                    </div>
                ) : null}
                <pre className="d-block">{detail !== null ? detail.eventDetail : ""}</pre>
                {detail !== null && detail.eventDetailExtra !== null ? (
                    <p style={{ fontWeight: "bold" }}>Value of all recovery metrics at this point:</p>
                ) : null}
                {detail !== null && detail.eventDetailExtra !== null ? (
                    <pre className="d-block">{detail.eventDetailExtra}</pre>
                ) : null}
                <button type="button" className="btn btn-secondary mt-3 btn-block" onClick={onHide}>
                    Close
                </button>
            </Modal.Body>
        </Modal>
    );
}

export { EventDetailModal };
