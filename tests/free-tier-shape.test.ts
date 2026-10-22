/**
 * Unit tests for the Zen free-tier request-shaping module (shared.ts).
 * Runs with `node --test` — Node >= 22.18 strips types natively, so no
 * build step or test framework is needed. These cross exactly the same seam
 * callers use (ensureZenFreeTierShape / shapeZenPayload / sanitizeZenResponsesItems)
 * and pin the v2 recipe verified upstream: exact read/shell fingerprint
 * tools, wire-def swap for compatible caller tools (alias concealment as
 * fallback), no tool_choice "none", system-note, and the reasoning_content
 * placeholder.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	ensureZenFreeTierShape,
	sanitizeZenResponsesItems,
	shapeZenPayload,
	ZEN_FINGERPRINT_DEFINITIONS,
	ZEN_FINGERPRINT_TOOL_NAMES,
} from "../shared.ts";

type JsonObj = Record<string, any>;

/** Tool names present in a payload, across all three wire wrappers. */
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

test("chat tool-less turn: appends the exact read/shell fingerprint, no tool_choice", () => {
	const payload: JsonObj = { model: "big-pickle", messages: [], stream: true };
	const result = ensureZenFreeTierShape(payload, "openai-completions");
	assert.notEqual(result, null);
	assert.strictEqual(result!.payload, payload); // same reference back
	assert.deepEqual(toolNamesOf(payload), ["read", "shell"]);
	// v2 rejects tool_choice "none"; absent stays absent.
	assert.strictEqual(payload.tool_choice, undefined);
	// Placeholders are blocked; anything else is a real tool.
	assert.strictEqual(result!.shouldBlock("read"), true);
	assert.strictEqual(result!.shouldBlock("shell"), true);
	assert.strictEqual(result!.shouldBlock("edit"), false);
	assert.strictEqual(result!.restoreToolName("read_client"), "read_client"); // identity
	// The system note tells the model what the placeholders are and what to use instead.
	assert.strictEqual((payload.messages as JsonObj[])[0]!.role, "system");
	assert.match((payload.messages as JsonObj[])[0]!.content, /satisfy the API gateway/);
	assert.match((payload.messages as JsonObj[])[0]!.content, /call `bash`/);
});

test("chat multi-turn: assistant messages get a reasoning_content placeholder (9router #4805)", () => {
	const payload: JsonObj = {
		model: "big-pickle",
		messages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "assistant", content: "again", reasoning_content: "thinking" },
			{ role: "assistant", content: "empty", reasoning_content: "" },
			{ role: "user", content: "more" },
		],
		stream: true,
	};
	ensureZenFreeTierShape(payload, "openai-completions");
	// The system note is prepended (placeholders were appended), shifting indices.
	assert.strictEqual((payload.messages as JsonObj[])[0]!.role, "system");
	const messages = payload.messages as JsonObj[];
	assert.strictEqual(messages[1]!.reasoning_content, undefined); // user untouched
	assert.strictEqual(messages[2]!.reasoning_content, " "); // placeholder injected
	assert.strictEqual(messages[3]!.reasoning_content, "thinking"); // existing kept
	assert.strictEqual(messages[4]!.reasoning_content, " "); // empty string filled
	assert.strictEqual(messages[5]!.reasoning_content, undefined);
});

/** pi's native read schema — wire-compatible with opencode's fingerprint def. */
const piReadTool = {
	type: "function",
	function: {
		name: "read",
		description: "Read the contents of a file. Supports text files and images.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file to read" },
				offset: { type: "number", description: "Line number to start reading from" },
				limit: { type: "number", description: "Maximum number of lines to read" },
			},
			required: ["path"],
		},
	},
};

test("chat with pi's compatible `read`: name kept, def swapped, nothing blocked for read", () => {
	const payload: JsonObj = {
		model: "big-pickle",
		messages: [{ role: "system", content: "be brief" }],
		stream: true,
		tools: [structuredClone(piReadTool), chatTool("edit")],
		tool_choice: { function: { name: "read" } },
	};
	const result = ensureZenFreeTierShape(payload, "openai-completions");
	assert.notEqual(result, null);
	// `read` keeps its name (now the caller's real tool); only `shell` is appended.
	assert.deepEqual(toolNamesOf(payload), ["read", "edit", "shell"]);
	// the wire def is opencode's verbatim one
	const read = (payload.tools as JsonObj[])[0]!.function!;
	assert.strictEqual(read.description, ZEN_FINGERPRINT_DEFINITIONS.read!.description);
	assert.deepEqual(read.parameters, ZEN_FINGERPRINT_DEFINITIONS.read!.parameters);
	// explicit tool_choice name stays valid — it now points at the real tool
	assert.deepEqual(payload.tool_choice, { function: { name: "read" } });
	// response side: nothing to restore for read, shell still blocked
	assert.strictEqual(result!.restoreToolName("read"), "read");
	assert.strictEqual(result!.shouldBlock("read"), false);
	assert.strictEqual(result!.shouldBlock("shell"), true);
	assert.strictEqual(result!.aliasFor("read"), undefined);
});

