import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	FreeModelEntry,
	FreeModelsFile,
	ZenModelConfig,
} from "./shared.js";
import {
	fromFreeModelEntry,
	humanize,
	validateFreeModelsFile,
} from "./shared.js";

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
// Model list & metadata come from a single curated file:
//
//   free-models.json  (served from the `data` branch via jsdelivr CDN)
//
// A GitHub Action (`.github/workflows/update-free-models.yml`) maintains this
// file by scraping the opencode.ai docs table and cross-referencing models.dev
// for metadata (context, reasoning, thinking levels, compat flags). The Action
// runs every 6 hours + on manual dispatch.
//
// Resolution flow:
//   1. Fetch free-models.json from jsdelivr CDN (1 h TTL).
//   2. Register all listed models — metadata is already baked in.
//   3. Fallback: if CDN fails, use the last-known-good in-memory set,
//      then the disk snapshot at ~/.pi/agent/cache/pi-zen-models.json,
//      then the bundled free-models.snapshot.json.
//
// The extension NEVER fetches models.dev at runtime — all metadata lives in
// the curated JSON. This keeps the extension simple and the knowledge of
// "which models are actually free" in one auditable, hotfixable file.
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
// Curated free-model list — maintained by the GitHub Action in
// `.github/workflows/update-free-models.yml`, committed to the `data` branch,
// served via jsdelivr CDN (1 h cache). Contains full model metadata so the
// extension never needs to fetch models.dev at runtime.
const FREE_MODELS_CDN_URL =
	"https://cdn.jsdelivr.net/gh/udit-001/pi-zen@data/free-models.json";

// Zen's live list is tiny — refresh aggressively. The curated free-models.json
// from CDN is a small payload and changes infrequently — cache it for 1 hour.
const MODEL_CACHE_TTL_MS = 60_000;
const FREE_MODELS_CDN_TTL_MS = 3_600_000;
const FETCH_TIMEOUT_MS = 8_000;

// Mimic the opencode CLI so Zen serves the free models like it does for opencode.
// The x-opencode-client / x-opencode-project / x-opencode-session headers are the
// meaningful signal; User-Agent is best-effort (the OpenAI SDK may override it).
const OPENCODE_CLI_VERSION = "1.17.11";
const OPENCODE_USER_AGENT = `opencode/${OPENCODE_CLI_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`;
// One session id per pi process ("ses_" + 32 lowercase hex), matching the CLI.
const OPENCODE_SESSION_ID = `ses_${randomUUID().replace(/-/g, "")}`;

// ─── Types ───────────────────────────────────────────────────────────────────
// FreeModelEntry, FreeModelsFile, ZenModelConfig imported from ./shared.ts.
// ZenModel is extension-local (the raw { id } from Zen's /models endpoint).

type ZenModel = {
	id: string;
};

type Snapshot = {
	savedAt: number;
	defaultModel?: string;
	models: ZenModelConfig[];
};

// ─── State ───────────────────────────────────────────────────────────────────

let zenCache: { expiresAt: number; models: ZenModel[] } | null = null;
let freeModelsCache: { expiresAt: number; models: FreeModelEntry[] } | null = null;
/** Last fully-resolved config set (successful resolve, or snapshot load). */
let lastGood: ZenModelConfig[] | null = null;
/** CDN-provided default model id (from free-models.json `defaultModel` field). */
let cdnDefaultModel: string | null = null;
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

/**
 * Read the bundled free-models.snapshot.json that ships with the extension.
 * Used as the first-ever offline fallback (before any CDN fetch has succeeded
 * and written a disk snapshot).
 */
function readBundledSnapshot(): ZenModelConfig[] {
	try {
		// resolve() is relative to the compiled output, not cwd.
		const snapshotPath = join(import.meta.dirname || ".", "free-models.snapshot.json");
		const file = JSON.parse(readFileSync(snapshotPath, "utf8")) as FreeModelsFile;
		return Array.isArray(file?.models) ? file.models.map(fromFreeModelEntry) : [];
	} catch {
		return [];
	}
}

