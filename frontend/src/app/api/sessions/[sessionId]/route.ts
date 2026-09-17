import { BACKEND_ROUTES, proxySessionRequest } from "@/lib/backend/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ readonly sessionId: string }>;
}

/**
 * Clear the session's conversation history on the backend.
 *
 * The backend clears it through its own session interface; this route only forwards the
 * instruction. A failure is reported rather than assumed, because telling the user their
 * history was cleared when it was not is worse than telling them the attempt failed.
 */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  return proxySessionRequest(request, sessionId, BACKEND_ROUTES.session);
}
