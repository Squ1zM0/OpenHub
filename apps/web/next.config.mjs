/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: [
    "@openhub/agent",
    "@openhub/github",
    "@openhub/manifest",
    "@openhub/protocol",
  ],
};
