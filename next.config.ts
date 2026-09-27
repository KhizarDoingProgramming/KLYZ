import type { NextConfig } from "next";

/**
 * Baseline response headers for every document, asset and API route.
 *
 * These are deliberately conservative: nothing here changes how the
 * application renders, but together they remove whole classes of
 * problems — clickjacking, MIME sniffing, XSS carried by injected
 * markup, referrer leakage, and drive-by feature access.
 */
function securityHeaders(): { key: string; value: string }[] {
  const isProd = process.env.NODE_ENV === "production";
  const scriptSrc = isProd
    ? "'self' 'unsafe-inline'"
    /* React Refresh and the dev server need eval + the HMR socket. */
    : "'self' 'unsafe-inline' 'unsafe-eval' ws:";
  const connectSrc = isProd ? "'self'" : "'self' ws: wss:";

  const headers: { key: string; value: string }[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    {
      key: "Content-Security-Policy",
      value: [
        "default-src 'self'",
        `script-src ${scriptSrc}`,
        /* styled-jsx and inline design tokens set element styles. */
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src ${connectSrc}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        ...(isProd ? ["upgrade-insecure-requests"] : []),
      ].join("; "),
    },
  ];
  if (isProd) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
  }
  return headers;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(),
      },
    ];
  },
};

export default nextConfig;
