import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", // self-contained server, so the Docker image needs no node_modules
  agentRules: false,
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
};

export default nextConfig;