test("chat with an incompatible foreign `read`: alias fallback as before", () => {
	const foreignRead = {
		type: "function",
		function: {
			name: "read",
			description: "x",
			parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
		},
	};
	const payload: JsonObj = {
		model: "big-pickle",
		messages: [{ role: "system", content: "be brief" }],
		stream: true,
		tools: [foreignRead, chatTool("edit")],
		tool_choice: { function: { name: "read" } },
	};
	const result = ensureZenFreeTierShape(payload, "openai-completions");
	assert.notEqual(result, null);
	assert.deepEqual(toolNamesOf(payload), ["read_client", "edit", "read", "shell"]);
	assert.deepEqual(payload.tool_choice, { function: { name: "read_client" } });
	assert.strictEqual(result!.restoreToolName("read_client"), "read");
	assert.strictEqual(result!.shouldBlock("read"), true); // the appended placeholder
	assert.strictEqual(result!.shouldBlock("read_client"), false); // the caller's real tool
	// block copy can name the working substitute
	assert.strictEqual(result!.aliasFor("read"), "read_client");
	assert.strictEqual(result!.aliasFor("shell"), undefined);
	// prior-turn calls to the concealed tool are retargeted too
	const payload2: JsonObj = {
		model: "big-pickle",
		messages: [
			{ role: "assistant", tool_calls: [{ function: { name: "read", arguments: {} } }] },
		],
		stream: true,
		tools: [structuredClone(foreignRead)],
	};
	ensureZenFreeTierShape(payload2, "openai-completions");
	// system note prepended → assistant moved to index 1
	assert.strictEqual(
		(payload2.messages as JsonObj[])[1]!.tool_calls![0]!.function!.name,
		"read_client",
	);
});

test("chat with opencode's exact definitions: nothing appended, nothing blocked", () => {
	const fingerprintTool = (name: "read" | "shell") => ({
		type: "function",
		function: { name, ...ZEN_FINGERPRINT_DEFINITIONS[name] },
	});
	const payload: JsonObj = {
		model: "big-pickle",
		messages: [],
		stream: true,
		tools: [fingerprintTool("read"), fingerprintTool("shell")],
	};
	const result = ensureZenFreeTierShape(payload, "openai-completions");
	assert.notEqual(result, null);
	assert.deepEqual(toolNamesOf(payload), ["read", "shell"]);
	assert.strictEqual(result!.shouldBlock("read"), false); // caller's real tools
	assert.strictEqual(result!.shouldBlock("shell"), false);
	assert.strictEqual(result!.restoreToolName("read"), "read");
});

test("chat tool_choice 'none' is removed (v2 rejects it with 403 FreeTierError)", () => {
	const payload: JsonObj = { model: "big-pickle", messages: [], stream: true, tool_choice: "none" };
	ensureZenFreeTierShape(payload, "openai-completions");
	assert.strictEqual(payload.tool_choice, undefined);
});

