#!/usr/bin/env node
/**
 * build-free-models.mjs
 *
 * Fetches the opencode.ai Zen docs table, identifies the free models,
 * enriches them with metadata from models.dev, and writes free-models.json.
 *
 * Usage:
 *   node scripts/build-free-models.mjs                            # write to ./free-models.json
 *   node scripts/build-free-models.mjs --out path/to/out          # write to custom path
 *   node scripts/build-free-models.mjs --overrides overrides.yml  # apply hand-curated overrides
 *   node scripts/build-free-models.mjs --dry-run                  # print to stdout only
 *   node scripts/build-free-models.mjs --pretty                   # pretty-print JSON
 *
 * Can be run locally or in GitHub Actions. No dependencies beyond Node 18+.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const DOCS_URL = "https://opencode.ai/docs/zen";
const MODELS_DEV_URL = "https://models.dev/api.json";
// Registry (not the GitHub API) so the Action needs no token and no rate budget.
const OPENCODE_NPM_URL = "https://registry.npmjs.org/opencode-ai/latest";
const FETCH_TIMEOUT_MS = 15_000;

// Docs endpoint → pi api family. Free models are not all OpenAI-compatible:
// stealth models can be served over Anthropic Messages or the Responses API.
const API_BY_ENDPOINT = [
	{ pattern: /:stream?[gG]enerateContent/, api: "google-generative-ai" },
	{ pattern: /\/responses\/?$/, api: "openai-responses" },
	{ pattern: /\/messages\/?$/, api: "anthropic-messages" },
];

/** pi's api for a Zen endpoint; the OpenAI-compatible chat route is the default. */
function apiForEndpoint(endpoint) {
	for (const { pattern, api } of API_BY_ENDPOINT) {
		if (pattern.test(endpoint ?? "")) return api;
	}
	return "openai-completions";
}

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pretty = args.includes("--pretty");
const outIdx = args.indexOf("--out");
const outDir = outIdx !== -1 ? args[outIdx + 1] : ".";
const overridesIdx = args.indexOf("--overrides");
const overridesPath = overridesIdx !== -1 ? args[overridesIdx + 1] : null;

// ─── YAML Parser (minimal) ───────────────────────────────────────────────────
//
// Just enough to parse overrides.yml:
//   key: value
//   key:
//     - item1
//     - item2

function parseSimpleYaml(text) {
	const result = {};
	let currentKey = null;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/#.*$/, "").trim(); // strip comments
		if (!line) continue;

		// List item: "  - value" (indented with dash)
		const listMatch = line.match(/^\s*-\s+(.+)$/);
		if (listMatch && currentKey) {
			if (!Array.isArray(result[currentKey])) result[currentKey] = [];
			result[currentKey].push(listMatch[1].trim());
			continue;
		}

		// Key-value: "key: value" or "key:" (start of list)
		const kvMatch = line.match(/^(\w+):\s*(.*)$/);
		if (kvMatch) {
			currentKey = kvMatch[1];
			const value = kvMatch[2].trim();
			if (value) {
				result[currentKey] = value;
			}
			continue;
		}
	}

	return result;
}

function loadOverrides(path) {
	if (!path || !existsSync(path)) {
		return { disabledModels: [] };
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = parseSimpleYaml(raw);
		return {
			defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined,
			disabledModels: Array.isArray(parsed.disabledModels) ? parsed.disabledModels : [],
		};
	} catch (err) {
		console.error(`⚠️  Failed to load overrides: ${err.message}`);
		return { disabledModels: [] };
	}
}

