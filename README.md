# pi-mem

Persistent memory for [pi](https://github.com/earendil-works/pi). pi-mem lets pi carry facts between sessions: who you are, how you want it to work, why a project is going the way it is, and where things live outside the repository.

Memories are plain Markdown files on disk. There is no database, no embedding index, and nothing to maintain by hand. At the start of every run pi-mem puts a one-line index of each memory directory into the system prompt. pi reads a memory's body only when its description says the file matters, so a large memory collection costs a few lines of context, not all of it.

## Install

```bash
pi install git:github.com/guimingyue/pi-mem
```

Or from a local checkout:

```bash
git clone https://github.com/guimingyue/pi-mem
cd pi-mem && npm install
pi install ./
```

`pi list` shows the installed package, `pi remove git:github.com/guimingyue/pi-mem` removes it. To try it for one invocation without installing, use `pi -e ./path/to/pi-mem`.

## Where memories live

| Scope | Directory | Holds |
| --- | --- | --- |
| User | `~/.pi/agent/memory/` | Facts about you and your preferences, shared by every project |
| Project | `<project>/.pi/memory/` | Facts about this working directory: its goals, decisions, and external references |

`PI_CODING_AGENT_DIR` moves the user directory along with the rest of pi's state. pi-mem reads the project directory only after you [trust the project](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md#understand-project-trust), because project memories reach the system prompt.

## Memory files

Each memory is one Markdown file with frontmatter:

```markdown
---
name: terse-replies
description: User wants short answers with no trailing summary
metadata:
  type: feedback
---

Answer in a few sentences and stop. Do not recap what changed at the end.

**Why:** The user reads diffs directly, so a summary is noise.
**How to apply:** Every reply, including after a successful edit.
```

pi-mem names the file `<type>-<name>.md`, where `name` is the frontmatter slug. `type` decides which directory the memory belongs in:

| Type | Directory | Use it for |
| --- | --- | --- |
| `user` | User | Your role, expertise, and preferences |
| `feedback` | User, or Project when the rule binds everyone working on the project | A correction you gave, or an approach you confirmed |
| `project` | Project | Ongoing work, goals, deadlines, and the reasons behind a decision |
| `reference` | Project | Where to find things in external systems |

A `feedback` or `project` body states the rule first, then a `**Why:**` line and a `**How to apply:**` line, so a later session can judge an edge case instead of following the rule blindly. `[[another-name]]` links related memories.

## MEMORY.md is generated

Each directory also has a `MEMORY.md` index that lists every memory as one line: `- [name](file.md) — description`. pi-mem regenerates it from the memory files at startup, after each write, and before each run, so it also picks up files you added with an editor or a shell command.

Do not write `MEMORY.md` yourself. pi-mem blocks a write or edit that targets it and points at the memory file instead. Files without recognizable frontmatter stay on disk but are not indexed; `/memory` lists them.

The index holds at most 200 lines. Past that, the last memories are left out and the index says how many.

## Save a memory

Ask pi: "remember that I want short answers." It writes the file and the index updates on its own. Ask it to forget something and it deletes the file.

pi-mem also extracts memories by itself. After a run settles, every third run by default, it makes one background model call over the messages the previous pass did not see and saves what looks durable: a correction you repeated, a rule you stated for the future, a direction change mid-task, or a procedure that took several steps. It updates an existing memory rather than adding a near-duplicate, and it skips what the repository already says — code patterns, file paths, git history, and anything in `AGENTS.md`.

The pass reports what it saved. It does not run in `pi -p` print mode, where the process would exit first, and it does not run after an aborted run.

## Configure

`memory.json` in the agent directory sets the defaults. In a trusted project, `<project>/.pi/memory.json` overrides them:

```json
{
  "user": true,
  "project": true,
  "autoExtract": true,
  "extractEveryRuns": 3,
  "model": "anthropic/claude-haiku-4-5"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `user` | `true` | Use the user directory |
| `project` | `true` | Use the project directory |
| `autoExtract` | `true` | Run the background extraction pass |
| `extractEveryRuns` | `3` | Settled runs between extraction passes |
| `model` | the session model | `provider/modelId` for the extraction pass. A cheap model is enough |

pi-mem reports a malformed `memory.json` once at startup and keeps the defaults for the keys it could not read.

| Environment variable | Effect |
| --- | --- |
| `PI_MEMORY=0` | Turns both scopes and extraction off |
| `PI_MEMORY_AUTO_EXTRACT=0` | Turns off only the background pass; pi still reads and writes memories when you ask |

## /memory

| Command | Does |
| --- | --- |
| `/memory` | Lists both directories, their memories, and the extraction settings |
| `/memory reindex` | Regenerates `MEMORY.md` in every enabled directory |
| `/memory extract` | Runs an extraction pass now and waits for it |

## Memories are context, not instructions

pi is told that a memory is background information from an earlier session, that it may be stale, and that what it observes now wins over what a memory says. Before recommending something a memory names — a file, a function, a flag — it checks that it still exists.

Expect a memory to be wrong sometimes. Correct pi and the next extraction pass updates the file.

## Turn it off

`pi remove git:github.com/guimingyue/pi-mem` uninstalls it. `PI_MEMORY=0` keeps it installed but idle, which is what you want for scripts and CI runs.

## How it works in pi

pi-mem is an ordinary pi extension. It does not fork pi, patch its internals, or wrap its tools: everything happens through the public extension API. `package.json` declares the entry point, and pi calls the default export with an `ExtensionAPI` when it loads extensions — at startup and on `/reload`:

```json
{ "pi": { "extensions": ["./index.ts"] } }
```

```ts
export default function memoryExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => { /* ... */ });
  pi.registerCommand("memory", { /* ... */ });
}
```

The factory registers six event handlers and one command, then returns. Nothing runs until pi fires an event. The scope list is resolved on the first event of a session and cached until `session_shutdown`, because the cwd and the project-trust decision both feed it.

| pi event | What pi-mem does |
| --- | --- |
| `session_start` | Resolves the enabled scopes from `memory.json`, the environment, the cwd, and the project-trust decision; brings each `MEMORY.md` up to date |
| `before_agent_start` | Writes the `memory` section into `event.systemPromptOptions.sections` |
| `tool_call` (`write`, `edit`) | Confines the call to a memory directory, or blocks it with a reason |
| `tool_result` (`write`, `edit`, not an error) | Re-derives the index of the directory that was written |
| `agent_settled` | Counts the run and, every `extractEveryRuns` runs, starts a background extraction pass |
| `session_shutdown` | Aborts an in-flight pass and drops the cached scope state |

### Injection is a section, not a prompt rewrite

pi builds its system prompt from independently replaceable sections, each wrapped in its own XML tag. pi-mem sets one of them:

```ts
event.systemPromptOptions.sections.memory = buildMemorySection(scopeDirs);
```

pi diffs the sections against what the model already has in the transcript and patches only the ones that changed. Returning `event.systemPrompt` instead would replace the complete prompt for the turn, leaving nothing to diff; setting one section keeps the rest of the prompt byte-identical, so the provider's prompt cache still hits.

The section carries the directories, their indexes, and the rules for saving and using memories — not the memory bodies. pi reads a body with its ordinary `read` tool when a description looks relevant, which is why a large collection costs a few lines of context.

### The write guard checks the path it will actually write

pi fires `tool_call` before executing a tool. Returning `{ block: true, reason }` cancels the call and sends the reason back to the model, so a blocked write is a correction the model can act on rather than a silent failure.

For a `write` or `edit` aimed at a memory directory, pi-mem:

1. Resolves the path exactly as pi's tool does — `~`, a leading `@`, unicode spaces, `file://`, relative to the session cwd. A resolver that differed from the tool's would let a model reach a file the guard never inspected.
2. Checks the resolved path is directly inside a scope directory, is NFC-normalized, and has a valid memory file name. `MEMORY.md` is rejected with a message pointing at the memory file instead.
3. Writes the resolved path back into `event.input.path`, so the path that was checked is the path that gets written.

