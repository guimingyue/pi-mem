import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { resolveToCwd } from "../src/paths.ts";
import { findScopeDir, validateMemoryPath } from "../src/store.ts";

const cwd = join(homedir(), "project");

describe("resolveToCwd", () => {
	test("resolves relative paths against the cwd and keeps absolute ones", () => {
		expect(resolveToCwd("memory/a.md", cwd)).toBe(join(cwd, "memory", "a.md"));
		expect(resolveToCwd("/tmp/a.md", cwd)).toBe(resolve("/tmp/a.md"));
	});

	test("expands ~ and strips the @ of a file mention", () => {
		expect(resolveToCwd("~/a.md", cwd)).toBe(join(homedir(), "a.md"));
		expect(resolveToCwd("@memory/a.md", cwd)).toBe(join(cwd, "memory", "a.md"));
	});

	test("normalizes unicode spaces and file URLs the way the write tool does", () => {
		expect(resolveToCwd("my\u00A0memory/a.md", cwd)).toBe(join(cwd, "my memory", "a.md"));
		expect(resolveToCwd(pathToFileURL(join(cwd, "a.md")).href, cwd)).toBe(join(cwd, "a.md"));
	});
});

describe("write guard path confinement", () => {
	const scopeDirs = [{ scope: "user" as const, dir: join(cwd, ".pi", "memory") }];

	test("a traversal out of the directory is not a memory path", () => {
		const escaped = resolveToCwd(".pi/memory/../../elsewhere.md", cwd);
		expect(findScopeDir(scopeDirs, escaped)).toBeUndefined();
	});

	test("a sibling directory whose name starts with the scope name is not inside it", () => {
		const sibling = resolveToCwd(".pi/memory-backup/a.md", cwd);
		expect(findScopeDir(scopeDirs, sibling)).toBeUndefined();
	});

	test("a memory file in the directory passes validation", () => {
		const path = resolveToCwd(".pi/memory/user-role.md", cwd);
		expect(findScopeDir(scopeDirs, path)?.scope).toBe("user");
		expect(validateMemoryPath(scopeDirs[0].dir, path)).toBeUndefined();
	});

	test("the generated index is rejected even though it is inside the directory", () => {
		const path = resolveToCwd(".pi/memory/MEMORY.md", cwd);
		expect(validateMemoryPath(scopeDirs[0].dir, path)).toContain("generated");
	});
});