/**
 * Shared types and pure helpers for pi-zen.
 *
 * No dependencies on pi's ExtensionAPI and no I/O — consumed by:
 *   - index.ts (the extension)
 *   - build-free-models.mjs (the GitHub Action, via its own copies of the helpers)
 *   - scripts/canary.mjs (the live free-tier probe)
 *
 * The helpers here are the single source of truth for the logic they encode.
 * The build script duplicates them because it runs in a plain Node context
 * without TypeScript strip-types; the duplication is acceptable for <30 lines
 * of stable, self-contained code.
 */

import { createHash } from "node:crypto";

// ─── Provider identity ───────────────────────────────────────────────────────

/**
 * The provider id this extension registers. Lives here rather than in index.ts
 * so registration and every provider-id comparison agree on one constant.
 */
export const ZEN_PROVIDER_ID = "pi-zen";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * pi API families Zen serves. Determines which endpoint/model config pi uses.
 * Not all of them have a client in pi — see isSpeakableApi below.
 */
export type ModelApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "systemone";

/**
 * Every family, in one record keyed by ModelApi: adding a family is one line
 * here, and forgetting it is a type error rather than a model that silently
 * passes validation and then fails to register. The two facts callers need
 * — may the curated list carry this family, may the picker register it — are
 * derived from this record, never re-stated.
 *
 * `speakable: false` for `systemone` (Jev, TypeSafe AI): Zen serves it on
 * /zen/v1/systemone, a structured-evaluation protocol that answers typed
 * questions with values and probabilities — not chat turns, so pi has no wire
 * client for it. Flip it to `true` when pi ships a SystemOne client; the
 * curated list already carries each model's `endpoint`, so no other file
 * changes. See registerProvider in index.ts for the filter this drives.
 */
const API_FAMILIES: Readonly<Record<ModelApi, { speakable: boolean }>> = {
	"openai-completions": { speakable: true },
	"openai-responses": { speakable: true },
	"anthropic-messages": { speakable: true },
	"google-generative-ai": { speakable: true },
	systemone: { speakable: false },
};

/** May the curated list carry this family? (Type guard for the validator.) */
export function acceptsCuratedApi(api: string): api is ModelApi {
	return Object.prototype.hasOwnProperty.call(API_FAMILIES, api);
}

/**
 * May the picker register a model on this family? `undefined` means
 * openai-completions — the family a model without an `api` field gets.
 */
export function isSpeakableApi(api: ModelApi | undefined): boolean {
	return API_FAMILIES[api ?? "openai-completions"].speakable;
}

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
	/**
	 * Absolute endpoint URL this model is served on, carried verbatim from the
	 * docs table — the raw source `api` was derived from. Absent only in lists
	 * generated before this field existed.
	 */
	endpoint?: string;
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
 * provider) because Zen free models span several families, while auth, base
 * URL, and headers stay shared at the provider level.
 */
