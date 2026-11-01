// Repository chrome (parity/app-shell.md §2.4 "Button targets", §8.10).

/** Public repository of qvis-react. The MainMenu buttons deep-link into its issue templates by filename. */
export const REPO_URL = "https://github.com/mjoras/qvis-react";

/** `.github/ISSUE_TEMPLATE/feature_request.md` */
export const FEATURE_REQUEST_URL = REPO_URL + "/issues/new?template=feature_request.md&title=Feature+request";

/** `.github/ISSUE_TEMPLATE/bug-report-in-live-version.md` */
export const REPORT_ISSUE_URL =
    REPO_URL + "/issues/new?template=bug-report-in-live-version.md&title=Bug+in+live+version";

/** Version string shown in the file manager heading ("Welcome to qvis v0.1, ..."; owned by the file-manager spec). */
export const QVIS_VERSION = "0.1";
