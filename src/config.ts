/**
 * Memory configuration.
 *
 * Memories are Markdown files in two scopes: a user scope shared by every project
 * (`~/.pi/agent/memory/`) and a project scope inside the working directory (`<cwd>/.pi/memory/`).
 * Both are on by default, and the project scope additionally needs a project-trust decision.
 * `memory.json` in the agent directory turns a scope off or tunes auto-extraction; for a trusted
 * project, `<cwd>/.pi/memory.json` overrides it.
 *
 * ```json
 * {
 *   "user": true,
 *   "project": true,
 *   "autoExtract": true,
 *   "extractEveryRuns": 3,
 *   "model": "anthropic/claude-haiku-4-5"
 * }
 * ```
 *
 * `PI_MEMORY=0` disables both scopes and `PI_MEMORY_AUTO_EXTRACT=0` disables the background
 * extraction pass, for scripts and CI runs that should not write memories or spend tokens.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Where a memory lives: across every project, or inside one project. */
export type MemoryScope = "user" | "project";

/** One enabled memory directory and the scope it stores. */
export interface MemoryScopeDir {
	scope: MemoryScope;
	dir: string;
}

/** Effective memory configuration: config files merged over the defaults, then env overrides. */
export interface MemoryConfig {
	user: boolean;
	project: boolean;
	autoExtract: boolean;
	/** Settled agent runs between extraction passes. */
	extractEveryRuns: number;
	/** `provider/modelId` for the extraction pass. The session model when absent. */
	model?: string;
	/** Config file problems, reported once at startup. */
	errors: string[];
}

export const MEMORY_CONFIG_FILE = "memory.json";

const DEFAULTS: Omit<MemoryConfig, "errors" | "model"> = {
	user: true,
	project: true,
	autoExtract: true,
	extractEveryRuns: 3,
};

/** Read the merged configuration. `projectTrusted` gates the project config file, as for `mcp.json`. */
export function loadMemoryConfig(options: { cwd: string; projectTrusted: boolean }): MemoryConfig {
	const config: MemoryConfig = { ...DEFAULTS, errors: [] };
	readConfigFile(join(getAgentDir(), MEMORY_CONFIG_FILE), config);
	if (options.projectTrusted) {
		readConfigFile(join(options.cwd, CONFIG_DIR_NAME, MEMORY_CONFIG_FILE), config);
	}
	applyEnvOverrides(config);
	return config;
}

/** The enabled memory directories, user scope first. Paths are resolved so writes can be confined to them. */
export function getMemoryScopeDirs(
	config: MemoryConfig,
	options: { cwd: string; projectTrusted: boolean },
): MemoryScopeDir[] {
	const dirs: MemoryScopeDir[] = [];
	if (config.user) dirs.push({ scope: "user", dir: resolve(getAgentDir(), "memory") });
	// Project memories are injected into the system prompt, so an untrusted folder must not supply them.
	if (config.project && options.projectTrusted) {
		dirs.push({ scope: "project", dir: resolve(join(options.cwd, CONFIG_DIR_NAME, "memory")) });
	}
	return dirs;
}

function applyEnvOverrides(config: MemoryConfig): void {
	if (isDisabled(process.env.PI_MEMORY)) {
		config.user = false;
		config.project = false;
		config.autoExtract = false;
	}
	if (isDisabled(process.env.PI_MEMORY_AUTO_EXTRACT)) config.autoExtract = false;
}

function isDisabled(value: string | undefined): boolean {
	return value === "0" || value === "false";
}

function readConfigFile(path: string, config: MemoryConfig): void {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		config.errors.push(`${path}: ${(error as Error).message}`);
		return;
	}

	let parsed: unknown;
	try {
		// Windows editors save JSON with a byte order mark, which is not a syntax error to the user.
		parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	} catch (error) {
		config.errors.push(`${path}: ${(error as Error).message}`);
		return;
	}
	if (!isRecord(parsed)) {
		config.errors.push(`${path}: expected a JSON object`);
		return;
	}

	applyBooleans(parsed, config, path);
	applyExtractEveryRuns(parsed, config, path);
	applyModel(parsed, config, path);
}

function applyBooleans(parsed: Record<string, unknown>, config: MemoryConfig, path: string): void {
	for (const key of ["user", "project", "autoExtract"] as const) {
		const value = parsed[key];
		if (value === undefined) continue;
		if (typeof value !== "boolean") {
			config.errors.push(`${path}: "${key}" must be a boolean`);
			continue;
		}
		config[key] = value;
	}
}

function applyExtractEveryRuns(parsed: Record<string, unknown>, config: MemoryConfig, path: string): void {
	const value = parsed.extractEveryRuns;
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		config.errors.push(`${path}: "extractEveryRuns" must be an integer >= 1`);
		return;
	}
	config.extractEveryRuns = value;
}

function applyModel(parsed: Record<string, unknown>, config: MemoryConfig, path: string): void {
	const value = parsed.model;
	if (value === undefined) return;
	if (typeof value !== "string" || !value.includes("/")) {
		config.errors.push(`${path}: "model" must be a "provider/modelId" string`);
		return;
	}
	config.model = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}