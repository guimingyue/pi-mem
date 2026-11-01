import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { MemoryScopeDir } from "../src/config.ts";
import {
	findScopeDir,
	MEMORY_INDEX_FILE,
	MEMORY_INDEX_MAX_LINES,
	type Memory,
	memoryFileName,
	parseMemory,
	readMemoryDir,
	renderIndex,
	serializeMemory,
	syncIndex,
	validateMemoryPath,
} from "../src/store.ts";

const tempDir = join(tmpdir(), `pi-mem-test-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		fileName: "feedback-terse-replies.md",
		name: "terse-replies",
		description: "User wants short answers",
		type: "feedback",
		body: "Keep replies short.\n\n**Why:** the user reads diffs.\n**How to apply:** one-sentence summary.",
		...overrides,
	};
}

beforeEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("parseMemory", () => {
	test("reads name, description, type, and body", () => {
		const parsed = parseMemory("feedback-terse-replies.md", serializeMemory(memory()));
		expect(parsed).toEqual(memory());
	});

	test("accepts unquoted values and quoted values with colons", () => {
		const text = [
			"---",
			"name: plain-name",
			'description: "has: a colon"',
			"metadata:",
			"  type: project",
			"---",
			"",
			"Body text.",
		].join("\n");
		const parsed = parseMemory("project-plain-name.md", text);
		expect(parsed?.name).toBe("plain-name");
		expect(parsed?.description).toBe("has: a colon");
		expect(parsed?.type).toBe("project");
		expect(parsed?.body).toBe("Body text.");
	});

	test("ignores unknown top-level keys and keys outside metadata", () => {
		const text = [
			"---",
			"name: n",
			"extra: ignored",
			"type: user",
			"metadata:",
			"  other: ignored",
			"  type: reference",
			"---",
			"Body.",
		].join("\n");
		const parsed = parseMemory("reference-n.md", text);
		expect(parsed?.type).toBe("reference");
	});

	test("returns undefined without frontmatter, name, or a known type", () => {
		expect(parseMemory("a.md", "no frontmatter")).toBeUndefined();
		expect(parseMemory("a.md", "---\ndescription: d\nmetadata:\n  type: user\n---\nBody.")).toBeUndefined();
		expect(parseMemory("a.md", "---\nname: n\nmetadata:\n  type: nope\n---\nBody.")).toBeUndefined();
	});
});

describe("serializeMemory", () => {
	test("round-trips a body with frontmatter-looking text", () => {
		const original = memory({ body: "Mentions --- and name: value inline." });
		expect(parseMemory(original.fileName, serializeMemory(original))).toEqual(original);
	});
});

describe("readMemoryDir", () => {
	test("lists memory files and skips the index", () => {
		writeFileSync(join(tempDir, memory().fileName), serializeMemory(memory()));
		writeFileSync(join(tempDir, MEMORY_INDEX_FILE), "# Memory index\n");
		writeFileSync(join(tempDir, "notes.txt"), "not markdown");
		const contents = readMemoryDir(tempDir);
		expect(contents.memories.map((entry) => entry.fileName)).toEqual([memory().fileName]);
		expect(contents.unparsed).toEqual([]);
	});

	test("reports files without parseable frontmatter instead of dropping them silently", () => {
		writeFileSync(join(tempDir, "broken.md"), "no frontmatter");
		const contents = readMemoryDir(tempDir);
		expect(contents.memories).toEqual([]);
		expect(contents.unparsed).toEqual(["broken.md"]);
	});

	test("returns empty contents for a directory that does not exist", () => {
		expect(readMemoryDir(join(tempDir, "missing"))).toEqual({ memories: [], unparsed: [] });
	});
});

describe("syncIndex", () => {
	test("writes one line per memory", () => {
		syncIndex(tempDir);
		writeFileSync(join(tempDir, memory().fileName), serializeMemory(memory()));
		const contents = syncIndex(tempDir);
		expect(contents.memories).toHaveLength(1);
		expect(readFileSync(join(tempDir, MEMORY_INDEX_FILE), "utf-8")).toBe(
			`# Memory index\n\n- [terse-replies](feedback-terse-replies.md) — User wants short answers\n`,
		);
	});

	test("leaves the file untouched when nothing changed", () => {
		writeFileSync(join(tempDir, memory().fileName), serializeMemory(memory()));
		syncIndex(tempDir);
		const before = statSync(join(tempDir, MEMORY_INDEX_FILE)).mtimeMs;
		syncIndex(tempDir);
		expect(statSync(join(tempDir, MEMORY_INDEX_FILE)).mtimeMs).toBe(before);
	});

	test("replaces a hand-edited index", () => {
		writeFileSync(join(tempDir, MEMORY_INDEX_FILE), "# stale\n");
		syncIndex(tempDir);
		expect(readFileSync(join(tempDir, MEMORY_INDEX_FILE), "utf-8")).toBe("# Memory index\n\nNo memories yet.\n");
	});
});