export type ZenModelConfig = {
	id: string;
	name: string;
	/** Endpoint family to reach this model on Zen. Absent = openai-completions. */
	api?: ModelApi;
	/** Exact endpoint URL, when the curated list carried one. */
	endpoint?: string;
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
		endpoint: entry.endpoint,
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
		if (m.api !== undefined && (typeof m.api !== "string" || !acceptsCuratedApi(m.api))) return false;
		if (
			m.endpoint !== undefined &&
			(typeof m.endpoint !== "string" || !/^https?:\/\//.test(m.endpoint))
		) {
			return false;
		}
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
//   POST /inference/v1/chat/completions
//   authorization:      Bearer public
//   user-agent:         opencode/latest/2.0.26/cli
//   x-opencode-client:  cli
//   x-opencode-project: 012780c4098d08caa4ea8c479ed0a4690489f38d
//   x-opencode-session: ses_f4f54dfb4ffenca2ngz8p9R1uA
//   x-opencode-session-id / x-session-affinity / x-session-id: same ses_ value
//   (the v1 `x-opencode-request` header is GONE — v2 rejects it with 403)
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
// Since OpenCode v2 (2026-10-14, 9router #4842) the server enforces the v2
// User-Agent shape: `opencode/<channel>/<major>.x.y/<client>` with major >= 2.
// The v1 form (`opencode/1.18.x`, optionally with the AI-SDK suffix) is
// rejected with 403 FreeTierError, as is any `x-opencode-request` header.
// Every `x-opencode-session` must still match
// /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/ with a *descending* (bit-inverted)
// timestamp — see opencodeId. The captured pair above is the live evidence:
// `ses_` starts f4f5… exactly because it is the ~complement of the msg_ id's
// 0b0a… timestamp from the same request burst.

/** Verified-good opencode v2 identity parts (from the 2.0.26 CLI, via 9router #4842). */
export const OPENCODE_UA_CHANNEL = "latest";
export const OPENCODE_UA_VERSION = "2.0.26";
export const OPENCODE_UA_CLIENT = "cli";

/**
 * Build the User-Agent opencode v2 sends:
 * `opencode/<channel>/<version>/<client>`.
 *
 * `version` is optional and defensive: a bare v2 version (major >= 2, e.g.
 * scraped from a newer snapshot) is used verbatim; anything else — v1
 * versions from older snapshots, junk — clamps to the pinned verified-good
 * OPENCODE_UA_VERSION, so the header can never regress into a 403.
 */
export function opencodeUserAgent(version?: string): string {
	return `opencode/${OPENCODE_UA_CHANNEL}/${validOpencodeVersion(version)}/${OPENCODE_UA_CLIENT}`;
}

/**
 * Clamp a configured opencode version (bare `X.Y.Z` as stored in
 * free-models.json) to one the v2 server accepts. Returns the version
 * untouched when it has major >= 2, else OPENCODE_UA_VERSION — the same clamp
 * 9router applies to outdated downstream UAs: a v1 form or low version draws
 * 403 FreeTierError from OpenCode before the request is ever served.
 */
export function validOpencodeVersion(version?: string): string {
	const m = String(version ?? "").trim().match(/^(\d+)\.\d+\.\d+/);
	if (m && Number.parseInt(m[1] ?? "", 10) >= 2) return m[0] ?? OPENCODE_UA_VERSION;
	return OPENCODE_UA_VERSION;
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
 *   - `counter` must be a real per-millisecond count and stay SMALL: v2
 *     decodes it and rejects values >= ~100 with 403 FreeTierError (9router
 *     #4842 live probes: 0–16 pass, >= 100 fail). Callers reset a per-ms
 *     counter every millisecond (see nextRequestId in index.ts); a session id
 *     minted once per conversation uses 0.
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

// ─── Zen canary ─────────────────────────────────────────────────────────────
//
// The canary (scripts/canary.mjs, run daily by .github/workflows/canary.yml)
// is the authority on whether the shipped wire recipe still passes Zen's
// free-tier gate. Two consumers read its output:
//
//   - canaryVerdict: the workflow's exit code -> GitHub emails on failure.
//   - canaryHealth:  the extension's registration gate. The verdict is
//     committed as canary-status.json on the data branch; a broken verdict
//     keeps the free models OUT of the /model picker and replaces the
//     session-start message with one honest warning, instead of letting
//     every turn fail with a raw 403.
//
// Freshness policy: a verdict older than CANARY_STALE_MS (or a missing /
// malformed status file) is "unknown" — absence of evidence is not breakage,
// so the models register and behave exactly as today; the in-session 403 copy
// still catches real breakage in that window. "inconclusive" (all-429) is
// likewise not breakage: no evidence either way.

/** Age past which a canary verdict is stale enough to distrust. */
export const CANARY_STALE_MS = 48 * 60 * 60 * 1000;

/** Shape of canary-status.json as the canary writes it (scripts/canary.mjs). */
export type CanaryStatus = {
	verdict: string;
	checkedAt: string;
	probed: string[];
};

/** The extension's belief about the bridge, derived from a canary status. */
export type CanaryHealth = "healthy" | "broken" | "unknown";

/**
 * Classify a canary status for the registration gate. Pure: the caller owns
 * fetching (index.ts) and the test owns the clock.
 */
/**
 * A canary status that passed the shape + freshness gate, or undefined.
 * Internal: the one definition of a usable read, shared by canaryHealth and
 * resolveCanaryStatus so the two can never disagree about what "fresh" means.
 */
function asFreshCanaryStatus(
	status: unknown,
	now: number,
): { checkedAt: string; verdict: "fail" | "inconclusive" | "pass" } | undefined {
	if (typeof status !== "object" || status === null) return undefined;
	const { verdict, checkedAt } = status as Record<string, unknown>;
	if (typeof verdict !== "string" || typeof checkedAt !== "string") return undefined;
	if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") return undefined;
	const checked = Date.parse(checkedAt);
	if (!Number.isFinite(checked)) return undefined;
	if (now - checked > CANARY_STALE_MS) return undefined;
	return { verdict, checkedAt };
}

export function canaryHealth(status: unknown, now: number): CanaryHealth {
	const fresh = asFreshCanaryStatus(status, now);
	if (!fresh) return "unknown";
	return fresh.verdict === "fail" ? "broken" : "healthy";
}

/**
 * Pick the canary status the registration gate should trust when the two
 * mirrors of canary-status.json disagree.
 *
 * The file lives on the data branch and reaches the extension through two
 * caches with very different lag: the jsDelivr edge (up to 12 h stale until
 * its purge API fires) and raw.githubusercontent.com (Fastly, max-age=300 —
 * at most ~5 min stale). On differing verdicts the origin read is the
 * fresher evidence: the mirror can pin a dead "fail" for half a day after
 * the free tier recovered (Oct 2026 — the gate hid the models for hours
 * after the canary had re-passed) or a dead "pass" after a real gate change.
 * A stale or unusable origin read defers to the mirror untouched, and the
 * returned status still goes through canaryHealth, so this never publishes
 * a verdict the gate would call "unknown". Pure: the caller owns fetching.
 */
export function resolveCanaryStatus(mirror: unknown, origin: unknown, now: number): unknown {
	const fromMirror = asFreshCanaryStatus(mirror, now);
	const fromOrigin = asFreshCanaryStatus(origin, now);
	if (!fromOrigin) return mirror;
	if (!fromMirror) return origin;
	return fromMirror.verdict === fromOrigin.verdict ? mirror : origin;
}

// ─── Canary run verdict ─────────────────────────────────────────────────────
//
// The alert policy for scripts/canary.mjs, the daily live probe of the
// free-tier gate (the regression class unit tests cannot catch — the Oct 2026
// 403 arrived with every test green). Classification, pure so tests can pin
// it (tests/canary-verdict.test.ts):
//
//   "pass"          — at least one candidate served with the shipped recipe
//   "inconclusive"  — every candidate rate-limited (429): anonymous access is
//                     IP-limited and CI runners share IPs, so rate limiting
//                     is not evidence of a gate change. Paging on this would
//                     train the user to ignore alerts.
//   "fail"          — 403 on every candidate (gate changed upstream) or any
//                     other status across the board (Zen-side failure)
//
// A single "pass" settles it: candidates exist so one delisted model does not
// page anyone.

/**
 * Classify a canary run from its per-candidate HTTP statuses (-1 = network
 * error). Consumed by scripts/canary.mjs; the workflow sees only its exit code.
 */
export function canaryVerdict(statuses: number[]): "pass" | "inconclusive" | "fail" {
	if (statuses.includes(200)) return "pass";
	if (statuses.every((s) => s === 429)) return "inconclusive";
	return "fail";
}

// ─── Zen free-tier request shape ────────────────────────────────────────────
//
// Zen serves its free models only to requests that look like opencode v2 CLI
// traffic. Verified upstream (9router #4842, Oct 2026), the gate is:
//
//   stream:true  AND  a `tools` array carrying opencode's own `read` and
//                     `shell` tools with their EXACT v2 descriptions and
//                     parameter schemas
//
// plus the identity headers from the wire-parity section above. Anything else
// fails 403 with `FreeTierError: OpenCode's free tier can only be used from
// within OpenCode`. The v1 cloak pi-zen shipped (a "file-search quartet" of
// stub-described decoys plus `tool_choice: "none"`) is rejected by the v2
// gate: stubbed descriptions, renamed schemas and `tool_choice: "none"` all
// draw the 403.
//
// pi omits `tools` for tool-less turns, and pi's real tool set collides with
// the fingerprint names (`read`), so the shaping pass (ensureZenFreeTierShape):
//
//   1. resolves caller tools whose name is exactly `read`/`shell` but whose
//      definition differs from opencode's. When the caller's schema accepts
//      calls shaped by the fingerprint schema (pi's native `read` does: same
//      path/offset/limit fields), the tool KEEPS its name and only its wire
//      description and parameters are swapped to opencode's verbatim def — a
//      model call to `read` then dispatches to the caller's real tool and
//      nothing is blocked. Only an incompatible schema (a foreign `read` with
//      different fields) falls back to alias concealment: the tool travels
//      under a `read_client`-style alias, with explicit `tool_choice` objects
//      and prior-turn tool calls retargeted to the alias (definition matches
//      pass through untouched);
//   2. appends opencode's verbatim definition for every fingerprint name not
//      already declared — after a successful swap that is normally `shell`
//      alone, since pi has no tool of that name;
//   3. appends a system note telling the model the appended tools are
//      placeholders. Wording matters: without the old "must not be used"
//      descriptions the model does call the appended tools (live probe:
//      `read` on "what files are in /etc?"), and "not available" made it also
//      refuse the caller's own Read tool — the note names the real substitute
//      (`bash` for commands) so a stray call self-corrects on the next try;
//   4. injects a `reasoning_content` placeholder into assistant history
//      messages that lack one: Zen reasoning models reject multi-turn chats
//      without it (400 missing_required_parameter), and the response pipeline
//      strips the field before it reaches the client, so the echo can never
//      come from the client (9router #4805).
//
// The return value carries the response-side half of the recipe: shouldBlock
// (block calls to the placeholders), restoreToolName (map aliases back to the
// caller's names), and aliasFor (the inverse — which wire name a blocked
// fingerprint name should be retried as) — see ZenShapedRequest.

/** The tool names Zen's free tier requires in `tools`: opencode's own. */
export const ZEN_FINGERPRINT_TOOL_NAMES = ["read", "shell"] as const;

// Verbatim from the OpenCode v2.0.26 CLI (9router #4842). Upstream compares
// description and parameters, so do not reword or reformat these. Exported
// for tests and callers that must build a definition-exact tool.
export const ZEN_FINGERPRINT_DEFINITIONS: Record<
	string,
	{ description: string; parameters: Record<string, unknown> }
> = {
	read: {
		description:
			"Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File or directory to read" },
				offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
				limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
	shell: {
		description:
			"Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command string to execute" },
				workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
				timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
				background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when they complete. DO NOT poll for completion." },
			},
			required: ["command"],
			additionalProperties: false,
		},
	},
};

/** Read a tool's name from any of the three wire shapes (flat, chat, anthropic). */
function zenToolNameOf(tool: unknown): string {
	if (!tool || typeof tool !== "object") return "";
	const t = tool as { name?: unknown; function?: { name?: unknown } };
	if (typeof t.name === "string" && t.name.trim()) return t.name.trim();
	if (typeof t.function?.name === "string" && t.function.name.trim()) return t.function.name.trim();
	return "";
}

/** True when `tool` already carries opencode's exact v2 definition for `key`. */
function isFingerprintDefinition(tool: unknown, key: string): boolean {
	if (!tool || typeof tool !== "object") return false;
	const t = tool as { function?: unknown; description?: unknown; parameters?: unknown; input_schema?: unknown };
	// Chat shape nests under `function`; responses/anthropic are flat.
	const def = (t.function && typeof t.function === "object" ? t.function : t) as typeof t;
	const want = ZEN_FINGERPRINT_DEFINITIONS[key];
	if (!want || typeof def.description !== "string" || def.description !== want.description) return false;
	const params = def.parameters !== undefined ? def.parameters : def.input_schema;
	return JSON.stringify(params) === JSON.stringify(want.parameters);
}

/**
 * True when the caller's tool schema accepts calls shaped by opencode's
 * fingerprint schema for `read` — same field names and types — so its wire
 * definition can be swapped to the verbatim def without breaking execution.
 * Anything else (a foreign `read` with extra or differently typed fields)
 * falls back to alias concealment.
 */
function isWireCompatibleRead(tool: unknown): boolean {
	if (!tool || typeof tool !== "object") return false;
	const t = tool as { function?: unknown; parameters?: unknown; input_schema?: unknown };
	const fn = t.function && typeof t.function === "object" ? (t.function as Record<string, unknown>) : t;
	const raw = fn.parameters ?? t.input_schema;
	if (!raw || typeof raw !== "object") return false;
	const params = raw as Record<string, unknown>;
	if (params.type !== "object") return false;
	if (!params.properties || typeof params.properties !== "object") return false;
	const props = params.properties as Record<string, unknown>;
	const names = Object.keys(props);
	if (!names.includes("path")) return false;
	if (!names.every((n) => n === "path" || n === "offset" || n === "limit")) return false;
	const pathType = (props.path as Record<string, unknown> | undefined)?.type;
	if (pathType !== "string") return false;
	for (const n of ["offset", "limit"] as const) {
		if (!(n in props)) continue;
		const ty = (props[n] as Record<string, unknown>).type;
		if (ty !== "number" && ty !== "integer") return false;
	}
	const required = Array.isArray(params.required) ? (params.required as unknown[]) : [];
	return required.includes("path") && required.every((r) => r === "path" || r === "offset" || r === "limit");
}

/**
 * Overwrite a tool's description and parameter schema with opencode's verbatim
 * fingerprint def for `key`, keeping its wire shape and — critically — its
 * name. The gate compares description and parameters, so the swapped tool
 * satisfies it without an alias; calls to the name still dispatch to the
 * caller's real tool.
 */
function swapFingerprintDef(tool: unknown, key: string): Record<string, unknown> {
	const def = ZEN_FINGERPRINT_DEFINITIONS[key];
	if (!def) return tool as Record<string, unknown>;
	const t = tool as Record<string, unknown>;
	if (t.function && typeof t.function === "object") {
		return { ...t, function: { ...(t.function as Record<string, unknown>), description: def.description, parameters: def.parameters } };
	}
	if (t.input_schema !== undefined) {
		return { ...t, description: def.description, input_schema: def.parameters };
	}
	return { ...t, description: def.description, parameters: def.parameters };
}

/** Wrap opencode's definition for `name` in the payload's endpoint-family shape. */
function fingerprintTool(name: string, api: ModelApi | undefined): Record<string, unknown> {
	const def = ZEN_FINGERPRINT_DEFINITIONS[name];
	if (!def) return {};
	const { description, parameters } = def;
	if (api === "openai-responses") return { type: "function", name, description, parameters };
	if (api === "anthropic-messages") return { name, description, input_schema: parameters };
	return { type: "function", function: { name, description, parameters } };
}

/** Copy a tool with a new name, keeping its wire shape. */
function withZenToolName(tool: unknown, name: string): Record<string, unknown> {
	const t = tool as Record<string, unknown>;
	if (t.function && typeof t.function === "object") {
		return { ...t, function: { ...(t.function as Record<string, unknown>), name } };
	}
	return { ...t, name };
}

/**
 * Result of shaping a request for Zen's free tier — the caller-facing half of
 * the recipe. `payload` is the same (mutated) reference the caller passed in;
 * `shouldBlock` answers "is this tool call one of the placeholders stood in by
 * this shaping pass?" (never a real caller tool); `restoreToolName` maps a
 * concealed alias (`read_client`) back to the caller's original tool name
 * (identity for anything else). Both close over exactly what this pass did,
 * so they are safe to hold until the response arrives.
 */
export type ZenShapedRequest = {
	/** The (mutated) request payload — the same reference callers passed in. */
	payload: Record<string, unknown>;
	/** True only for placeholder tools appended by this call, never real tools. */
	shouldBlock: (toolName: string) => boolean;
	/** Map a model tool-call name back to the caller's original (identity otherwise). */
	restoreToolName: (toolName: string) => string;
	/**
	 * The wire alias a concealed fingerprint name traveled under, when one
	 * exists — the inverse of restoreToolName. Block copy uses it to tell the
	 * model which name actually executes; undefined when the name was appended
	 * as a placeholder with no caller tool behind it.
	 */
	aliasFor: (toolName: string) => string | undefined;
};

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
 * Guarantee the request shape Zen's free tier requires (see the section
 * comment above). Shapes `payload` in place and returns the same reference
 * plus the response-side callbacks; returns `null` when the family is skipped
 * (google-generative-ai) or the payload is not a plain request object.
 *
 * `api` picks the wire shape for the payload's endpoint family; callers
 * resolve it from the request's model id (the before_provider_request event
 * carries no headers). Unknown families default to chat-completions, the
 * family every free model but muse-spark and union-alpha uses.
 *
 * Per-family extras, all mirrored from 9router's executor:
 *   - Responses (muse-spark): `store: false` (free models run on a pool of
 *     shared upstream accounts), `tool_choice` coerced to `"auto"` (the only
 *     value upstream accepts), and prior-turn reasoning items dropped (see
 *     sanitizeZenResponsesItems).
 *   - Chat-completions: a `tool_choice: "none"` (v1's decoy guard) is now
 *     REMOVED — v2 rejects it with 403 FreeTierError; the system note plus
 *     the shouldBlock guard keep the placeholders uncalled.
 *   - Anthropic-messages (union-alpha): no tool_choice handling — Anthropic
 *     has no "none" and the model is not live anyway (401 "not supported").
 */
export function ensureZenFreeTierShape(payload: unknown, api?: ModelApi): ZenShapedRequest | null {
	if (api === "google-generative-ai") return null;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
	const obj = payload as Record<string, unknown>;

	// Muse invariants (Responses family) hold for every request, tools or not.
	if (api === "openai-responses") {
		obj.store = false;
		// "auto" is the only tool_choice upstream accepts on the Responses lane,
		// and it must always be present (9router #4842).
		obj.tool_choice = "auto";
		sanitizeZenResponsesItems(obj);
	} else if (obj.tool_choice === "none") {
		delete obj.tool_choice;
	}

	const tools = Array.isArray(obj.tools) ? [...obj.tools] : [];
	const aliases: { alias: string; original: string }[] = [];

	// 1. Conceal caller tools that collide with a fingerprint name but are not
	//    opencode's own definition of it.
	const taken = new Set<string>(tools.map(zenToolNameOf).filter((name) => name !== ""));
	const seenFingerprint = new Set<string>();
	const shaped: unknown[] = [];
	for (const tool of tools) {
		const key = ZEN_FINGERPRINT_TOOL_NAMES.find((n) => n === zenToolNameOf(tool));
		if (!key) {
			shaped.push(tool);
			continue;
		}
		// Duplicate declarations of one name are rejected upstream; keep the first.
		if (seenFingerprint.has(key)) continue;
		seenFingerprint.add(key);
		if (isFingerprintDefinition(tool, key)) {
			shaped.push(tool);
			continue;
		}
		// Wire-compatible schema: keep the caller's name and swap only the
		// description and parameters to opencode's verbatim def. The name now
		// points at the caller's real tool, so a model call to it executes
		// normally — no alias, no placeholder to block.
		if (key === "read" && isWireCompatibleRead(tool)) {
			shaped.push(swapFingerprintDef(tool, key));
			continue;
		}
		let alias = `${key}_client`;
		for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
		taken.add(alias);
		aliases.push({ alias, original: key });
		shaped.push(withZenToolName(tool, alias));
	}

	// 2. Append opencode's verbatim definition for every fingerprint name not
	//    already declared.
	const appended: string[] = [];
	const present = new Set(shaped.map(zenToolNameOf));
	for (const name of ZEN_FINGERPRINT_TOOL_NAMES) {
		if (present.has(name)) continue;
		shaped.push(fingerprintTool(name, api));
		appended.push(name);
	}
	obj.tools = shaped;

	// 3. Tell the model the appended tools are placeholders.
	noteUnavailableTools(obj, api, appended);

	// Retarget explicit tool_choice and prior-turn calls to the aliases.
	if (aliases.length > 0) {
		retargetZenToolChoice(obj, aliases);
		aliasZenHistoryToolCalls(obj, aliases);
	}

	// 4. reasoning_content placeholder for assistant history — chat family
	//    only (the field is an OpenAI chat-completions extension; Responses
	//    carries reasoning as separate input items, Anthropic as thinking
	//    blocks). Injected for every Zen chat model: upstream ships the rule
	//    provider-wide because non-reasoning models ignore the field while
	//    reasoning models 400 without it (9router #4805, scope "all").
	if (api !== "openai-responses" && api !== "anthropic-messages" && Array.isArray(obj.messages)) {
		obj.messages = (obj.messages as Record<string, unknown>[]).map((m) => {
			const rc = m?.reasoning_content;
			if (m?.role !== "assistant" || (typeof rc === "string" && rc.length > 0)) return m;
			return { ...m, reasoning_content: " " };
		});
	}

	const appendedSet = new Set(appended);
	const originalByAlias = new Map(aliases.map((a) => [a.alias, a.original]));
	const aliasByOriginal = new Map(aliases.map((a) => [a.original, a.alias]));
	return {
		payload: obj,
		shouldBlock: (toolName) => appendedSet.has(toolName),
		restoreToolName: (toolName) => originalByAlias.get(toolName) ?? toolName,
		aliasFor: (toolName) => aliasByOriginal.get(toolName),
	};
}

/**
 * Point an explicit `tool_choice` at the alias of a concealed caller tool, so
 * a forced choice keeps forcing the caller's actual tool. Handles the chat
 * (`{ function: { name } }`) and flat (`{ name }`) object shapes; string
 * choices ("auto", …) need no retargeting.
 */
function retargetZenToolChoice(
	obj: Record<string, unknown>,
	aliases: { alias: string; original: string }[],
): void {
	const choice = obj.tool_choice;
	if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
	const byOriginal = new Map(aliases.map((a) => [a.original, a.alias]));
	const c = choice as { name?: unknown; function?: { name?: unknown } };
	if (typeof c.name === "string" && byOriginal.has(c.name.trim())) {
		obj.tool_choice = { ...(choice as Record<string, unknown>), name: byOriginal.get(c.name.trim()) };
		return;
	}
	const fn = c.function;
	if (fn && typeof fn === "object" && typeof fn.name === "string" && byOriginal.has(fn.name.trim())) {
		obj.tool_choice = {
			...(choice as Record<string, unknown>),
			function: { ...(fn as Record<string, unknown>), name: byOriginal.get(fn.name.trim()) },
		};
	}
}

/**
 * Rename prior-turn tool calls to concealed caller tools as well; otherwise
 * the model reads its own earlier calls as calls to opencode's tool of the
 * same name. Covers the chat (`messages[].tool_calls[].function.name`) and
 * Responses (`input[]` function_call items) histories; the anthropic family
 * is not live (401) and is left alone.
 */
function aliasZenHistoryToolCalls(
	obj: Record<string, unknown>,
	aliases: { alias: string; original: string }[],
): void {
	if (aliases.length === 0) return;
	const byOriginal = new Map(aliases.map((a) => [a.original, a.alias]));

	if (Array.isArray(obj.input)) {
		obj.input = (obj.input as Record<string, unknown>[]).map((item) =>
			item?.type === "function_call" && typeof item.name === "string" && byOriginal.has(item.name)
				? { ...item, name: byOriginal.get(item.name) }
				: item,
		);
	}

	if (Array.isArray(obj.messages)) {
		obj.messages = (obj.messages as Record<string, unknown>[]).map((msg) => {
			if (!Array.isArray(msg?.tool_calls)) return msg;
			return {
				...msg,
				tool_calls: (msg.tool_calls as { function?: { name?: unknown } }[]).map((call) =>
					typeof call?.function?.name === "string" && byOriginal.has(call.function.name)
						? { ...call, function: { ...call.function, name: byOriginal.get(call.function.name) } }
						: call,
				),
			};
		});
	}
}

/**
 * Tell the model, in the system prompt, that the appended placeholder tools
 * must not be called (see the section comment above for why the note lives
 * here and why it is worded "placeholders"). Per family: `instructions`
 * (Responses), `system` (Anthropic), or a leading system message (chat).
 */
function noteUnavailableTools(
	obj: Record<string, unknown>,
	api: ModelApi | undefined,
	names: string[],
): void {
	if (names.length === 0) return;
	const list = names.map((name) => `\`${name}\``).join(" or ");
	const noun = names.length > 1 ? "tools are" : "tool is";
	const pronoun = names.length > 1 ? "them" : "it";
	const bashHint = names.includes("shell") ? " For shell commands, call `bash`." : "";
	const note =
		`The ${list} ${noun} sent only to satisfy the API gateway; calling ${pronoun} returns an error.${bashHint} Use the other tools you have been given for everything else.`;
	if (api === "openai-responses") {
		obj.instructions =
			typeof obj.instructions === "string" && obj.instructions.trim()
				? `${obj.instructions}\n\n${note}`
				: note;
		return;
	}
	if (api === "anthropic-messages") {
		if (typeof obj.system === "string") obj.system = `${obj.system}\n\n${note}`;
		else if (obj.system === undefined) obj.system = note;
		return;
	}
	// OpenAI chat shape only.
	if (!Array.isArray(obj.messages)) return;
	const first = obj.messages[0] as { role?: unknown; content?: unknown } | undefined;
	if (first?.role === "system" && typeof first.content === "string") {
		obj.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...obj.messages.slice(1)];
	} else {
		obj.messages = [{ role: "system", content: note }, ...(obj.messages as unknown[])];
	}
}

