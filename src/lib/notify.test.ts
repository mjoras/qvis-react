import { afterEach, describe, expect, it } from "vitest";
import {
    notify,
    resetNotificationsForTests,
    splitNotificationLines,
    subscribeNotifications,
    type NotificationItem,
} from "./notify";

afterEach(() => resetNotificationsForTests());

describe("notify", () => {
    it("fills in the defaults (group 'default', 3000 ms)", () => {
        const got: NotificationItem[] = [];
        subscribeNotifications((n) => got.push(n));
        notify({ title: "t", text: "x" });
        notify({ group: "other", text: "y", type: "error", duration: 6000 });
        expect(got).toHaveLength(2);
        expect(got[0]).toMatchObject({ group: "default", title: "t", text: "x", duration: 3000 });
        expect(got[0].type).toBeUndefined();
        expect(got[1]).toMatchObject({ group: "other", type: "error", duration: 6000 });
        expect(got[1].id).toBeGreaterThan(got[0].id);
    });

    it("buffers notifications emitted before anyone subscribed", () => {
        notify({ text: "early" });
        const got: string[] = [];
        const unsubscribe = subscribeNotifications((n) => got.push(n.text));
        expect(got).toEqual(["early"]);
        unsubscribe();
        notify({ text: "late, buffered again" });
        subscribeNotifications((n) => got.push(n.text));
        expect(got).toEqual(["early", "late, buffered again"]);
    });

    it("stops delivering after unsubscribe", () => {
        const got: string[] = [];
        const a = subscribeNotifications((n) => got.push("a:" + n.text));
        subscribeNotifications((n) => got.push("b:" + n.text));
        a();
        notify({ text: "x" });
        expect(got).toEqual(["b:x"]);
    });
});

describe("splitNotificationLines", () => {
    it("splits on <br/>, <br> and <br /> only", () => {
        expect(splitNotificationLines("a<br/>b<BR>c<br />d")).toEqual(["a", "b", "c", "d"]);
        expect(splitNotificationLines("<img src=x onerror=alert(1)>")).toEqual(["<img src=x onerror=alert(1)>"]);
    });
});
