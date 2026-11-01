// File Manager page (port of qvis FileManagerContainer.vue; file-loading spec §2 UI verbatim, §3.2/3.3/3.9/3.11).
//
// Five numbered options plus the list of loaded files. Loading logic lives in src/loading (pure async functions)
// and the connection store; this component only owns the form state (reset on remount, as in qvis).
// Deviations (all from the spec's FIX / DECISION list): Enter in the URL field fetches instead of reloading the page
// (Q1), the URL is trimmed (6.3), pcap without a backend gives X6 and the Option 1 help text says so (D1/D6),
// `secrets` is only sent while the secrets field is shown (Q4), dropping files anywhere on the page selects them
// instead of navigating away (Q10), Option 5 links point at this deployment (D7), group links are http(s)-only and
// open in a new tab (Q3).

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { QVIS_VERSION } from "@/app/constants";
import { notify } from "@/lib/notify";
import type { QlogConnectionGroup } from "@/model/QlogConnectionGroup";
import { useConnectionStore } from "@/store/connectionStore";
import {
    DEFAULT_MASSIVE_BUTTON_LABEL,
    DEFAULT_MASSIVE_DOWNLOAD_SIZE,
    getMassiveDemoEntry,
    massiveButtonLabel,
    massiveDownloadSize,
} from "@/loading/demo";
import { isPcapLikeURL, urlIsPcap } from "@/loading/detect";
import { downloadGroup } from "@/loading/exportQlog";
import { N1_pcapWithoutKeys, X6_pcapUnsupported } from "@/loading/messages";
import { pcapBackendURL } from "@/loading/remote";
import { UPLOAD_ACCEPT } from "@/loading/upload";
import FileUploadControl from "./FileUploadControl";
import LoadedFilesList from "./LoadedFilesList";
import "./FileManagerContainer.css";

/** Option 5 example link: visible text verbatim, href to this deployment (D7). */
function paramHref(query: string): string {
    if (typeof window === "undefined") return "#?" + query;
    return window.location.origin + window.location.pathname + "#?" + query;
}

