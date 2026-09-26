import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_DIR = join(homedir(), ".openhub");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const Config = z.object({
  server_url: z.string().url(),
  token: z.string().min(1),
  /**
   * If unset, defaults to os.hostname(). Shown in the dashboard so the user
   * can tell their machines apart.
   */
  daemon_id: z.string().optional(),
});
export type Config = z.infer<typeof Config>;

export async function readConfig(): Promise<Config | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return Config.parse(JSON.parse(raw));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeConfig(cfg: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
