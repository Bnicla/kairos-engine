import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine is imported as TS source from packages/engine via tsconfig paths.
  transpilePackages: ["@kairos/engine"],
  experimental: {
    serverActions: {
      // The Settings data-import accepts a zip of a whole local Kairos tree.
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
