import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
// Zen's live /models endpoint returns ids only — no context window, reasoning,
// or limits. Model metadata is therefore discovered dynamically:
//
//   1. Fetch the live free ids from Zen (source of truth for what exists).
//   2. Join each id against the `opencode` provider entry on models.dev
//      (https://models.dev/api.json), which the opencode team also maintains —
//      it is authoritative for how Zen serves each model.
//   3. Translate to pi's model config using the same rules pi's own
//      generate-models.ts script applies when it builds its Zen catalog:
//        - contextWindow/maxTokens  ← limit.context / limit.output (uncapped)
//        - reasoning                ← reasoning
//        - thinkingLevelMap         ← reasoning_options effort values map to
//                                      themselves; "none" → off; levels absent
//                                      from the values are null (hidden);
//                                      xhigh is never derived from "max".
//                                      Toggle / budget_tokens / empty options
//                                      → no map (pi's default levels).
//        - image input              ← modalities.input includes "image"
//        - reasoning replay         ← interleaved.field === "reasoning_content"
//                                      sets requiresReasoningContentOnAssistantMessages
//                                      (backends like DeepSeek 400 without it).
//   4. A free id with no models.dev entry yet (fresh stealth drop) registers
//      with safe defaults: humanized name, 128k context, 8k output, no
//      reasoning. Metadata upgrades automatically once models.dev catalogs it.
//   5. If either fetch fails, fall back to the last-known-good resolution
//      snapshotted at ~/.pi/agent/cache/pi-zen-models.json — so a model list
//      you saw yesterday still works offline. First-ever run offline registers
//      nothing.
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
const MODELS_DEV_URL = "https://models.dev/api.json";

// Zen's list is tiny and public — refresh it aggressively. models.dev's api.json
// is a multi-MB payload (we keep only the `opencode` slice) — refresh it rarely.
const MODEL_CACHE_TTL_MS = 60_000;
const MODELS_DEV_CACHE_TTL_MS = 300_000;
const FETCH_TIMEOUT_MS = 8_000;
const MODELS_DEV_TIMEOUT_MS = 15_000;

// Safe defaults for free models that appear on Zen before models.dev catalogs
// them. Never used for models with metadata.
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
};

// models.dev reasoning_options entries (only the kinds we act on).
type ReasoningOption =
	| { type: "toggle" }
	| { type: "effort"; values: string[] }
	| { type: "budget_tokens"; min?: number; max?: number };

// A model entry under the `opencode` provider on models.dev — the fields we
// consume. Unknown fields are ignored.
type ModelsDevModel = {
	id?: string;
	name?: string;
	reasoning?: boolean;
	reasoning_options?: ReasoningOption[] | null;
	modalities?: { input?: string[]; output?: string[] } | null;
	interleaved?: { field?: string } | null;
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number };
};

type ThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
>;

type ZenModelConfig = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
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
		requiresReasoningContentOnAssistantMessages?: boolean;
	};
};

type Snapshot = {
	savedAt: number;
	models: ZenModelConfig[];
};

// ─── State ───────────────────────────────────────────────────────────────────

let zenCache: { expiresAt: number; models: ZenModel[] } | null = null;
let devCache: { expiresAt: number; slice: Record<string, ModelsDevModel> } | null = null;
/** Last fully-resolved config set (successful resolve, or snapshot load). */
let lastGood: ZenModelConfig[] | null = null;
let hasRegisteredProvider = false;
let ourModelIds = new Set<string>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Snapshot of the last successful resolution (offline fallback). */
function getSnapshotPath(): string {
	return join(getAgentDir(), "cache", "pi-zen-models.json");
}

function readSnapshot(): ZenModelConfig[] {
	try {
		const snap = JSON.parse(readFileSync(getSnapshotPath(), "utf8")) as Snapshot;
		return Array.isArray(snap?.models) ? snap.models : [];
	} catch {
		return [];
	}
}

