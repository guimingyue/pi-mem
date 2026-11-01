/**
 * pi-mem: persistent memory for pi.
 *
 * Memories are Markdown files in two scopes: a user directory shared by every project and a project
 * directory in the working directory, which needs a project-trust decision. Each directory has a
 * `MEMORY.md` index derived from its files. The indexes are injected into the system prompt as the
 * `memory` section, so a session starts knowing what it can remember and reads only the bodies it
 * needs.
 *
 * The model writes memories with the ordinary `write` and `edit` tools; this extension confines
 * those calls to the memory directories and re-derives the index afterwards. After a run settles it
 * also runs a background extraction pass over the messages the previous pass did not see, so
 * durable facts are saved without the user asking.
 *
 * `memory.json` in the agent directory (and, for a trusted project, `<cwd>/.pi/memory.json`)
 * configures it; `PI_MEMORY=0` turns it off. `/memory` shows the state, re-indexes, or extracts now.
 */

import type {
	EditToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEventResult,
	WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { getMemoryScopeDirs, loadMemoryConfig, type MemoryConfig, type MemoryScopeDir } from "./src/config.ts";
import { type ExtractionOutcome, readExtractionCommit, runExtractionPass } from "./src/extraction.ts";
import { resolveToCwd } from "./src/paths.ts";
import { buildMemorySection } from "./src/prompt.ts";
import { findScopeDir, syncIndex, validateMemoryPath } from "./src/store.ts";

const STATUS_KEY = "memory";

interface MemoryState {
	config: MemoryConfig;
	scopeDirs: MemoryScopeDir[];
}

export default function memoryExtension(pi: ExtensionAPI): void {
	// Reloaded per session: the cwd and the project trust decision both feed the scope list.
	let state: MemoryState | undefined;
	let runsSinceExtraction = 0;
	let inFlight: { controller: AbortController; done: Promise<void> } | undefined;

	const getState = (ctx: ExtensionContext): MemoryState => {
		if (!state) {
			const options = { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
			const config = loadMemoryConfig(options);
			state = { config, scopeDirs: getMemoryScopeDirs(config, options) };
			reportConfigErrors(ctx, config);
		}
		return state;
	};

	pi.on("session_start", (_event, ctx) => {
		const { scopeDirs } = getState(ctx);
		for (const scopeDir of scopeDirs) syncIndex(scopeDir.dir);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const { scopeDirs } = getState(ctx);
		if (scopeDirs.length === 0) {
			delete event.systemPromptOptions.sections.memory;
			return;
		}
		event.systemPromptOptions.sections.memory = buildMemorySection(scopeDirs);
	});

	pi.on("tool_call", (event, ctx) => {
		if (isToolCallEventType("write", event)) return guardMemoryWrite(event, getState(ctx).scopeDirs, ctx.cwd);
		if (isToolCallEventType("edit", event)) return guardMemoryWrite(event, getState(ctx).scopeDirs, ctx.cwd);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const { path } = event.input;
		if (typeof path !== "string") return;
		const scopeDir = findScopeDir(getState(ctx).scopeDirs, resolveToCwd(path, ctx.cwd));
		if (scopeDir) syncIndex(scopeDir.dir);
	});

	pi.on("agent_settled", (event, ctx) => {
		const { config, scopeDirs } = getState(ctx);
		if (!config.autoExtract || event.aborted || scopeDirs.length === 0) return;
		// Print mode exits once the prompt is answered, before a background pass could finish.
		if (ctx.mode === "print") return;
		runsSinceExtraction += 1;
		// An unfinished pass keeps the counter, so the next settle tries again instead of skipping.
		if (runsSinceExtraction < config.extractEveryRuns || inFlight) return;
		runsSinceExtraction = 0;
		startExtraction(pi, ctx, config, scopeDirs);
	});

	pi.on("session_shutdown", () => {
		inFlight?.controller.abort();
		inFlight = undefined;
		state = undefined;
		runsSinceExtraction = 0;
	});

	pi.registerCommand("memory", {
		description: "Show memory scopes and memories, re-index them, or extract now",
		getArgumentCompletions: (prefix) => {
			const commands = ["extract", "reindex"].filter((name) => name.startsWith(prefix));
			return commands.length > 0 ? commands.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const { config, scopeDirs } = getState(ctx);
			const command = args.trim();
			if (command === "reindex") {
				const counts = scopeDirs.map((scopeDir) => `${scopeDir.scope}: ${syncIndex(scopeDir.dir).memories.length}`);
				ctx.ui.notify(`Re-indexed ${counts.join(", ") || "no enabled memory directories"}`, "info");
				return;
			}
			if (command === "extract") {
				if (inFlight) {
					ctx.ui.notify("An extraction pass is already running", "warning");
					return;
				}
				runsSinceExtraction = 0;
				await startExtraction(pi, ctx, config, scopeDirs).done;
				return;
			}
			await showMemoryStatus(ctx, scopeDirs, config);
		},
	});

	function startExtraction(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		config: MemoryConfig,
		scopeDirs: MemoryScopeDir[],
	): { controller: AbortController; done: Promise<void> } {
		const controller = new AbortController();
		const lastEntryId = readExtractionCommit(ctx.sessionManager.getBranch());
		ctx.ui.setStatus(STATUS_KEY, "extracting memories");
		const done = runExtractionPass({ pi, ctx, config, scopeDirs, lastEntryId, signal: controller.signal })
			.then((outcome) => reportExtraction(ctx, outcome))
			// runExtractionPass reports its own failures; this keeps a stray rejection from crashing pi.
			.catch(() => {})
			.finally(() => {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				inFlight = undefined;
			});
		inFlight = { controller, done };
		return inFlight;
	}
}

/** Confine a model write to the memory directories, and make the path we checked the path written. */
function guardMemoryWrite(
	event: WriteToolCallEvent | EditToolCallEvent,
	scopeDirs: MemoryScopeDir[],
	cwd: string,
): ToolCallEventResult | undefined {
	const resolved = resolveToCwd(event.input.path, cwd);
	const scopeDir = findScopeDir(scopeDirs, resolved);
	if (!scopeDir) return undefined;
	const reason = validateMemoryPath(scopeDir.dir, resolved);
	if (reason) return { block: true, reason: `memory: ${reason}` };
	event.input.path = resolved;
	return undefined;
}

function reportExtraction(ctx: ExtensionContext, outcome: ExtractionOutcome): void {
	if (!ctx.hasUI) return;
	if (outcome.kind === "failed") {
		ctx.ui.notify(`Memory extraction failed: ${outcome.error}`, "warning");
		return;
	}
	if (outcome.kind === "no-model") {
		ctx.ui.notify("Memory extraction skipped: no model available", "warning");
		return;
	}
	if (outcome.kind === "done" && outcome.written.length > 0) {
		const names = outcome.written.map((memory) => memory.name).join(", ");
		ctx.ui.notify(
			`Saved ${outcome.written.length} ${outcome.written.length === 1 ? "memory" : "memories"}: ${names}`,
			"info",
		);
	}
}

async function showMemoryStatus(
	ctx: ExtensionContext,
	scopeDirs: MemoryScopeDir[],
	config: MemoryConfig,
): Promise<void> {
	if (scopeDirs.length === 0) {
		ctx.ui.notify("Memory is disabled (PI_MEMORY=0 or memory.json)", "info");
		return;
	}

	const lines = [
		`auto-extract: ${config.autoExtract ? `on, every ${config.extractEveryRuns} runs` : "off"}`,
		`extraction model: ${config.model ?? "the session model"}`,
	];
	for (const scopeDir of scopeDirs) {
		const contents = syncIndex(scopeDir.dir);
		lines.push(`--- ${scopeDir.scope}: ${scopeDir.dir} (${contents.memories.length}) ---`);
		for (const memory of contents.memories) lines.push(`${memory.name} (${memory.type}) - ${memory.description}`);
		for (const fileName of contents.unparsed) lines.push(`${fileName} - no frontmatter, not indexed`);
	}

	if (ctx.hasUI && ctx.mode === "tui") {
		await ctx.ui.select("Memory", lines);
		return;
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

function reportConfigErrors(ctx: ExtensionContext, config: MemoryConfig): void {
	if (config.errors.length === 0 || !ctx.hasUI) return;
	ctx.ui.notify(`memory.json: ${config.errors.join("; ")}`, "warning");
}