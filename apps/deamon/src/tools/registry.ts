import type { Tool } from "./types.js";
import { readFileTool } from "./read_file.js";
import { listDirTool } from "./list_dir.js";
import { searchTool } from "./search.js";
import { writeFileTool } from "./write_file.js";
import { applyPatchTool } from "./apply_patch.js";
import { runTool } from "./run.js";
import { gitStatusTool } from "./git_status.js";
import { gitDiffTool } from "./git_diff.js";
import { gitRestoreTool } from "./git_restore.js";
import { gitCommitTool } from "./git_commit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tools: Record<string, Tool<any, any>> = {
  [readFileTool.name]: readFileTool,
  [listDirTool.name]: listDirTool,
  [searchTool.name]: searchTool,
  [writeFileTool.name]: writeFileTool,
  [applyPatchTool.name]: applyPatchTool,
  [runTool.name]: runTool,
  [gitStatusTool.name]: gitStatusTool,
  [gitDiffTool.name]: gitDiffTool,
  [gitRestoreTool.name]: gitRestoreTool,
  [gitCommitTool.name]: gitCommitTool,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTool(name: string): Tool<any, any> | undefined {
  return tools[name];
}
