import { BACKEND_ROUTES, proxySessionRequest } from "@/lib/backend/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ readonly sessionId: string }>;
}

/**
 * Run one turn without streaming and return the backend's native output items.
 *
 * This is the fallback and test path; the product's primary interaction uses the streaming
 * route. The body travels upstream unchanged: it is an OpenAI Responses input, not a
 * frontend request object, and nothing here wraps or rewrites it.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  return proxySessionRequest(request, sessionId, BACKEND_ROUTES.responses);
}
