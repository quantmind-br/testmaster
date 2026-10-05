import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalUrl, classifyIp, EgressPolicy, type NetworkPolicy } from "./policy.js";

export const testPolicy = (allowedOrigins: string[]): NetworkPolicy => ({
  defaultAction: "deny",
  allowedOrigins,
  privateTargets: [],
  allowedProtocols: ["http", "https"],
  allowRedirects: true,
  maxRedirects: 10,
  allowInsecureTls: false,
});
describe("SEC-008 canonical origins", () => {
  it.each([
    "http://0x7f.1",
    "http://2130706433",
    "http://0177.0.0.1",
    "http://127.1",
    "http://127.000.0.1",
    "http://allowed.test@127.0.0.1",
    "http://allowed.test\\@127.0.0.1",
    "http://%61llowed.test",
    "http://[fe80::1%25eth0]",
    "http://allowed.test\n",
    "file:///etc/passwd",
  ])("rejects %s", (url) => expect(() => canonicalUrl(url)).toThrow());
  it("normalizes IDNA, final dots, IPv6 and default ports reproducibly", () => {
    expect(canonicalUrl("https://BÜCHER.test.:443/a").origin).toBe(
      "https://xn--bcher-kva.test:443",
    );
    expect(canonicalUrl("http://[2001:4860:4860:0:0:0:0:8888]/").hostname).toBe(
      "2001:4860:4860::8888",
    );
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ["http", "https"] }), (url) => {
        const target = canonicalUrl(url);
        expect(canonicalUrl(target.url)).toEqual(target);
        expect(canonicalUrl(target.origin).origin).toBe(target.origin);
      }),
    );
  });
  it("matches exact origins instead of suffixes", async () => {
    const policy = new EgressPolicy(testPolicy(["http://allowed.test"]));
    await expect(
      policy.authorize("http://allowed.test.attacker.test", async () => ["8.8.8.8"]),
    ).rejects.toThrow("origin_denied");
  });
});
describe("SEC-009 restricted IP corpus", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "fd00:ec2::254",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "192.0.2.1",
    "2001:db8::1",
  ])("denies %s", async (address) => {
    expect(classifyIp(address)).not.toBe("public");
    await expect(
      new EgressPolicy(testPolicy(["http://target.test"])).authorize(
        "http://target.test",
        async () => [address],
      ),
    ).rejects.toThrow();
  });
  it("classifies private and mapped ranges for all octets", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (a, b) => {
        expect(classifyIp(`10.${a}.${b}.1`)).toBe("private");
        expect(classifyIp(`::ffff:10.${a}.${b}.1`)).toBe("private");
        expect(classifyIp(`127.${a}.${b}.1`)).toBe("loopback");
      }),
    );
  });
  it("fails closed on mixed answers and rechecks reconnects", async () => {
    const policy = new EgressPolicy(testPolicy(["http://target.test"]));
    await expect(
      policy.authorize("http://target.test", async () => ["8.8.8.8", "127.0.0.1"]),
    ).rejects.toThrow();
    let call = 0;
    const resolver = async () => (++call === 1 ? ["8.8.8.8"] : ["127.0.0.1"]);
    expect((await policy.authorize("http://target.test", resolver)).pinnedIp).toBe("8.8.8.8");
    await expect(policy.authorize("http://target.test", resolver)).rejects.toThrow();
    expect(call).toBe(2);
  });
  it("never grants metadata through private exceptions", async () => {
    const config = testPolicy(["http://target.test"]);
    config.privateTargets = [{ hostname: "target.test", cidr: "169.254.0.0/16", port: 80 }];
    await expect(
      new EgressPolicy(config).authorize("http://target.test", async () => ["169.254.169.254"]),
    ).rejects.toThrow();
  });
});
