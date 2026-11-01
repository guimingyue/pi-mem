/**
 * The extraction pass: one background model call over the messages added since the last pass, which
 * writes the durable memories it finds.
 *
 * It runs after an agent run settles, so it never delays a reply, and it is incremental: the id of
 * the last entry it consumed is committed to the session as a custom entry, so a resumed session
 * continues where the previous one stopped instead of re-reading the whole transcript.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { serializeConversation, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig, MemoryScopeDir } from "./config.ts";
import {
	MEMORY_TYPES,
	type Memory,
	type MemoryDirContents,
	memoryFileName,
	readMemoryDir,
	syncIndex,
	writeMemory,
} from "./store.ts";

/** Custom session entry type that records how far extraction has consumed the transcript. */
export const MEMORY_ENTRY_TYPE = "memory";

export interface MemoryExtractionCommit {
	kind: "extraction-commit";
	/** Id of the last session entry an extraction pass consumed. */
	lastEntryId: string;
}

export type ExtractionOutcome =
	| { kind: "nothing-new" }
	| { kind: "no-model" }
	| { kind: "aborted" }
	| { kind: "failed"; error: string }
	| { kind: "done"; written: Memory[] };

/** One memory the model proposed. */
interface MemoryCandidate {
	action: "create" | "update";
	scope: MemoryScopeDir["scope"];
	type: Memory["type"];
	name: string;
	description: string;
	body: string;
}

/** Transcript budget for one pass. The tail is kept: recent turns carry the signals. */
const MAX_TRANSCRIPT_CHARS = 80_000;

/** Cap on memories one pass may write, so a confused model cannot flood the directory. */
const MAX_MEMORIES_PER_PASS = 5;

/** Run one extraction pass and commit its position. Never throws: problems come back as an outcome. */
export async function runExtractionPass(options: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	config: MemoryConfig;
	scopeDirs: MemoryScopeDir[];
	lastEntryId: string | undefined;
	signal: AbortSignal;
}): Promise<ExtractionOutcome> {
	const { ctx, scopeDirs, signal } = options;
	const model = resolveExtractionModel(ctx, options.config.model);
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return { kind: "no-model" };

	const branch = ctx.sessionManager.getBranch();
	const messages = sliceAfter(branch, options.lastEntryId)
		.flatMap(sessionEntryToContextMessages)
		.filter(isContextMessage);
	if (!messages.some((message) => message.role === "user")) return { kind: "nothing-new" };

	const existing = scopeDirs.map((scopeDir) => readMemoryDir(scopeDir.dir));
	const transcript = tail(serializeConversation(messages), MAX_TRANSCRIPT_CHARS);
	let responseText: string;
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildExtractionPrompt(transcript, existing, scopeDirs) }],
						timestamp: Date.now(),
					},
				],
			},
			{ signal, sessionId: uuidv7(), cacheRetention: "none" },
		);
		responseText = responseTextOf(response.content);
	} catch {
		return signal.aborted ? { kind: "aborted" } : { kind: "failed", error: "the extraction request failed" };
	}
	if (signal.aborted) return { kind: "aborted" };

	const written = applyCandidates(scopeDirs, existing, parseCandidates(responseText));
	const lastEntry = branch[branch.length - 1];
	if (lastEntry) {
		const commit: MemoryExtractionCommit = { kind: "extraction-commit", lastEntryId: lastEntry.id };
		options.pi.appendEntry(MEMORY_ENTRY_TYPE, commit);
	}
	return { kind: "done", written };
}

/** The model an extraction pass uses: the configured one, or the session model. */
export function resolveExtractionModel(ctx: ExtensionContext, configured: string | undefined): Model<Api> | undefined {
	if (!configured) return ctx.model;
	const separator = configured.indexOf("/");
	if (separator === -1) return undefined;
	return ctx.modelRegistry.find(configured.slice(0, separator), configured.slice(separator + 1));
}

/** The id of the last entry an extraction pass committed for this session, if any. */
export function readExtractionCommit(entries: readonly SessionEntry[]): string | undefined {
	let lastEntryId: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MEMORY_ENTRY_TYPE) continue;
		const commit = entry.data as MemoryExtractionCommit | undefined;
		if (commit?.kind === "extraction-commit") lastEntryId = commit.lastEntryId;
	}
	return lastEntryId;
}

