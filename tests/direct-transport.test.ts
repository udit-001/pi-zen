/**
 * Direct-transport shaping (compat seam). The registry wrapper in index.ts
 * composes zenDirectStreamOptions into pi-ai's stream/streamSimple for
 * pi-zen models; these tests cross the same seam the wrapper uses — the pure
 * composition helpers in shared.ts — with in-memory fixtures:
 *   - identity-header fill never clobbers caller values
 *   - caller sessionId wins; headers fill from the EFFECTIVE session id
 *   - onPayload composition shapes the payload before caller hooks see it
 *   - foreign options pass through structurally untouched (spread, not mutate)
 * The fetch-edge counterpart (shapeZenRequestBody, consumed by
 * installZenFetchGuard) is pinned here too: pi-zen bodies shaped, foreign or
 * malformed bodies untouched, and shaping converges for idempotent re-entry.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	fillZenIdentityHeaders,
	shapeZenRequestBody,
	zenDirectStreamOptions,
	type ZenDirectOptions,
} from "../shared.ts";

const SESSION = "ses_test000000000000000001";
const shape = (p: unknown) => (p && typeof p === "object" ? { ...(p as object), shaped: true } : p);

test("fillZenIdentityHeaders fills all four correlation headers from the session id", () => {
	const out = fillZenIdentityHeaders(undefined, SESSION);
	assert.equal(out["x-opencode-session"], SESSION);
	assert.equal(out["x-opencode-session-id"], SESSION);
	assert.equal(out["x-session-affinity"], SESSION);
	assert.equal(out["x-session-id"], SESSION);
	assert.equal(Object.keys(out).length, 4);
});

test("fillZenIdentityHeaders OVERWRITES all four correlation headers with the session id", () => {
	// pi core pre-populates the UUID-shaped trio on the direct path (options.sessionId
	// -> x-session-id/x-session-affinity/x-opencode-session-id). Any non-ses_ value
	// in the family trips the gate (2026-10-21: fill-gaps kept the UUIDs -> 403;
	// overwrite -> 200 x3). Non-identity headers are preserved.
	const UUID = "01a15d2d-2e03-7106-814a-f6bc1f8ce280";
	const out = fillZenIdentityHeaders(
		{ "x-opencode-session": "ses_mine", "x-opencode-session-id": UUID, "x-session-affinity": UUID, "x-session-id": UUID, "x-foo": "1" },
		SESSION,
	);
	for (const name of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"]) {
		assert.equal(out[name], SESSION, `${name} must be overwritten with the effective session id`);
	}
	assert.equal(out["x-foo"], "1");
});

test("zenDirectStreamOptions with no caller options: defaults + shaping onPayload", () => {
	const out = zenDirectStreamOptions(undefined, { fallbackSessionId: SESSION, shapePayload: shape });
	assert.equal(out.sessionId, SESSION);
	assert.equal(out.headers?.["x-opencode-session"], SESSION);
	const shaped = (out.onPayload as (p: unknown) => unknown)({ model: "m" }) as { shaped?: boolean };
	assert.equal(shaped.shaped, true);
});

test("zenDirectStreamOptions: caller sessionId wins and headers fill from it", () => {
	const out = zenDirectStreamOptions<ZenDirectOptions>(
		{ sessionId: "ses_caller" },
		{ fallbackSessionId: SESSION, shapePayload: shape },
	);
	assert.equal(out.sessionId, "ses_caller");
	assert.equal(out.headers?.["x-opencode-session"], "ses_caller");
	assert.equal(out.headers?.["x-session-affinity"], "ses_caller");
});

test("zenDirectStreamOptions composes onPayload: caller sees the SHAPED payload", () => {
	const seen: unknown[] = [];
	const out = zenDirectStreamOptions<ZenDirectOptions>(
		{ onPayload: (p) => { seen.push(p); } },
		{ fallbackSessionId: SESSION, shapePayload: shape },
	);
	const result = (out.onPayload as (p: unknown) => unknown)({ model: "m" });
	assert.equal((seen[0] as { shaped?: boolean }).shaped, true); // caller saw shaped
	assert.equal((result as { shaped?: boolean }).shaped, true); // transport gets shaped back (caller returned undefined)
});

test("zenDirectStreamOptions: shape returning undefined passes the payload through", () => {
	const out = zenDirectStreamOptions(undefined, { fallbackSessionId: SESSION, shapePayload: () => undefined });
	const payload = { model: "m" };
	const result = (out.onPayload as (p: unknown) => unknown)(payload);
	assert.equal(result, payload); // same reference — untouched
});

test("zenDirectStreamOptions preserves async caller onPayload results", async () => {
	const out = zenDirectStreamOptions(
		{ onPayload: async (p) => ({ ...(p as object), tagged: true }) },
		{ fallbackSessionId: SESSION, shapePayload: shape },
	);
	const result = await (out.onPayload as (p: unknown) => Promise<unknown>)({ model: "m" });
	assert.deepEqual(result, { model: "m", shaped: true, tagged: true });
});

test("zenDirectStreamOptions never mutates the caller's options object", () => {
	const caller: ZenDirectOptions = { sessionId: "ses_caller", headers: { "x-foo": "1" } };
	zenDirectStreamOptions<ZenDirectOptions>(caller, { fallbackSessionId: SESSION, shapePayload: shape });
	assert.deepEqual(caller, { sessionId: "ses_caller", headers: { "x-foo": "1" } });
	// strict.deepEqual aliases deepStrictEqual (`asserts actual is T`), which
	// narrows `caller` to the literal — read through an annotated alias.
	const snapshot: ZenDirectOptions = caller;
	assert.equal(snapshot.onPayload, undefined);
});

test("index.ts installs the compat wrapper and fetch guard for pi-zen models", () => {
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(source, /installZenCompatTransport\(\);/);
	assert.match(source, /installZenFetchGuard\(\);/);
	assert.match(source, /model\.provider !== PROVIDER_ID/); // foreign models untouched
	assert.match(source, /url\.startsWith\(BASE_URL\)/); // fetch guard scoped to the Zen host
});

const apiLookup = new Map<string, "openai-completions" | "openai-responses">([
	["glm-5.3-flash-free", "openai-completions"],
]);

function zenBody(extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		model: "glm-5.3-flash-free",
		stream: true,
		messages: [{ role: "user", content: "Say OK." }],
		...extra,
	});
}

test("shapeZenRequestBody shapes a pi-zen body: fingerprint tools in, cache fields out", () => {
	const out = shapeZenRequestBody(zenBody({ prompt_cache_key: "ses_abc" }), apiLookup);
	assert.ok(out, "pi-zen body must shape, not pass through");
	const shaped = JSON.parse(out) as { tools?: unknown[]; prompt_cache_key?: unknown };
	assert.ok(Array.isArray(shaped.tools) && shaped.tools.length > 0, "fingerprint tool defs appended");
	assert.equal("prompt_cache_key" in shaped, false); // cache field stripped
});

test("shapeZenRequestBody passes foreign and malformed bodies through", () => {
	assert.equal(shapeZenRequestBody(JSON.stringify({ model: "gpt-9", messages: [] }), apiLookup), undefined);
	assert.equal(shapeZenRequestBody("not json", apiLookup), undefined);
	assert.equal(shapeZenRequestBody("42", apiLookup), undefined);
});

test("shapeZenRequestBody converges: an already-shaped body is returned unchanged", () => {
	const once = shapeZenRequestBody(zenBody(), apiLookup);
	assert.ok(once);
	assert.equal(shapeZenRequestBody(once, apiLookup), once); // idempotent re-entry
});
