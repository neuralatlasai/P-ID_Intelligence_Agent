import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell/AppShell";
import { isValidSessionId } from "@/lib/session/ids";

interface PageProps {
  readonly params: Promise<{ readonly sessionId: string }>;
}

/**
 * The session route.
 *
 * The identifier lives in the URL, which makes the page refresh-safe and shareable and
 * keeps session identity out of opaque global state.
 *
 * The identifier is validated in three places, and each is there for a different reason.
 * The proxy refuses a malformed address before rendering begins, which is the only place
 * that can return a genuine 404 status. This check is the last line of defence, in case
 * that matcher is ever narrowed. The gateway validates again before anything reaches the
 * network.
 */
export default async function SessionPage({ params }: PageProps) {
  const { sessionId } = await params;

  if (!isValidSessionId(sessionId)) {
    notFound();
  }

  return (
    <AppShell
      sessionId={sessionId}
      productName={process.env.NEXT_PUBLIC_PRODUCT_NAME ?? "P&ID Intelligence"}
    />
  );
}
