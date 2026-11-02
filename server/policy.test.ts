// @vitest-environment node
//
// Local server policy tables (server/policy.ts): which proxy targets --allow-private opens, this machine's own
// addresses, loopback binds and host-name normalization.

import { describe, expect, it } from "vitest";
import { isLoopbackBind, isPrivateTarget, localAddressPolicy, normalizeHostName, ownAddresses } from "./policy.ts";

describe("isPrivateTarget (opened by --allow-private)", () => {
    it.each([
        "127.0.0.1",
        "127.1.2.3",
        "10.0.0.7",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.20",
        "100.64.0.1",
        "100.127.255.254",
        "::1",
        "fd00::5",
        "fc12:3456::1",
        "::ffff:127.0.0.1",
        "::ffff:192.168.1.1",
    ])("%s is private", (a) => {
        expect(isPrivateTarget(a)).toBe(true);
    });

    it.each([
        "169.254.169.254", // cloud metadata
        "169.254.1.1",
        "0.0.0.0",
        "0.1.2.3",
        "::",
        "fe80::1",
        "224.0.0.1",
        "255.255.255.255",
        "240.0.0.1",
        "172.32.0.1",
        "100.128.0.1",
        "8.8.8.8",
        "2001:4860:4860::8888",
        "::ffff:169.254.169.254",
        "not-an-ip",
    ])("%s is not", (a) => {
        expect(isPrivateTarget(a)).toBe(false);
    });
});

describe("localAddressPolicy", () => {
    // public addresses that the Vercel policy allows, standing in for this machine's own public addresses
    const own = () => new Set(["8.8.4.4", "2a01:4f8:0:0:0:0:0:1"]);
    const METADATA = ["169.254.169.254", "::ffff:169.254.169.254", "100.100.100.200", "::ffff:100.100.100.200"];
    const METADATA6 = ["fd00:ec2::254", "fd20:ce::254", "FD00:EC2:0:0:0:0:0:254"];

    it("default: the Vercel policy plus this machine's own public addresses", () => {
        const blocked = localAddressPolicy(false, own);
        expect(blocked("8.8.8.8")).toBe(false);
        expect(blocked("127.0.0.1")).toBe(true);
        expect(blocked("192.168.1.1")).toBe(true);
        expect(blocked("8.8.4.4")).toBe(true); // own address
        expect(blocked("::ffff:8.8.4.4")).toBe(true); // own address, IPv4-mapped
        expect(blocked("2a01:4f8::1")).toBe(true); // own address, other spelling
        for (const a of [...METADATA, ...METADATA6]) expect(blocked(a), a).toBe(true);
    });

    it("--allow-private: this computer and private networks too, never metadata, link-local or unspecified", () => {
        const blocked = localAddressPolicy(true, own);
        for (const a of [
            "127.0.0.1",
            "::1",
            "10.1.2.3",
            "192.168.1.1",
            "fd00::5",
            "8.8.8.8",
            "8.8.4.4",
            "2a01:4f8::1",
        ]) {
            expect(blocked(a), a).toBe(false);
        }
        for (const a of [...METADATA, ...METADATA6, "fe80::1", "0.0.0.0", "::", "224.0.0.1", "255.255.255.255", "x"]) {
            expect(blocked(a), a).toBe(true);
        }
    });

    it("finds this machine's addresses (at least loopback)", () => {
        const mine = ownAddresses();
        expect(mine.has("127.0.0.1") || mine.has("0:0:0:0:0:0:0:1")).toBe(true);
    });
});

describe("isLoopbackBind", () => {
    it.each(["127.0.0.1", "127.0.0.2", "::1", "[::1]", "localhost", "LOCALHOST"])("%s is loopback", (h) => {
        expect(isLoopbackBind(h)).toBe(true);
    });
    it.each(["0.0.0.0", "::", "192.168.1.5", "fe80::1", "example.com"])("%s is not", (h) => {
        expect(isLoopbackBind(h)).toBe(false);
    });
});

describe("normalizeHostName", () => {
    it.each([
        ["Qvis.Example.", "qvis.example"],
        ["qvis.example:8080", "qvis.example"],
        ["[::1]", "::1"],
        ["[::1]:8080", "::1"],
        [" qvis.example ", "qvis.example"],
    ])("%s -> %s", (input, expected) => {
        expect(normalizeHostName(input)).toBe(expected);
    });
});
