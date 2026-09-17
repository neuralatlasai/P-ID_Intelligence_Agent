import { notFound } from "next/navigation";

import { ModelLabLoader } from "@/components/modellab/ModelLabLoader";
import { stageById } from "@/lib/modellab/stages";

export const dynamic = "force-dynamic";

/** One stage of the training lifecycle, addressed by its slug so each page is linkable. */
export default async function ModelLabStagePage({
  params,
}: {
  readonly params: Promise<{ readonly stage: string }>;
}) {
  const { stage } = await params;
  const found = stageById(stage);
  if (!found) notFound();
  return <ModelLabLoader stageId={found.id} />;
}
