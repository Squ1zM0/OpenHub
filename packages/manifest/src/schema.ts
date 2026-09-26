import { z } from "zod";
import { MANIFEST_VERSION } from "./constants";

/**
 * Project kind — the top-level shape of the repo. Drives which capability
 * set is valid, which entry points are required, and how the preview loop
 * verifies the result.
 */
export const ProjectKind = z.enum([
  "web-app",
  "api",
  "worker",
  "static",
  "cli",
]);
export type ProjectKind = z.infer<typeof ProjectKind>;

export const PackageManager = z.enum(["pnpm", "npm", "yarn", "bun"]);
export type PackageManager = z.infer<typeof PackageManager>;

export const Stack = z.object({
  framework: z.string().optional(),
  runtime: z.string().optional(),
  package_manager: PackageManager.optional(),
  language: z.enum(["ts", "js"]).optional(),
});
export type Stack = z.infer<typeof Stack>;

/**
 * Capability name format: dot.separated.lowercase.
 * e.g. "storage.kv", "auth.session", "email.transactional"
 */
export const CapabilityName = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, {
    message: "capability name must be dot.separated.lowercase with ≥2 segments",
  });
export type CapabilityName = z.infer<typeof CapabilityName>;

export const CapabilityBinding = z.object({
  name: CapabilityName,
  adapter: z.string().min(1),
  /** Env var the adapter reads its config from, if any. */
  bind: z.string().optional(),
  /** Adapter-specific config. Shape is validated by the capability itself. */
  config: z.record(z.string(), z.unknown()).optional(),
});
export type CapabilityBinding = z.infer<typeof CapabilityBinding>;

export const HttpMethod = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type HttpMethod = z.infer<typeof HttpMethod>;

export const Route = z.object({
  path: z.string().startsWith("/"),
  file: z.string().min(1),
  kind: z.enum(["page", "api", "layout", "middleware", "worker"]),
  /** Only meaningful for `kind: "api"`. */
  methods: z.array(HttpMethod).optional(),
});
export type Route = z.infer<typeof Route>;

export const FieldType = z.enum([
  "uuid",
  "text",
  "int",
  "float",
  "bool",
  "timestamp",
  "json",
  "bytes",
]);
export type FieldType = z.infer<typeof FieldType>;

export const FieldSpec = z.union([
  FieldType,
  z.object({
    type: FieldType,
    optional: z.boolean().optional(),
    unique: z.boolean().optional(),
    default: z.unknown().optional(),
  }),
]);
export type FieldSpec = z.infer<typeof FieldSpec>;

export const DataModel = z.object({
  name: z.string().min(1),
  /** Capability name — e.g. "storage.kv", "storage.postgres". */
  store: CapabilityName,
  fields: z.record(z.string(), FieldSpec),
  primary_key: z.string().default("id"),
});
export type DataModel = z.infer<typeof DataModel>;

export const EntryPoints = z.object({
  dev: z.string().optional(),
  build: z.string().optional(),
  test: z.string().optional(),
  start: z.string().optional(),
  lint: z.string().optional(),
});
export type EntryPoints = z.infer<typeof EntryPoints>;

/**
 * The manifest. `.hub/MANIFEST.json` in every hub-native repo.
 *
 * The agent reads this before touching anything. It is the machine-readable
 * ground truth of what the repo is and how it's wired.
 */
export const Manifest = z.object({
  manifest_version: z.literal(MANIFEST_VERSION),
  name: z.string().min(1),
  description: z.string().optional(),
  kind: ProjectKind,
  stack: Stack.default({}),
  capabilities: z.array(CapabilityBinding).default([]),
  routes: z.array(Route).default([]),
  data_models: z.array(DataModel).default([]),
  entry_points: EntryPoints.default({}),
  env_required: z.array(z.string()).default([]),
  /** Free-form. Namespaced by tool. Reserved for future use. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Manifest = z.infer<typeof Manifest>;

/** Input type — what callers can pass in before defaults are applied. */
export type ManifestInput = z.input<typeof Manifest>;
