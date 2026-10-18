import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // In dev, Next's badge sits bottom-left, on top of the composer's + button.
  devIndicators: { position: "bottom-right" },
};

export default withWorkflow(nextConfig);
