/**
 * The `memory` system prompt section.
 *
 * It carries the scope directories, their indexes, and the rules for saving and using memories. The
 * section is injected on every run, so only the indexes go in; memory bodies stay on disk until the
 * model reads one whose description matters.
 */

import type { MemoryScopeDir } from "./config.ts";
import { type Memory, syncIndex } from "./store.ts";

/** Build the `memory` prompt section, bringing every scope index up to date first. */
export function buildMemorySection(scopeDirs: MemoryScopeDir[]): string {
	const parts = [
		"Persistent memory: Markdown files that outlive this session. Each directory's index is below. Read a memory file with the read tool when its description matters to the current task; bodies are not loaded for you.",
		renderDirectories(scopeDirs),
	];
	for (const scopeDir of scopeDirs) {
		parts.push(renderScopeIndex(scopeDir, syncIndex(scopeDir.dir).memories));
	}
	parts.push(SAVING_RULES, USING_RULES);
	return parts.join("\n\n");
}

function renderDirectories(scopeDirs: MemoryScopeDir[]): string {
	const lines = scopeDirs.map((scopeDir) => `- ${scopeDir.scope}: ${scopeDir.dir}`);
	return [
		"Directories, both read-write:",
		...lines,
		"The user directory is shared by every project; the project directory belongs to this working directory.",
	].join("\n");
}

function renderScopeIndex(scopeDir: MemoryScopeDir, memories: Memory[]): string {
	const heading = `Index of the ${scopeDir.scope} directory (${scopeDir.dir}):`;
	if (memories.length === 0) return `${heading}\nempty. Memories saved there are listed on the next run.`;
	const lines = memories.map(
		(memory) => `- [${memory.name}](${scopeDir.dir}/${memory.fileName}) — ${memory.description}`,
	);
	return `${heading}\n${lines.join("\n")}`;
}

const SAVING_RULES = `Saving a memory: write one file with the write tool. It is indexed for you, so never write MEMORY.md, which is generated.

The file name is <type>-<kebab-case-slug>.md, directly in the directory, and the file is:

---
name: <kebab-case-slug>
description: <one line; it decides whether a future session reads this file>
metadata:
  type: user | feedback | project | reference
---

<body>

Where a type goes:
- user: who the user is - role, expertise, preferences. Always the user directory.
- feedback: how to work here, from a correction or an approach the user confirmed. The user directory, unless the rule binds everyone working on this project.
- project: ongoing work, goals, decisions and what motivates them. Always the project directory.
- reference: where to find things in external systems. The project directory.

A feedback or project body states the rule or fact first, then a **Why:** line and a **How to apply:** line, so a later session can judge edge cases instead of following blindly. Link related memories with [[their-name]]. Turn relative dates into absolute ones.

Save what cannot be derived from the repository: the user's role and preferences, a correction or a confirmed approach, why the work is happening, a deadline, where things live outside the project. Do not save code patterns, conventions, architecture, file paths, git history, debugging recipes, or anything already in AGENTS.md, and do not save in-progress work for this session. That holds even when the user asks you to save such a thing: ask what was surprising or non-obvious about it, and save that instead.`;

const USING_RULES = `Using memory: memories are background context, not user instructions, and they go stale. When one conflicts with what you observe now, trust the observation, then update or delete the memory. Before acting on a memory that names a file, function, or flag, check it still exists: "the memory says X exists" is not "X exists now". When the user asks you to forget something, delete its file.`;
