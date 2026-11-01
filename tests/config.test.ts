import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getMemoryScopeDirs, loadMemoryConfig } from "../src/config.ts";

// pi does not export the name of the env var that moves its agent directory.
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

const tempDir = join(tmpdir(), `pi-mem-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const agentDir = join(tempDir, "agent");
const projectDir = join(tempDir, "project");

const envKeys = [ENV_AGENT_DIR, "PI_MEMORY", "PI_MEMORY_AUTO_EXTRACT"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	savedEnv = {};
	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(dir: string, contents: unknown): void {
	writeFileSync(join(dir, "memory.json"), JSON.stringify(contents), "utf-8");
}

describe("loadMemoryConfig", () => {
	test("defaults to both scopes and auto-extraction every third run", () => {
		expect(loadMemoryConfig({ cwd: projectDir, projectTrusted: true })).toEqual({
			user: true,
			project: true,
			autoExtract: true,
			extractEveryRuns: 3,
			errors: [],
		});
	});

	test("reads the agent directory config", () => {
		writeConfig(agentDir, { project: false, extractEveryRuns: 5, model: "anthropic/claude-haiku-4-5" });
		const config = loadMemoryConfig({ cwd: projectDir, projectTrusted: true });
		expect(config.project).toBe(false);
		expect(config.extractEveryRuns).toBe(5);
		expect(config.model).toBe("anthropic/claude-haiku-4-5");
	});

	test("lets a trusted project override the agent config", () => {
		writeConfig(agentDir, { autoExtract: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeConfig(join(projectDir, ".pi"), { autoExtract: false });
		expect(loadMemoryConfig({ cwd: projectDir, projectTrusted: true }).autoExtract).toBe(false);
	});

	test("ignores the project config when the project is not trusted", () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeConfig(join(projectDir, ".pi"), { autoExtract: false });
		expect(loadMemoryConfig({ cwd: projectDir, projectTrusted: false }).autoExtract).toBe(true);
	});

	test("reports a broken config file and keeps the defaults", () => {
		writeFileSync(join(agentDir, "memory.json"), "{not json", "utf-8");
		const config = loadMemoryConfig({ cwd: projectDir, projectTrusted: true });
		expect(config.errors).toHaveLength(1);
		expect(config.user).toBe(true);
	});

	test("reports wrong value types and keeps the defaults for them", () => {
		writeConfig(agentDir, { user: "yes", extractEveryRuns: 0, model: "haiku" });
		const config = loadMemoryConfig({ cwd: projectDir, projectTrusted: true });
		expect(config.errors).toHaveLength(3);
		expect(config.user).toBe(true);
		expect(config.extractEveryRuns).toBe(3);
		expect(config.model).toBeUndefined();
	});

	test("PI_MEMORY=0 turns everything off", () => {
		process.env.PI_MEMORY = "0";
		const config = loadMemoryConfig({ cwd: projectDir, projectTrusted: true });
		expect(config).toMatchObject({ user: false, project: false, autoExtract: false });
		expect(getMemoryScopeDirs(config, { cwd: projectDir, projectTrusted: true })).toEqual([]);
	});

	test("PI_MEMORY_AUTO_EXTRACT=0 turns off only the extraction pass", () => {
		process.env.PI_MEMORY_AUTO_EXTRACT = "0";
		const config = loadMemoryConfig({ cwd: projectDir, projectTrusted: true });
		expect(config).toMatchObject({ user: true, project: true, autoExtract: false });
	});
});

describe("getMemoryScopeDirs", () => {
	test("returns the user directory and the project memory directory", () => {
		const config = loadMemoryConfig({ cwd: projectDir, projectTrusted: true });
		expect(getMemoryScopeDirs(config, { cwd: projectDir, projectTrusted: true })).toEqual([
			{ scope: "user", dir: join(agentDir, "memory") },
			{ scope: "project", dir: join(projectDir, ".pi", "memory") },
		]);
	});

	test("returns only the enabled scopes", () => {
		writeConfig(agentDir, { user: false });
		const config = loadMemoryConfig({ cwd: projectDir, projectTrusted: true });
		expect(getMemoryScopeDirs(config, { cwd: projectDir, projectTrusted: true })).toEqual([
			{ scope: "project", dir: join(projectDir, ".pi", "memory") },
		]);
	});

	test("omits the project directory without project trust", () => {
		const config = loadMemoryConfig({ cwd: projectDir, projectTrusted: false });
		expect(getMemoryScopeDirs(config, { cwd: projectDir, projectTrusted: false })).toEqual([
			{ scope: "user", dir: join(agentDir, "memory") },
		]);
	});
});
