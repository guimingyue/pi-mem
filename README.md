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