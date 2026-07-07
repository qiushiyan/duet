# Corpus Replay Acceptance Contract

These assertions define the runtime behaviors that make corpus replay acceptable. They are intentionally independent of any implementation shape.

[A1] While loading, dry-running, or replaying a corpus record, the system SHALL NOT modify any file under the selected corpus record directory, any live `.duet/runs/<runId>` directory outside the requested replay output directory, or any provider session store.  
Verify by: snapshot hashes and mtimes for a corpus record, a sentinel live run directory, and provider session stores before a dry run and a fake-turn replay -> all snapshots are unchanged, and every new or modified artifact is under the requested replay output directory.

[A2] When archived terminal state contains an `orchestratorSessionId`, active-turn hints, pending-turn records, or worker `contextUsage`, the system SHALL NOT carry those replay-identity values into the fresh replay phase-entry state or orchestrator turn.  
Verify by: seed archived `state.json` with sentinel values for those fields and instrument the orchestrator-turn boundary -> replay workspace state omits the sentinels, and the turn invocation contains no resume/session/context value matching a sentinel.

[A3] When the replayed orchestrator asks for `get_task`, the system SHALL serve the recorded phase brief from the corpus record.  
Verify by: change the live spec or registry so a sentinel string would appear in a freshly rendered brief -> `get_task` returns the archived brief byte-for-byte and excludes the sentinel.

[A4] If a replay input surface is synthesized, current-backed, omitted, or otherwise not reconstructed byte-identically from the corpus record, then the system SHALL name that surface in reconstruction notes in both the text report and JSON report.  
Verify by: replay a record that lacks raw historical `list_snippets` output and contains a mid-phase steer that is not reinjected -> both reports contain reconstruction notes naming the current-library `list_snippets` fallback and the unreplayed mid-phase steer.

[A5] When a fresh worker turn has the same duty, snippet tag, per-duty ordinal, and fan-out membership as the original worker turn but a different prompt body, the system SHALL report adaptation drift and SHALL NOT report structural drift for that turn.  
Verify by: run a fake-turn replay that changes only whitespace or wording inside an otherwise aligned worker prompt -> the report places the body diff under adaptation drift and records no structural divergence at that turn.

[A6] When the first mismatch between original and fresh traces is a changed worker duty, snippet tag, fan-out membership, terminal verb, or terminal decision payload, the system SHALL mark that event as the first structural divergence.  
Verify by: run separate fake-turn replays whose first mismatch is each listed surface -> each report identifies that event as the first structural divergence rather than adaptation drift.

[A7] If a structural divergence or script exhaustion occurs before later worker prompts, the system SHALL label later trace events as unanchored or post-divergence and SHALL NOT include later prompt-body differences as anchored adaptation drift.  
Verify by: force an early tag mismatch and then force later body-only differences -> the report shows the early mismatch as the anchored cutoff and labels or suppresses the later body differences outside the comparable anchored region.

[A8] When a fresh prompt to a duty differs from the recorded prompt body or tag for that duty ordinal, the scripted worker SHALL still return that duty ordinal's recorded response.  
Verify by: record two responses for the same duty with unique sentinel bodies, then send a mismatched first fresh prompt for that duty -> the worker returns the first sentinel response and the report records the prompt mismatch instead of selecting by prompt similarity or equality.

[A9] If a fresh replay sends the `(N+1)`th prompt to a duty that has only `N` recorded responses, the scripted worker SHALL return an exhaustion sentinel.  
Verify by: replay a trace with one recorded response for a duty while the fake orchestrator sends two prompts to that duty -> the second worker result is an exhaustion sentinel rather than a reused, empty, or live-provider response.

[A10] If a scripted worker returns an exhaustion sentinel during replay, the system SHALL report script exhaustion as structural drift at that turn.  
Verify by: replay a trace that exhausts a duty's recorded responses -> both reports mark script exhaustion as structural drift at the exhausted prompt.

[A11] When the live replay command is invoked without `--yes`, the system SHALL NOT invoke the live orchestrator SDK.  
Verify by: run the live replay command without `--yes` using an SDK boundary spy that would fail on invocation -> the command stops before the SDK boundary and stdout names the record, phase, output directory, model/budget context, and that the orchestrator would run live.

[A12] When dry-run mode is invoked, the system SHALL perform record loading, parsing, phase-entry state rewind, and reconstruction checks without invoking the live orchestrator SDK.  
Verify by: run dry-run mode on a record with a reconstruction fallback and an SDK boundary spy -> dry-run output includes the reconstruction note and rewind result, and the SDK spy observes zero invocations.
