import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@agent-os/ui"],
  turbopack: {
    // Pin the monorepo root explicitly; auto-detection can otherwise pick a
    // stray lockfile above the repo (e.g. ~/package-lock.json).
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
