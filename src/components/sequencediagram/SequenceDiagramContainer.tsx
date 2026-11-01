// Port of qvis SequenceDiagramContainer.vue: `div.home` with the configurator and the renderer, both reading the
// store's sequence-diagram config (parity/sequence-diagram.md §2.1). The debug SimpleRenderer and the abandoned canvas
// renderer of qvis are dead code and not ported.

import "./SequenceDiagram.css";
import SequenceDiagramConfigurator from "./SequenceDiagramConfigurator";
import SequenceDiagramRenderer from "./SequenceDiagramRenderer";

export default function SequenceDiagramContainer() {
    return (
        // the id is not in qvis; the shell's tests use it to find the page
        <div className="home" id="SequenceDiagramContainer">
            <SequenceDiagramConfigurator />
            <SequenceDiagramRenderer />
        </div>
    );
}

export { SequenceDiagramContainer };
