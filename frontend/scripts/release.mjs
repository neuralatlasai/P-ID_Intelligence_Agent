import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releases = path.join(root, ".releases");
const [command, ...args] = process.argv.slice(2);
if (command !== "build" && command !== "start") throw new Error("Use build or start");
await mkdir(releases, { recursive: true });
const pointer = path.join(releases, "current.json");
const release =
  command === "build"
    ? { id: `release-${Date.now()}-${randomUUID().slice(0, 8)}` }
    : JSON.parse(await readFile(pointer, "utf8"));
if (!/^release-\d+-[a-f0-9]{8}$/.test(release.id))
  throw new Error("Invalid release identifier");
const buildDir = `.releases/${release.id}`;
if (command === "start") {
  await access(path.join(root, buildDir, "BUILD_ID"));
  if (!process.env.BACKEND_BASE_URL)
    throw new Error("Set BACKEND_BASE_URL before starting the gateway");
}
const child = spawn(
  process.execPath,
  [path.join(root, "node_modules/next/dist/bin/next"), command, ...args],
  {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, PID_BUILD_DIR: buildDir, PID_RELEASE_ID: release.id },
  },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (value) => resolve(value ?? 1));
});
if (code === 0 && command === "build") {
  const entries = await readdir(path.join(root, buildDir), {
    recursive: true,
    withFileTypes: true,
  });
  const required = entries
    .filter((entry) => entry.isFile() && /\.(js|css)$/.test(entry.name))
    .map((entry) =>
      path.relative(path.join(root, buildDir), path.join(entry.parentPath, entry.name)),
    );
  await writeFile(
    path.join(root, buildDir, "runtime-integrity.json"),
    JSON.stringify(required),
  );
  // Publish the pointer only after compilation succeeds; old releases remain recoverable.
  const temporary = path.join(releases, `${release.id}.json`);
  await writeFile(temporary, JSON.stringify(release), { flag: "wx" });
  await rename(temporary, pointer);
  process.stdout.write(`Release ready: ${release.id}\n`);
}
process.exitCode = code;