describe("renderIndex", () => {
	test("caps the index and says how many memories it dropped", () => {
		const memories = Array.from({ length: MEMORY_INDEX_MAX_LINES + 50 }, (_, index) =>
			memory({ fileName: `user-m${index}.md`, name: `m${index}` }),
		);
		const lines = renderIndex(memories).trimEnd().split("\n");
		expect(lines).toHaveLength(MEMORY_INDEX_MAX_LINES);
		expect(lines[lines.length - 1]).toBe("(53 more memories are in this directory but not listed here.)");
	});
});

describe("validateMemoryPath", () => {
	test("accepts a memory file directly in the directory", () => {
		expect(validateMemoryPath(tempDir, join(tempDir, "user-role.md"))).toBeUndefined();
	});

	test("rejects the generated index", () => {
		expect(validateMemoryPath(tempDir, join(tempDir, MEMORY_INDEX_FILE))).toContain("generated");
	});

	test("rejects a path outside the directory", () => {
		expect(validateMemoryPath(tempDir, join(tempDir, "..", "escape.md"))).toContain("outside");
	});

	test("rejects subdirectories, dot files, and non-markdown names", () => {
		expect(validateMemoryPath(tempDir, join(tempDir, "nested", "a.md"))).toContain("subdirectory");
		expect(validateMemoryPath(tempDir, join(tempDir, ".hidden.md"))).toContain("not a valid memory file name");
		expect(validateMemoryPath(tempDir, join(tempDir, "notes.txt"))).toContain("not a valid memory file name");
	});

	test("rejects a path that only NFC-normalizes into the directory", () => {
		const decomposed = join(tempDir, "me\u0301moire.md");
		expect(validateMemoryPath(tempDir, decomposed)).toContain("NFC-normalized");
		expect(validateMemoryPath(tempDir, decomposed.normalize("NFC"))).toBeUndefined();
	});
});

describe("findScopeDir", () => {
	test("matches the directory that contains the path", () => {
		const scopeDirs: MemoryScopeDir[] = [
			{ scope: "user", dir: join(tempDir, "user") },
			{ scope: "project", dir: join(tempDir, "project") },
		];
		expect(findScopeDir(scopeDirs, join(tempDir, "project", "a.md"))?.scope).toBe("project");
		expect(findScopeDir(scopeDirs, join(tempDir, "elsewhere", "a.md"))).toBeUndefined();
		// A sibling whose name starts with a scope directory name is not inside it.
		expect(findScopeDir(scopeDirs, join(tempDir, "project-x", "a.md"))).toBeUndefined();
	});
});

describe("memoryFileName", () => {
	test("slugs the name and prefixes the type", () => {
		expect(memoryFileName("Terse Replies!", "feedback")).toBe("feedback-terse-replies.md");
	});

	test("keeps non-latin names instead of collapsing them", () => {
		expect(memoryFileName("闸门式推进节奏", "project")).toBe("project-闸门式推进节奏.md");
	});

	test("falls back when nothing is left to slug", () => {
		expect(memoryFileName("---", "user")).toBe("user-memory.md");
	});
});
