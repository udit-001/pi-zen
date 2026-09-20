/**
 * Shared types and pure helpers for pi-zen.
 *
 * No dependencies on pi's ExtensionAPI and no I/O — consumed by both:
 *   - index.ts (the extension)
 *   - build-free-models.mjs (the GitHub Action, via its own copies of the helpers)
 *
 * The helpers here are the single source of truth for the logic they encode.
 * The build script duplicates them because it runs in a plain Node context
 * without TypeScript strip-types; the duplication is acceptable for <30 lines
 * of stable, self-contained code.
 */

import { createHash } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

/** pi API families Zen serves. Determines which endpoint/model config pi uses. */
export type ModelApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

/** The ModelApi values we accept from the curated list. */
export const MODEL_APIS: ReadonlySet<string> = new Set<ModelApi>([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);

/** Pi's thinking-level map: maps level names to model-specific values or null (hidden). */
export type ThinkingLevelMap = Partial<
	Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
>;

/** models.dev reasoning_options entries (only the kinds we act on). */
export type ReasoningOption =
	| { type: "toggle" }
	| { type: "effort"; values: string[] }
	| { type: "budget_tokens"; min?: number; max?: number };

/** A model entry under the `opencode` provider on models.dev — the fields we consume. */
export type ModelsDevModel = {
	id?: string;
	name?: string;
	reasoning?: boolean;
	reasoning_options?: ReasoningOption[] | null;
	modalities?: { input?: string[]; output?: string[] } | null;
	interleaved?: { field?: string } | null;
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number };
};

/** A curated free-model entry from free-models.json (built by the GitHub Action). */
export type FreeModelEntry = {
	id: string;
	name: string;
	/** Endpoint family from the Zen docs table. Absent = openai-completions. */
	api?: ModelApi;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: ModelCompat;
};

/** Shape of the full free-models.json file. */
export type FreeModelsFile = {
	generatedAt: string;
	source: string;
	count: number;
	defaultModel?: string;
	/** Latest opencode release the Action saw — drives the User-Agent version. */
	opencodeVersion?: string;
	models: FreeModelEntry[];
};

/**
 * pi's model config — the output of all resolution paths. `api` names the
 * endpoint family this model is served on; it is set per model (not on the
 * provider) because Zen free models span three families, while auth, base
 * URL, and headers stay shared at the provider level.
 */
export type ZenModelConfig = {
	id: string;
	name: string;
	/** Endpoint family to reach this model on Zen. Absent = openai-completions. */
	api?: ModelApi;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: ModelCompat;
};

/** Completions-specific compat flags — the historical shape, kept verbatim. */
export type OpenAICompletionsModelCompat = {
	maxTokensField: "max_tokens" | "max_completion_tokens";
	supportsStore: boolean;
	supportsReasoningEffort: boolean;
	supportsDeveloperRole: boolean;
	supportsUsageInStreaming: boolean;
	requiresReasoningContentOnAssistantMessages?: boolean;
};

/**
 * Family-aware compat block. Only openai-completions has flags of its own
 * (maxTokensField drives the max-tokens wire field); for every other family
 * pi-ai applies its own defaults per compat key, so those models ship an
 * empty object instead of completions flags that mean nothing on their
 * endpoint.
 */
export type ModelCompat = OpenAICompletionsModelCompat | Record<string, never>;

// ─── Pure helpers ────────────────────────────────────────────────────────────

