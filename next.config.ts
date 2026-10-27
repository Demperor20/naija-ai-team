import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Keep ffmpeg-static out of the bundle so routes load it (and its binary)
  // from node_modules at runtime, on Vercel and locally.
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/team": ["./prompts/**/*", "./assets/**/*"],
    "/api/start": ["./prompts/**/*"],
    "/api/whatsapp": ["./prompts/**/*", "./assets/**/*"],
    "/api/upload": ["./prompts/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
