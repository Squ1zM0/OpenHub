/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: [
    "@openhub/agent",
    "@openhub/github",
    "@openhub/manifest",
    "@openhub/protocol",
  ],

  // Playwright uses dynamic requires and optional native deps. Bundling it
  // breaks. Leave it as a runtime require resolved from node_modules.
  // Requires playwright-core to also be a direct dependency of apps/web
  // (see apps/web/package.json) — otherwise it lives in the pnpm store
  // and isn't resolvable from the app directory.
  serverExternalPackages: ["playwright-core"],

  webpack(config) {
    // Webpack's resolver does not apply `resolve.extensions` to files
    // reached through node_modules symlinks. Workspace packages under
    // pnpm are symlinked, so extensionless relative imports inside them
    // (e.g. `from "./types"`) never resolve, no matter what extensions
    // are configured.
    //
    // `resolve.extensionAlias` runs at the resolver level, before module
    // resolution — it applies to symlinked paths too. This is the
    // documented fix for NodeNext-style packages: source carries `.js`
    // specifiers, and this maps them to the `. thets`/`.tsx` files on disk.
    //
    // For this build to work, the packages must use `.js` extensions in their
    // relative imports. Run the "Restore .js in relative imports" workflow
    // if they currently don't.
    //
    // Reference: CopilotKit PR #5955.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };

    return config;
  },
};
