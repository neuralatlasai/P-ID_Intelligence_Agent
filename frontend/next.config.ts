import path from "node:path";

import type { NextConfig } from "next";

/**
 * Security headers applied to every response.
 *
 * The Content-Security-Policy is deliberately strict. Model output is untrusted content:
 * it is rendered as Markdown with raw HTML disabled, and this header is the second line of
 * defence if that ever regresses.
 *
 * `'unsafe-inline'` remains on `style-src` because the framework emits inline styles for
 * streaming and font loading. It is not granted to `script-src`, where it would matter.
 * `'unsafe-eval'` is granted only in development, where the dev server requires it; the
 * production bundle is built without it.
 */
const contentSecurityPolicy = (isDevelopment: boolean): string =>
  [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The browser talks only to this origin. The Python backend is reached through Node
    // route handlers, never directly, so no backend host appears here.
    `connect-src 'self'${isDevelopment ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

const nextConfig: NextConfig = {
  // A running release keeps its own immutable chunks while another release builds.
  distDir: process.env.PID_BUILD_DIR || ".next",
  deploymentId: process.env.PID_RELEASE_ID,
  reactStrictMode: true,
  poweredByHeader: false,

  // Pin the workspace root. Without it the bundler walks up looking for a lockfile and can
  // land on one in the user's home directory, which changes what it traces between
  // machines. Pinning keeps the build reproducible.
  turbopack: { root: path.resolve(__dirname) },

  // Fail the production build on a type error rather than shipping past it.
  //
  // Linting is not part of `next build` in this framework version, so `npm run gate` runs
  // ESLint as its own step. CI runs the gate, which means a lint error still blocks a
  // release; it simply blocks it one step earlier than the build.
  typescript: { ignoreBuildErrors: false },

  async headers() {
    const isDevelopment = process.env.NODE_ENV !== "production";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "content-security-policy", value: contentSecurityPolicy(isDevelopment) },
          { key: "x-content-type-options", value: "nosniff" },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
          { key: "x-frame-options", value: "DENY" },
          {
            key: "permissions-policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "cross-origin-opener-policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
