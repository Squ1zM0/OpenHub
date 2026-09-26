import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "./config";
import { ensureRepo } from "./snapshot";

/**
 * A session is one open poll loop scoped to one cloud-side task. The workspace
 * is a git-backed scratch directory the tools operate within. Wiped when the
 * session ends unless OPENHUB_KEEP_SESSION=1.
 */
export class Session {
  readonly id: string;
  readonly workspace: string;
  readonly initializedRepo: boolean;
  private closed = false;

  private constructor(id: string, workspace: string, initializedRepo: boolean) {
    this.id = id;
    this.workspace = workspace;
    this.initializedRepo = initializedRepo;
  }

  static async open(id: string): Promise<Session> {
    const workspace = join(CONFIG_DIR, "sessions", id, "workspace");
    await mkdir(workspace, { recursive: true });
    const initializedRepo = await ensureRepo(workspace);
    return new Session(id, workspace, initializedRepo);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (process.env.OPENHUB_KEEP_SESSION === "1") return;
    const root = join(CONFIG_DIR, "sessions", this.id);
    await rm(root, { recursive: true, force: true });
  }
}