/** Where a payload's endpoint family comes from: the registered-model map. */
export type ZenApiLookup = Pick<Map<string, ModelApi>, "get">;

/**
 * One shape pass over a provider request payload: drop OpenAI-only cache
 * fields Zen may reject, then apply ensureZenFreeTierShape. Pure apart from
 * mutating the payload object in place (same contract as ensureZenFreeTierShape
 * — callers get the same reference back).
 *
 * Two callers share this: the `before_provider_request` hook (agent-loop
 * turns) and the compaction stream fn in index.ts — pi's compaction requests
 * bypass `before_provider_request` (they call the provider with no `onPayload`),
 * so the session_before_compact handler has to shape its own payload.
 */
export function shapeZenPayload(payload: unknown, apiLookup: ZenApiLookup): ZenShapedRequest | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	const obj = payload as Record<string, unknown>;
	// Gate on model id FIRST: only shape payloads for models we registered.
	// The before_provider_request event is global — it fires for every
	// provider — and an unregistered id used to fall through to the
	// chat-completions default, injecting chat-shaped decoys into foreign
	// payloads (a Responses-API model then 400s on tools[i].name). A foreign
	// payload must pass through untouched, cache fields included.
	const api = typeof obj.model === "string" ? apiLookup.get(obj.model) : undefined;
	if (api === undefined) return undefined;
	delete obj.prompt_cache_key;
	delete obj.prompt_cache_retention;
	return ensureZenFreeTierShape(obj, api) ?? undefined;
}

