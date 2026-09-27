/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  // Workspace packages are compiled to dist/ by `turbo run build` before
  // this app builds (dependsOn: ["^build"] in turbo.json). They resolve as
  // normal JavaScript — no transpilePackages needed, no extension aliasing
  // needed, no webpack resolve overrides needed.
  //
  // This replaces the previous approach of shipping TypeScript source as
  // the package entry point and asking webpack to resolve `.js` specifiers
  // to `.ts` files across a pnpm symlink boundary. That boundary is where
  // resolution breaks, and it isn't something this config can influence.

  // Browser driver packages use dynamic requires and optional native deps.
  // Bundling them breaks. Leave them as runtime requires resolved from
  // node_modules.
  //
  // Both must also be direct dependencies of apps/web — otherwise they live
  // in the pnpm store and aren't resolvable from the app directory.
  serverExternalPackages: ["playwright-core", "puppeteer-core"],
};