test("responses tool-less turn: flat fingerprint tools + store:false + tool_choice auto", () => {
	const payload: JsonObj = { model: "muse-spark-1.3-contributor-free", input: [], stream: true };
	const result = ensureZenFreeTierShape(payload, "openai-responses");
	assert.notEqual(result, null);
	assert.deepEqual(toolNamesOf(payload), ["read", "shell"]);
	assert.strictEqual(payload.store, false);
	assert.strictEqual(payload.tool_choice, "auto");
	assert.strictEqual(typeof payload.instructions, "string");
	assert.match(payload.instructions as string, /satisfy the API gateway/);
	assert.strictEqual(result!.shouldBlock("read"), true);
	assert.strictEqual(result!.shouldBlock("shell"), true);
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

test("responses history: function_call items retargeted to aliases, reasoning items dropped", () => {
	const payload: JsonObj = {
		model: "muse-spark-1.3-contributor-free",
		input: [
			{ type: "reasoning", id: "rs_1", encrypted_content: "fake", summary: [] },
			{ type: "function_call", name: "read", arguments: "{}" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
		],
		stream: true,
		tools: [{ type: "function", name: "read", description: "x", parameters: {} }],
	};
	ensureZenFreeTierShape(payload, "openai-responses");
	const input = payload.input as JsonObj[];
	assert.deepEqual(
		input.map((item) => item.type),
		["function_call", "message"],
	);
	assert.strictEqual(input[0]!.name, "read_client");
});

test("responses multi-turn: no reasoning_content injection (Responses carries reasoning as items)", () => {
	const payload: JsonObj = {
		model: "muse-spark-1.3-contributor-free",
		input: [{ type: "message", role: "assistant", content: [] }],
		stream: true,
	};
	ensureZenFreeTierShape(payload, "openai-responses");
	assert.strictEqual("reasoning_content" in (payload.input as JsonObj[])[0]!, false);
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

test("anthropic tool-less turn: anthropic-shaped fingerprint tools, no tool_choice forcing", () => {
	const payload: JsonObj = { model: "union-alpha", messages: [], stream: true };
	const result = ensureZenFreeTierShape(payload, "anthropic-messages");
	assert.notEqual(result, null);
	assert.deepEqual(toolNamesOf(payload), ["read", "shell"]);
	const read = (payload.tools as JsonObj[])[0]!;
	assert.strictEqual(read.input_schema.type, "object"); // anthropic wrapper shape
	assert.strictEqual(read.function, undefined);
	assert.strictEqual(payload.tool_choice, undefined);
	assert.strictEqual(typeof payload.system, "string");
	assert.match(payload.system as string, /satisfy the API gateway/);
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
	assert.deepEqual(toolNamesOf(payload), ["read", "shell"]);
	assert.strictEqual(payload.tool_choice, undefined);
});

test("the fingerprint name constant is exactly opencode's read/shell pair", () => {
	assert.deepEqual(ZEN_FINGERPRINT_TOOL_NAMES, ["read", "shell"]);
});

// shapeZenPayload (compaction path)
//
// pi's compaction requests bypass before_provider_request (no onPayload on
// that path), so the session_before_compact handler shapes its own payload
// through this helper. These tests pin the two things it layers on top of
// ensureZenFreeTierShape: cache-field stripping and the model-id → api lookup.

const apiLookup = {
	get: (id: string) =>
		({ "big-pickle": "openai-completions", "muse-spark": "openai-responses" })[id] as never,
};

test("shapeZenPayload: strips pi cache fields then applies the fingerprint recipe", () => {
	const payload: JsonObj = {
		model: "big-pickle",
		messages: [],
		stream: true,
		prompt_cache_key: "ses_x",
		prompt_cache_retention: "24h",
	};
	const result = shapeZenPayload(payload, apiLookup);
	assert.notEqual(result, undefined);
	assert.deepEqual(toolNamesOf(payload), ["read", "shell"]);
	assert.strictEqual("prompt_cache_key" in payload, false);
	assert.strictEqual("prompt_cache_retention" in payload, false);
	// same-reference contract, like ensureZenFreeTierShape
	assert.strictEqual(result!.payload, payload);
});

test("shapeZenPayload: foreign model id passes through untouched (Responses regression)", () => {
	// gpt-6.1-sol on OpenAI Responses: 19 real flat tools must survive intact —
	// the chat-completions default used to append nested {function:{name}}
	// decoys here and OpenAI 400'd on tools[19].name.
	const realTool = { type: "function", name: "web_search", parameters: { type: "object" } };
	const toolsPayload: JsonObj = {
		model: "gpt-6.1-sol",
		stream: true,
		store: true,
		tools: Array.from({ length: 19 }, (_, i) => ({ ...realTool, name: `tool_${i}` })),
		prompt_cache_key: "ses_foreign",
	};
	assert.strictEqual(shapeZenPayload(toolsPayload, { get: () => undefined }), undefined);
	assert.strictEqual(toolsPayload.tools.length, 19);
	assert.strictEqual((toolsPayload.tools as JsonObj[])[0]!.name, "tool_0");
	assert.strictEqual("prompt_cache_key" in toolsPayload, true); // untouched, cache fields included

	// Tool-less foreign payload: no tools injected, no tool_choice touched.
	const toolLessPayload: JsonObj = { model: "gpt-6.1-sol", stream: true, input: [] };
	assert.strictEqual(shapeZenPayload(toolLessPayload, { get: () => undefined }), undefined);
	assert.strictEqual("tools" in toolLessPayload, false);

	// Foreign chat-completions payload: no tool_choice injected.
	const chatPayload: JsonObj = { model: "some-unregistered-model", messages: [], stream: true };
	assert.strictEqual(shapeZenPayload(chatPayload, { get: () => undefined }), undefined);
	assert.strictEqual("tool_choice" in chatPayload, false);
});

test("shapeZenPayload: registered chat payload gets placeholders + reasoning injection", () => {
	const payload: JsonObj = {
		model: "big-pickle",
		messages: [{ role: "assistant", content: "earlier turn" }],
	};
	const result = shapeZenPayload(payload, apiLookup);
	assert.notEqual(result, undefined);
	// system note prepended → assistant moved to index 1
	assert.strictEqual((payload.messages as JsonObj[])[1]!.reasoning_content, " ");
	assert.deepEqual(toolNamesOf(payload), ["read", "shell"]);
});

test("shapeZenPayload: non-object payloads return undefined untouched", () => {
	assert.strictEqual(shapeZenPayload("nope", apiLookup), undefined);
	assert.strictEqual(shapeZenPayload(null, apiLookup), undefined);
	assert.strictEqual(shapeZenPayload([1, 2], apiLookup), undefined);
});