function writeSnapshot(models: ZenModelConfig[]): void {
	try {
		const dir = join(getAgentDir(), "cache");
		mkdirSync(dir, { recursive: true });
		const payload = JSON.stringify({ savedAt: Date.now(), models } satisfies Snapshot);
		// Write-then-rename keeps readers off partial files on POSIX. On Windows,
		// renaming over an existing destination can transiently fail with EPERM
		// (antivirus / a concurrent pi holding it) — fall back to a direct write,
		// which is atomic enough for a best-effort cache.
		const tmp = join(dir, `pi-zen-models.json.${process.pid}.tmp`);
		try {
			writeFileSync(tmp, payload);
			renameSync(tmp, getSnapshotPath());
		} catch {
			try {
				writeFileSync(getSnapshotPath(), payload);
			} catch {
				// Still best-effort.
			}
		}
	} catch {
		// Best-effort persistence.
	}
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
	// ZEN_API_KEY is the canonical env fallback for headless/CI use.
	return getStoredKey() || process.env.ZEN_API_KEY || "";
}

/**
 * A model is free if its id says so (`-free` suffix, or the stealth
 * `big-pickle`), or if its models.dev entry carries zero cost (catches no-suffix
 * free drops once cataloged). A paid or unknown model is never registered —
 * guessing a paid model in as free risks silent billing.
 */
function isFreeModel(id: string, meta?: ModelsDevModel): boolean {
	const lower = id.toLowerCase();
	if (lower === "big-pickle" || lower.endsWith("-free")) return true;
	return !!meta && meta.cost?.input === 0 && meta.cost?.output === 0;
}

function humanize(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

// ─── Metadata resolution (models.dev → pi model config) ──────────────────────

/**
 * Translate models.dev `reasoning_options` into pi's thinkingLevelMap, using the
 * same rules as pi's generate-models.ts:
 *   - An `effort` option maps its values to themselves; "none" means `off`;
 *     pi levels absent from the values are null (hidden from /model picker);
 *     `xhigh` is only exposed when literally listed (never derived from "max").
 *   - `toggle`, `budget_tokens`, or no options → undefined (pi's default levels,
 *     no map) — thinking is on/off, every standard effort accepted as-is.
 */
function buildThinkingLevelMap(meta?: ModelsDevModel): ThinkingLevelMap | undefined {
	const effort = meta?.reasoning_options?.find(
		(o): o is { type: "effort"; values: string[] } =>
			o.type === "effort" && Array.isArray(o.values) && o.values.length > 0,
	);
	if (!effort) return undefined;
	const values = new Set(effort.values);
	const map: ThinkingLevelMap = {
		off: values.has("none") ? "none" : null,
	};
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		map[level] = values.has(level) ? level : null;
	}
	return map;
}

/**
 * Backends with interleaved reasoning (DeepSeek/GLM-style `reasoning_content`)
 * reject multi-turn requests that drop the prior assistant turn's reasoning.
 * models.dev's `interleaved.field` marks them.
 */
function needsReasoningReplay(meta?: ModelsDevModel): boolean {
	return meta?.interleaved?.field === "reasoning_content";
}

function toModelConfig(m: ZenModel, meta?: ModelsDevModel): ZenModelConfig {
	const reasoning = meta?.reasoning === true;
	const context = meta?.limit?.context;
	const output = meta?.limit?.output;
	const hasImage = Array.isArray(meta?.modalities?.input) && meta.modalities.input.includes("image");
	return {
		id: m.id,
		name: meta?.name || humanize(m.id),
		reasoning,
		thinkingLevelMap: buildThinkingLevelMap(meta),
		input: hasImage ? ["text", "image"] : ["text"],
		// Free models are zero-cost by construction (see isFreeModel).
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: typeof context === "number" && context > 0 ? context : DEFAULT_CONTEXT_WINDOW,
		maxTokens: typeof output === "number" && output > 0 ? output : DEFAULT_OUTPUT_TOKENS,
		compat: {
			// OpenAI-compatible gateways expect `max_tokens` and `system` role.
			maxTokensField: "max_tokens",
			supportsStore: false,
			// Only emit reasoning_effort for models that support thinking.
			supportsReasoningEffort: reasoning,
			supportsDeveloperRole: false,
			supportsUsageInStreaming: false,
			...(reasoning && needsReasoningReplay(meta)
				? { requiresReasoningContentOnAssistantMessages: true }
				: {}),
		},
	};
}

