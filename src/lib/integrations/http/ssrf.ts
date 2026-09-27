import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { EngineError } from "@/lib/engine/types";
import { HTTP_ERRORS, integrationError } from "../errors";

/**
 * SSRF guard for outbound HTTP.
 *
 * Every request — and every redirect hop — must clear three checks:
 * scheme/credentials, the hostname allowlist (when `KLYZ_HTTP_ALLOW_HOSTS`
 * is set), and the resolved addresses (no private, loopback, link-local
 * or otherwise non-public target unless explicitly allowed for local dev).
 * Name resolution goes through a validating `dns.lookup` so a public
 * hostname cannot re-resolve to an internal address.
 */

export interface UrlPolicy {
  /** Lowercase `host`, `host:port` or `*.suffix` entries. Empty = any public host. */
  allowHosts: string[];
  /** Allow loopback/private targets — development only. */
  allowPrivate: boolean;
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export function targetBlocked(reason: string): EngineError {
  return integrationError(
    HTTP_ERRORS.blockedTarget,
    "That request target is not allowed.",
    {
      detail: reason,
      hint: "Point the node at a public host, or widen KLYZ_HTTP_ALLOW_HOSTS for local development.",
      remediation: { label: "Inspect configuration", kind: "inspect" },
    },
  );
}

export function invalidUrl(reason: string): EngineError {
  return integrationError(HTTP_ERRORS.urlInvalid, "The URL is not usable.", {
    detail: reason,
    hint: "Use an absolute http:// or https:// URL without embedded credentials.",
  });
}

/** Parse + pre-validate a target URL (scheme, no userinfo, allowlist, literal IPs). */
export function assertTarget(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalidUrl("The value is not a valid absolute URL.");
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw invalidUrl(`Scheme "${url.protocol}" is not supported — use http: or https:.`);
  }
  if (url.username || url.password) {
    throw invalidUrl("Credentials in the URL are not allowed — use the auth settings instead.");
  }
  assertHostnameAllowed(url.hostname, url.port || url.protocol.slice(0, -1), policy);
  return url;
}

/** Allowlist check plus a literal-IP private-range check (pre-DNS). */
export function assertHostnameAllowed(
  hostname: string,
  port: string,
  policy: UrlPolicy,
): void {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostAllowed(host, port, policy)) {
    throw targetBlocked(
      `"${host}" is not in the configured allowlist (KLYZ_HTTP_ALLOW_HOSTS).`,
    );
  }
  if (isIpLiteral(host) && isPrivateAddress(host) && !policy.allowPrivate) {
    throw targetBlocked(`"${host}" resolves to a private network address.`);
  }
}

function hostAllowed(host: string, port: string, policy: UrlPolicy): boolean {
  if (policy.allowHosts.length === 0) return true;
  return policy.allowHosts.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry === "*" ) return true;
    if (entry === host) return true;
    if (entry === `${host}:${port}`) return true;
    if (entry.startsWith("*.")) return host.endsWith(entry.slice(1));
    return false;
  });
}

export function isIpLiteral(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved space. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!ip) return true;
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  if (ip.includes(":")) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

function isPrivateIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return true;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(value: string): boolean {
  if (value === "::1" || value === "::") return true;
  if (/^f[cd]/.test(value)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(value)) return true; // fe80::/10 link-local
  if (value.startsWith("ff")) return true; // multicast
  if (value.startsWith("2001:db8")) return true; // documentation
  return false;
}

/**
 * `dns.lookup` replacement: resolves every address first and refuses
 * non-public results. Returned in the shape `http.request` expects.
 */
export function safeLookup(policy: UrlPolicy) {
  return function lookup(
    hostname: string,
    options: unknown,
    callback: (err: Error | null, address?: string | LookupAddress[], family?: number) => void,
  ): void {
    let done = callback;
    let opts: Record<string, unknown> = {};
    if (typeof options === "function") {
      done = options as typeof callback;
    } else {
      opts = (options ?? {}) as Record<string, unknown>;
    }
    dnsLookup(
      hostname,
      { ...(opts as object), all: true } as never,
      (error, addresses) => {
        if (error) {
          done(error);
          return;
        }
        const list = Array.isArray(addresses)
          ? addresses
          : [{ address: String(addresses), family: 4 }];
        for (const entry of list) {
          if (isPrivateAddress(entry.address) && !policy.allowPrivate) {
            done(
              targetBlocked(
                `"${hostname}" resolves to a private address (${entry.address}).`,
              ),
            );
            return;
          }
        }
        if (opts.all) {
          done(null, list);
          return;
        }
        const first = list[0];
        if (!first) {
          done(targetBlocked(`"${hostname}" resolved to no addresses.`));
          return;
        }
        done(null, first.address, first.family);
      },
    );
  };
}
