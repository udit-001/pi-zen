#!/usr/bin/env node
/**
 * build-free-models.mjs
 *
 * Fetches the opencode.ai Zen docs table, identifies the free models,
 * enriches them with metadata from models.dev, and writes free-models.json.
 *
 * Usage:
 *   node scripts/build-free-models.mjs                    # write to ./free-models.json
 *   node scripts/build-free-models.mjs --out path/to/out  # write to custom path
 *   node scripts/build-free-models.mjs --dry-run          # print to stdout only
 *   node scripts/build-free-models.mjs --pretty           # pretty-print JSON
 *
 * Can be run locally or in GitHub Actions. No dependencies beyond Node 18+.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const DOCS_URL = "https://opencode.ai/docs/zen";
const MODELS_DEV_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 15_000;
const SOURCE_REPO = "udit-001/pi-zen"; // for the "updatedFrom" field

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pretty = args.includes("--pretty");
const outIdx = args.indexOf("--out");
const outDir = outIdx !== -1 ? args[outIdx + 1] : ".";

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
 * Parse the Zen docs page for the model table. The page is HTML with a
 * markdown-like table. We extract rows by regex rather than importing an
 * HTML parser — the table format is stable and maintained by opencode.
 *
 * Returns: Array<{ name: string, id: string, endpoint: string, sdk: string }>
 */
function parseDocsTable(html) {
	const models = [];

	// The docs page renders a markdown table. In the raw HTML, each row is
	// <tr><td>Model</td><td>model-id</td><td>endpoint</td><td>sdk</td></tr>
	// We match both HTML table rows and markdown table rows.

	// Try HTML table rows first
	const htmlRowRegex = /<tr>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gs;
	let match;
	while ((match = htmlRowRegex.exec(html)) !== null) {
		const name = stripTags(match[1]).trim();
		const id = stripTags(match[2]).trim();
		const endpoint = stripTags(match[3]).trim();
		const sdk = stripTags(match[4]).trim();
		if (id && id !== "Model ID") {
			models.push({ name, id, endpoint, sdk });
		}
	}

	// If no HTML rows found, try markdown table rows
	if (models.length === 0) {
		const mdRowRegex = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm;
		while ((match = mdRowRegex.exec(html)) !== null) {
			const name = match[1].trim();
			const id = match[2].trim();
			const endpoint = match[3].trim().replace(/`/g, "");
			const sdk = match[4].trim();
			if (id && id !== "Model ID" && id !== "---") {
				models.push({ name, id, endpoint, sdk });
			}
		}
	}

	return models;
}

function stripTags(html) {
	return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// ─── Step 2: Identify free models ────────────────────────────────────────────

/**
 * Determine if a model is free based on the docs table entry.
 *
 * Free models on Zen are identified by:
 *   1. The `-free` suffix on the model id (e.g., `deepseek-v4-flash-free`)
 *   2. The `big-pickle` stealth id
 *   3. Using the `/v1/chat/completions` endpoint (OpenAI-compatible)
 *
 * We use the same heuristic as the extension's `isFreeModel` but on the
 * curated docs table — which is a strict subset of the `/models` endpoint.
 */
function isFreeModel(id, endpoint) {
	const lower = id.toLowerCase();
	if (lower === "big-pickle" || lower.endsWith("-free")) return true;
	// Also include chat/completions models without -free suffix if they
	// appear to be free-tier (e.g., future stealth drops). The docs table
	// only lists models opencode actually serves, so if it's in the table
	// and uses chat/completions, it's worth considering.
	if (endpoint?.includes("/chat/completions") && !lower.endsWith("-free") && lower !== "big-pickle") {
		// Not clearly free — skip unless it's in a known free list.
		// This catches paid chat/completions models if opencode adds any.
		return false;
	}
	return false;
}

// ─── Step 3: Enrich with models.dev metadata ─────────────────────────────────

/**
 * Cross-reference free model ids with models.dev `opencode` provider metadata.
 * Returns enriched configs matching pi's model format.
 */
function enrichWithMetadata(freeIds, devSlice) {
	const models = [];

	for (const entry of freeIds) {
		const meta = devSlice[entry.id];
		const reasoning = meta?.reasoning === true;
		const context = meta?.limit?.context;
		const output = meta?.limit?.output;
		const hasImage = Array.isArray(meta?.modalities?.input) && meta.modalities.input.includes("image");

		models.push({
			id: entry.id,
			name: meta?.name || entry.name || humanize(entry.id),
			reasoning,
			thinkingLevelMap: buildThinkingLevelMap(meta),
			input: hasImage ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: typeof context === "number" && context > 0 ? context : 128_000,
			maxTokens: typeof output === "number" && output > 0 ? output : 8_192,
			compat: {
				maxTokensField: "max_tokens",
				supportsStore: false,
				supportsReasoningEffort: reasoning,
				supportsDeveloperRole: false,
				supportsUsageInStreaming: false,
				...(reasoning && needsReasoningReplay(meta)
					? { requiresReasoningContentOnAssistantMessages: true }
					: {}),
			},
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	console.error("⏳ Fetching opencode.ai docs...");
	const docsHtml = await fetchText(DOCS_URL);
	const allModels = parseDocsTable(docsHtml);
	console.error(`📋 Found ${allModels.length} models in docs table`);

	// Identify free models: -free suffix or big-pickle
	const freeModels = allModels.filter(
		(m) => m.id.toLowerCase() === "big-pickle" || m.id.toLowerCase().endsWith("-free"),
	);
	console.error(`🆓 Identified ${freeModels.length} free models`);

	if (freeModels.length === 0) {
		console.error("⚠️  No free models found — docs format may have changed");
		process.exit(1);
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
	const enriched = enrichWithMetadata(freeModels, devSlice);
	const output = {
		$schema: "./free-models.schema.json",
		generatedAt: new Date().toISOString(),
		source: DOCS_URL,
		count: enriched.length,
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
