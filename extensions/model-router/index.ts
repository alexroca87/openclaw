/**
 * OpenClaw Model Router Plugin
 *
 * Routes each message to the cheapest capable LLM model based on
 * heuristic complexity classification. Uses the before_model_resolve
 * hook to override provider/model before every LLM call.
 *
 * Tier distribution target: Simple ~80%, Complex ~15%, Hard ~5%
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Types & Configuration
// ---------------------------------------------------------------------------

type TierName = "simple" | "complex" | "hard" | "background";

type TierConfig = {
  model: string;
  provider: string;
  label: string;
};

type RouterConfig = {
  tiers: Record<TierName, TierConfig>;
  complexWordThreshold: number;
  hardWordThreshold: number;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function resolveConfig(pluginConfig?: Record<string, unknown>): RouterConfig {
  const cfg = pluginConfig ?? {};
  const provider =
    str(cfg.provider) ||
    process.env.MODEL_ROUTER_PROVIDER ||
    "openrouter";

  return {
    tiers: {
      simple: {
        model:
          str(cfg.simpleModel) ||
          process.env.MODEL_ROUTER_SIMPLE ||
          "google/gemini-2.0-flash-exp",
        provider,
        label: "Gemini Flash",
      },
      complex: {
        model:
          str(cfg.complexModel) ||
          process.env.MODEL_ROUTER_COMPLEX ||
          "anthropic/claude-haiku-4-5",
        provider,
        label: "Claude Haiku 4.5",
      },
      hard: {
        model:
          str(cfg.hardModel) ||
          process.env.MODEL_ROUTER_HARD ||
          "anthropic/claude-sonnet-4",
        provider,
        label: "Claude Sonnet",
      },
      background: {
        model:
          str(cfg.backgroundModel) ||
          process.env.MODEL_ROUTER_BACKGROUND ||
          "deepseek/deepseek-chat",
        provider,
        label: "DeepSeek V3",
      },
    },
    complexWordThreshold: num(cfg.complexWordThreshold) ?? 100,
    hardWordThreshold: num(cfg.hardWordThreshold) ?? 50,
  };
}

// ---------------------------------------------------------------------------
// Intent Classifier (heuristic, no LLM call, <2ms)
// ---------------------------------------------------------------------------

const BACKGROUND_PATTERNS = [
  /\b(summarize|summary|digest|recap|tl;?dr)\b/i,
  /\b(resumen|resumir|resumiendo|recapitular)\b/i,
];

const HARD_PATTERNS = [
  /\b(step[- ]by[- ]step|in detail|comprehensive|thorough|essay|article|report|whitepaper)\b/i,
  /\b(paso a paso|en detalle|completo|exhaustivo|ensayo|art[ií]culo|reporte)\b/i,
];

const COMPLEX_PATTERNS = [
  /\b(explain|analyze|compare|implement|write code|debug|refactor|create a|build a|design|plan|strategy)\b/i,
  /\b(explica|analiza|compara|implementa|escribe c[oó]digo|crea un|dise[nñ]a|planifica|estrategia)\b/i,
  /```[\s\S]*```/,
  /\b(function|class|import|export|const|let|var|async|await|def |SELECT |FROM |WHERE )\b/,
];

function classifyIntent(prompt: string, config: RouterConfig): TierName {
  const wordCount = prompt.split(/\s+/).length;

  if (BACKGROUND_PATTERNS.some((p) => p.test(prompt))) return "background";

  if (
    HARD_PATTERNS.some((p) => p.test(prompt)) &&
    wordCount > config.hardWordThreshold
  ) {
    return "hard";
  }

  if (COMPLEX_PATTERNS.some((p) => p.test(prompt))) return "complex";
  if (wordCount > config.complexWordThreshold) return "complex";

  return "simple";
}

// ---------------------------------------------------------------------------
// Plugin Definition
// ---------------------------------------------------------------------------

const modelRouterPlugin = {
  id: "model-router",
  name: "Model Router",
  description:
    "Routes messages to the cheapest capable model based on complexity",

  register(api: OpenClawPluginApi) {
    // Skip routing if no OpenRouter API key is configured
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      api.logger.warn(
        "model-router: OPENROUTER_API_KEY not set, plugin disabled. " +
          "Set the env var and restart the gateway to enable routing.",
      );
      return;
    }

    const config = resolveConfig(api.pluginConfig);

    api.logger.info(
      `model-router: registered ` +
        `(simple=${config.tiers.simple.model}, ` +
        `complex=${config.tiers.complex.model}, ` +
        `hard=${config.tiers.hard.model}, ` +
        `background=${config.tiers.background.model})`,
    );

    // Route each message to the appropriate model tier
    api.on("before_model_resolve", (event) => {
      const tier = classifyIntent(event.prompt, config);
      const target = config.tiers[tier];

      api.logger.info(
        `[model-router] ${tier} -> ${target.label} | ` +
          `${target.provider}/${target.model} ` +
          `(${event.prompt.length} chars, ` +
          `${event.prompt.split(/\s+/).length} words)`,
      );

      return {
        modelOverride: target.model,
        providerOverride: target.provider,
      };
    });

    // Track token usage per model for cost observability
    api.on("llm_output", (event) => {
      if (!event.usage) return;
      const { input = 0, output = 0, cacheRead = 0 } = event.usage;
      api.logger.info(
        `[model-router] usage: ${event.provider}/${event.model} | ` +
          `in=${input} out=${output} cache=${cacheRead} ` +
          `total=${input + output}`,
      );
    });
  },
};

export default modelRouterPlugin;
