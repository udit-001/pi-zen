/**
 * Deprecation self-healing loop, asserted on source text: index.ts imports
 * "./shared.js", which only pi's loader resolves, so a plain `node --test`
 * process cannot import it (same honest source check as headless-exit.test.ts).
 * The invariant is narrow: the three pieces of the loop exist and are wired —
 * detect (pattern), explain (friendly copy), heal (evict + re-register) —
 * and the build script purges deprecated entries so dead models don't ship.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const buildSource = readFileSync(new URL("../scripts/build-free-models.mjs", import.meta.url), "utf8");

test("deprecation detection pattern exists and matches Zen's error wording", () => {
	assert.match(indexSource, /ModelDeprecated\|has been deprecated/i);
	// Same wording the fork verified against real Zen deprecation errors.
	assert.match(indexSource, /ZEN_DEPRECATED_MODEL_PATTERN/);
});

test("friendly copy is provided and ordered first in the message_end chain", () => {
	assert.match(indexSource, /zenDeprecatedFriendlyError/);
	assert.match(
		indexSource,
		/zenDeprecatedFriendlyError\(restored\) \?\? zenFreeTierFriendlyError\(restored\) \?\? zenQuotaFriendlyError\(restored\)/,
	);
});

test("message_end evicts the dead model and re-registers the provider", () => {
	// The eviction is guarded by the same provider/stopReason/errorMessage
	// gates the friendly rewrite uses, and re-registers with the survivors.
	assert.match(
		indexSource,
		/registerProvider\(pi, evictModel\(restored\.model\)\)/,
	);
});

test("evictModel clears every cache the module keeps", () => {
	const fn = indexSource.slice(indexSource.indexOf("function evictModel"));
	const body = fn.slice(0, fn.indexOf("\n}\n"));
	assert.match(body, /lastGood = current/);
	assert.match(body, /freeModelsCache\.models = freeModelsCache\.models\.filter/);
	assert.match(body, /writeSnapshot\(current\)/);
});

test("build script purges deprecated entries from the models.dev enrichment", () => {
	assert.match(buildSource, /meta\?\.status === "deprecated"\) continue/);
});