// ─── Direct-transport shaping (compat seam) ──────────────────────────────────
//
// pi's agent loop shapes every turn via before_provider_request. Calls that
// bypass pi entirely — extension-side registry.complete() (pi-web's fetch
// summarizer), background memory transports — reach the gateway with an
// unshaped body and die with 403 FreeTierError, because the gate checks the
// BODY, not just headers (verified live 2026-10-21: identical canary headers,
// shaped body -> 200, unshaped -> 403). index.ts wraps pi-ai's compat
// registry for pi-zen models; the pure composition decisions live here where
// node --test can cross the same seam callers use.

/** Structural slice of pi-ai's StreamOptions this module touches. */
export interface ZenDirectOptions {
	headers?: Record<string, string>;
	sessionId?: string;
	onPayload?: (payload: unknown, model: unknown) => unknown | undefined | Promise<unknown | undefined>;
	[key: string]: unknown;
}

/** Session-correlation headers Zen-bound requests are expected to carry. */
const ZEN_IDENTITY_HEADER_NAMES = [
	"x-opencode-session",
	"x-opencode-session-id",
	"x-session-affinity",
	"x-session-id",
] as const;

/**
 * Overwrite ALL session-correlation headers with the effective session id and
 * return the copy (input never mutated). Overwrite — not fill-gaps — is the
 * gate's requirement: pi core stamps x-session-id/x-session-affinity/
 * x-opencode-session-id from options.sessionId (the raw pi UUID on direct
 * paths), and any non-ses_ value in the family poisons the request
 * (2026-10-21: fill-gaps kept pi's UUIDs -> 403 FreeTierError; overwrite ->
 * 200). A caller cannot manage its own affinity here — the gateway only
 * accepts opencode-shaped ids, which is exactly what `sessionId` is.
 */