/** The prompt for one pass: what counts as durable, what already exists, and the reply shape. */
export function buildExtractionPrompt(
	transcript: string,
	existing: MemoryDirContents[],
	scopeDirs: MemoryScopeDir[],
): string {
	return [
		"You extract durable memories from one slice of a conversation between a user and a coding agent. A memory is a fact a future session cannot derive from the repository.",
		"",
		"Save when the slice holds any of these signals:",
		"- the user corrected your approach, scope, or style, especially more than once",
		'- the user stated a rule for the future ("from now on", "always", "never", "以后都这样", "不要再", "记住")',
		"- you changed direction because a tool failed or the user pushed back, and the reason is reusable",
		"- a reproducible multi-step procedure emerged that the user will want again",
		"- the user said who they are, what they are responsible for, or what they already know",
		"- the user named an external system and what it is for: a tracker, a dashboard, a channel",
		"- a decision was made for a reason that is not in the code: a deadline, a constraint, a stakeholder",
		"",
		"Do not save code patterns, conventions, architecture, file paths, git history, debugging recipes, anything already in AGENTS.md, or in-progress work for this session.",
		"",
		renderScopes(scopeDirs),
		renderExisting(existing, scopeDirs),
		"",
		"Reply with JSON only, no prose and no code fence:",
		'{"memories":[{"action":"create","scope":"user","type":"feedback","name":"kebab-case-slug","description":"one line","body":"markdown"}]}',
		"",
		'- "action" is "create", or "update" to replace an existing memory whose "name" you list exactly.',
		'- "type" is one of: user, feedback, project, reference. A feedback or project body states the rule or fact first, then a **Why:** line and a **How to apply:** line.',
		'- "description" is one line and decides whether a future session reads the file.',
		'- Use absolute dates, never "today" or "this week".',
		'- Return {"memories":[]} when the slice holds nothing durable. Most slices do not.',
		"",
		"<conversation>",
		transcript,
		"</conversation>",
	].join("\n");
}

/** Parse the model's reply into candidates, dropping entries that are not well formed. */
export function parseCandidates(text: string): MemoryCandidate[] {
	const json = extractJson(text);
	if (!json) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	const memories = (parsed as { memories?: unknown }).memories;
	if (!Array.isArray(memories)) return [];

	const candidates: MemoryCandidate[] = [];
	for (const entry of memories.slice(0, MAX_MEMORIES_PER_PASS)) {
		const candidate = toCandidate(entry);
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

/** Write the candidates that name an enabled scope, replacing an existing memory of the same name. */
export function applyCandidates(
	scopeDirs: MemoryScopeDir[],
	existing: MemoryDirContents[],
	candidates: MemoryCandidate[],
): Memory[] {
	const byDir = new Map<MemoryScopeDir, Map<string, Memory>>();
	for (const candidate of candidates) {
		const scopeIndex = scopeDirs.findIndex((scopeDir) => scopeDir.scope === candidate.scope);
		if (scopeIndex === -1) continue;
		const scopeDir = scopeDirs[scopeIndex];
		const previous = existing[scopeIndex].memories.find((memory) => memory.name === candidate.name);
		const fileName =
			candidate.action === "update" && previous ? previous.fileName : memoryFileName(candidate.name, candidate.type);
		let files = byDir.get(scopeDir);
		if (!files) {
			files = new Map();
			byDir.set(scopeDir, files);
		}
		files.set(fileName, {
			fileName,
			name: candidate.name,
			description: candidate.description,
			type: candidate.type,
			body: candidate.body,
		});
	}

	const written: Memory[] = [];
	for (const [scopeDir, files] of byDir) {
		for (const memory of files.values()) {
			writeMemory(scopeDir.dir, memory);
			written.push(memory);
		}
		syncIndex(scopeDir.dir);
	}
	return written;
}

function renderScopes(scopeDirs: MemoryScopeDir[]): string {
	const lines = scopeDirs.map((scopeDir) => `- "${scopeDir.scope}": ${scopeDir.dir}`);
	return [
		"Write to the scope that owns the fact:",
		...lines,
		"A user memory follows the user across projects; a project memory belongs to this working directory.",
	].join("\n");
}

function renderExisting(existing: MemoryDirContents[], scopeDirs: MemoryScopeDir[]): string {
	const sections = existing.map((contents, index) => {
		const scope = scopeDirs[index].scope;
		if (contents.memories.length === 0) return `${scope} directory: no memories yet`;
		const lines = contents.memories.map((memory) => `- ${memory.name} (${memory.type}): ${memory.description}`);
		return `${scope} directory:\n${lines.join("\n")}`;
	});
	return ["Memories that already exist. Update one instead of creating a near-duplicate.", ...sections].join("\n");
}

function sliceAfter(entries: readonly SessionEntry[], lastEntryId: string | undefined): readonly SessionEntry[] {
	if (!lastEntryId) return entries;
	const index = entries.findIndex((entry) => entry.id === lastEntryId);
	// The commit can point at an entry another branch or a compaction dropped; re-reading beats skipping.
	return index === -1 ? entries : entries.slice(index + 1);
}

function isContextMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function tail(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function responseTextOf(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function extractJson(text: string): string | undefined {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const source = fenced ? fenced[1] : text;
	const start = source.indexOf("{");
	const end = source.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	return source.slice(start, end + 1);
}

function toCandidate(entry: unknown): MemoryCandidate | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const value = entry as Record<string, unknown>;
	const { action, scope, type } = value;
	if (action !== "create" && action !== "update") return undefined;
	if (scope !== "user" && scope !== "project") return undefined;
	if (typeof type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(type)) return undefined;
	if (typeof value.name !== "string" || value.name.trim() === "") return undefined;
	if (typeof value.body !== "string" || value.body.trim() === "") return undefined;
	return {
		action,
		scope,
		// The list check above is the narrowing TypeScript cannot express.
		type: type as Memory["type"],
		name: value.name.trim(),
		description: typeof value.description === "string" ? value.description.trim() : "",
		body: value.body,
	};
}
