import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  HUB_DIR,
  MANIFEST_FILENAME,
} from "./constants.js";
import { Manifest, type Manifest as ManifestType } from "./schema.js";
import { ManifestError } from "./errors.js";

export function manifestPath(repoRoot: string): string {
  return join(repoRoot, HUB_DIR, MANIFEST_FILENAME);
}

export function parseManifest(input: unknown): ManifestType {
  const result = Manifest.safeParse(input);
  if (!result.success) {
    throw new ManifestError("Invalid manifest", result.error.issues);
  }
  return result.data;
}

export async function manifestExists(repoRoot: string): Promise<boolean> {
  try {
    await readFile(manifestPath(repoRoot), "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function readManifest(repoRoot: string): Promise<ManifestType> {
  const path = manifestPath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ManifestError(
        `No manifest at ${path}. Generate one before editing this repo.`,
      );
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ManifestError(
      `Manifest at ${path} is not valid JSON: ${(e as Error).message}`,
    );
  }

  return parseManifest(parsed);
}

export async function writeManifest(
  repoRoot: string,
  manifest: ManifestType,
): Promise<void> {
  const dir = join(repoRoot, HUB_DIR);
  await mkdir(dir, { recursive: true });
  const body = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(join(dir, MANIFEST_FILENAME), body, "utf8");
}
