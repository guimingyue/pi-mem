import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import type { MemoryScopeDir } from "../src/config.ts";
import {
	applyCandidates,
	buildExtractionPrompt,
	MEMORY_ENTRY_TYPE,
	type MemoryExtractionCommit,
	parseCandidates,
	readExtractionCommit,
} from "../src/extraction.ts";
import { MEMORY_INDEX_FILE, type Memory, readMemoryDir, serializeMemory } from "../src/store.ts";

const tempDir = join(tmpdir(), `pi-mem-test-extraction-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const userDir = join(tempDir, "user");
const projectDir = join(tempDir, "project");
const scopeDirs: MemoryScopeDir[] = [
	{ scope: "user", dir: userDir },
	{ scope: "project", dir: projectDir },
];

beforeEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	mkdirSync(userDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function reply(memories: unknown[]): string {
	return JSON.stringify({ memories });
}

function existingMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		fileName: "feedback-terse-replies.md",
		name: "terse-replies",
		description: "User wants short answers",
		type: "feedback",
		body: "Keep replies short.",
		...overrides,
	};
}

function customEntry(id: string, data: unknown, customType: string = MEMORY_ENTRY_TYPE): CustomEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-10-29T00:00:00.000Z",
		customType,
		data,
	};
}

describe("parseCandidates", () => {
	const valid = {
		action: "create",
		scope: "user",
		type: "feedback",
		name: "terse-replies",
		description: "User wants short answers",
		body: "Keep replies short.",
	};

	test("reads a bare JSON reply", () => {
		expect(parseCandidates(reply([valid]))).toEqual([valid]);
	});

	test("reads JSON out of a code fence and out of surrounding prose", () => {
		expect(parseCandidates(`\`\`\`json\n${reply([valid])}\n\`\`\``)).toEqual([valid]);
		expect(parseCandidates(`Here you go: ${reply([valid])} hope that helps`)).toEqual([valid]);
	});

	test("returns nothing for an empty list, broken JSON, or a reply without a list", () => {
		expect(parseCandidates(reply([]))).toEqual([]);
		expect(parseCandidates('{"memories": [{"action":')).toEqual([]);
		expect(parseCandidates("nothing to save")).toEqual([]);
		expect(parseCandidates('{"memories":"none"}')).toEqual([]);
	});

	test("drops entries with an unknown action, scope, type, or an empty name or body", () => {
		const candidates = parseCandidates(
			reply([
				valid,
				{ ...valid, action: "delete" },
				{ ...valid, scope: "team" },
				{ ...valid, type: "opinion" },
				{ ...valid, name: "  " },
				{ ...valid, body: "" },
				"not an object",
			]),
		);
		expect(candidates).toEqual([valid]);
	});

	test("keeps at most five memories from one reply", () => {
		const candidates = parseCandidates(
			reply(Array.from({ length: 9 }, (_, index) => ({ ...valid, name: `m${index}` }))),
		);
		expect(candidates).toHaveLength(5);
	});

	test("keeps a missing description as an empty string", () => {
		const { description: _description, ...withoutDescription } = valid;
		expect(parseCandidates(reply([withoutDescription]))[0].description).toBe("");
	});
});

