import { z } from "zod";

const Env = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
});

export type GitHubEnv = z.infer<typeof Env>;

export function readGitHubEnv(env: NodeJS.ProcessEnv = process.env): GitHubEnv {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`missing GitHub env: ${missing}`);
  }
  return parsed.data;
}
