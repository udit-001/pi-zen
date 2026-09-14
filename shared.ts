/**
 * Shared types and pure helpers for pi-zen.
 *
 * No dependencies on pi's ExtensionAPI or any I/O — consumed by both:
 *   - index.ts (the extension)
 *   - build-free-models.mjs (the GitHub Action, via its own copies of the helpers)
 *
 * The helpers here are the single source of truth for the logic they encode.
 * The build script duplicates them because it runs in a plain Node context
 * without TypeScript strip-types; the duplication is acceptable for <30 lines
 * of stable, self-contained code.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

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

/** Shape of the full free-models.json file. */
export type FreeModelsFile = {
	generatedAt: string;
	source: string;
	count: number;
	defaultModel?: string;
	models: FreeModelEntry[];
};

/** pi's model config — the output of all resolution paths. */
export type ZenModelConfig = {
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

	for (const m of obj.models) {
		if (typeof m !== "object" || m === null) return false;
		if (typeof m.id !== "string" || !m.id) return false;
		if (typeof m.name !== "string") return false;
		if (typeof m.reasoning !== "boolean") return false;
		if (!Array.isArray(m.input) || m.input.length === 0) return false;
		if (typeof m.contextWindow !== "number" || m.contextWindow <= 0) return false;
		if (typeof m.maxTokens !== "number" || m.maxTokens <= 0) return false;
		if (typeof m.cost !== "object" || m.cost === null) return false;
		if (typeof m.compat !== "object" || m.compat === null) return false;
	}
	return true;
}
