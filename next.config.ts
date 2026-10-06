import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Pinned explicitly: a stray package-lock.json in a parent directory otherwise makes
    // Turbopack warn about ambiguous project root on every dev start.
    root: path.resolve(import.meta.dirname),
  },
};

export default nextConfig;