export function humanize(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/**
 * Translate models.dev `reasoning_options` into pi's thinkingLevelMap.
 *
 * Rules (matching pi's generate-models.ts):
 *   - An `effort` option maps its values to themselves; "none" means `off`;
 *     pi levels absent from the values are null (hidden from /model picker);
 *     `xhigh` is only exposed when literally listed (never derived from "max").
 *   - `toggle`, `budget_tokens`, or no options → undefined (pi's default levels).
 */
export function buildThinkingLevelMap(meta?: ModelsDevModel): ThinkingLevelMap | undefined {
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
 */
export function needsReasoningReplay(meta?: ModelsDevModel): boolean {
	return meta?.interleaved?.field === "reasoning_content";
}

/** Convert a curated FreeModelEntry into pi's ZenModelConfig. */
export function fromFreeModelEntry(entry: FreeModelEntry): ZenModelConfig {
	return {
		id: entry.id,
		name: entry.name,
		api: entry.api,
		reasoning: entry.reasoning,
		thinkingLevelMap: entry.thinkingLevelMap,
		input: entry.input,
		cost: entry.cost,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: entry.compat,
	};
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Lightweight structural validation for a parsed free-models.json.
 * Checks required fields and value ranges — not a full JSON Schema validation,
 * but enough to catch corrupted CDN responses or schema drift at load time.
 */
export function validateFreeModelsFile(data: unknown): data is FreeModelsFile {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	if (!Array.isArray(obj.models)) return false;
	if (obj.opencodeVersion !== undefined && typeof obj.opencodeVersion !== "string") return false;

	for (const m of obj.models) {
		if (typeof m !== "object" || m === null) return false;
		if (typeof m.id !== "string" || !m.id) return false;
		if (typeof m.name !== "string") return false;
		if (m.api !== undefined && (typeof m.api !== "string" || !MODEL_APIS.has(m.api))) return false;
		if (typeof m.reasoning !== "boolean") return false;
		if (!Array.isArray(m.input) || m.input.length === 0) return false;
		if (typeof m.contextWindow !== "number" || m.contextWindow <= 0) return false;
		if (typeof m.maxTokens !== "number" || m.maxTokens <= 0) return false;
		if (typeof m.cost !== "object" || m.cost === null) return false;
		if (typeof m.compat !== "object" || m.compat === null) return false;
		// Family gate: completions models must carry the compat block pi reads
		// (maxTokensField drives the max-tokens wire field). Other families
		// ship an empty block — pi-ai fills in its own defaults.
		const compat = m.compat as Record<string, unknown>;
		if ((m.api ?? "openai-completions") === "openai-completions" && typeof compat.maxTokensField !== "string") {
			return false;
		}
	}
	return true;
}

// ─── OpenCode wire parity ────────────────────────────────────────────────────
//
// Captured from a live opencode v1.18.31 request (its Zen baseUrl pointed at a
// local logger):
//
//   POST /zen/v1/chat/completions
//   authorization:      Bearer public
//   user-agent:         opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
//   x-opencode-client:  cli
//   x-opencode-project: 012780c4098d08caa4ea8c479ed0a4690489f38d
//   x-opencode-session: ses_f4f54dfb4ffenca2ngz8p9R1uA
//   x-opencode-request: msg_0b0ab20c8001bs3RC6w093Nluk
//
// The helpers below mirror opencode's own algorithms so we send the same
// shapes, without depending on opencode's packages:
//
//   headers      packages/opencode/src/session/llm/request.ts
//   project id   packages/core/src/project.ts          (Hash.fast + url())
//   ids          packages/schema/src/identifier.ts     (create())
//
// Zen also gates its free tier on request *shape* (see ensureZenFreeTierShape):
// a free-model call is served only when it streams and carries tools.
//
// Since the 1.17 server checks, OpenCode additionally enforces two wire-level
// facts (9router PR #4105): the User-Agent must carry `opencode/>=1.17` (see
// OPENCODE_MIN_UA_VERSION below), and every `x-opencode-session` must match
// /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/ with a *descending* (bit-inverted)
// timestamp — see opencodeId. The captured pair above is the live evidence:
// `ses_` starts f4f5… exactly because it is the ~complement of the msg_ id's
// 0b0a… timestamp from the same request burst.

/** The AI SDK suffix opencode's OpenAI-compatible client appends to its User-Agent. */
export const OPENCODE_UA_SUFFIX = "ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

/**
 * Verified-good opencode version: OpenCode's server serves the free tier only
 * to `User-Agent: opencode/<version>` with major > 1 or (major === 1 && minor
 * >= 17). Anything older gets 426 Upgrade Required; bare `opencode` or
 * third-party UAs get 403 FreeTierError. Used to clamp stale versions from
 * free-models.json and as the upstream-documented baseline (9router PR #4105).
 */
export const OPENCODE_MIN_UA_VERSION = "1.18.31";

/** Build the User-Agent opencode sends: `opencode/<version> <ai-sdk suffix>`. */
export function opencodeUserAgent(version: string): string {
	return `opencode/${version} ${OPENCODE_UA_SUFFIX}`;
}

/**
 * Clamp a configured opencode version (bare `X.Y[.Z]` as stored in
 * free-models.json) to one Zen accepts. Returns the version untouched when it
 * is >= 1.17, else OPENCODE_MIN_UA_VERSION — the same upgrade 9router applies
 * to bare/outdated downstream UAs: a low version would draw 426 / 403 from
 * OpenCode before the request is ever served.
 */
export function validOpencodeVersion(version: string): string {
	const m = String(version || "").trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
	if (!m) return OPENCODE_MIN_UA_VERSION;
	const major = Number.parseInt(m[1] ?? "", 10);
	const minor = Number.parseInt(m[2] ?? "", 10);
	if (Number.isNaN(major) || Number.isNaN(minor) || major < 1 || (major === 1 && minor < 17)) {
		return OPENCODE_MIN_UA_VERSION;
	}
	return m[0] ?? OPENCODE_MIN_UA_VERSION;
}

/** opencode's id alphabet (base62, in upstream order). */
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 12 hex chars (6 time bytes, most significant first) + 14 base62 bytes. */
function formatOpencodeIdBody(timeBytes: Uint8Array, bodyBytes: Uint8Array): string {
	const time = Array.from(timeBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	const body = Array.from(bodyBytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
	return time + body;
}

/** Bits of the timestamp opencode encodes ahead of the random id bytes. */
const ID_TIME_SHIFT = 0x1000n;

/**
 * Mint an opencode-shaped id: `<prefix>_<12 hex time><14 base62 random>`.
 * Mirrors upstream `create()` including its 12-bit per-millisecond counter and
 * the per-prefix timestamp encoding, so ids sort the way opencode's do.
 *
 * Prefix encoding matches upstream (packages/schema/src/identifier.ts):
 *   - `ses` encodes `~current` (descending): session ids sort newest-first, and
 *     OpenCode's server validates the canonical descending `ses_` shape — the
 *     9router fix (PR #4105) shipped exactly this change after ascending/UUID
 *     sessions started drawing 403 FreeTierError.
 *   - `msg` encodes `current` (ascending): request ids sort oldest-first.
 *
 * Caller contract (not enforced — wrong values corrupt the time field):
 *   - `counter` must be within one millisecond, i.e. 0 <= counter < 4096
 *     (callers keep a per-millisecond counter; see nextRequestId in index.ts)
 *   - `random` must carry at least 14 bytes (exactly the first 14 are used)
 */
export function opencodeId(
	prefix: "ses" | "msg",
	timestamp: number,
	counter: number,
	random: Uint8Array,
): string {
	const current = BigInt(timestamp) * ID_TIME_SHIFT + BigInt(counter);
	// Upstream create(descending): ses_ carries the bitwise complement of the
	// timestamp; msg_ carries it ascending. (`~current` on a positive BigInt is
	// -(current+1); the low-byte mask below extracts the two's-complement bytes
	// opencode uses, so the shapes match upstream exactly.)
	const value = prefix === "ses" ? ~current : current;
	const timeBytes = Uint8Array.from({ length: 6 }, (_, index) =>
		Number((value >> BigInt(40 - 8 * index)) & 0xffn),
	);
	return `${prefix}_${formatOpencodeIdBody(timeBytes, random.subarray(0, 14))}`;
}

/**
 * Deterministic opencode-shaped id derived from a seed. Same wire shape as
 * opencodeId, but stable for a given seed — used to pin pi's session id to an
 * opencode-shaped `ses_...` that survives reconnects (Zen keys its sticky
 * provider routing and prompt cache on the session id).
 */
export function opencodeIdFromSeed(prefix: "ses" | "msg", seed: string): string {
	const digest = createHash("sha1").update(seed).digest();
	return `${prefix}_${formatOpencodeIdBody(digest.subarray(0, 6), digest.subarray(6, 20))}`;
}

/**
 * Normalize a git remote URL the way opencode does (`url()` + `parts()`):
 * `https://github.com/foo/bar.git` and `git@github.com:foo/bar` both become
 * `github.com/foo/bar`.
 */
export function normalizeGitRemote(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	try {
		const parsed = new URL(value);
		if (parsed.protocol === "file:") return undefined;
		return remoteParts(parsed.hostname, parsed.pathname);
	} catch {
		const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/);
		// noUncheckedIndexedAccess: groups are `string | undefined`; both are
		// guaranteed present when the regex matched, just not to the compiler.
		return scp && scp[2] !== undefined && scp[3] !== undefined
			? remoteParts(scp[2], scp[3])
			: undefined;
	}
}

function remoteParts(host: string, name: string): string | undefined {
	const pathname = name
		.replace(/^\/+/, "")
		.replace(/\.git\/?$/, "")
		.replace(/\/+$/, "");
	if (!host || !pathname) return undefined;
	return `${host.toLowerCase()}/${pathname}`;
}

/**
 * opencode's project id for a repo: sha1 of `git-remote:<host/path>`, sent as a
 * bare hex digest in `x-opencode-project`. Non-git directories get `global`.
 */
export function projectIdFromRemote(remoteUrl: string): string | undefined {
	const normalized = normalizeGitRemote(remoteUrl);
	return normalized ? createHash("sha1").update(`git-remote:${normalized}`).digest("hex") : undefined;
}

// ─── Zen free-tier request shape ────────────────────────────────────────────
//
// Zen serves its free models only to requests that look like an agent turn.
// Verified against the live endpoint (Sep 2026), the gate is:
//
//   stream:true  AND  tools containing BOTH the names "bash" AND "read"
//
// plus a `User-Agent` carrying opencode/>=1.17 and an `x-opencode-session`
// matching /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/ (both satisfied by the header
// pipeline in index.ts). Anything else fails 403 with
// `FreeTierError: OpenCode's free tier can only be used from within OpenCode`.
// In particular the tool names must literally be present: a single arbitrary
// placeholder (pi-zen's previous `_zen_noop`), only one of the two names, or a
// pi-style custom tool all draw the 403, while decoys named `bash` + `read`
// are accepted. This is the same cloak 9router ships (open-sse/executors/
// opencode.js, "fix free tier 403 error" — PR/commit 93837af).
//
// pi omits `tools` for tool-less turns (and sends `[]` when replaying tool
// history), so we stand in the two decoys. Their descriptions say they are
// unavailable and must never be called. pi always streams, so the `stream`
// half of the gate is satisfied.
//
// Per-family extras, all verified against the live endpoint / the opencode
// console gateway (`packages/console/app/src/routes/zen` in the opencode v2
// fork) and mirrored from 9router's executor:
//
//   - Chat-completions (big-pickle, mimo, ling, nemotron, …): when the request
//     had no tools, force `tool_choice: "none"` so the model cannot call a
//     decoy it was told is unavailable (200 verified).
//   - Responses (muse-spark): only `tool_choice: "auto"` is supported — `none`
//     draws 400 `only "auto" is supported for "tool_choice"`. Free models run
//     on a pool of shared upstream accounts with `store: false`, and prior-turn
//     reasoning items carry account-bound `encrypted_content` that 400s on
//     replay, so those items are dropped (see sanitizeZenResponsesItems below).
//   - Anthropic-messages (union-alpha): no tool_choice forcing — Anthropic has
//     no "none" and the model is not live anyway (401 "not supported").
//
// The wire wrapper differs per family — chat-completions nests under
// `function`, responses and anthropic are flat.

/** The two tool names Zen's free tier literally requires in `tools`. */
export const ZEN_FREE_TIER_DECOY_TOOL_NAMES = ["bash", "read"] as const;

const ZEN_DECOY_DESCRIPTION =
	"This tool is currently unavailable and must not be used. Do not call it, and do not mention it.";

/** Chat-completions wrapper: `{ type: "function", function: { name, ... } }`. */
export const ZEN_FREE_TIER_DECOY_TOOLS = [
	{ type: "function", function: { name: "bash", description: ZEN_DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } } },
	{ type: "function", function: { name: "read", description: ZEN_DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } } },
];

/** Responses-API wrapper: flat `{ type, name, description, parameters }`. */
const ZEN_FREE_TIER_DECOY_TOOLS_RESPONSES = [
	{ type: "function", name: "bash", description: ZEN_DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } },
	{ type: "function", name: "read", description: ZEN_DECOY_DESCRIPTION, parameters: { type: "object", properties: {} } },
];

/** Anthropic-messages wrapper: flat `{ name, description, input_schema }`. */
const ZEN_FREE_TIER_DECOY_TOOLS_ANTHROPIC = [
	{ name: "bash", description: ZEN_DECOY_DESCRIPTION, input_schema: { type: "object", properties: {} } },
	{ name: "read", description: ZEN_DECOY_DESCRIPTION, input_schema: { type: "object", properties: {} } },
];

/**
 * Result of shaping a request for Zen's free tier: the (mutated) payload plus a
 * predicate answering "is this tool call a decoy that must be blocked?" for
 * exactly the names this call stood in. Null when nothing was injected — the
 * payload already carried real `bash`/`read` tools, or was passed through
 * untouched (google family / non-object payloads). The predicate never matches
 * real tools: pi registers its own `bash`/`read`, so blanket blocking by name
 * would break genuine tool turns.
 */
export type ZenDecoyInjection = {
	/** The (mutated) request payload — the same reference callers passed in. */
	payload: Record<string, unknown>;
	/** True only for decoy tools stood in by this call, never real tools. */
	shouldBlock: (toolName: string) => boolean;
} | null;

/**
 * Muse (openai-responses family) is served from a pool of shared upstream
 * accounts ("Bearer public" routes to whichever pooled account the gateway
 * sticks you on). Responses-API reasoning items carry `encrypted_content` that
 * is bound to the exact upstream account that issued it; replaying it on a
 * later turn — which may land on a different pooled account, and which is
 * rejected as deleted under `store: false` — draws:
 *
 *   [invalid_request_error] reasoning `encrypted_content` was not issued to
 *   this caller (400)
 *
 * so prior reasoning items are dropped and stray encrypted fields are cleared.
 * Same sanitization 9router applies (`sanitizeResponsesItems`). No-op for
 * payloads without an `input` array.
 */
export function sanitizeZenResponsesItems(payload: Record<string, unknown>): void {
	const input = payload.input;
	if (!Array.isArray(input)) return;
	for (const item of input) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const obj = item as Record<string, unknown>;
		delete obj.encrypted_content;
		delete obj.reasoning_encrypted_content;
	}
	payload.input = input.filter(
		(item) => !(item && typeof item === "object" && (item as Record<string, unknown>).type === "reasoning"),
	);
}