// ─── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchText(url) {
	const res = await fetch(url, {
		headers: { Accept: "text/html,application/json,text/plain,*/*" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
	return res.text();
}

async function fetchJSON(url) {
	const res = await fetch(url, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
	return res.json();
}

// ─── Step 1: Parse the docs table ────────────────────────────────────────────

/**
 * Accept a row only when its endpoint cell is actually a URL. The docs table
 * renders follow-up prose rows (e.g. a cell saying just "Free") through the
 * same <table> markup — without this check they parse as garbage models.
 */
function isDocsModelRow(id, endpoint) {
	return Boolean(id) && id !== "Model ID" && /^https?:\/\//i.test(endpoint);
}

function parseDocsTable(html) {
	const models = [];

	const htmlRowRegex = /<tr>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gs;
	let match;
	while ((match = htmlRowRegex.exec(html)) !== null) {
		const name = stripTags(match[1]).trim();
		const id = stripTags(match[2]).trim();
		const endpoint = stripTags(match[3]).trim();
		const sdk = stripTags(match[4]).trim();
		if (isDocsModelRow(id, endpoint)) {
			models.push({ name, id, endpoint, sdk });
		}
	}

	if (models.length === 0) {
		const mdRowRegex = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm;
		while ((match = mdRowRegex.exec(html)) !== null) {
			const name = match[1].trim();
			const id = match[2].trim();
			const endpoint = match[3].trim().replace(/`/g, "");
			const sdk = match[4].trim();
			if (isDocsModelRow(id, endpoint)) {
				models.push({ name, id, endpoint, sdk });
			}
		}
	}

	return models;
}

function stripTags(html) {
	return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// ─── Step 2: Identify free models ─────────────────────────────────────────────

/**
 * Zen marks free models in two ways: a `-free` id suffix (the normal case) or
 * "Free" in the display name with a plain id — the stealth models, e.g.
 * `union-alpha` ("Union Alpha Free", served over Anthropic /messages) and the
 * original `big-pickle`. Both spellings must match, else the docs table is the
 * only place the free list is written down and stealth models get dropped.
 * The endpoint is not part of the test — apiForEndpoint() handles that.
 */
function isFreeModel(entry) {
	const lower = entry.id.toLowerCase();
	if (lower === "big-pickle" || lower.endsWith("-free")) return true;
	return /(^|\s)free$/i.test(entry.name ?? "");
}

// ─── Step 3: Enrich with models.dev metadata ─────────────────────────────────

function enrichWithMetadata(freeIds, devSlice) {
	const models = [];

	for (const entry of freeIds) {
		const meta = devSlice[entry.id];
		const reasoning = meta?.reasoning === true;
		const context = meta?.limit?.context;
		const output = meta?.limit?.output;
		const hasImage = Array.isArray(meta?.modalities?.input) && meta.modalities.input.includes("image");
		const api = apiForEndpoint(entry.endpoint);

		models.push({
			id: entry.id,
			name: meta?.name || entry.name || humanize(entry.id),
			api,
			reasoning,
			thinkingLevelMap: buildThinkingLevelMap(meta),
			input: hasImage ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: typeof context === "number" && context > 0 ? context : 128_000,
			maxTokens: typeof output === "number" && output > 0 ? output : 8_192,
			// Compat is family-aware: these flags describe the OpenAI-completions
			// wire (maxTokensField names the max-tokens field, store/developer/
			// usage flags gate completions-only params). Other families ship an
			// empty block — pi-ai applies its own per-key defaults there.
			compat:
				api === "openai-completions"
					? {
							maxTokensField: "max_tokens",
							supportsStore: false,
							supportsReasoningEffort: reasoning,
							supportsDeveloperRole: false,
							supportsUsageInStreaming: false,
							...(reasoning && needsReasoningReplay(meta)
								? { requiresReasoningContentOnAssistantMessages: true }
								: {}),
						}
					: {},
		});
	}

	return models;
}

// ─── Shared helpers (mirrored from index.ts for standalone use) ───────────────

function humanize(id) {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function buildThinkingLevelMap(meta) {
	const effort = meta?.reasoning_options?.find(
		(o) => o.type === "effort" && Array.isArray(o.values) && o.values.length > 0,
	);
	if (!effort) return undefined;
	const values = new Set(effort.values);
	const map = { off: values.has("none") ? "none" : null };
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
		map[level] = values.has(level) ? level : null;
	}
	return map;
}

function needsReasoningReplay(meta) {
	return meta?.interleaved?.field === "reasoning_content";
}

// ─── Default model selection ─────────────────────────────────────────────────

/**
 * Compute the recommended default model.
 *
 * Criteria (weighted):
 *   +10  reasoning capable
 *   +5   vision (image input)
 *   +N   context window (N = contextWindow / 100_000, capped at 10)
 *   -1   requires reasoning replay (quirky backends)
 *
 * big-pickle is always eligible as a stable alias.
 * Tie-broken by model id alphabetically for determinism.
 */
function pickDefaultModel(models) {
	if (models.length === 0) return null;

	let best = null;
	let bestScore = -Infinity;

	for (const m of models) {
		let score = 0;
		score += m.reasoning ? 10 : 0;
		score += m.input.includes("image") ? 5 : 0;
		score += Math.min(m.contextWindow / 100_000, 10);
		score += m.compat?.requiresReasoningContentOnAssistantMessages ? -1 : 0;

		// Deterministic tie-break
		if (score > bestScore || (score === bestScore && m.id < best.id)) {
			best = m;
			bestScore = score;
		}
	}

	return best?.id ?? null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	// Load overrides
	const overrides = loadOverrides(overridesPath);
	if (overrides.defaultModel) {
		console.error(`📋 Overrides: defaultModel=${overrides.defaultModel}`);
	}
	if (overrides.disabledModels.length > 0) {
		console.error(`📋 Overrides: disabled=${overrides.disabledModels.join(", ")}`);
	}

	console.error("⏳ Fetching opencode.ai docs...");
	const docsHtml = await fetchText(DOCS_URL);
	const allModels = parseDocsTable(docsHtml);
	console.error(`📋 Found ${allModels.length} models in docs table`);

	// Identify free models: -free suffix or big-pickle
	const freeModels = allModels.filter(isFreeModel);
	console.error(`🆓 Identified ${freeModels.length} free models`);

	if (freeModels.length === 0) {
		console.error("⚠️  No free models found — docs format may have changed");
		process.exit(1);
	}

	// Latest opencode release — the extension copies this into its User-Agent so
	// the header keeps matching a current opencode build without a reinstall.
	let opencodeVersion;
	try {
		const pkg = await fetchJSON(OPENCODE_NPM_URL);
		if (typeof pkg?.version === "string" && pkg.version) {
			opencodeVersion = pkg.version;
			console.error(`🔢 Latest opencode: ${opencodeVersion}`);
		}
	} catch (err) {
		console.error(`⚠️  opencode version lookup failed: ${err.message} — omitting`);
	}

	// Fetch models.dev for metadata enrichment
	console.error("⏳ Fetching models.dev metadata...");
	let devSlice = {};
	try {
		const devJson = await fetchJSON(MODELS_DEV_URL);
		devSlice = devJson?.opencode?.models ?? {};
		console.error(`📦 Got metadata for ${Object.keys(devSlice).length} models from models.dev`);
	} catch (err) {
		console.error(`⚠️  models.dev fetch failed: ${err.message} — using defaults`);
	}

	// Build the output
	let enriched = enrichWithMetadata(freeModels, devSlice);

	// Apply disabled models from overrides
	if (overrides.disabledModels.length > 0) {
		const disabledSet = new Set(overrides.disabledModels);
		const before = enriched.length;
		enriched = enriched.filter((m) => !disabledSet.has(m.id));
		console.error(`🚫 Disabled ${before - enriched.length} model(s)`);
	}

	// Resolve defaultModel: overrides > auto-compute
	const defaultModel = overrides.defaultModel || pickDefaultModel(enriched);
	console.error(`🎯 Default model: ${defaultModel}`);

	const output = {
		$schema: "./free-models.schema.json",
		generatedAt: new Date().toISOString(),
		source: DOCS_URL,
		count: enriched.length,
		defaultModel,
		...(opencodeVersion ? { opencodeVersion } : {}),
		models: enriched,
	};

	// Write or print
	const json = pretty ? JSON.stringify(output, null, "\t") : JSON.stringify(output);

	if (dryRun) {
		console.log(json);
	} else {
		const outPath = join(outDir, "free-models.json");
		writeFileSync(outPath, json + "\n");
		console.error(`✅ Wrote ${outPath} (${enriched.length} models)`);
	}
}

main().catch((err) => {
	console.error(`❌ Build failed: ${err.message}`);
	process.exit(1);
});
