import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow importing workspace packages directly from source.
  transpilePackages: ["@staticforge/schemas", "@staticforge/core"],
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
