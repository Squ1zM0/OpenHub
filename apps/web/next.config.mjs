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
  // For this to work under pnpm, playwright-core must also be a direct
  // dependency of apps/web (see apps/web/package.json) — otherwise it
  // lives in the pnpm store and isn't resolvable from the app directory.
  serverExternalPackages: ["playwright-core"],

  webpack(config) {
    // Webpack resolves files inside pnpm-symlinked workspace packages using
    // the *package's* resolution context, not the app's. Setting symlinks
    // to false forces webpack to resolve the real path first, so the app's
    // resolver config below applies to the package's files too. Without
    // this, every relative import inside @openhub/* fails to resolve.
    config.resolve.symlinks = false;

    // Try TS extensions first for extensionless relative imports.
    config.resolve.extensions = [
      ".ts",
      ".tsx",
      ...(config.resolve.extensions ?? []).filter(
        (ext) => ext !== ".ts" && ext !== ".tsx",
      ),
    ];

    // Belt-and-suspenders: if any package still has a `.js` specifier
    // pointing at a `.ts` source, teach webpack to try the TS file first.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };

    return config;
  },
};
