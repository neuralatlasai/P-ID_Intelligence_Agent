import { access, readFile } from "node:fs/promises";
import path from "node:path";

let cached: { checked: number; ok: boolean } | undefined;
/** Bounded local artifact check catches missing chunks even while the API still responds. */
export async function buildIntegrity(): Promise<boolean> {
  if (process.env.NODE_ENV !== "production") return true;
  if (cached && Date.now() - cached.checked < 5000) return cached.ok;
  // Release files are already deployed by release.mjs; do not trace the workspace into itself.
  const root = path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.PID_BUILD_DIR || ".next");
  let ok = false;
  try {
    const raw = await readFile(path.join(root, "runtime-integrity.json"), "utf8");
    if (raw.length > 1_000_000) return false;
    const files: unknown = JSON.parse(raw);
    if (!Array.isArray(files) || !files.length || files.length > 5000) return false;
    for (const file of files) {
      if (typeof file !== "string") return false;
      const target = path.resolve(/* turbopackIgnore: true */ root, file);
      if (!target.startsWith(root + path.sep)) return false;
      await access(target);
    }
    ok = true;
  } catch {
    ok = false;
  }
  cached = { checked: Date.now(), ok };
  return ok;
}
