import { InvestigationLoader } from "@/components/investigation/InvestigationLoader";
import { createSessionId, isValidSessionId } from "@/lib/session/ids";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Keep the investigation and assistant on the same durable backend session. */
export default async function InvestigationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { session } = await searchParams;
  if (session === undefined) redirect(`/investigation?session=${createSessionId()}`);
  if (typeof session !== "string" || !isValidSessionId(session)) notFound();
  return <InvestigationLoader sessionId={session} />;
}
