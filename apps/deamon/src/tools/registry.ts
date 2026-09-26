import type { Tool } from "./types";
import { readFileTool } from "./read_file";
import { listDirTool } from "./list_dir";
import { searchTool } from "./search";
import { writeFileTool } from "./write_file";
import { applyPatchTool } from "./apply_patch";
import { runTool } from "./run";
import { gitStatusTool } from "./git_status";
import { gitDiffTool } from "./git_diff";
import { gitRestoreTool } from "./git_restore";
import { gitCommitTool } from "./git_commit";

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
