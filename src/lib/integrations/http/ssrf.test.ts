import { describe, expect, it } from "vitest";
import {
  assertTarget,
  isPrivateAddress,
  isIpLiteral,
  safeLookup,
  type UrlPolicy,
} from "./ssrf";

const publicPolicy: UrlPolicy = { allowHosts: [], allowPrivate: false };
const openPolicy: UrlPolicy = { allowHosts: [], allowPrivate: true };

function lookupAsync(policy: UrlPolicy, hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    safeLookup(policy)(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve((addresses as { address: string }[]).map((entry) => entry.address));
    });
  });
}

describe("ssrf — address classification", () => {
  it("treats loopback, private, link-local, CGNAT and reserved space as private", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "198.18.0.1",
      "255.255.255.255",
      "224.0.0.1",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:192.168.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("leaves public addresses alone", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("recognises IP literals", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("localhost")).toBe(false);
    expect(isIpLiteral("api.example.com")).toBe(false);
  });
});

describe("ssrf — target validation", () => {
  it("accepts a normal public https URL", () => {
    const url = assertTarget("https://api.example.com/v1/users?limit=1", publicPolicy);
    expect(url.host).toBe("api.example.com");
  });

  it("rejects unsupported schemes", () => {
    for (const raw of ["ftp://example.com/x", "file:///etc/passwd", "gopher://x/", "not a url"]) {
      expect(() => assertTarget(raw, publicPolicy)).toThrowError(/HTTP_URL_INVALID|URL/);
    }
    try {
      assertTarget("ftp://example.com", publicPolicy);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("HTTP_URL_INVALID");
    }
  });

  it("rejects credentials embedded in the URL", () => {
    try {
      assertTarget("https://user:pass@example.com/", publicPolicy);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("HTTP_URL_INVALID");
    }
  });

  it("blocks private IP literals unless the policy allows them", () => {
    for (const raw of [
      "http://127.0.0.1:8080/",
      "http://10.1.2.3/",
      "http://192.168.0.10/",
      "http://[::1]:3000/",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      try {
        assertTarget(raw, publicPolicy);
        throw new Error(`should have blocked ${raw}`);
      } catch (error) {
        expect((error as { code?: string }).code, raw).toBe("HTTP_BLOCKED_TARGET");
      }
    }
    expect(assertTarget("http://127.0.0.1:8080/", openPolicy).host).toBe("127.0.0.1:8080");
  });

  it("enforces the host allowlist", () => {
    const policy: UrlPolicy = { allowHosts: ["api.example.com", "*.cdn.example.com"], allowPrivate: true };
    expect(assertTarget("https://api.example.com/x", policy).host).toBe("api.example.com");
    expect(assertTarget("https://images.cdn.example.com/x", policy).host).toBe(
      "images.cdn.example.com",
    );
    try {
      assertTarget("https://evil.test/x", policy);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("HTTP_BLOCKED_TARGET");
    }
    /* `host:port` entries are exact */
    expect(assertTarget("http://localhost:3000/", { allowHosts: ["localhost:3000"], allowPrivate: true }).port).toBe("3000");
  });
});

describe("ssrf — validating DNS lookup", () => {
  it("refuses a hostname that resolves to a private address", async () => {
    await expect(lookupAsync(publicPolicy, "localhost")).rejects.toMatchObject({
      code: "HTTP_BLOCKED_TARGET",
    });
  });

  it("allows the same hostname when private targets are permitted", async () => {
    const addresses = await lookupAsync(openPolicy, "localhost");
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((address) => isPrivateAddress(address))).toBe(true);
  });
});
