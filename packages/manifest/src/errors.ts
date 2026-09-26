import type { ZodIssue } from "zod";

export class ManifestError extends Error {
  readonly issues: readonly ZodIssue[];

  constructor(message: string, issues: readonly ZodIssue[] = []) {
    super(message);
    this.name = "ManifestError";
    this.issues = issues;
  }

  /** Human-readable, one issue per line. Safe to feed back to the agent. */
  format(): string {
    if (this.issues.length === 0) return this.message;
    const lines = this.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "<root>";
      return `  ${path}: ${i.message}`;
    });
    return [this.message, ...lines].join("\n");
  }
}
