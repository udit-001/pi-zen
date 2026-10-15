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
import { canaryHealth, canaryVerdict, resolveCanaryStatus } from "../shared.ts";

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

// ─── resolveCanaryStatus (mirror vs origin trust policy) ────────────────────

// The Oct 2026 incident: the data branch had re-passed but jsdelivr's edge
// kept serving the stale "fail" for hours, hiding the models.
test("fresh origin pass beats a stale mirror fail", () => {
	const mirror = status("fail");
	const origin = status("pass");
	const resolved = resolveCanaryStatus(mirror, origin, NOW);
	assert.equal(resolved, origin); // returns the origin object on disagreement
	assert.equal(canaryHealth(resolved, NOW), "healthy");
});

test("fresh origin fail beats a stale mirror pass — no phantom models after a gate change", () => {
	assert.equal(canaryHealth(resolveCanaryStatus(status("pass"), status("fail"), NOW), NOW), "broken");
});

test("origin inconclusive beats a mirror fail — rate limiting is not evidence of breakage", () => {
	assert.equal(canaryHealth(resolveCanaryStatus(status("fail"), status("inconclusive"), NOW), NOW), "healthy");
});

test("agreement returns the mirror — no origin override on consensus", () => {
	const mirror = status("pass");
	assert.equal(resolveCanaryStatus(mirror, status("pass"), NOW), mirror);
	const failing = status("fail");
	assert.equal(resolveCanaryStatus(failing, status("fail"), NOW), failing);
});

test("a stale origin defers to the mirror even on disagreement", () => {
	const stale = 48 * 60 * 60 * 1000 + 1;
	const resolved = resolveCanaryStatus(status("fail"), status("pass", stale), NOW);
	assert.equal(canaryHealth(resolved, NOW), "broken");
});

test("a missing or malformed origin defers to the mirror", () => {
	assert.equal(canaryHealth(resolveCanaryStatus(status("fail"), undefined, NOW), NOW), "broken");
	assert.equal(canaryHealth(resolveCanaryStatus(status("fail"), "nope", NOW), NOW), "broken");
	assert.equal(canaryHealth(resolveCanaryStatus(status("fail"), { verdict: "pass" }, NOW), NOW), "broken");
});

test("an unusable mirror takes a usable origin — the origin read is real evidence", () => {
	assert.equal(canaryHealth(resolveCanaryStatus(undefined, status("fail"), NOW), NOW), "broken");
	assert.equal(canaryHealth(resolveCanaryStatus("nope", status("pass"), NOW), NOW), "healthy");
});

test("both reads unusable stays unknown — absence of evidence is not breakage", () => {
	assert.equal(canaryHealth(resolveCanaryStatus(undefined, undefined, NOW), NOW), "unknown");
	assert.equal(canaryHealth(resolveCanaryStatus(null, 42, NOW), NOW), "unknown");
});