describe("applyCandidates", () => {
	const candidate = {
		action: "create",
		scope: "user",
		type: "feedback",
		name: "terse-replies",
		description: "User wants short answers",
		body: "Keep replies short.\n\n**Why:** the user reads diffs.\n**How to apply:** one line.",
	};

	test("writes the memory file and indexes it", () => {
		const written = applyCandidates(
			scopeDirs,
			scopeDirs.map((scopeDir) => readMemoryDir(scopeDir.dir)),
			parseCandidates(reply([candidate])),
		);
		expect(written).toHaveLength(1);
		expect(readMemoryDir(userDir).memories).toEqual([written[0]]);
		expect(readFileSync(join(userDir, MEMORY_INDEX_FILE), "utf-8")).toContain("[terse-replies]");
	});

	test("names the file after the type and the slug", () => {
		applyCandidates(
			scopeDirs,
			scopeDirs.map((scopeDir) => readMemoryDir(scopeDir.dir)),
			parseCandidates(reply([candidate])),
		);
		expect(readFileSync(join(userDir, "feedback-terse-replies.md"), "utf-8")).toContain("type: feedback");
	});

	test("writes to the scope the candidate names", () => {
		applyCandidates(
			scopeDirs,
			scopeDirs.map((scopeDir) => readMemoryDir(scopeDir.dir)),
			parseCandidates(reply([{ ...candidate, scope: "project", type: "project" }])),
		);
		expect(readMemoryDir(projectDir).memories).toHaveLength(1);
		expect(readMemoryDir(userDir).memories).toHaveLength(0);
	});

	test("skips a candidate for a scope that is not enabled", () => {
		const written = applyCandidates([scopeDirs[1]], [readMemoryDir(projectDir)], parseCandidates(reply([candidate])));
		expect(written).toEqual([]);
	});

	test("an update replaces the existing file instead of adding a second one", () => {
		const existing = existingMemory();
		writeFileSync(join(userDir, existing.fileName), serializeMemory(existing));
		const before = readMemoryDir(userDir);
		applyCandidates(
			scopeDirs,
			[before, readMemoryDir(projectDir)],
			parseCandidates(reply([{ ...candidate, action: "update", body: "Updated body." }])),
		);
		const after = readMemoryDir(userDir);
		expect(after.memories).toHaveLength(1);
		expect(after.memories[0].body).toBe("Updated body.");
	});

	test("two candidates for the same file leave one memory", () => {
		const written = applyCandidates(
			scopeDirs,
			scopeDirs.map((scopeDir) => readMemoryDir(scopeDir.dir)),
			parseCandidates(reply([candidate, { ...candidate, body: "Second version." }])),
		);
		expect(written).toHaveLength(1);
		expect(readMemoryDir(userDir).memories[0].body).toBe("Second version.");
	});
});

describe("readExtractionCommit", () => {
	test("returns the last committed entry id", () => {
		const commit = (id: string): MemoryExtractionCommit => ({ kind: "extraction-commit", lastEntryId: id });
		expect(readExtractionCommit([customEntry("a", commit("e1")), customEntry("b", commit("e2"))])).toBe("e2");
	});

	test("ignores other custom entries and malformed commits", () => {
		const other = customEntry("a", undefined, "something-else");
		expect(
			readExtractionCommit([other, customEntry("b", { kind: "unknown" }), customEntry("c", null)]),
		).toBeUndefined();
	});

	test("returns undefined for a session that never extracted", () => {
		expect(readExtractionCommit([])).toBeUndefined();
	});
});

describe("buildExtractionPrompt", () => {
	test("carries the scopes, the existing memories, the reply shape, and the transcript", () => {
		const prompt = buildExtractionPrompt(
			"[User]: from now on, no summaries",
			[readMemoryDir(userDir), readMemoryDir(projectDir)],
			scopeDirs,
		);
		expect(prompt).toContain(userDir);
		expect(prompt).toContain(projectDir);
		expect(prompt).toContain('"memories"');
		expect(prompt).toContain("from now on");
		expect(prompt).toContain("no memories yet");
		expect(prompt).toContain("<conversation>");
	});

	test("lists existing memories so the model updates instead of duplicating", () => {
		writeFileSync(join(userDir, existingMemory().fileName), serializeMemory(existingMemory()));
		const prompt = buildExtractionPrompt(
			"[User]: hi",
			[readMemoryDir(userDir), readMemoryDir(projectDir)],
			scopeDirs,
		);
		expect(prompt).toContain("terse-replies (feedback): User wants short answers");
		expect(prompt).toContain("near-duplicate");
	});
});
