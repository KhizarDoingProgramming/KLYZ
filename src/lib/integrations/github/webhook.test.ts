import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  deliveryRepository,
  parseGitHubDelivery,
  signGitHubPayload,
  verifyGitHubSignature,
} from "./webhook";

const SECRET = "klyz_test_secret";
const BODY = JSON.stringify({ action: "opened", issue: { number: 42 } });

describe("parseGitHubDelivery", () => {
  it("reads the delivery headers GitHub sends", () => {
    const delivery = parseGitHubDelivery({
      "X-GitHub-Event": "Issues",
      "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      "X-Hub-Signature-256": "sha256=abc",
      "X-GitHub-Hook-ID": "12345",
      "X-GitHub-Repository": "klyz/platform",
      "Content-Type": "application/json",
    });
    expect(delivery.event).toBe("issues");
    expect(delivery.deliveryId).toBe("72d3162e-cc78-11e3-81ab-4c9367dc0958");
    expect(delivery.signature).toBe("sha256=abc");
    expect(delivery.hookId).toBe("12345");
    expect(delivery.repository).toBe("klyz/platform");
    expect(delivery.contentType).toBe("application/json");
  });

  it("takes the first value when a header arrives twice", () => {
    const delivery = parseGitHubDelivery({
      "x-github-event": ["push", "issues"],
      "x-github-delivery": ["first", "second"],
    });
    expect(delivery.event).toBe("push");
    expect(delivery.deliveryId).toBe("first");
  });

  it("returns empty values rather than throwing when nothing is sent", () => {
    const delivery = parseGitHubDelivery({});
    expect(delivery).toMatchObject({
      event: "",
      deliveryId: "",
      signature: null,
      hookId: null,
      repository: null,
      contentType: null,
    });
  });
});

describe("verifyGitHubSignature", () => {
  it("accepts a signature over the exact bytes sent", () => {
    const signature = signGitHubPayload(BODY, SECRET);
    expect(verifyGitHubSignature(Buffer.from(BODY), signature, SECRET)).toBe(true);
    expect(verifyGitHubSignature(BODY, signature, SECRET)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret and a stray algorithm", () => {
    const signature = signGitHubPayload(BODY, SECRET);
    expect(verifyGitHubSignature(`${BODY} `, signature, SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, signature, "not_the_secret")).toBe(false);
    expect(verifyGitHubSignature(BODY, signature.replace("sha256=", "sha1="), SECRET)).toBe(
      false,
    );
  });

  it("rejects malformed or absent signatures without throwing", () => {
    expect(verifyGitHubSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, "sha256=", SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, "nonsense", SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, "sha256=zzzz", SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, signGitHubPayload(BODY, SECRET), "")).toBe(false);
  });

  it("signs and verifies the same way GitHub does", () => {
    const expected = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;
    expect(signGitHubPayload(BODY, SECRET)).toBe(expected);
  });
});

describe("deliveryRepository", () => {
  it("accepts owner/name and rejects anything else", () => {
    expect(deliveryRepository("klyz/platform")).toBe("klyz/platform");
    expect(deliveryRepository("klyz/platform.git")).toBe("klyz/platform.git");
    expect(deliveryRepository("platform")).toBeNull();
    expect(deliveryRepository("klyz/platform/extra")).toBeNull();
    expect(deliveryRepository("")).toBeNull();
    expect(deliveryRepository(null)).toBeNull();
  });
});
