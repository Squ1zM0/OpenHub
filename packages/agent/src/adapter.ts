import type { Adapter, AdapterResponse, Message, ScriptedResponse } from "./types.js";

/**
 * Scripted adapter for exercising the loop without a real model.
 *
 * The sequence is walked in order. Each entry is either a raw string (always
 * returned on the next call) or an object with a `when_last` regex that gates
 * it on the content of the previous message — useful for branching on
 * whether a tool call succeeded or failed.
 *
 * When the sequence is exhausted, returns a generic final message so the
 * loop terminates cleanly rather than spinning until max_turns.
 */
export class ScriptedAdapter implements Adapter {
  readonly name = "scripted";
  private cursor = 0;
  private readonly seq: ScriptedResponse[];

  constructor(seq: ScriptedResponse[]) {
    this.seq = seq;
  }

  async send(messages: Message[]): Promise<AdapterResponse> {
    const last = messages[messages.length - 1]?.content ?? "";

    while (this.cursor < this.seq.length) {
      const entry = this.seq[this.cursor]!;
      if (typeof entry === "string") {
        this.cursor++;
        return { content: entry };
      }
      if (!entry.when_last || new RegExp(entry.when_last).test(last)) {
        this.cursor++;
        return { content: entry.content };
      }
      // Entry was gated and its gate didn't match — skip it and try the next.
      this.cursor++;
    }

    return { content: "Task complete. No further actions required." };
  }
}

/**
 * Default script used by the web demo route when no script is provided.
 * Exercises write_file → read_file → final.
 */
export function defaultDemoScript(filePath = "notes.txt", content = "hello from openhub"): ScriptedResponse[] {
  return [
    `<tool_call name="write_file">\n${JSON.stringify(
      { path: filePath, content: content + "\n", create_only: true },
      null,
      2,
    )}\n</tool_call>`,
    {
      when_last: `<tool_result name="write_file"`,
      content: `<tool_call name="read_file">\n${JSON.stringify(
        { path: filePath },
        null,
        2,
      )}\n</tool_call>`,
    },
    {
      when_last: `<tool_result name="read_file"`,
      content: `Created ${filePath} and verified its contents. Task complete.`,
    },
  ];
}
