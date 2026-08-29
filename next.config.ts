import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/**": ["./vault-data/**"],
    "/api/transcode/**": ["./node_modules/ffmpeg-static/**"],
  },
};

export default nextConfig;
