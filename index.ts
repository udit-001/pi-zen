import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Configuration ───────────────────────────────────────────────────────────
//
// OpenCode Zen is the OpenCode team's curated AI gateway:
//   https://opencode.ai/zen
//
// This extension registers ONLY the free models. Every free model on Zen is
// served through the OpenAI-compatible Chat Completions endpoint
//   https://opencode.ai/zen/v1/chat/completions
// so we register a single provider with `api: "openai-completions"`.
//
// Get an API key at https://opencode.ai/zen (sign in → billing → copy key), then
// either run `/login pi-zen` inside pi (stores the key in ~/.pi/agent/auth.json),
// or export ZEN_API_KEY="oc_...". Then pick a model via `/model` (pi-zen/*).
//
// We also send the same x-opencode-* headers the opencode CLI sends, so Zen
// treats us as a first-class opencode client (relevant for the free models).

const PROVIDER_ID = "pi-zen";
const PROVIDER_NAME = "OpenCode Zen (Free)";
// ZEN_BASE_URL override lets you route through a proxy / local gateway (and is
// handy for testing). MODELS_URL derives from it.
const BASE_URL = process.env.ZEN_BASE_URL || "https://opencode.ai/zen/v1";
const MODELS_URL = `${BASE_URL}/models`;

const MODEL_CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_OUTPUT_TOKENS = 8_192;

// Mimic the opencode CLI so Zen serves the free models like it does for opencode.
// The x-opencode-client / x-opencode-project / x-opencode-session headers are the
// meaningful signal; User-Agent is best-effort (the OpenAI SDK may override it).
const OPENCODE_CLI_VERSION = "1.17.11";
const OPENCODE_USER_AGENT = `opencode/${OPENCODE_CLI_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`;
// One session id per pi process ("ses_" + 32 lowercase hex), matching the CLI.
const OPENCODE_SESSION_ID = `ses_${randomUUID().replace(/-/g, "")}`;

// ─── Types ───────────────────────────────────────────────────────────────────

type ZenModel = {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
};

type ZenModelConfig = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<
		Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
	>;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: {
		maxTokensField: "max_tokens" | "max_completion_tokens";
		supportsStore: boolean;
		supportsReasoningEffort: boolean;
		supportsDeveloperRole: boolean;
		supportsUsageInStreaming: boolean;
	};
};

// ─── Known free-model metadata ───────────────────────────────────────────────
//
// The live /models endpoint only returns { id, created, owned_by } — no context
// window, max tokens, or reasoning info. So we curate the free models here.
//
// Reasoning config + context/output limits come from the `opencode` provider
// entries on https://models.dev/api.json (authoritative for how Zen serves each
// model). `reasoning` is derived from whether models.dev lists `reasoning_options`
// for the model (its `capabilities.reasoning` is null for these). The
// `thinkingLevelMap` mirrors the opencode CLI's effort levels: null hides a level
// the model doesn't accept; an absent `off` means off is available and sends no
// reasoning param (toggle models). New free models discovered live fall back to
// non-reasoning defaults. All free models have zero cost.

const FREE_MODEL_META: Record<
	string,
	{
		name: string;
		contextWindow?: number;
		maxTokens?: number;
		reasoning?: boolean;
		input?: ("text" | "image")[];
		thinkingLevelMap?: Partial<
			Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
		>;
	}
