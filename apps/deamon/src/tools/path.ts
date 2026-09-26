import { resolve, relative, isAbsolute } from "node:path";

/**
 * Resolve a user-supplied path against the workspace, refusing escapes.
 * Tool inputs come from the cloud and must never traverse outside.
 *
 * Note: this guards against `..` traversal but not symlink escapes. A
 * follow-up pass will add `fs.realpath` verification for symlink safety.
 */
export function safeResolve(workspace: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(workspace, p);
  const rel = relative(workspace, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return abs;
}
