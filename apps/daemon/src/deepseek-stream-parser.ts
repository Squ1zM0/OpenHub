/**
 * Parser for DeepSeek's streaming patch protocol.
 *
 * The web app does NOT stream plain text deltas. It streams a sequence of
 * patch frames over SSE, and the client reassembles the message from them.
 * There are four frame shapes:
 *
 *   1. Full state   {"v":{"response":{"fragments":[...]}}}
 *      Resets the document. Emitted once at the start of a message and
 *      occasionally after (e.g. on regeneration).
 *
 *   2. Path patch   {"p":"response/fragments/-1/content","v":"你"}
 *      Sets the "current path" for subsequent value deltas. Usually points
 *      at the content field of the last fragment.
 *
 *   3. Value delta  {"v":"1"}  {"v":"Hello"}
 *      This is where the actual text lives. It's a bare string with no
 *      other keys. Appended to whatever the current path points to.
 *
 *   4. Field merge  {"updated_at":1789977769}
 *      Frame-level fields that belong on the root object. Not message
 *      content.
 *
 * The trap: frames 3 and 4 look identical when only `v` is present. The
 * disambiguation is the currentPath — deltas only count as message content
 * when the current path ends in "/content". Before any path patch, bare
 * `v` strings are just field assignments we don't care about.
 *
 * Ported from dubridge (MIT). See https://github.com/anthropics/dubridge
 * for the reference implementation.
 */

export interface ParserResult {
  /** Text to append to the message, or null if this frame produced none. */
  delta: string | null;
  /** True if this frame reset the document (full state). */
  reset?: boolean;
}

export class DeepSeekStreamParser {
  private currentPath: string | null = null;
  private firstFragmentSeen = false;

  /**
   * Feed one decoded SSE data frame. Returns the delta (if any) it
   * contributed to the message body.
   *
   * The frame is the JSON object parsed from one `data: ...` line. Callers
   * are responsible for the SSE envelope — split on newlines, strip the
   * `data: ` prefix, JSON.parse, pass the result here.
   */
  ingest(frame: unknown): ParserResult {
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      return { delta: null };
    }

    const obj = frame as Record<string, unknown>;

    // Frame 1: full state. `v` is an object containing `response`.
    if (
      "v" in obj &&
      typeof obj.v === "object" &&
      obj.v !== null &&
      !Array.isArray(obj.v)
    ) {
      const v = obj.v as Record<string, unknown>;
      if ("response" in v) {
        // Reset parser state. The client rendered the fragments from scratch.
        // We do NOT try to extract historical text from this frame — the
        // full state contains the entire conversation, and we only want the
        // *new* deltas that follow. The generator that drives this parser
        // knows which assistant message it's targeting.
        this.currentPath = null;
        this.firstFragmentSeen = false;
        return { delta: null, reset: true };
      }
    }

    // Frame 2: path patch. Has both `p` and `v`.
    if ("p" in obj && typeof obj.p === "string") {
      this.currentPath = obj.p;
      if (obj.p.endsWith("/content") || obj.p.endsWith("/content/-1")) {
        this.firstFragmentSeen = true;
      }
      // A path patch may also carry an initial value for that path. If it
      // does, and the path is a content path, that's a delta too.
      if (
        this.isContentPath(obj.p) &&
        typeof obj.v === "string" &&
        obj.v.length > 0
      ) {
        return { delta: obj.v };
      }
      return { delta: null };
    }

    // Frame 3: bare value delta. `v` is a string, and there are no other
    // meaningful keys (excluding bookkeeping fields the app sometimes adds).
    if ("v" in obj && typeof obj.v === "string") {
      if (!this.isContentPath(this.currentPath)) {
        // We haven't been told where content lives yet. Ignore.
        return { delta: null };
      }
      return { delta: obj.v };
    }

    // Frame 4: field merge. No `v`, no `p`, just root-level keys.
    // Ignored entirely — these never carry message content.
    return { delta: null };
  }

  /**
   * True when the current path is a content path — the field the app
   * appends streamed characters to. Handles both the direct form
   * ("response/fragments/-1/content") and versioned forms that DeepSeek
   * occasionally emits.
   */
  private isContentPath(path: string | null): boolean {
    if (!path) return false;
    if (path.endsWith("/content")) return true;
    if (/\/content(-[0-9]+)?$/.test(path)) return true;
    return false;
  }

  /** Reset all state. Called between turns. */
  reset(): void {
    this.currentPath = null;
    this.firstFragmentSeen = false;
  }
}

/**
 * Parse a raw SSE line into a frame object. Returns null for lines that
 * aren't data frames (comments, blank lines, "event:" headers).
 */
export function parseSSELine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("data:")) return null;

  const payload = trimmed.slice(5).trim();
  if (payload.length === 0) return null;
  if (payload === "[DONE]") return null;

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
