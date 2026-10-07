/**
 * Endpoint → api-family contract.
 *
 * The bug this pins: the build used to default any endpoint it didn't
 * recognize to `openai-completions`, so `jev-1.13-free` — served on
 * /zen/v1/systemone, a structured-evaluation protocol that answers typed
 * questions, not chat turns — entered the model picker as a chat model and
 * failed every request. Three invariants now hold:
 *
 *   1. The mapping rule throws on an unknown endpoint instead of guessing.
 *   2. Every entry in the bundled model lists carries its endpoint, and its
 *      `api` is exactly what the rule derives from that endpoint.
 *   3. The family predicates answer correctly for every family the rule can
 *      produce, and index.ts registers through the speakable one — so a model
 *      on a family pi can't speak is data in the list, not a picker entry.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { apiForEndpoint, API_BY_ENDPOINT } from "../scripts/zen-endpoints.mjs";
import {
	acceptsCuratedApi,
	fromFreeModelEntry,
	isSpeakableApi,
	validateFreeModelsFile,
	type FreeModelEntry,
	type FreeModelsFile,
	type ModelApi,
} from "../shared.ts";

/** Endpoints as they appear in the Zen docs table → family the rule derives. */
const KNOWN_ENDPOINTS: Record<string, string> = {
	"https://opencode.ai/zen/v1/chat/completions": "openai-completions",
	"https://opencode.ai/zen/v1/responses": "openai-responses",
	"https://opencode.ai/zen/v1/messages": "anthropic-messages",
	"https://opencode.ai/zen/v1/systemone": "systemone",
	"https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent":
		"google-generative-ai",
};

test("every known Zen endpoint maps to its pi family", () => {
	for (const [endpoint, api] of Object.entries(KNOWN_ENDPOINTS)) {
		assert.equal(apiForEndpoint(endpoint), api, `endpoint ${endpoint}`);
	}
});

test("an unrecognized endpoint throws instead of defaulting to chat", () => {
	assert.throws(
		() => apiForEndpoint("https://opencode.ai/zen/v1/embeddings", "some-embed-free"),
		/unrecognized Zen endpoint/,
		"a new Zen route must fail the build, not enter the picker as a chat model",
	);
	assert.throws(() => apiForEndpoint(undefined), /unrecognized Zen endpoint/);
});

test("the rule's error names the file to fix", () => {
	assert.throws(
		() => apiForEndpoint("https://opencode.ai/zen/v1/whatever"),
		/zen-endpoints\.mjs/,
	);
});

/** Load one of the bundled model lists (both ship with the extension). */
function readList(name: string): FreeModelsFile {
	const path = new URL(`../${name}`, import.meta.url);
	return JSON.parse(readFileSync(path, "utf8")) as FreeModelsFile;
}

for (const listName of ["free-models.json", "free-models.snapshot.json"]) {
	test(`${listName}: passes the runtime validator`, () => {
		assert.equal(
			validateFreeModelsFile(readList(listName)),
			true,
			`${listName} would be rejected at load time`,
		);
	});

	test(`${listName}: every entry carries an endpoint matching its api family`, () => {
		const file = readList(listName);
		assert.ok(file.models.length > 0);
		for (const m of file.models) {
			assert.ok(
				typeof m.endpoint === "string" && m.endpoint.length > 0,
				`${m.id}: missing endpoint — regenerate with scripts/build-free-models.mjs`,
			);
			assert.equal(
				m.api ?? "openai-completions",
				apiForEndpoint(m.endpoint, m.id),
				`${m.id}: api does not match its endpoint`,
			);
		}
	});
}

test("every family the rule produces the curated list accepts, and only speakable ones register", () => {
	for (const { api } of API_BY_ENDPOINT) {
		assert.equal(acceptsCuratedApi(api), true, `${api} would be rejected at load time`);
	}
	// Speakability is a subset of acceptance, and systemone is the known
	// member that is data-only until pi ships a client for it.
	assert.equal(isSpeakableApi("systemone"), false);
	assert.equal(isSpeakableApi(undefined), true, "an absent api means openai-completions");
	const families: ModelApi[] = [
		"openai-completions",
		"openai-responses",
		"anthropic-messages",
		"google-generative-ai",
	];
	for (const family of families) {
		assert.equal(acceptsCuratedApi(family), true, family);
		assert.equal(isSpeakableApi(family), true, family);
	}
});

test("fromFreeModelEntry carries the endpoint into the model config", () => {
	// The config is what every resolution path (CDN, disk snapshot, bundled
	// snapshot) hands to registration, so an endpoint dropped here would be
	// gone exactly when pi's SystemOne client needs it.
	const entry: FreeModelEntry = {
		id: "jev-1.13-free",
		name: "Jev 1.13 Free",
		api: "systemone",
		endpoint: "https://opencode.ai/zen/v1/systemone",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		compat: {},
	};
	const config = fromFreeModelEntry(entry);
	assert.equal(config.endpoint, "https://opencode.ai/zen/v1/systemone");
	assert.equal(config.api, "systemone");
});

test("index.ts registers models through isSpeakableApi", () => {
	// index.ts imports "./shared.js", which only pi's loader resolves, so
	// node --test cannot import it — same honest source check the
	// headless-exit regression test uses. Pins the filter that keeps a
	// non-speakable family out of the picker.
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(source, /models\.filter\(\(m\) => isSpeakableApi\(m\.api\)\)/);
});
