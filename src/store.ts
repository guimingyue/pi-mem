/**
 * The memory store.
 *
 * A memory is one Markdown file with frontmatter (`name`, `description`, `metadata.type`) living
 * directly inside a scope directory. Each directory also has a `MEMORY.md` index with one line per
 * memory. The index is derived: it is regenerated from the files whenever one changes, so neither
 * the model nor the user has to keep it in sync, and writing it directly is rejected.
 *
 * ```markdown
 * ---
 * name: terse-replies
 * description: User wants short answers with no trailing summary
 * metadata:
 *   type: feedback
 * ---
 *
 * Keep replies to a few sentences.
 *
 * **Why:** the user reads diffs, not prose.
 * **How to apply:** end-of-turn summary is one sentence.
 * ```
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { MemoryScopeDir } from "./config.ts";

/** What a memory records. `feedback` and `project` bodies carry **Why:** and **How to apply:**. */
export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface Memory {
	/** File name inside its scope directory, for example `feedback-terse-replies.md`. */
	fileName: string;
	name: string;
	description: string;
	type: MemoryType;
	/** Markdown after the frontmatter. */
	body: string;
}

/** What one scope directory holds, including files that could not be parsed. */
export interface MemoryDirContents {
	memories: Memory[];
	/** File names without parseable frontmatter. They stay on disk but out of the index. */
	unparsed: string[];
}

export const MEMORY_INDEX_FILE = "MEMORY.md";

/** Index size cap. The whole index goes into the system prompt every run, so it has to stay small. */
export const MEMORY_INDEX_MAX_LINES = 200;

export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;
const MEMORY_FILE_NAME = /^[^\s/\\][^/\\]*\.md$/;

/** Read every memory in a scope directory, ordered by file name. */
export function readMemoryDir(dir: string): MemoryDirContents {
	let fileNames: string[];
	try {
		fileNames = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { memories: [], unparsed: [] };
		throw error;
	}

	const contents: MemoryDirContents = { memories: [], unparsed: [] };
	for (const fileName of fileNames.sort()) {
		if (!fileName.endsWith(".md") || fileName === MEMORY_INDEX_FILE) continue;
		const memory = parseMemory(fileName, readFileSync(join(dir, fileName), "utf-8"));
		if (memory) contents.memories.push(memory);
		else contents.unparsed.push(fileName);
	}
	return contents;
}

/** Parse a memory file. Returns undefined when the frontmatter is missing or incomplete. */
export function parseMemory(fileName: string, text: string): Memory | undefined {
	const match = FRONTMATTER.exec(text);
	if (!match) return undefined;

	let name: string | undefined;
	let description: string | undefined;
	let type: string | undefined;
	let inMetadata = false;
	for (const line of match[1].split(/\r?\n/)) {
		const field = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
		if (!field) continue;
		const [, indent, key, rawValue] = field;
		const value = unquote(rawValue.trim());
		if (indent) {
			if (inMetadata && key === "type") type = value;
			continue;
		}
		inMetadata = key === "metadata";
		if (key === "name") name = value;
		else if (key === "description") description = value;
	}

	if (!name || !isMemoryType(type)) return undefined;
	return {
		fileName,
		name,
		description: description ?? "",
		type,
		body: text.slice(match[0].length).trim(),
	};
}

/** Render a memory as file text: frontmatter, blank line, body. */
export function serializeMemory(memory: Memory): string {
	const frontmatter = [
		"---",
		`name: ${quote(memory.name)}`,
		`description: ${quote(memory.description)}`,
		"metadata:",
		`  type: ${memory.type}`,
		"---",
	];
	return `${frontmatter.join("\n")}\n\n${memory.body.trim()}\n`;
}

/** Write a memory file, creating the scope directory when needed. */
export function writeMemory(dir: string, memory: Memory): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, memory.fileName), serializeMemory(memory), "utf-8");
}

/** Read a scope directory and bring its `MEMORY.md` up to date. Writing is skipped when it already matches. */
export function syncIndex(dir: string): MemoryDirContents {
	const contents = readMemoryDir(dir);
	const index = renderIndex(contents.memories);
	const path = join(dir, MEMORY_INDEX_FILE);
	let current: string | undefined;
	try {
		current = readFileSync(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (current !== index) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, index, "utf-8");
	}
	return contents;
}

/** Render index text: a heading, then one `- [name](file.md) — description` line per memory. */
export function renderIndex(memories: Memory[]): string {
	if (memories.length === 0) return "# Memory index\n\nNo memories yet.\n";
	const lines = memories.map((memory) => `- [${memory.name}](${memory.fileName}) — ${memory.description}`);
	// Reserve the heading, its blank line, and the truncation note.
	const budget = MEMORY_INDEX_MAX_LINES - 3;
	const kept = lines.slice(0, Math.max(budget, 0));
	const dropped = lines.length - kept.length;
	if (dropped > 0) kept.push(`(${dropped} more memories are in this directory but not listed here.)`);
	return `# Memory index\n\n${kept.join("\n")}\n`;
}

/**
 * Check a resolved path the model wants to write as a memory. Returns the reason it is not a valid
 * memory path, or undefined when the write may go ahead. The path is a trust boundary: it comes from
 * a model tool call, so it is normalized and confined to the scope directory.
 */
export function validateMemoryPath(dir: string, path: string): string | undefined {
	const normalized = path.normalize("NFC");
	if (normalized !== path) return `path must be NFC-normalized (got ${JSON.stringify(basename(path))})`;
	if (!normalized.startsWith(`${dir}${sep}`)) return `${normalized} is outside the memory directory ${dir}`;
	if (dirname(normalized) !== dir) return "memories live directly in the memory directory, not in a subdirectory";

	const fileName = basename(normalized);
	if (fileName === MEMORY_INDEX_FILE) {
		return `${MEMORY_INDEX_FILE} is generated from the memory files; write the memory file instead`;
	}
	if (!MEMORY_FILE_NAME.test(fileName) || fileName.startsWith(".")) {
		return `${fileName} is not a valid memory file name`;
	}
	return undefined;
}

/** The scope directory that contains a resolved path, or undefined when it is not a memory path. */
export function findScopeDir(scopeDirs: MemoryScopeDir[], path: string): MemoryScopeDir | undefined {
	const normalized = path.normalize("NFC");
	return scopeDirs.find((scopeDir) => normalized.startsWith(`${scopeDir.dir}${sep}`));
}

/** Turn a memory name into a file name: kebab-case, prefixed by its type. */
export function memoryFileName(name: string, type: MemoryType): string {
	const slug = name
		.normalize("NFC")
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return `${type}-${slug || "memory"}.md`;
}

function isMemoryType(value: string | undefined): value is MemoryType {
	return value !== undefined && (MEMORY_TYPES as readonly string[]).includes(value);
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		try {
			return JSON.parse(value) as string;
		} catch {
			return value.slice(1, -1);
		}
	}
	return value;
}

function quote(value: string): string {
	return /[:#"'\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
}
