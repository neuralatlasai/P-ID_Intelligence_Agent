import { CanvasLoader } from "@/components/canvas/CanvasLoader";
import { createSessionId, isValidSessionId } from "@/lib/session/ids";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const WORKSPACE_VIEWS = ["Canvas", "Assets", "Files", "Simulation", "Twin"];

/** The existing backend retains ownership of every agent conversation. */
export default async function CanvasPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    session?: string | string[];
    node?: string | string[];
    view?: string | string[];
  }>;
}) {
  const { session, node, view } = await searchParams;
  // Deep links from other pages name a component and a view; both survive the session mint.
  const focus = new URLSearchParams();
  if (typeof node === "string" && /^[\w/.-]{1,128}$/.test(node)) focus.set("node", node);
  if (typeof view === "string" && WORKSPACE_VIEWS.includes(view)) focus.set("view", view);
  // A reload reopens the same backend conversation rather than abandoning its history.
  if (session === undefined) {
    const extra = focus.toString();
    redirect(`/canvas?session=${createSessionId()}${extra ? `&${extra}` : ""}`);
  }
  if (typeof session !== "string" || !isValidSessionId(session)) notFound();
  return (
    <CanvasLoader
      sessionId={session}
      initialNode={focus.get("node") ?? undefined}
      initialView={focus.get("view") ?? undefined}
    />
  );
}
