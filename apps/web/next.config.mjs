/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: [
    "@openhub/agent",
    "@openhub/github",
    "@openhub/manifest",
    "@openhub/protocol",
  ],
  webpack(config) {
    // Resolve `.js` imports to `.ts`/`.tsx` sources. The packages in this
    // monorepo use moduleResolution: "NodeNext", which requires `.js`
    // extensions in source even though the files on disk are `.ts`.
    // Webpack doesn't follow that convention by default.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};
