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

/** The AI SDK suffix opencode's OpenAI-compatible client appends to its User-Agent. */
export const OPENCODE_UA_SUFFIX = "ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

/** Build the User-Agent opencode sends: `opencode/<version> <ai-sdk suffix>`. */
export function opencodeUserAgent(version: string): string {
	return `opencode/${version} ${OPENCODE_UA_SUFFIX}`;
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
 * Mirrors upstream `create()` including its 12-bit per-millisecond counter, so
 * ids sort by creation time the way opencode's do.
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
	const timeBytes = Uint8Array.from({ length: 6 }, (_, index) =>
		Number((current >> BigInt(40 - 8 * index)) & 0xffn),
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

/**
 * Placeholder tool injected when a request carries none.
 *
 * Zen serves its free models only to requests that look like an agent turn —
 * verified against the live endpoint: `stream: true` plus a non-empty `tools`
 * array, or the call fails 403 with
 * `FreeTierError: OpenCode's free tier can only be used from within OpenCode`.
 * pi omits `tools` for tool-less turns (and sends `[]` when replaying tool
 * history), so we stand in a tool that must never be called — the same trick
 * opencode itself uses for GitHub Copilot requests without tools.
 *
 * The name is shared across api families; only the wire wrapper differs
 * (chat-completions nests under `function`, responses and anthropic are flat).
 * pi always streams, so the `stream` half of the gate is already satisfied.
 */
export const ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAME = "_zen_noop";

const ZEN_PLACEHOLDER_DESCRIPTION =
	"Compatibility placeholder. Do not call this tool, and do not mention it. It must never be invoked.";

/** Chat-completions wrapper: `{ type: "function", function: { name, ... } }`. */
export const ZEN_FREE_TIER_PLACEHOLDER_TOOL = {
	type: "function",
	function: {
		name: ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAME,
		description: ZEN_PLACEHOLDER_DESCRIPTION,
		parameters: {
			type: "object",
			properties: { reason: { type: "string", description: "Unused" } },
			required: [],
		},
	},
};

/** Responses-API wrapper: flat `{ type, name, description, parameters }`. */
const ZEN_FREE_TIER_PLACEHOLDER_TOOL_RESPONSES = {
	type: "function",
	name: ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAME,
	description: ZEN_PLACEHOLDER_DESCRIPTION,
	parameters: {
		type: "object",
		properties: { reason: { type: "string", description: "Unused" } },
	},
};

/** Anthropic-messages wrapper: flat `{ name, description, input_schema }`. */
const ZEN_FREE_TIER_PLACEHOLDER_TOOL_ANTHROPIC = {
	name: ZEN_FREE_TIER_PLACEHOLDER_TOOL_NAME,
	description: ZEN_PLACEHOLDER_DESCRIPTION,
	input_schema: {
		type: "object",
		properties: { reason: { type: "string", description: "Unused" } },
	},
};

/**
 * Guarantee the request shape Zen's free tier requires: a non-empty `tools`
 * array. Returns the same (mutated) payload. Anything that isn't a plain
 * request object is passed through untouched.
 *
 * `api` picks the tool wrapper for the payload's endpoint family; callers
 * resolve it from the request's model id (the before_provider_request event
 * carries no headers). `google-generative-ai` is skipped — no free model uses
 * it today and its tool shape differs; unknown families default to
 * chat-completions, the family every other free model uses.
 */
export function ensureZenFreeTierShape(payload: unknown, api?: ModelApi): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	const obj = payload as Record<string, unknown>;
	const tools = obj.tools;
	if (Array.isArray(tools) && tools.length > 0) return obj;
	obj.tools =
		api === "openai-responses"
			? [ZEN_FREE_TIER_PLACEHOLDER_TOOL_RESPONSES]
			: api === "anthropic-messages"
				? [ZEN_FREE_TIER_PLACEHOLDER_TOOL_ANTHROPIC]
				: [ZEN_FREE_TIER_PLACEHOLDER_TOOL];
	return obj;
}
