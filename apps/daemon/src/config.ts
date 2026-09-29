import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_DIR = join(homedir(), ".openhub");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * Configuration for the local Chromium instance the daemon runs for
 * DeepSeek. When present, the daemon launches a persistent browser on
 * startup, keeps the login alive across restarts, and handles chat jobs
 * by typing into the real DeepSeek UI.
 *
 * Delete this block from config.json to disable chat. Tool execution
 * still works without it.
 */
const DeepSeekBrowserConfig = z.object({
  /**
   * Chromium executable path. If omitted, we search common locations:
   *   macOS:   /Applications/Google Chrome.app/...
   *   Linux:   /usr/bin/google-chrome, /usr/bin/chromium, ...
   *   Windows: C:\Program Files\Google\Chrome\...
   * Also honors $CHROME_PATH if set.
   */
  chrome_path: z.string().optional(),

  /**
   * Persistent user-data directory. The login lives here. Default:
   *   ~/.openhub/chromium-profile
   * Delete the directory to force a fresh login.
   */
  profile_dir: z.string().optional(),

  /**
   * Run a visible Chrome window. Default true — required for the first
   * login, and more reliable against DeepSeek's bot detection. You can
   * minimize the window after the daemon starts; it just has to exist.
   */
  headful: z.boolean().optional(),

  /**
   * How long to wait for a single DeepSeek reply. Default 240000 (4 min).
   * Long replies (DeepThink reasoning, big code blocks) can take a while.
   */
  response_timeout_ms: z.number().int().positive().optional(),
});

const Config = z.object({
  server_url: z.string().url(),
  token: z.string().min(1),
  /**
   * If unset, defaults to os.hostname(). Shown in the dashboard so the user
   * can tell their machines apart.
   */
  daemon_id: z.string().optional(),

  /**
   * Optional. If present, the daemon launches Chromium at startup and
   * services chat jobs. If absent, chat jobs are rejected and only tool
   * calls are handled.
   */
  deepseek_browser: DeepSeekBrowserConfig.optional(),
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