`tool_result` then re-derives the index. Because the index is derived rather than maintained, this also heals memories added or edited outside pi — with an editor, a shell command, or another session.

### Extraction is incremental and commits to the session

`agent_settled` fires only when a run is fully finished: no automatic retry, compaction, or queued continuation will follow. That is why pi-mem uses it instead of `agent_end`, which fires at the end of each agent loop even when more work is coming.

Every third settled run, pi-mem makes one `modelRegistry.complete` call with `cacheRetention: "none"` — a background pass should not compete with the conversation for cache. Its input is the transcript slice the previous pass did not see, tail-capped at 80,000 characters, plus the memories that already exist so the model updates one instead of adding a near-duplicate. The reply is JSON, parsed defensively: malformed entries are dropped, at most five memories are written, and a candidate naming a disabled scope is skipped.

The position is then committed to the session itself:

```ts
pi.appendEntry("memory", { kind: "extraction-commit", lastEntryId: lastEntry.id });
```

There is no sidecar state file. The commit travels with the session, so a resumed session continues where the last pass stopped instead of re-reading the whole transcript. If the commit points at an entry that a branch switch or a compaction dropped, the pass re-reads from the start rather than skipping the gap.

The pass never delays a reply, never runs after an aborted run, and never runs in `pi -p` print mode, where the process exits before it could finish.

### One run, end to end

1. pi loads the package and calls the factory. Handlers are registered.
2. `session_start`: the project is trusted, so both scopes are enabled. Each `MEMORY.md` is regenerated.
3. `before_agent_start`: the `memory` section is set. pi patches it into the system prompt. The model sees `[launch-deadline](…/project-deadline.md) — The launch date is fixed by the contract` and reads that file only if the task touches the deadline.
4. The model calls `write` on `.pi/memory/feedback-terse-replies.md`. `tool_call` resolves and validates it; `tool_result` adds its line to the index.
5. The run finishes. `agent_settled` increments the counter to 1 of 3 — no pass yet.
6. Two runs later the counter reaches 3. One background call reads the new messages, saves what is durable, and appends an extraction commit. The status line shows `extracting memories` while it runs, and a notification lists what was saved.
7. `session_shutdown` aborts the pass if it is still running.

## Code layout

| File | What it does |
| --- | --- |
| `index.ts` | Extension entry point: event wiring, the write guard, and `/memory` |
| `src/config.ts` | Scopes, `memory.json`, environment overrides |
| `src/store.ts` | The file format, the derived index, and path validation |
| `src/prompt.ts` | The `memory` system prompt section |
| `src/extraction.ts` | The background extraction pass and its session commit |
| `src/paths.ts` | Path resolution matching pi's `write` and `edit` tools |

Read `src/store.ts` first: the file format explains everything the other files do.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT. `src/paths.ts` ports the path normalization of pi's `write` and `edit` tools; pi's copyright notice is carried in [LICENSE](LICENSE).