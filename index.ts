import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	FreeModelEntry,
	FreeModelsFile,
	ModelApi,
	ZenModelConfig,
} from "./shared.js";
import {
	ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAME,
	ensureZenFreeTierShape,
	fromFreeModelEntry,
	humanize,
	opencodeId,
	opencodeIdFromSeed,
	opencodeUserAgent,
	projectIdFromRemote,
	validateFreeModelsFile,
} from "./shared.js";

// ─── Configuration ───────────────────────────────────────────────────────────
//
// OpenCode Zen is the OpenCode team's curated AI gateway:
//   https://opencode.ai/zen
//
// This extension registers ONLY the free models. Zen serves them across three
// endpoint families — most on the OpenAI-compatible chat route, muse-spark on
// the Responses API, and the stealth union-alpha on Anthropic's /messages —
// so the endpoint family is carried per MODEL
// (`api` on each entry of free-models.json), not on the provider. The
// provider itself stays single: one baseUrl, one credential, one set of
// opencode-CLI headers, because auth and identity are identical on every
// family (the anthropic client authenticates via Bearer like the others).
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
// Without a key we authenticate exactly like the opencode CLI does when you are
// signed out — `Authorization: Bearer public`, which Zen maps to anonymous,
// IP-rate-limited access to the free models. A key is still recommended: it
// ties usage to your workspace instead of the shared anonymous bucket.
//
// Wire parity with opencode (verified against a live opencode 1.18.31 request;
// see shared.ts "OpenCode wire parity"):
//   User-Agent, x-opencode-client, x-opencode-project, x-opencode-session,
//   x-opencode-request
//
// Zen's free tier additionally requires an *agent-shaped* request: it serves a
// free model only when the call streams and carries a non-empty `tools` array,
// otherwise it answers 403 (`FreeTierError`). pi streams always, but it omits
// `tools` for tool-less turns — so we stand in a placeholder tool. See
// ensureZenFreeTierShape in shared.ts.

const PROVIDER_ID = "pi-zen";
const PROVIDER_NAME = "OpenCode Zen (Free)";
// Sent when no key is configured: what the opencode CLI sends while signed out.
// Zen treats it as "no credential" → anonymous free-tier access (IP rate limited).
// See packages/console/app/src/routes/zen/v1/chat/completions.ts → `key === "public"`.
const ZEN_ANONYMOUS_API_KEY = "public";
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

// ─── opencode parity (pi → Zen requests look like opencode requests) ────────

// Mimic the opencode CLI on the wire so Zen serves the free models exactly as
// it does for opencode. The full capture this mirrors — header names, value
// shapes, and the live request they were verified against — is recorded once in
// shared.ts ("OpenCode wire parity"); that file owns the evidence and the pure
// helpers, this file owns pi-side policy:
//
//   User-Agent version   refreshed from free-models.json (the GitHub Action
//                        records the latest opencode release), so it doesn't
//                        go stale between extension installs
//   x-opencode-project   resolved once from the git remote of the cwd
//   x-opencode-session   pinned to pi's session id, finalized per request
//   x-opencode-request   minted fresh per provider request
const OPENCODE_VERSION_FALLBACK = "1.18.31";
// The opencode CLI reads its client identity from OPENCODE_CLIENT ("cli" by default).
const OPENCODE_CLIENT = process.env.OPENCODE_CLIENT || "cli";
// Process-wide fallback session id, used when no pi session id is available yet.
const FALLBACK_SESSION_ID = opencodeId("ses", Date.now(), 0, randomBytes(14));

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
/** opencode version from free-models.json — keeps the User-Agent from going stale. */
let opencodeVersion = OPENCODE_VERSION_FALLBACK;
/** Resolved on first use: the project id opencode would compute for this cwd. */
let projectId: string | null = null;
/** Per-millisecond counter for opencode-style ascending ids (matches upstream). */
let idCounter = 0;
/**
 * Registered model id → endpoint family. before_provider_request carries the
 * model id but no headers, so this map is how the payload hook resolves which
 * Zen free-tier tool shape a payload needs. Rebuilt on every registration.
 */
