import type { Job, Result } from "@openhub/protocol";

/**
 * Session + job + result persistence.
 *
 * The in-memory implementation below works when everything runs in one
 * Node process (local dev, `next dev`). It is NOT correct on Vercel, where
 * /api/poll and /api/result may land on different function instances and
 * share no memory. Production requires a persistent store — Vercel KV or
 * Redis. The interface is designed so that swap is a one-line change in
 * store-singleton.ts.
 */
export interface SessionStore {
  createSession(sessionId: string): Promise<void>;
  sessionExists(sessionId: string): Promise<boolean>;
  listSessions(): Promise<string[]>;
  deleteSession(sessionId: string): Promise<void>;

  enqueueJob(sessionId: string, job: Job): Promise<void>;
  dequeueJob(sessionId: string): Promise<Job | null>;

  saveResult(result: Result): Promise<void>;
  getResult(jobId: string): Promise<Result | null>;
}

export class InMemoryStore implements SessionStore {
  private sessions = new Map<string, Set<string>>(); // sessionId -> known jobIds
  private queues = new Map<string, Job[]>();         // sessionId -> pending jobs
  private results = new Map<string, Result>();       // jobId -> result

  async createSession(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async listSessions(): Promise<string[]> {
    return [...this.sessions.keys()];
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.queues.delete(sessionId);
  }

  async enqueueJob(sessionId: string, job: Job): Promise<void> {
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(job);
    this.queues.set(sessionId, queue);
    this.sessions.get(sessionId)?.add(job.job_id);
  }

  async dequeueJob(sessionId: string): Promise<Job | null> {
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  async saveResult(result: Result): Promise<void> {
    this.results.set(result.job_id, result);
  }

  async getResult(jobId: string): Promise<Result | null> {
    return this.results.get(jobId) ?? null;
  }
}
