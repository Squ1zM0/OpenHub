import type { Tool } from "./types.js";
import { readFileTool } from "./read_file.js";
import { listDirTool } from "./list_dir.js";
import { searchTool } from "./search.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tools: Record<string, Tool<any, any>> = {
  [readFileTool.name]: readFileTool,
  [listDirTool.name]: listDirTool,
  [searchTool.name]: searchTool,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTool(name: string): Tool<any, any> | undefined {
  return tools[name];
}
