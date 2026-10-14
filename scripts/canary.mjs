/**
 * Live canary for the Zen free tier — the regression class unit tests cannot
 * catch. The 403 we fixed (Oct 2026) came from an upstream wire change while
 * every test stayed green; this script replays the shipped wire recipe against
 * opencode.ai and exits nonzero when the gate rejects it.
 *
 * Drift-proof by construction: the request body is shaped by the SAME
 * `shapeZenPayload` the extension ships (decoy quartet, tool_choice forcing,
 * cache-field stripping all come from shared.ts), and ids + User-Agent come
 * from shared.ts helpers — Node >= 22.18 strips types natively, same as
 * `npm test`. Only the header assembly (7 lines, mirrored from index.ts
 * opencodeHeaders) is repeated, because index.ts itself needs pi's
 * ExtensionAPI and cannot run in CI. If Zen starts requiring a header, fix
 * both places — the canary failing first is the signal.
 *
 * No secrets: the probe authenticates exactly like a signed-out opencode CLI
 * (Authorization: Bearer public). One request per candidate, three candidates
 * max, run daily — negligible against the anonymous rate limit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	canaryVerdict,
	opencodeId,
	opencodeUserAgent,
	shapeZenPayload,
	validOpencodeVersion,
} from "../shared.ts";

/**
 * One live probe against the free tier. The request body is shaped by the
 * shipped `shapeZenPayload` (decoy quartet, tool_choice forcing, cache-field
 * stripping all come from shared.ts) — exactly what a real tool-less pi turn
 * sends. Verdict classification is `canaryVerdict` from shared.ts, pinned by
 * tests/canary-verdict.test.ts; exit 0 = pass/inconclusive, 1 = page.
 */
async function main() {
	const snapshot = JSON.parse(
		readFileSync(new URL("../free-models.snapshot.json", import.meta.url), "utf8"),
	);

	/** Candidate models: free chat-completions entries from the bundled snapshot. */
	const candidates = snapshot.models
		.filter((m) => m.api === "openai-completions")
		.slice(0, 3);

	if (candidates.length === 0) {
		console.error("canary: no openai-completions models in free-models.snapshot.json");
		process.exit(1);
	}

	const apiByModelId = new Map(snapshot.models.map((m) => [m.id, m.api]));

	const statuses = [];
	for (const model of candidates) {
		// The shipped shaping stands in the decoys and forces tool_choice —
		// exactly what a real tool-less pi turn sends.
		const payload = {
			model: model.id,
			stream: true,
			messages: [{ role: "user", content: "Say OK." }],
		};
		shapeZenPayload(payload, apiByModelId);

		const now = Date.now();
		let status;
		try {
			const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer public",
					"User-Agent": opencodeUserAgent(validOpencodeVersion(snapshot.opencodeVersion)),
					"x-opencode-client": "cli",
					"x-opencode-project": "global",
					"x-opencode-session": opencodeId("ses", now, 0, new Uint8Array(14).fill(7)),
					"x-opencode-request": opencodeId("msg", now, 1, new Uint8Array(14).fill(8)),
					Accept: "text/event-stream",
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(60_000),
			});
			// Drain so the socket closes cleanly without reading the whole stream.
			await res.body?.cancel().catch(() => {});
			status = res.status;
		} catch (err) {
			console.error(`canary: ${model.id} network failure: ${err}`);
			status = -1;
		}
		statuses.push(status);
		console.error(`canary: ${model.id} -> ${status === -1 ? "network error" : `HTTP ${status}`}`);
		if (status === 200) break; // first served model settles the verdict
	}

	const verdict = canaryVerdict(statuses);

	// Machine-readable run record, written for EVERY verdict (pass or fail):
	//   canary-status.json — the extension's registration gate (verdict + when).
	//   canary-badge.json  — shields.io endpoint format for the README badge.
	// Output dir is argv[2]; without one the verdict lives only in the log.
	if (process.argv[2]) {
		mkdirSync(process.argv[2], { recursive: true });
		const badge =
			verdict === "pass"
				? { schemaVersion: 1, label: "pi-zen free tier", message: "up", color: "brightgreen" }
				: verdict === "fail"
					? { schemaVersion: 1, label: "pi-zen free tier", message: "down", color: "red" }
					: { schemaVersion: 1, label: "pi-zen free tier", message: "unknown", color: "yellow" };
		const statusDoc = {
			verdict,
			checkedAt: new Date().toISOString(),
			probed: statuses.map((_, i) => candidates[i].id),
		};
		writeFileSync(`${process.argv[2]}/canary-status.json`, JSON.stringify(statusDoc, undefined, "\t") + "\n");
		writeFileSync(`${process.argv[2]}/canary-badge.json`, JSON.stringify(badge) + "\n");
	}

	if (verdict === "pass") {
		console.log(`canary: PASS — free tier served a candidate with the shipped wire recipe (${statuses.join(", ")})`);
		return 0;
	}
	if (verdict === "inconclusive") {
		console.log(`canary: INCONCLUSIVE — every candidate rate-limited (${statuses.join(", ")}); not a gate change`);
		return 0;
	}
	console.error(
		statuses.every((s) => s === 403)
			? "canary: FAIL — 403 FreeTierError on every candidate: the free-tier gate changed upstream; re-diff against 9router's opencode executor"
			: `canary: FAIL — no candidate served (statuses: ${statuses.join(", ")})`,
	);
	return 1;
}

// Run only when executed directly — importing the module must not probe.
// argv[1] is absent under `node -e`/REPL; the guard then evaluates false.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(await main());
}
