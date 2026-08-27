import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow importing workspace packages directly from source.
  transpilePackages: [
    "@staticforge/schemas",
    "@staticforge/core",
    "@staticforge/database",
  ],
  // Prisma ships a generated client with native engine binaries. Bundling it
  // breaks those lookups, so it stays external and is required at runtime —
  // which is fine, because only the dashboard's server components touch it.
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
  // Workspace packages use NodeNext-style ".js" specifiers that point at ".ts"
  // sources. Teach webpack to resolve ".js" imports to their ".ts" files.
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
