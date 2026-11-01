// Thin route wrapper (qvis views/*.vue: `<div><XContainer/></div>`, no logic).

import * as ContainerModule from "@/components/filemanager/FileManagerContainer";
import { pickComponent } from "./pickComponent";

const FileManagerContainer = pickComponent(ContainerModule, "FileManagerContainer");

export default function FileManagerView() {
    return (
        <div>
            <FileManagerContainer />
        </div>
    );
}
