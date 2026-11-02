// Cloudflare Worker that fronts the Docker container. Every request is proxied to the container,
// which serves both the frontend and the /api/score endpoint. The container is stateless, so any
// instance can take any request.
import { Container, getRandom } from "@cloudflare/containers";

interface Env {
  INTENT_CONTAINER: DurableObjectNamespace<IntentContainer>;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL?: string;
  APP_URL?: string;
  CONTAINER_INSTANCES?: string;
  LLM_TIMEOUT_MS?: string;
  MAX_FILE_MB?: string;
  MAX_TOTAL_MB?: string;
  RATE_LIMIT_PER_10MIN?: string;
}

export class IntentContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "15m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Pass Worker secrets and vars into the container as environment variables.
    const vars: Record<string, string> = {};
    for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "APP_URL", "LLM_TIMEOUT_MS", "MAX_FILE_MB", "MAX_TOTAL_MB", "RATE_LIMIT_PER_10MIN"] as const) {
      const v = env[k];
      if (v) vars[k] = v;
    }
    this.envVars = vars;
  }

  override onError(error: unknown) {
    console.error("container error", error);
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const n = Math.max(1, parseInt(env.CONTAINER_INSTANCES || "1", 10) || 1);
    const container = n > 1 ? await getRandom(env.INTENT_CONTAINER, n) : env.INTENT_CONTAINER.getByName("primary");
    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;