/**
 * Internal: build the `shouldBlock` predicate for the decoy names a call stood
 * in. Closes over exactly the names injected by that call, so real pi tools
 * (which share the `bash`/`read` names on genuine tool turns) are never
 * matched.
 */
function decoyBlocker(names: readonly string[]): (toolName: string) => boolean {
	return (toolName) => names.includes(toolName);
}

/**
 * Guarantee the request shape Zen's free tier requires: a `tools` array that
 * contains both `bash` and `read`. Shapes `payload` in place and returns the
 * same reference plus a `shouldBlock` predicate covering exactly the decoy
 * names this call stood in; returns `null` when nothing was needed (the
 * payload already carries real `bash`/`read`, is not a plain request object,
 * or the family is skipped).
 *
 * - No tools / empty `tools` → stand in BOTH decoys; on chat-completions (and
 *   unknown families, which default to its shape) force `tool_choice: "none"`
 *   (when absent) so the model cannot call a decoy it was told is unavailable.
 * - `tools` present but missing a decoy name → append the missing ones
 *   (mirrors 9router; keeps the gate green for tool sets that omit bash/read);
 *   `tool_choice` is left untouched — pi's own choice governs real tools.
 * - Responses family (muse-spark) additionally gets `store: false`, a
 *   `tool_choice` coerced to `"auto"` (the only value upstream accepts), and
 *   prior-turn reasoning items dropped (see sanitizeZenResponsesItems).
 *
 * `api` picks the wrapper for the payload's endpoint family; callers resolve
 * it from the request's model id (the before_provider_request event carries no
 * headers). `google-generative-ai` is skipped — no free model uses it today
 * and its tool shape (`functionDeclarations`) differs from all three wrappers,
 * so the payload is left untouched rather than mangled. Unknown families
 * default to chat-completions, the family every other free model uses.
 */
