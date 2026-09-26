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
};
