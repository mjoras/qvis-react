// qvis App.vue: <MainMenu/> + the routed tool view + <Notifications/> (parity/app-shell.md §2.2).
// DOM order: menu, view, notification container (position: fixed). The #app element itself is the mount point in
// index.html, so App renders a fragment instead of a nested #app.

import { useEffect } from "react";
import MainMenu from "@/components/shell/MainMenu";
import Notifications from "@/components/shell/Notifications";
import { findRoute } from "./routes";
import { getRoute, useRoute } from "./router";
import { runStartupLoadOnce } from "./startup";

export default function App() {
    const route = useRoute();
    const def = findRoute(route.path);
    const View = def?.view;

    useEffect(() => {
        runStartupLoadOnce(getRoute().query);
    }, []);

    return (
        <>
            {View ? <MainMenu /> : null}
            {View ? <View /> : null}
            <Notifications group="default" position="bottom center" width="50%" />
        </>
    );
}
