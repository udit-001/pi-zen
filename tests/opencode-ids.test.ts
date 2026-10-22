/**
 * Unit tests for opencode id minting (shared.ts opencodeId).
 *
 * Pins the session-id scheme Zen's free tier actually validates: a `ses_...`
 * whose 12-hex time field is hash-derived (pi-zen's old scheme) draws 403
 * FreeTierError, while timestamp-derived ids pass. These tests pin, at the
 * same exported seam callers use, that the time field is derived from the mint
 * timestamp (varies with it) and that ses/msg stay bitwise complements (the
 * descending/ascending pairing upstream validates).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { opencodeId } from "../shared.ts";

/** The `ses_`/`msg_` shape OpenCode's server validates. */
const ID_SHAPE = /^(ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/** An id's 12-hex time field as bytes, most significant first. */
function timeBytes(id: string): number[] {
	const hex = id.slice(4, 16);
	return [...hex.matchAll(/../g)].map((pair) => Number.parseInt(pair[0]!, 16));
}

test("minted ids match the server-validated opencode shape", () => {
	for (const prefix of ["ses", "msg"] as const) {
		const id = opencodeId(prefix, Date.now(), 0, new Uint8Array(14).fill(9));
		assert.match(id, ID_SHAPE);
	}
});

test("ses encodes ~current, msg encodes current: their time fields are bitwise complements", () => {
	const ts = Date.now();
	const ses = opencodeId("ses", ts, 0, new Uint8Array(14).fill(1));
	const msg = opencodeId("msg", ts, 0, new Uint8Array(14).fill(2));
	const sesBytes = timeBytes(ses);
	const msgBytes = timeBytes(msg);
	assert.equal(sesBytes.length, 6);
	for (let i = 0; i < 6; i++) {
		assert.equal(sesBytes[i], 0xff - msgBytes[i]!, `time byte ${i} not complemented`);
	}
});

test("the time field tracks the mint timestamp (a hash-derived field would be constant)", () => {
	const day = 86_400_000;
	const early = opencodeId("ses", Date.now() - 30 * day, 0, new Uint8Array(14).fill(3));
	const late = opencodeId("ses", Date.now(), 0, new Uint8Array(14).fill(3));
	assert.notDeepEqual(timeBytes(early), timeBytes(late));
});
