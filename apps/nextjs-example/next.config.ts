import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["pg-ratelimit"],
};

export default nextConfig;
