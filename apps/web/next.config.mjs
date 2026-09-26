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
  serverExternalPackages: ["playwright-core"],

  webpack(config) {
    // Webpack does not automatically resolve extensionless imports inside
    // workspace packages to `.ts`/`.tsx` sources. The `transpilePackages`
    // option processes the code, but the resolver still needs to be told
    // which extensions to try.
    config.resolve.extensions = [
      ".ts",
      ".tsx",
      ...(config.resolve.extensions ?? []).filter(
        (ext) => ext !== ".ts" && ext !== ".tsx",
      ),
    ];

    // Belt-and-suspenders: if any package still has a `.js` specifier
    // pointing at a `.ts` source, this teaches webpack to try the TS
    // file first.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };

    return config;
  },
};
