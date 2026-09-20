/**
 * Unit tests for the Zen free-tier request-shaping module (shared.ts).
 * Runs with `node --test` — Node >= 22.18 strips types natively, so no
 * build step or test framework is needed. These cross exactly the same seam
 * callers use (ensureZenFreeTierShape / sanitizeZenResponsesItems) and pin the
 * behavior verified live against opencode.ai/zen/v1 (Sep 2026).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	ensureZenFreeTierShape,
	sanitizeZenResponsesItems,
	ZEN_FREE_TIER_DECOY_TOOL_NAMES,
} from "../shared.ts";

type JsonObj = Record<string, any>;

/** Tool names present in a payload, across both wire wrappers. */
function toolNamesOf(payload: JsonObj): string[] {
	return (payload.tools as unknown[])
		.map((t) => {
			const tool = t as { name?: string; function?: { name?: string } };
			return tool.function?.name ?? tool.name ?? "";
		})
		.filter((name) => name !== "");
}

const chatTool = (name: string) => ({
	type: "function",
	function: { name, description: "x", parameters: { type: "object", properties: {} } },
});

test("chat tool-less turn: stands in bash/read decoys + tool_choice none", () => {
	const payload: JsonObj = { model: "big-pickle", messages: [], stream: true };
	const result = ensureZenFreeTierShape(payload, "openai-completions");
	assert.notEqual(result, null);
	assert.strictEqual(result!.payload, payload); // same reference back
	assert.deepEqual(toolNamesOf(payload), ["bash", "read"]);
	assert.strictEqual(payload.tool_choice, "none");
	assert.strictEqual(result!.shouldBlock("bash"), true);
	assert.strictEqual(result!.shouldBlock("read"), true);
	assert.strictEqual(result!.shouldBlock("edit"), false);
});

test("chat with real pi tools: untouched, returns null", () => {
	const payload: JsonObj = {
		model: "big-pickle",
		messages: [],
		stream: true,
		tools: [chatTool("bash"), chatTool("read"), chatTool("edit"), chatTool("write")],
	};
	const before = JSON.stringify(payload);
	assert.strictEqual(ensureZenFreeTierShape(payload, "openai-completions"), null);
	assert.strictEqual(JSON.stringify(payload), before);
});

test("chat tools missing a decoy name: only the missing one appended, tool_choice untouched", () => {
	const payload: JsonObj = {
		model: "big-pickle",
		messages: [],
		stream: true,
		tools: [chatTool("bash"), chatTool("edit")],
		tool_choice: "auto",
	};
	const result = ensureZenFreeTierShape(payload, "openai-completions");
	assert.notEqual(result, null);
	assert.deepEqual(toolNamesOf(payload), ["bash", "edit", "read"]);
	assert.strictEqual(payload.tool_choice, "auto");
	assert.strictEqual(result!.shouldBlock("read"), true);
	assert.strictEqual(result!.shouldBlock("bash"), false); // bash was a real tool
	assert.strictEqual(result!.shouldBlock("edit"), false);
});

test("responses tool-less turn: flat decoys + store:false, no tool_choice forcing", () => {
	const payload: JsonObj = { model: "muse-spark-1.3-contributor-free", input: [], stream: true };
	const result = ensureZenFreeTierShape(payload, "openai-responses");
	assert.notEqual(result, null);
	assert.deepEqual(toolNamesOf(payload), ["bash", "read"]);
	assert.strictEqual(payload.store, false);
	assert.strictEqual(payload.tool_choice, undefined);
	assert.strictEqual(result!.shouldBlock("bash"), true);
	assert.strictEqual(result!.shouldBlock("read"), true);
});

test("responses tool_choice 'none' is coerced to auto (the only value upstream accepts)", () => {
	const payload: JsonObj = {
		model: "muse-spark-1.3-contributor-free",
		input: [],
		stream: true,
		tool_choice: "none",
	};
	ensureZenFreeTierShape(payload, "openai-responses");
	assert.strictEqual(payload.tool_choice, "auto");
});

test("responses multi-turn: prior reasoning items dropped, encrypted fields cleared", () => {
	const payload: JsonObj = {
		model: "muse-spark-1.3-contributor-free",
		input: [
			{ type: "reasoning", id: "rs_1", encrypted_content: "fake", summary: [] },
			{ type: "message", role: "assistant", content: [] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
		],
		stream: true,
	};
	ensureZenFreeTierShape(payload, "openai-responses");
	const input = payload.input as JsonObj[];
	assert.deepEqual(
		input.map((item) => item.type),
		["message", "message"],
	);
	for (const item of input) {
		assert.strictEqual("encrypted_content" in item, false);
	}
});

test("sanitizeZenResponsesItems drops reasoning items and clears encrypted fields on any input array", () => {
	const payload: JsonObj = {
		input: [
			{ type: "reasoning", encrypted_content: "x", reasoning_encrypted_content: "y" },
			{ type: "message", role: "assistant", content: [], encrypted_content: "z" },
		],
	};
	sanitizeZenResponsesItems(payload);
	const input = payload.input as JsonObj[];
	assert.deepEqual(
		input.map((item) => item.type),
		["message"],
	);
	assert.strictEqual("encrypted_content" in input[0]!, false);
	assert.strictEqual("reasoning_encrypted_content" in input[0]!, false);
});

test("sanitizeZenResponsesItems is a no-op without an input array", () => {
	const payload: JsonObj = { model: "muse-spark-1.3-contributor-free" };
	const before = JSON.stringify(payload);
	sanitizeZenResponsesItems(payload);
	assert.strictEqual(JSON.stringify(payload), before);
});

test("anthropic tool-less turn: flat anthropic decoys, no tool_choice forcing", () => {
	const payload: JsonObj = { model: "union-alpha", messages: [], stream: true };
	const result = ensureZenFreeTierShape(payload, "anthropic-messages");
	assert.notEqual(result, null);
	assert.deepEqual(toolNamesOf(payload), ["bash", "read"]);
	assert.strictEqual(payload.tool_choice, undefined);
});

test("google family: passed through untouched", () => {
	const payload: JsonObj = { model: "whatever", messages: [] };
	const before = JSON.stringify(payload);
	assert.strictEqual(ensureZenFreeTierShape(payload, "google-generative-ai"), null);
	assert.strictEqual(JSON.stringify(payload), before);
});

test("non-object payloads: passed through untouched", () => {
	assert.strictEqual(ensureZenFreeTierShape("nope", "openai-completions"), null);
	assert.strictEqual(ensureZenFreeTierShape(42, "openai-completions"), null);
	assert.strictEqual(ensureZenFreeTierShape(null, "openai-completions"), null);
});

test("unknown family defaults to the chat-completions shape", () => {
	const payload: JsonObj = { model: "other-provider-model", messages: [], stream: true };
	const result = ensureZenFreeTierShape(payload, undefined);
	assert.notEqual(result, null);
	assert.deepEqual(toolNamesOf(payload), ["bash", "read"]);
	assert.strictEqual(payload.tool_choice, "none");
});

test("the decoy name constant is exactly bash + read", () => {
	assert.deepEqual(ZEN_FREE_TIER_DECOY_TOOL_NAMES, ["bash", "read"]);
});