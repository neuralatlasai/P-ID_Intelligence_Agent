import { NextResponse, type NextRequest } from "next/server";

import { SESSION_ID_PATTERN } from "@/lib/session/ids";

/**
 * Rejects a malformed session address before any rendering begins.
 *
 * This is the framework's proxy convention (formerly `middleware`), which runs at the edge
 * of the request, ahead of routing and rendering.
 *
 * The session page also validates its parameter, but by the time a Server Component runs
 * the response has already begun streaming and its status is fixed at 200. Calling
 * `notFound()` there produces the right *page* with the wrong *status* — a soft 404, which
 * lies to anything that reads status codes rather than prose.
 *
 * The proxy runs before the response starts, so it is the one place that can answer 404
 * and mean it. It also means a malformed path costs no rendering work at all.
 *
 * The page keeps its own check as a last line of defence: if the matcher below is ever
 * narrowed, the page must still refuse rather than open a session on a bad identifier.
 */

/** The dead-end page. Deliberately minimal — it is an error, not a product surface. */
const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Session address not found</title>
    <style>
      body {
        margin: 0;
        padding: 3rem 1.5rem;
        background: #f4f6fb;
        color: #15202e;
        font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      main { max-width: 60ch; margin-inline: auto; }
      h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
      p { color: #4a5668; margin: 0 0 1.5rem; }
      a { color: #1c4fb5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Session address not found</h1>
      <p>
        A session address is 1 to 128 characters of letters, digits, dots, underscores or
        hyphens, beginning with a letter or digit. This one is not, so there is nothing to
        open.
      </p>
      <a href="/">Start a new session</a>
    </main>
  </body>
</html>
`;

export default function proxy(request: NextRequest): NextResponse {
  const match = /^\/s\/([^/]+)\/?$/.exec(request.nextUrl.pathname);
  if (!match?.[1]) {
    return NextResponse.next();
  }

  // The path segment is percent-encoded. Decoding is what exposes an attempt such as
  // `..%2Fescape`, which is a traversal wearing an encoding.
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    return notFoundResponse();
  }

  return SESSION_ID_PATTERN.test(sessionId) ? NextResponse.next() : notFoundResponse();
}

function notFoundResponse(): NextResponse {
  return new NextResponse(NOT_FOUND_PAGE, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

export const config = {
  // Session addresses only. The gateway routes, static assets and the root redirect are
  // untouched, so the proxy costs nothing on the paths that matter.
  //
  // `:path*` rather than `:sessionId` so that a nested path under /s/ is matched too: a
  // request such as /s/a/b must be refused rather than fall through unchecked.
  matcher: ["/s/:path*"],
};