function writeSnapshot(models: ZenModelConfig[], defaultModel?: string): void {
	try {
		const dir = join(getAgentDir(), "cache");
		mkdirSync(dir, { recursive: true });
		const payload = JSON.stringify({ savedAt: Date.now(), defaultModel, models } satisfies Snapshot);
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

/**
 * Global default model from settings.json — written by pi every time the user
 * picks a model (/model, Ctrl+P, setModel). Used as the fallback intent when a
 * session has no model of its own yet (brand-new sessions).
 */
function getSettingsDefaultModel(): { provider: string; modelId: string } | null {
	try {
		const settings = JSON.parse(
			readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
		) as { defaultProvider?: string; defaultModel?: string };
		if (settings?.defaultProvider && settings?.defaultModel) {
			return { provider: settings.defaultProvider, modelId: settings.defaultModel };
		}
	} catch {
		// No/unreadable settings — no intent recoverable.
	}
	return null;
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

// humanize() and fromFreeModelEntry() imported from ./shared.ts.

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

/**
 * Curated free-model list from the data branch (maintained by GitHub Action).
 * Contains full model metadata — no runtime models.dev join required.
 * jsdelivr caches for ~1 hour; we mirror that TTL locally.
 */
async function fetchFreeModelsList(force = false): Promise<{ models: FreeModelEntry[]; defaultModel?: string }> {
	if (!force && freeModelsCache && freeModelsCache.expiresAt > Date.now()) {
		return { models: freeModelsCache.models, defaultModel: cdnDefaultModel ?? undefined };
	}
	const res = await fetch(FREE_MODELS_CDN_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText}`);
	}
	const data = await res.json();
	if (!validateFreeModelsFile(data)) {
		throw new Error("Curated free-models.json failed validation — data may be corrupted or schema drifted");
	}
	freeModelsCache = { expiresAt: Date.now() + FREE_MODELS_CDN_TTL_MS, models: data.models };
	cdnDefaultModel = typeof data.defaultModel === "string" ? data.defaultModel : null;
	return { models: data.models, defaultModel: cdnDefaultModel ?? undefined };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve the free-model config set.
 *
 * Primary path: fetch the curated list from the data branch via jsdelivr CDN.
 * The JSON already contains full model metadata — no models.dev join needed.
 *
 * Fallback path: if CDN is unreachable, fall back to the last-known-good
 * in-memory set, then the disk snapshot (shipped with the extension).
 *
 * A successful primary resolve becomes the new last-known-good.
 */
async function resolveModels(): Promise<ZenModelConfig[]> {
	const { models: curated, defaultModel } = await fetchFreeModelsList();
	if (curated.length === 0) {
		throw new Error("Curated free-models list is empty");
	}
	const configs = curated.map(fromFreeModelEntry);
	lastGood = configs;
	writeSnapshot(configs, defaultModel);
	return configs;
}

/**
 * The module's interface: never throws. Falls back to the last fully-resolved
 * set (in-memory, else the disk snapshot, else the bundled snapshot),
 * else an empty list.
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
	// First-ever run offline: the disk snapshot is empty. Try the bundled
	// free-models.snapshot.json that ships with the extension.
	if (lastGood.length === 0) {
		lastGood = readBundledSnapshot();
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

	// Pass a concrete key when one exists (stored credential or env). A concrete
	// value marks the provider "configured" synchronously at registration — which
	// pi's session-model restore checks immediately after extensions load. The
	// "$ENV_REF" form only authenticates after an async credential-store refresh
	// and loses that race, so resume/fork silently drops the pi-zen model. Keep
	// the $-reference as fallback so models still appear before any key is set.
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: getApiKey() || "$ZEN_API_KEY",
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

// ─── Model Restore ───────────────────────────────────────────────────────────
//
// pi resolves the session's model (createAgentSession) BEFORE extension
// factories finish registering providers — our factory awaits network fetches,
// so registerProvider lands a few ms after the restore block has already run.
// Any pi-zen model recorded in the session (or as the settings default) is
// therefore silently dropped in favor of the first authenticated native
// model. pi already persists everything needed to repair this — the session
// file records every model_change, and settings.json holds the last pick —
// so on session_start (post-registration) we simply re-apply the model pi
// intended. No extra state of our own.

/**
 * Update the settings.json with the new default model.
 */
function updateSettingsDefaultModel(modelId: string): void {
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		settings.defaultProvider = PROVIDER_ID;
		settings.defaultModel = modelId;
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	} catch {
		// Best-effort — don't block if settings write fails
	}
}

async function restoreIntendedModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		// Same resolution rule as pi's getSessionContextSettings: last
		// model_change / assistant message on the current branch wins. For
		// brand-new sessions pi seeds the branch with its own (post-fallback)
		// model choice, so only trust branch history when real messages exist;
		// otherwise the user's settings default is the intent to honor.
		const branch = ctx.sessionManager.getBranch();
		let fromSession: { provider: string; modelId: string } | null = null;
		if (branch.some((entry) => entry.type === "message")) {
			for (const entry of branch) {
				if (entry.type === "model_change") {
					fromSession = { provider: entry.provider, modelId: entry.modelId };
				} else if (entry.type === "message" && entry.message.role === "assistant") {
					const { provider, model } = entry.message;
					if (provider && model) fromSession = { provider, modelId: model };
				}
			}
		}
		const intended = fromSession ?? getSettingsDefaultModel();
		if (!intended || intended.provider !== PROVIDER_ID) return;

		const current = ctx.model;
		if (current?.provider === PROVIDER_ID && current.id === intended.modelId) return;

		let model = ctx.modelRegistry.find(PROVIDER_ID, intended.modelId);

		// If the intended model isn't available, fall back to the CDN-provided default
		if (!model) {
			const fallback = cdnDefaultModel || "big-pickle";
			if (intended.modelId !== fallback) {
				model = ctx.modelRegistry.find(PROVIDER_ID, fallback);
				if (model) {
					console.log(
						`${PROVIDER_ID}: Model "${intended.modelId}" not available, falling back to "${fallback}"`,
					);
					updateSettingsDefaultModel(fallback);
				}
			}
		}

		if (model) await pi.setModel(model);
	} catch {
		// Best-effort repair — never block session startup.
	}
}

// ─── Extension Entry ─────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	// Register provider eagerly in the factory (awaited) so models are available
	// before session_start / model restore runs.
	await refreshAndRegister(pi);

	// ─── Events ──────────────────────────────────────────────────────────────

	// Background refresh every 6 hours (stale-while-revalidate).
	setInterval(() => {
		fetchFreeModelsList(true)
			.then(({ models: curated }) => {
				if (curated.length > 0) {
					const configs = curated.map(fromFreeModelEntry);
					registerProvider(pi, configs);
				}
			})
			.catch(() => {
				// Silent — next session_start will retry.
			});
	}, FREE_MODELS_CDN_TTL_MS * 2);

	// Re-register on session_start (reload/new/fork) with a refreshed model list
	// (CDN 1 h TTL) and UI feedback about the API-key state.
	pi.on("session_start", async (_event, ctx) => {
		const count = await refreshAndRegister(pi);

		// Re-apply the session's (or default) pi-zen model — pi's own restore ran
		// before our provider registered. See Model Restore note above.
		await restoreIntendedModel(pi, ctx);

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

	// ─── Request lifecycle ──────────────────────────────────────────────────────
	//
	// Consolidated state for the request → response → message lifecycle.
	// Tracks which provider owns the in-flight request so post-processing
	// (cache stripping, error rewriting) stays scoped to pi-zen models only.

	const requestState = {
		provider: "", // which provider owns the current request
		zen429: false, // did the last response from our provider 429?
	};

	pi.on("before_provider_request", (event) => {
		const payload = event?.payload;
		if (!payload || typeof payload !== "object") return;
		const obj = payload as Record<string, unknown>;
		const modelId = typeof obj.model === "string" ? obj.model : "";
		requestState.provider = ourModelIds.has(modelId) ? PROVIDER_ID : "";

		// Strip OpenAI-only cache fields the Zen gateway may reject.
		delete obj.prompt_cache_key;
		delete obj.prompt_cache_retention;
		return obj;
	});

	pi.on("after_provider_response", (event) => {
		requestState.zen429 = requestState.provider === PROVIDER_ID && event.status === 429;
	});

	// ─── Error UX ─────────────────────────────────────────────────────────────
	//
	// Zen's free models return 429 with { type: "FreeUsageLimitError", ... }
	// when the free-tier quota is exhausted. Pi formats this as a raw JSON blob.
	// We rewrite it into an actionable message (diagnose → explain → recover),
	// matching opencode's own UX: "Free usage exceeded, subscribe to Go".

	pi.on("message_end", (event) => {
		if (!requestState.zen429) return;
		requestState.zen429 = false;

		const msg = event.message;
		if (msg.role !== "assistant" || !msg.errorMessage) return;

		msg.errorMessage = [
			"⚡ Free usage limit reached on Zen.",
			"",
			"Your free-tier quota for this model is exhausted.",
			"",
			"To continue:",
			"  • Switch to another free model: /model",
			"  • Wait for the quota to reset (varies by model)",
			"  • Add credits at https://opencode.ai/zen for paid models",
		].join("\n");
	});

	// ─── Commands ────────────────────────────────────────────────────────────

	// No custom commands: pi already provides /model (pick a model) and /login
	// (auth). This extension only registers the provider + free models.
}
