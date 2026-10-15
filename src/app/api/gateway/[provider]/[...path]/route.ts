import { handleGateway } from "@/lib/llm/gateway";
import { gatewayHooks } from "@/lib/llm/gateway-hooks";

// Model calls can stream for minutes; each call is its own request through the gateway.
export const maxDuration = 300;

type Ctx = { params: Promise<{ provider: string; path: string[] }> };

export async function POST(req: Request, ctx: Ctx) {
  return handleGateway(req, await ctx.params, gatewayHooks);
}

export async function GET(req: Request, ctx: Ctx) {
  return handleGateway(req, await ctx.params, gatewayHooks);
}