// ─── Fetchers (TTL-cached) ───────────────────────────────────────────────────

/** Live model ids from Zen. The endpoint is public — no API key required. */
async function fetchZenModels(force = false): Promise<ZenModel[]> {
	if (!force && zenCache && zenCache.expiresAt > Date.now()) {
		return zenCache.models;
	}
	const res = await fetch(MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText}`);
	}
	const json = (await res.json()) as { data?: ZenModel[] };
	const models = (json.data ?? []).filter((m) => typeof m?.id === "string");
	zenCache = { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models };
	return models;
}

/** The `opencode` provider slice of models.dev — authoritative Zen metadata. */
async function fetchModelsDev(force = false): Promise<Record<string, ModelsDevModel>> {
	if (!force && devCache && devCache.expiresAt > Date.now()) {
		return devCache.slice;
	}
	const res = await fetch(MODELS_DEV_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText}`);
	}
	const json = (await res.json()) as Record<string, { models?: Record<string, ModelsDevModel> }>;
	const slice = json?.opencode?.models ?? {};
	devCache = { expiresAt: Date.now() + MODELS_DEV_CACHE_TTL_MS, slice };
	return slice;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve the free-model config set: live Zen ids ⨝ models.dev metadata.
 * Refreshes each source only when its TTL has expired. Throws on fetch failure
 * (caller recovers). A successful resolve becomes the new last-known-good.
 */
async function resolveModels(): Promise<ZenModelConfig[]> {
	const [zenModels, devSlice] = await Promise.all([fetchZenModels(), fetchModelsDev()]);
	const configs = zenModels
		.map((m) => ({ m, meta: devSlice[m.id] }))
		.filter(({ m, meta }) => isFreeModel(m.id, meta))
		.map(({ m, meta }) => toModelConfig(m, meta));

	lastGood = configs;
	writeSnapshot(configs);
	return configs;
}

/**
 * The module's interface: never throws. Falls back to the last fully-resolved
 * set (in-memory, else the disk snapshot), else an empty list.
 */
async function resolveOrRecover(): Promise<ZenModelConfig[]> {
	try {
		return await resolveModels();
	} catch (err) {
		console.warn(
			`${PROVIDER_ID}: resolution failed (${err instanceof Error ? err.message : String(err)}); using last-known-good`,
		);
	}
	if (!lastGood) {
		lastGood = readSnapshot();
	}
	return lastGood;
}

// ─── Provider Registration ───────────────────────────────────────────────────

function registerProvider(pi: ExtensionAPI, models: ZenModelConfig[]) {
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
		models,
	});
}

/** Always register something: the resolved list, or the last-known-good. */
async function refreshAndRegister(pi: ExtensionAPI): Promise<number> {
	const models = await resolveOrRecover();
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
	// (stale sources only — Zen 60s TTL, models.dev 5min TTL) and UI feedback
	// about the API-key state.
	pi.on("session_start", async (_event, ctx) => {
		const count = await refreshAndRegister(pi);

		if (!ctx.hasUI) return;

		if (!getApiKey()) {
			ctx.ui.notify(
				`${PROVIDER_ID}: ${count} free model(s). Run /login ${PROVIDER_ID} or set ZEN_API_KEY to use them.`,
				"warning",
			);
		} else {
			ctx.ui.notify(`${PROVIDER_ID}: ${count} free model(s) ready`, "info");
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
