/**
 * Path resolution for memory writes, matching what pi's `write` and `edit` tools do.
 *
 * The write guard checks a path and then makes that checked path the path written, so this has to
 * normalize exactly like the tools: a difference would let a model reach a file the guard did not
 * inspect. pi does not export its resolver, so the parts that affect resolution are ported here.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Resolve a model-supplied path against the session cwd, expanding `~` and `file://`. */
export function resolveToCwd(filePath: string, cwd: string): string {
	const normalized = normalize(filePath);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(normalize(cwd), normalized);
}

function normalize(input: string): string {
	let normalized = input.replace(UNICODE_SPACES, " ");
	// pi strips the `@` of a CLI @file mention before resolving.
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);

	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("file://")) return fileURLToPath(normalized);
	return normalized;
}

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths to a form native Windows APIs accept. */
function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}