> = {
	"big-pickle": { name: "Big Pickle (Free)", contextWindow: 128_000, maxTokens: 8_192 },
	// reasoning_options: [toggle, effort(high, max)]
	"deepseek-v4-flash-free": {
		name: "DeepSeek V4 Flash (Free)",
		contextWindow: 200_000,
		maxTokens: 128_000,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
	},
	// reasoning_options: [] (no thinking support)
	// Multimodal: mimo supports image input → used as the vision subagent model.
	"mimo-v2.5-free": {
		name: "MiMo V2.5 (Free)",
		contextWindow: 200_000,
		maxTokens: 32_000,
		input: ["text", "image"],
	},
	// reasoning_options: [toggle, budget_tokens(max: 81920)]
	"qwen3.6-plus-free": {
		name: "Qwen3.6 Plus (Free)",
		contextWindow: 262_144,
		maxTokens: 65_536,
		reasoning: true,
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null },
	},
	// reasoning_options: [toggle]
	"minimax-m3-free": {
		name: "MiniMax M3 (Free)",
		contextWindow: 200_000,
		maxTokens: 32_000,
		reasoning: true,
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null },
	},
	// reasoning_options: [] (no thinking support)
	"nemotron-3-ultra-free": { name: "Nemotron 3 Ultra (Free)", contextWindow: 1_000_000, maxTokens: 128_000 },
	// reasoning_options: [effort(none, high)]
	"north-mini-code-free": {
		name: "North Mini Code (Free)",
		contextWindow: 256_000,
		maxTokens: 64_000,
		reasoning: true,
		thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null },
	},
};

// Hardcoded fallback used when the live endpoint is unreachable so the
// extension still works offline.
const FALLBACK_FREE_IDS = Object.keys(FREE_MODEL_META);

// ─── State ───────────────────────────────────────────────────────────────────