/** Option 4 button label and help-text download size, from the massive manifest (D13). */
function useMassiveDemoLabels(): { label: string; downloadSize: string } {
    const [labels, setLabels] = useState({
        label: DEFAULT_MASSIVE_BUTTON_LABEL,
        downloadSize: DEFAULT_MASSIVE_DOWNLOAD_SIZE,
    });
    useEffect(() => {
        let alive = true;
        getMassiveDemoEntry()
            .then((entry) => {
                if (alive && entry !== undefined) {
                    setLabels({ label: massiveButtonLabel(entry), downloadSize: massiveDownloadSize(entry) });
                }
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, []);
    return labels;
}

/** Q10 FIX: dropping files anywhere on the page selects them instead of letting the browser open them. */
function usePageDropGuard(onFiles: (files: File[]) => void): void {
    useEffect(() => {
        const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
        const onDragOver = (e: DragEvent) => {
            if (carriesFiles(e)) e.preventDefault();
        };
        const onDrop = (e: DragEvent) => {
            if (e.defaultPrevented || !carriesFiles(e)) return;
            e.preventDefault();
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (files.length > 0) onFiles(files);
        };
        window.addEventListener("dragover", onDragOver);
        window.addEventListener("drop", onDrop);
        return () => {
            window.removeEventListener("dragover", onDragOver);
            window.removeEventListener("drop", onDrop);
        };
    }, [onFiles]);
}

export default function FileManagerContainer() {
    const groups = useConnectionStore((s) => s.groups);
    useConnectionStore((s) => s.revision); // shorthand connection counts change with model events

    const [urlToLoad, setUrlToLoad] = useState("");
    const [secretsToLoad, setSecretsToLoad] = useState("");
    const [filesToUpload, setFilesToUpload] = useState<File[]>([]);
    const { label: massiveLabel, downloadSize: massiveDownloadSizeLabel } = useMassiveDemoLabels();
    usePageDropGuard(setFilesToUpload);

    const pcapBackend = pcapBackendURL();
    const showSecrets = pcapBackend !== undefined && urlIsPcap(urlToLoad);

    function loadURL(e?: FormEvent) {
        e?.preventDefault();
        const url = urlToLoad.trim();
        if (url === "") return;
        const secrets = secretsToLoad.trim();
        if (pcapBackend === undefined) {
            if (isPcapLikeURL(url)) {
                notify(X6_pcapUnsupported());
                return;
            }
        } else if (urlIsPcap(url) && secrets === "") {
            notify(N1_pcapWithoutKeys());
            return;
        }
        const params: Record<string, string> = {};
        if (url.toLowerCase().endsWith(".json")) params.list = url;
        else params.file = url;
        if (showSecrets && secrets !== "") params.secrets = secrets;
        void useConnectionStore.getState().loadFilesFromServer(params);
    }

    function uploadFile(e?: FormEvent) {
        e?.preventDefault();
        if (filesToUpload.length === 0) return;
        void useConnectionStore.getState().loadFiles(filesToUpload);
    }

    function loadExamples() {
        void useConnectionStore.getState().loadExamplesForDemo();
    }

    function loadMassiveExample() {
        void useConnectionStore.getState().loadMassiveDemo();
    }

    function removeGroup(group: QlogConnectionGroup) {
        console.log("FileManagerContainer:removeGroup : removing group ", group);
        useConnectionStore.getState().removeGroup(group);
    }

    const noSubmit = (e: FormEvent) => e.preventDefault();

    return (
        <div className="home" data-filemanager="">
            <h1>Welcome to qvis v{QVIS_VERSION}, the QUIC and HTTP/3 visualization toolsuite!</h1>
            <p>To be able to visualize something, you need to load some data. We have several options for that:</p>

            <div id="FileManagerContainer" className="container-fluid table-striped">
                <div className="row fileOptionContainer">
                    <div className="col-1 col-md-auto">
                        <h3>Option 1</h3>
                    </div>
                    <div className="col">
                        <h3>Load a file by URL</h3>
                        <div style={{ margin: "10px 0px" }}>
                            <form onSubmit={loadURL}>
                                <div className="row">
                                    <div className="col">
                                        <input
                                            id="urlInput"
                                            type="text"
                                            className="form-control"
                                            placeholder="https://www.example.com/output.qlog"
                                            value={urlToLoad}
                                            onChange={(e) => setUrlToLoad(e.target.value)}
                                        />
                                        {showSecrets && (
                                            <p style={{ marginTop: "10px" }}>
                                                For .pcap files, you also need to specify a .keys file so it can be
                                                decrypted.
                                            </p>
                                        )}
                                        {showSecrets && (
                                            <input
                                                id="secretsInput"
                                                type="text"
                                                className="form-control"
                                                placeholder="https://www.example.com/secrets.keys"
                                                value={secretsToLoad}
                                                onChange={(e) => setSecretsToLoad(e.target.value)}
                                            />
                                        )}
                                    </div>
                                    <div className="col-1 col-md-auto">
                                        <button type="submit" className="btn btn-primary" disabled={urlToLoad === ""}>
                                            Fetch
                                        </button>
                                    </div>
                                </div>
                            </form>
                        </div>
                        <div>
                            <p style={{ marginTop: "5px" }}>
                                {pcapBackend !== undefined ? (
                                    <>
                                        You can load .qlog, .sqlog, .netlog, .pcap (alongside separate .keys) and
                                        .pcapng (with embedded keys) files.
                                    </>
                                ) : (
                                    <>
                                        You can load .qlog, .sqlog and .netlog files. Converting .pcap and .pcapng files
                                        is not supported in this deployment.
                                    </>
                                )}
                                <br />
                                You can also load a .json file that lists several other files to be fetched (for the
                                format, see{" "}
                                <a href="https://github.com/quiclog/pcap2qlog#options">the pcap2qlog documentation</a>.
                                Or try{" "}
                                <a href="https://quic-tracker.info.ucl.ac.be/traces/20190820/list/quant.eggert.org:4433?.json">
                                    an example
                                </a>
                                ).
                                <br />
                                <br />
                                If you&apos;re looking for inspiration,{" "}
                                <a href="https://quant.eggert.org/" target="_blank" rel="noreferrer">
                                    quant
                                </a>{" "}
                                has public qlogs, as does{" "}
                                <a href="https://quic.aiortc.org/logs" target="_blank" rel="noreferrer">
                                    aioquic
                                </a>
                                .<br />
                                <a href="https://quic-tracker.info.ucl.ac.be">QUIC Tracker</a> provides .pcap files for
                                all its tests and has a convenient integration with qvis from its UI. <br />
                                Many of the tests in the <a href="https://interop.seemann.io/">
                                    QUIC Interop Runner
                                </a>{" "}
                                also include .qlog and .pcap output.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="row fileOptionContainer">
                    <div className="col-1 col-md-auto">
                        <h3>Option 2</h3>
                    </div>
                    <div className="col">
                        <h3>Upload a file</h3>
                        <div style={{ margin: "10px 0px" }}>
                            <form onSubmit={uploadFile}>
                                <div className="row">
                                    <div className="col">
                                        <FileUploadControl
                                            id="fileUpload"
                                            files={filesToUpload}
                                            onFilesChange={setFilesToUpload}
                                            state={filesToUpload.length > 0}
                                            placeholder="Choose files or drop them here..."
                                            dropPlaceholder="Drop files here..."
                                            accept={UPLOAD_ACCEPT}
                                        />
                                    </div>
                                    <div className="col-1 col-md-auto">
                                        <button
                                            type="submit"
                                            className="btn btn-primary"
                                            disabled={filesToUpload.length === 0}
                                        >
                                            Import
                                        </button>
                                    </div>
                                </div>
                            </form>
                        </div>
                        <div>
                            <p>
                                Upload currently supports .qlog, .sqlog, .json, and{" "}
                                <a href="https://www.chromium.org/for-testers/providing-network-details">.netlog</a>{" "}
                                files. No data is transfered to the server.
                                <br />
                                Eventually we will also support .pcap, .pcapng and .qtr files.
                                <br />
                                <span style={{ fontSize: "12px" }}>
                                    Note: Chrome netlog must be explicitly given the .netlog extension before uploading
                                    to qvis.
                                </span>
                            </p>
                        </div>
                    </div>
                </div>

                <div className="row fileOptionContainer">
                    <div className="col-1 col-md-auto">
                        <h3>Option 3</h3>
                    </div>
                    <div className="col">
                        <h3>Load some premade demo files</h3>
                        <div style={{ margin: "10px 0px" }}>
                            <form onSubmit={noSubmit}>
                                <button type="button" className="btn btn-primary" onClick={loadExamples}>
                                    Load example .qlog files
                                </button>
                            </form>
                        </div>
                        <div>
                            <p>
                                This will load a few example files that you can visualize to get an idea of what&apos;s
                                possible.
                                <br />
                            </p>
                        </div>
                    </div>
                </div>

                <div className="row fileOptionContainer">
                    <div className="col-1 col-md-auto">
                        <h3>Option 4</h3>
                    </div>
                    <div className="col">
                        <h3>Load a massive demo file</h3>
                        <div style={{ margin: "10px 0px" }}>
                            <form onSubmit={noSubmit}>
                                <button type="button" className="btn btn-primary" onClick={loadMassiveExample}>
                                    {massiveLabel}
                                </button>
                            </form>
                        </div>
                        <div>
                            <p>
                                {"This will load a single qlog file representing a " +
                                    massiveDownloadSizeLabel +
                                    " download. Use this to see how well qvis visualizations perform on larger traces."}
                                <br />
                            </p>
                        </div>
                    </div>
                </div>

                <div className="row fileOptionContainer">
                    <div className="col-1 col-md-auto">
                        <h3>Option 5</h3>
                    </div>
                    <div className="col">
                        <h3>Load a file by URL parameter</h3>
                        <div style={{ margin: "10px 0px" }}>
                            <p>
                                You can pass files you want to load via URL parameters to the qvis page.
                                <br />
                                This method supports the same formats as Option 1.
                                <br />
                                <br />
                                Format 1: <a href={paramHref("list=x.json")}>?list=x.json</a>
                                <br />
                                Format 2: <a href={paramHref("file=x.qlog")}>?file=x.qlog</a>
                                <br />
                                Format 3:{" "}
                                <a href={paramHref("file=x.pcap&secrets=x.keys")}>?file=x.pcap&amp;secrets=x.keys</a>
                                <br />
                                Format 4:{" "}
                                <a href={paramHref("file1=x.qlog&file2=y.qlog&file3=z.qlog")}>
                                    ?file1=x.qlog&amp;file2=y.qlog&amp;file3=z.qlog
                                </a>
                                <br />
                                Format 5:{" "}
                                <a href={paramHref("file1=x.qlog&secrets1=x.keys&file2=y.qlog&secrets2=y.keys")}>
                                    ?file1=x.qlog&amp;secrets1=x.keys&amp;file2=y.qlog&amp;secrets2=y.keys
                                </a>
                                <br />
                            </p>
                        </div>
                    </div>
                </div>

                {groups.length > 0 && (
                    <LoadedFilesList groups={groups} onRemove={removeGroup} onDownload={downloadGroup} />
                )}
            </div>
        </div>
    );
}