let apiByModelId: ReadonlyMap<string, ModelApi> = new Map();

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

// ─── OpenCode identity ───────────────────────────────────────────────────────
//
// The header values opencode computes per process/session/request. Kept honest
// rather than constant: the project id is derived from this repo's git remote
// and the session id from pi's session, so Zen's per-project grouping and
// sticky routing line up the way they do for opencode.

/**
 * opencode's project id: sha1("git-remote:<host/path>") from the repo's origin
 * remote, else the literal "global" (what opencode sends outside a repo).
 * Resolved once — it can't change without restarting in another directory.
 */
function resolveProjectId(): string {
	if (projectId) return projectId;
	try {
		// Only origin is consulted, matching opencode's git.remote.get.
		const origin = execFileSync("git", ["config", "--get", "remote.origin.url"], {
			cwd: process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		});
		projectId = projectIdFromRemote(origin) ?? "global";
	} catch {
		// Not a repo, no origin, or git missing — opencode falls back to "global".
		projectId = "global";
	}
	return projectId;
}

/**
 * `ses_...` for the current pi session: deterministic from pi's session id, so
 * reconnects in the same conversation keep Zen's sticky routing/cache warm.
 * Falls back to a per-process id before a session exists.
 */
function sessionIdFor(ctx: ExtensionContext): string {
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) return opencodeIdFromSeed("ses", sessionId);
	} catch {
		// No session manager in this context — use the process-wide id.
	}
	return FALLBACK_SESSION_ID;
}

/** One `msg_...` per provider request, in opencode's ascending id format. */
function nextRequestId(): string {
	idCounter = (idCounter + 1) % 4096;
	return opencodeId("msg", Date.now(), idCounter, randomBytes(14));
}

/**
 * `x-opencode-project` is set only by our provider config, so its presence
 * marks a request as ours — the gate both lifecycle hooks use. One named
 * predicate, so the marker can move without grepping for header names.
 */
function isZenRequest(headers: Record<string, unknown>): boolean {
	return Boolean(headers["x-opencode-project"]);
}

/**
 * Static identity headers registered with the provider config, mirroring the
 * opencode CLI. Two of these are defaults only: the before_provider_headers
 * hook finalizes x-opencode-session per request (sessionIdFor) and mints
 * x-opencode-request fresh. x-opencode-project doubles as the isZenRequest
 * marker — it must stay set for the hooks to recognize our traffic.
 */