let modelCache: { expiresAt: number; models: ZenModel[] } | null = null;
let hasRegisteredProvider = false;
let hasAutoSelectedModel = false;
let ourModelIds = new Set<string>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Key stored by `/login pi-zen` in auth.json (pi's official credential store). */
function getStoredKey(): string {
	try {
		const auth = JSON.parse(
			readFileSync(join(getAgentDir(), "auth.json"), "utf8"),
		) as Record<string, { type?: string; key?: string }>;
		const cred = auth[PROVIDER_ID];
		if (cred?.type === "api_key" && typeof cred.key === "string" && cred.key) {
			return cred.key;
		}
	} catch {
		// No auth file or unreadable — fall through to env vars.
	}
	return "";
}

function getApiKey(): string {
	// Stored credential (from /login) takes priority, matching pi's own resolution.
	// ZEN_API_KEY is the canonical env name (matches the opencode CLI / our Python
	// client). OPENCODE_API_KEY / OPENCODE_ZEN_API_KEY are accepted as aliases.
	return (
		getStoredKey() ||
		process.env.ZEN_API_KEY ||
		process.env.OPENCODE_API_KEY ||
		process.env.OPENCODE_ZEN_API_KEY ||
		""
	);
}

/** A model is "free" if its id ends in `-free`, or it's the stealth free model. */
function isFreeModel(id: string): boolean {
	const lower = id.toLowerCase();
	return lower === "big-pickle" || lower.endsWith("-free");
}

function humanize(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function toModelConfig(m: ZenModel): ZenModelConfig {
	const meta = FREE_MODEL_META[m.id];
	const reasoning = meta?.reasoning ?? false;
	return {
		id: m.id,
		name: meta?.name ?? `${humanize(m.id)} (Free)`,
		reasoning,
		thinkingLevelMap: meta?.thinkingLevelMap,
		input: meta?.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: meta?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: meta?.maxTokens ?? DEFAULT_OUTPUT_TOKENS,
		compat: {
			// OpenAI-compatible gateways expect `max_tokens` and `system` role.
			maxTokensField: "max_tokens",
			supportsStore: false,
			// Only emit reasoning_effort for models that support thinking.
			supportsReasoningEffort: reasoning,
			supportsDeveloperRole: false,
			supportsUsageInStreaming: false,
		},
	};
}

async function fetchModels(force = false): Promise<ZenModel[]> {
	if (!force && modelCache && modelCache.expiresAt > Date.now()) {
		return modelCache.models;
	}

	// The Zen /models endpoint is public — no API key required to list models.
	const res = await fetch(MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText}`);
	}
	const json = (await res.json()) as { data?: ZenModel[] };
	const all = json.data ?? [];
	const free = all.filter((m) => m?.id && isFreeModel(m.id));

	modelCache = { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models: free };
	return free;
}

// ─── Provider Registration ───────────────────────────────────────────────────

function registerProvider(pi: ExtensionAPI, models: ZenModel[]) {
	hasRegisteredProvider = true;
	ourModelIds = new Set(models.map((m) => m.id));

	// Stable per-project id (sha1 of cwd) so Zen groups usage by project, and a
	// per-process session id — same shape the opencode CLI sends.
	const projectId = createHash("sha1").update(process.cwd()).digest("hex");

	// apiKey is a reference — pi resolves $ZEN_API_KEY at request time, so models
	// register (and show in /models) even before the key is set. Requests only
	// fail (401) once the user actually sends a message without a key.
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: "$ZEN_API_KEY",
		authHeader: true,
		api: "openai-completions",
		// opencode-CLI headers so Zen serves the free models like it does for opencode.
		headers: {
			"User-Agent": OPENCODE_USER_AGENT,
			"x-opencode-client": "cli",
			"x-opencode-project": projectId,
			"x-opencode-session": OPENCODE_SESSION_ID,
		},
		models: models.map(toModelConfig),
	});
}

/** Always register something: the live list, or the static fallback. */
async function refreshAndRegister(pi: ExtensionAPI): Promise<number> {
	let models: ZenModel[] = [];
	try {
		models = await fetchModels(true);
	} catch (err) {
		console.warn(
			`${PROVIDER_ID}: fetch failed (${err instanceof Error ? err.message : String(err)}); using fallback list`,
		);
	}
	if (models.length === 0) {
		models = FALLBACK_FREE_IDS.map((id) => ({ id }));
	}
	registerProvider(pi, models);
	return models.length;
}

// ─── Extension Entry ─────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	// Register provider eagerly in the factory (awaited) so models are available
	// before session_start / model restore runs.
	await refreshAndRegister(pi);

	// ─── Events ──────────────────────────────────────────────────────────────

	// Re-register on session_start (reload/new/fork) with a refreshed model list
	// and UI feedback about the API-key state.
	pi.on("session_start", async (_event, ctx) => {
		const count = await refreshAndRegister(pi);

		if (!ctx.hasUI) return;

		if (!getApiKey()) {
			ctx.ui.notify(
				`${PROVIDER_ID}: ${count} free model(s). Run /login ${PROVIDER_ID} or set ZEN_API_KEY to use them.`,
				"warning",
			);
		} else {
			ctx.ui.notify(`${PROVIDER_ID}: ${count} free model(s) ready`, "success");
		}

		// Opt-in auto-select: if OPENCODE_ZEN_DEFAULT_MODEL is set, switch to it
		// once per process. Leaves the user's configured default untouched otherwise.
		const defaultModelId = process.env.OPENCODE_ZEN_DEFAULT_MODEL || "";
		if (defaultModelId && !hasAutoSelectedModel) {
			const model = ctx.modelRegistry.find(PROVIDER_ID, defaultModelId);
			if (model && (await pi.setModel(model))) {
				hasAutoSelectedModel = true;
				ctx.ui.notify(`Switched to ${PROVIDER_ID}/${defaultModelId}`, "info");
			} else {
				ctx.ui.notify(
					`${PROVIDER_ID}: could not select default model "${defaultModelId}"`,
					"warning",
				);
			}
		}
	});

	// Strip OpenAI-only cache fields the Zen gateway may reject. Scoped to our
	// models only — never modify payloads for other providers (e.g. closedrouter).
	pi.on("before_provider_request", (event) => {
		const payload = event?.payload;
		if (!payload || typeof payload !== "object") return;
		const obj = payload as Record<string, unknown>;
		const modelId = typeof obj.model === "string" ? obj.model : "";
		if (!ourModelIds.has(modelId)) return;

		delete obj.prompt_cache_key;
		delete obj.prompt_cache_retention;
		return obj;
	});

	// ─── Commands ────────────────────────────────────────────────────────────

	// No custom commands: pi already provides /model (pick a model) and /login
	// (auth). This extension only registers the provider + free models.
}