export function ensureZenFreeTierShape(payload: unknown, api?: ModelApi): ZenDecoyInjection {
	if (api === "google-generative-ai") return null;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const obj = payload as Record<string, unknown>;

	// Muse invariants (Responses family) hold for every request, tools or not.
	if (api === "openai-responses") {
		obj.store = false;
		if (obj.tool_choice !== undefined && obj.tool_choice !== "auto") obj.tool_choice = "auto";
		sanitizeZenResponsesItems(obj);
	}

	const tools = Array.isArray(obj.tools) ? obj.tools : null;
	if (tools === null || tools.length === 0) {
		obj.tools =
			api === "openai-responses"
				? ZEN_FREE_TIER_DECOY_TOOLS_RESPONSES
				: api === "anthropic-messages"
					? ZEN_FREE_TIER_DECOY_TOOLS_ANTHROPIC
					: ZEN_FREE_TIER_DECOY_TOOLS;
		// Chat-completions — and unknown families, which default to its shape —
		// can force "none" (verified 200); Responses cannot (already coerced to
		// "auto" above); Anthropic has no "none".
		if (api !== "openai-responses" && api !== "anthropic-messages" && obj.tool_choice === undefined) {
			obj.tool_choice = "none";
		}
		return { payload: obj, shouldBlock: decoyBlocker(ZEN_FREE_TIER_DECOY_TOOL_NAMES) };
	}
	// Tools exist — but the gate only passes when BOTH names are present.
	const names = new Set(
		tools
			.map((tool) => {
				const t = tool as { name?: unknown; function?: { name?: unknown } };
				return typeof t?.function?.name === "string"
					? t.function.name
					: typeof t?.name === "string"
						? t.name
						: "";
			})
			.filter((name) => name !== ""),
	);
	const missing: string[] = ZEN_FREE_TIER_DECOY_TOOL_NAMES.filter((name) => !names.has(name));
	if (missing.length === 0) return null;
	const appended =
		api === "openai-responses"
			? ZEN_FREE_TIER_DECOY_TOOLS_RESPONSES.filter((tool) => missing.includes(tool.name))
			: api === "anthropic-messages"
				? ZEN_FREE_TIER_DECOY_TOOLS_ANTHROPIC.filter((tool) => missing.includes(tool.name))
				: ZEN_FREE_TIER_DECOY_TOOLS.filter((tool) => missing.includes(tool.function.name));
	obj.tools = [...tools, ...appended];
	return { payload: obj, shouldBlock: decoyBlocker(missing) };
}