function opencodeHeaders(): Record<string, string> {
	return {
		"User-Agent": opencodeUserAgent(opencodeVersion),
		"x-opencode-client": OPENCODE_CLIENT,
		"x-opencode-project": resolveProjectId(),
		"x-opencode-session": FALLBACK_SESSION_ID,
	};
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
	if (data.opencodeVersion) opencodeVersion = data.opencodeVersion;
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
	// The endpoint family is per model (see file header); everything shared —
	// baseUrl, credential, headers — stays here. Provider-level `api` is the
	// default family for any model that omits one.
	//
	// Pass a concrete key when one exists (stored credential or env). A concrete
	// value marks the provider "configured" synchronously at registration — which
	// pi's session-model restore checks immediately after extensions load. The
	// "$ENV_REF" form only authenticates after an async credential-store refresh
	// and loses that race, so resume/fork silently drops the pi-zen model.
	//
	// Signed out, we send "public" instead — the sentinel the opencode CLI uses
	// when it has no key, which Zen maps to anonymous (IP-rate-limited) access to
	// the free models. Forwarding an unresolved "$ZEN_API_KEY" would instead be
	// read as a literal credential and rejected.
	apiByModelId = new Map(models.map((m) => [m.id, m.api ?? "openai-completions"]));
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		apiKey: getApiKey() || ZEN_ANONYMOUS_API_KEY,
		authHeader: true,
		api: "openai-completions",
		// opencode-CLI headers (User-Agent + x-opencode-*), see opencodeHeaders().
		headers: opencodeHeaders(),
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

// ─── Error UX ───────────────────────────────────────────────────────────────
//
// Zen's free models return 429 with { type: "FreeUsageLimitError", ... }
// when the free-tier quota is exhausted, and pi surfaces the raw JSON blob.
//
// Why detection happens on the message, not in after_provider_response: the
// OpenAI SDK throws APIError on non-2xx responses before pi-ai's onResponse
// hook runs, so that event never fires for 429s — any status flag set there
// stays false and the rewrite is skipped. Failed assistant messages keep
// their provider/model and carry the raw `429: {"type":...}` errorMessage,
// making the finalized message itself the reliable signal.
//
// Wording constraint: pi re-classifies the final message via
// isRetryableAssistantError (NON_RETRYABLE patterns first, then RETRYABLE:
// "429", "rate limit", "too many requests", "try ... again", "timeout", ...).
// The friendly text must avoid every RETRYABLE marker or a hard quota error
// becomes an auto-retry loop. It deliberately contains "usage limit", a
// NON_RETRYABLE marker, as a belt-and-braces guard.
//
// Style: follows the Focus output style (styles/Focus.md in output-style) —
// ASCII only, diagnosis on line 1, numbered one-action recovery steps ranked
// best first, list cap 5, no re-narrating the diagnosis in prose. Surface
// layer contract (layers-surface): the message must diagnose (line 1),
// explain (step 2: the quota resets — not permanent, not the user's fault),
// and recover (ranked steps). Terms are the extension's ubiquitous language:
// "usage limit" (opencode's own term), "free model", "Zen", "reset".

const ZEN_QUOTA_ERROR_PATTERN =
	/FreeUsageLimitError|GoUsageLimitError|insufficient_quota|usage limit|quota/i;

/** Fields of a failed assistant message the quota-error decision reads. */
type FailedAssistantMessage = {
	provider: string;
	model: string;
	stopReason: string;
	errorMessage?: string;
};

/**
 * Friendly replacement text for a Zen quota-exhausted error, or undefined
 * when the message isn't one (including transient 429 throttles, which pi's
 * own retry policy should keep handling). Pure — decision + wording only; the
 * message_end handler owns all event plumbing.
 */
function zenQuotaFriendlyError(msg: FailedAssistantMessage): string | undefined {
	if (msg.stopReason !== "error" || msg.provider !== PROVIDER_ID) return undefined;
	if (!msg.errorMessage || !ZEN_QUOTA_ERROR_PATTERN.test(msg.errorMessage)) return undefined;
	return [
		`Free usage limit hit for "${msg.model}" on Zen.`,
		"",
		"Fix (best first):",
		"1. /model -> pick another free model",
		"2. Wait for the reset (timing varies)",
		"3. Add credits: https://opencode.ai/zen",
	].join("\n");
}

// Zen's free tier also rejects a request outright (403) when it doesn't look
// like an agent turn — it must stream and carry tools. pi-zen guarantees that
// shape (ensureZenFreeTierShape), so a 403 here means the network's anonymous
// allowance is spent rather than a malformed request; a key moves the caller
// onto its own quota. Same wording constraints as the quota message above:
// no pi RETRYABLE markers (429 / rate limit / too many requests / try ... again
// / timeout) — the text says "usage limit" instead.
const ZEN_FREE_TIER_ERROR_PATTERN = /FreeTierError|free tier can only be used/i;

/**
 * Friendly replacement text for a Zen free-tier policy rejection, or undefined
 * when the message isn't one. Pure, like zenQuotaFriendlyError.
 */
function zenFreeTierFriendlyError(msg: FailedAssistantMessage): string | undefined {
	if (msg.stopReason !== "error" || msg.provider !== PROVIDER_ID) return undefined;
	if (!msg.errorMessage || !ZEN_FREE_TIER_ERROR_PATTERN.test(msg.errorMessage)) return undefined;
	return [
		`Zen refused this free-tier request for "${msg.model}" (403 FreeTierError).`,
		"",
		"Free models are served anonymously only up to a shared per-network usage limit.",
		"",
		"Fix (best first):",
		`1. /login ${PROVIDER_ID} -> free key, gives you your own quota`,
		"2. /model -> pick another free model",
		"3. Wait for the reset (timing varies)",
	].join("\n");
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
			// No key still works: we authenticate as opencode does when signed out
			// ("public" → anonymous free-tier access), so this is informational.
			ctx.ui.notify(
				`${PROVIDER_ID}: ${count} free model(s) ready (anonymous, shared per-network quota) — /login ${PROVIDER_ID} for your own`,
				"info",
			);
		} else {
			ctx.ui.notify(`${PROVIDER_ID}: ${count} free model(s) ready`, "info");
		}
	});

	// ─── Request lifecycle ──────────────────────────────────────────────────────

	// Identity headers, per request: a `ses_...` pinned to pi's session (Zen keys
	// sticky provider routing and prompt cache on it) and a fresh `msg_...`
	// request id — the same pair opencode sends. Gated by isZenRequest, so other
	// providers' requests are never touched.
	pi.on("before_provider_headers", (event, ctx) => {
		if (!isZenRequest(event.headers)) return;
		event.headers["x-opencode-session"] = sessionIdFor(ctx);
		event.headers["x-opencode-request"] = nextRequestId();
	});

	// Two jobs on every provider request:
	//   1. drop OpenAI-only cache fields the Zen gateway may reject
	//   2. guarantee the request shape Zen's free tier requires (see
	//      ensureZenFreeTierShape) — pi omits `tools` on tool-less turns
	//
	// Scope: applied to every provider's payload, not just our own. Forced by
	// pi's event interface — before_provider_request carries only
	// `{ type, payload }`, no headers, so there is nothing to gate on here (the
	// isZenRequest gate lives on the headers event instead). Harm is bounded:
	// unknown payload fields are stripped by the api clients anyway, and a
	// non-Zen provider only ever sees the `_zen_noop` placeholder on tool-less
	// turns — where it is blocked harmlessly by the tool_call hook below.
	//
	// The payload carries the model id, so apiByModelId resolves the endpoint
	// family and with it the placeholder tool's wire shape (chat-completions,
	// responses, or anthropic wrapper). Unregistered ids — other providers —
	// get the default chat-completions shape.
	pi.on("before_provider_request", (event) => {
		const payload = event?.payload;
		if (!payload || typeof payload !== "object") return;
		const obj = payload as Record<string, unknown>;
		delete obj.prompt_cache_key;
		delete obj.prompt_cache_retention;
		ensureZenFreeTierShape(obj, typeof obj.model === "string" ? apiByModelId.get(obj.model) : undefined);
		return obj;
	});

	// The placeholder tool exists only to satisfy that shape. If a model calls it
	// anyway, block it with a readable result instead of letting the turn die on
	// an unknown tool.
	pi.on("tool_call", (event) => {
		if (event.toolName !== ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAME) return;
		return {
			block: true,
			reason: "Placeholder tool added for Zen free-tier compatibility — no action needed.",
		};
	});

	// Rewrite raw Zen quota errors into actionable guidance. Detection and
	// wording live in zenQuotaFriendlyError (see Error UX above); this handler
	// is plumbing only: narrow the message, ask, return the replacement per the
	// message_end contract (the runner chains returned messages and
	// agent-session swaps them in place before persistence and display).
	pi.on("message_end", (event) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		const friendly = zenFreeTierFriendlyError(msg) ?? zenQuotaFriendlyError(msg);
		if (!friendly) return;
		return { message: { ...msg, errorMessage: friendly } };
	});

	// ─── Commands ────────────────────────────────────────────────────────────

	// No custom commands: pi already provides /model (pick a model) and /login
	// (auth). This extension only registers the provider + free models.
}
