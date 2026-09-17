import { BACKEND_ROUTES, proxyBackend } from "@/lib/backend/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Fixed source operations only; the gateway never resolves corpus paths itself. */
export async function GET(
  request: Request,
  context: { params: Promise<{ segments: string[] }> },
): Promise<Response> {
  const { segments } = await context.params;
  const [operation, ...rest] = segments;
  if (operation === "drawings" && rest.length === 0) {
    const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      return Response.json(
        { error: { message: "Invalid catalog offset" } },
        { status: 400 },
      );
    }
    return proxyBackend(request, BACKEND_ROUTES.canvasCatalog(offset));
  }
  const path = rest.join("/");
  if (
    (operation !== "graph" && operation !== "image" && operation !== "fusion") ||
    !path ||
    path.length > 1024 ||
    path.includes("\0")
  ) {
    return Response.json(
      { error: { message: "Unknown canvas source operation" } },
      { status: 400 },
    );
  }
  return proxyBackend(
    request,
    BACKEND_ROUTES.canvasSource(operation as "graph" | "image" | "fusion", path),
  );
}
