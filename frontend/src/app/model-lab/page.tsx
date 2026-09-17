import { redirect } from "next/navigation";

/** The lifecycle opens on its first stage. */
export default function ModelLabPage() {
  redirect("/model-lab/pretraining");
}