export function fillZenIdentityHeaders(
	headers: Record<string, string> | undefined,
	sessionId: string,
): Record<string, string> {
	const out = { ...(headers ?? {}) };
	for (const name of ZEN_IDENTITY_HEADER_NAMES) {
		out[name] = sessionId;
	}
	return out;
}

/**
 * Compose direct-call options for a pi-zen model: default the session id,
 * stamp ALL identity headers with the EFFECTIVE session id (the caller's
 * sessionId option if it passed one, else the fallback), and wrap onPayload
 * so the outgoing payload is shaped by the shipped wire recipe before any
 * caller hook sees it. Non-identity caller keys win. Pure — index.ts's
 * registry wrapper supplies
 * the deps.
 */
export function zenDirectStreamOptions<T extends ZenDirectOptions>(
	options: T | undefined,
	deps: { fallbackSessionId: string; shapePayload: (payload: unknown) => unknown },
): T {
	const sessionId = options?.sessionId || deps.fallbackSessionId;
	const caller = (options ?? {}) as T;
	const prevOnPayload = caller.onPayload;
	return {
		...caller,
		sessionId,
		headers: fillZenIdentityHeaders(caller.headers, sessionId),
		onPayload: (payload: unknown, model: unknown) => {
			const shaped = deps.shapePayload(payload);
			const effective = shaped === undefined ? payload : shaped;
			if (!prevOnPayload) return effective;
			const result = prevOnPayload(effective, model);
			if (result && typeof (result as Promise<unknown>).then === "function") {
				return Promise.resolve(result).then((r) => (r === undefined ? effective : r));
			}
			return result === undefined ? effective : result;
		},
	};
}

/**
 * Shape a serialized request body aimed at a pi-zen free model — the fetch-edge
 * counterpart to zenDirectStreamOptions. pi core's ModelRuntime dispatch
 * bypasses before_provider_request AND the compat registry, so the only seam
 * left is the network call itself (see installZenFetchGuard in index.ts).
 * Returns the re-serialized shaped body, or undefined when the body isn't a
 * shapable pi-zen request (non-JSON, foreign model) — the caller passes those
 * through untouched. Shaping converges: an already-shaped body re-enters
 * ensureZenFreeTierShape and comes back equal.
 */
export function shapeZenRequestBody(body: string, apiLookup: ZenApiLookup): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const model = (parsed as { model?: unknown }).model;
	if (typeof model !== "string" || !apiLookup.get(model)) return undefined;
	const shaped = shapeZenPayload(parsed, apiLookup);
	return JSON.stringify(shaped?.payload ?? parsed);
}
