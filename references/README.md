# references/

Shallow clones of external repos kept locally as design references for the duet MVP (cloned 2026-06-11). These are **read-only study material, not dependencies** — none of them is installed, imported, or built against. Re-clone to refresh; nothing here is pinned on purpose.

License matters because it determines what we may do beyond reading:

| Repo | License | What it's here for | Copy code? |
|---|---|---|---|
| `sandcastle/` | MIT | The best worker-plumbing prior art: exact `claude`/`codex` CLI invocations (`src/AgentProvider.ts`), stream-line parsers for both CLIs, idle-vs-completion dual timeouts (`src/Orchestrator.ts`, ADR 0019), session lookup by id (`src/SessionStore.ts`), BoundedTail, shutdownRegistry. Known gap to NOT inherit: no `proc.kill()` anywhere — host processes leak on abort. | **Yes** (MIT, attribute) |
| `codex/` (sparse: `sdk/typescript`, `docs`) | Apache-2.0 | The Codex TS SDK source and docs — how `codex exec` is driven programmatically, thread resume, output schema, event types. | **Yes** (Apache-2.0, attribute) |
| `claude-agent-sdk-typescript/` | Anthropic Commercial ToS (proprietary) | The orchestrator substrate. Read for API shapes: `query()`, `tool()` + `createSdkMcpServer()`, `canUseTool`, session resume/fork options. | **No** — use it as an npm dependency; read source only to understand the API |
| `claude-squad/` | AGPL-3.0 | The tmux **anti-model**: agents live inside tmux sessions, state read back by `capture-pane` scraping (`session/tmux/tmux.go`). Duet does the inverse (own the processes, panes are `tail -F` viewers). | **No** — AGPL; inspiration only, no code reuse |
| `pi-mono/` | MIT | Mario Zechner's agent toolkit — clean agent-loop/harness patterns (`pi-agent-core`), and a candidate third worker provider someday. | Yes (MIT), though duet builds its orchestrator on the Agent SDK instead |

Context for why each was chosen: the research summarized in `../docs/automation-design.md` §"Architecture" and the session notes behind the 2026-06-11 pivot.
