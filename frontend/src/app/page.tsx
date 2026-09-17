import { redirect } from "next/navigation";

import { createSessionId } from "@/lib/session/ids";

export const dynamic = "force-dynamic";

/**
 * The root route.
 *
 * Mints a session identifier and redirects to its address. No backend call happens here:
 * a session exists on the backend once it has a turn, so opening the application creates
 * nothing until a question is actually asked.
 *
 * The redirect is server-side and `force-dynamic`, so each visit gets a fresh session
 * rather than a cached page handing several people the same identifier.
 */
export default function RootPage(): never {
  redirect(`/s/${createSessionId()}`);
}
