/**
 * Unit tests for the canary policy (shared.ts canaryVerdict + canaryHealth).
 *
 * canaryVerdict pins the classification the daily workflow pages on: a false
 * "fail" spams the user on rate-limit noise; a false "pass"/"inconclusive"
 * silences a real gate change. The verdict table is the whole contract the
 * workflow consumes (via the script's exit code), so this is the same seam,
 * not an internal detail.
 *
 * canaryHealth pins the extension's registration gate: which verdicts hide
 * the free models, and which situations give the benefit of the doubt (a
 * paused or broken canary pipeline must not silently disable the extension).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canaryHealth, canaryVerdict } from "../shared.ts";

// ─── canaryVerdict (workflow exit code) ─────────────────────────────────────

test("any 200 passes — first served model settles the verdict", () => {
	assert.equal(canaryVerdict([200]), "pass");
	assert.equal(canaryVerdict([403, 200, 403]), "pass");
	assert.equal(canaryVerdict([-1, 429, 200]), "pass");
});

test("all-403 fails — the gate changed upstream", () => {
	assert.equal(canaryVerdict([403]), "fail");
	assert.equal(canaryVerdict([403, 403, 403]), "fail");
});

test("all-429 is inconclusive, not failure — CI runner IPs share the anonymous rate limit", () => {
	assert.equal(canaryVerdict([429, 429, 429]), "inconclusive");
	assert.equal(canaryVerdict([429]), "inconclusive");
});

test("network errors and server errors fail — no candidate served", () => {
	assert.equal(canaryVerdict([-1, -1]), "fail");
	assert.equal(canaryVerdict([500, 502]), "fail");
	assert.equal(canaryVerdict([403, -1, 500]), "fail");
});

// ─── canaryHealth (extension registration gate) ─────────────────────────────

const NOW = 1_800_000_000_000;
const status = (verdict: string, ageMs = 0) => ({
	verdict,
	checkedAt: new Date(NOW - ageMs).toISOString(),
	probed: ["big-pickle"],
});

test("a fresh fail hides the models", () => {
	assert.equal(canaryHealth(status("fail"), NOW), "broken");
});

test("fresh pass and inconclusive both register — no evidence of breakage", () => {
	assert.equal(canaryHealth(status("pass"), NOW), "healthy");
	assert.equal(canaryHealth(status("inconclusive"), NOW), "healthy");
});

test("a stale verdict is unknown — a paused canary must not disable the extension", () => {
	const stale = 48 * 60 * 60 * 1000 + 1;
	assert.equal(canaryHealth(status("fail", stale), NOW), "unknown");
	assert.equal(canaryHealth(status("pass", stale), NOW), "unknown");
});

test("a fresh verdict exactly at the staleness boundary is still trusted", () => {
	const boundary = 48 * 60 * 60 * 1000;
	assert.equal(canaryHealth(status("fail", boundary), NOW), "broken");
});

test("missing or malformed status is unknown", () => {
	assert.equal(canaryHealth(undefined, NOW), "unknown");
	assert.equal(canaryHealth(null, NOW), "unknown");
	assert.equal(canaryHealth("nope", NOW), "unknown");
	assert.equal(canaryHealth({}, NOW), "unknown");
	assert.equal(canaryHealth({ verdict: "fail" }, NOW), "unknown"); // no checkedAt
	assert.equal(canaryHealth({ verdict: "failing", checkedAt: new Date(NOW).toISOString() }, NOW), "unknown");
	assert.equal(canaryHealth({ verdict: "fail", checkedAt: "not-a-date" }, NOW), "unknown");
});
