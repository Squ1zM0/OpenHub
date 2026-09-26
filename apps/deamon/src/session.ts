import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";

/**
 * A session is one open poll loop scoped to one cloud-side task. The workspace
 * is a scratch directory the tools operate within. Wiped when the session ends.
 */
export class Session {
  readonly id: string;
  readonly workspace: string;
  private closed = false;

  private constructor(id: string, workspace: string) {
    this.id = id;
    this.workspace = workspace;
  }

  static async open(id: string): Promise<Session> {
    const workspace = join(CONFIG_DIR, "sessions", id, "workspace");
    await mkdir(workspace, { recursive: true });
    return new Session(id, workspace);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const root = join(CONFIG_DIR, "sessions", this.id);
    await rm(root, { recursive: true, force: true });
  }
}
