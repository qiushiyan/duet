# Acceptance Contract - `duet workflows`

[A1] When `duet workflows` lists a project or user workflow file whose top-level module body would throw or write a sentinel if imported, the list command SHALL report the workflow by filename without evaluating that module.
  Verify by: place `.duet/workflows/volatile.ts` with a top-level throw plus sentinel write, run `duet workflows` => exit code `0`, output includes `volatile  .duet/workflows/volatile.ts`, the thrown text is absent, and the sentinel file is absent.

[A2] When `duet workflows` lists project or user workflow files, the list command SHALL NOT create, modify, or remove any file under `.duet/`.
  Verify by: snapshot `.duet/` metadata and contents before and after `duet workflows` with at least one external definition present => no `.duet/runs/` path exists and the snapshot is byte-for-byte unchanged except for filesystem access times.

[A3] When one workflow name is defined in more than one layer, the list command SHALL report that name only as a collision and SHALL NOT report it under any available layer section.
  Verify by: create `.duet/workflows/full.ts` in a project => text output contains a `collisions` entry for `full  shipped + project (.duet/workflows/full.ts)` and contains no `full` row under `project · .duet/workflows`.

[A4] When `duet workflows --json` reports a name defined in multiple layers, the JSON row SHALL have `status: "collision"` and `sources` SHALL contain every colliding layer for that name.
  Verify by: create project and user definitions both named `personal.ts`, run `duet workflows --json` => the single `personal` object has `"status":"collision"` and exactly two `sources` entries whose `layer` values are `project` and `user`.

[A5] When `duet workflows --json` reports a project or user workflow that has not been compiled, the JSON row SHALL mark the workflow `available` without a `title` field.
  Verify by: create `.duet/workflows/broken.ts` containing a syntactically valid default export that would fail compilation, run `duet workflows --json` => the `broken` object has `"status":"available"`, one `project` source with its path, and no `title` key.

[A6] Where a provisioned workflow directory contains only the generated `duet-workflows.d.ts` typing stub, the workflows surface SHALL NOT treat `duet-workflows.d` as a workflow name.
  Verify by: provision `.duet/workflows/duet-workflows.d.ts`, run `duet workflows` and `duet workflows check duet-workflows.d` => the list output omits `duet-workflows.d`, and the check failure is the not-found diagnostic with no import attempt for the stub.

[A7] If `duet workflows check <name>` is run for a colliding workflow name, then the check command SHALL surface the loader's collision diagnostic without adding a command-specific wrapper.
  Verify by: create `.duet/workflows/full.ts`, run `duet workflows check full` => non-zero exit, stderr is the same collision message produced by resolving `full` for a run, with no added `workflows check` preface or alternate wording.

[A8] When `duet workflows check <name>` succeeds for a workflow whose delivery stage has no continuity edge, the summary SHALL describe delivery continuity as structurally fresh rather than as a runtime provider guarantee.
  Verify by: check a compiling workflow with no delivery-maker continuity edge => output contains `structurally fresh` and does not contain an unqualified promise that builder or judge will reuse architect or analyst context.

[A9] When `duet workflows check <name>` succeeds for a workflow with an acceptance-contract author phase and a build verification checkpoint, the summary SHALL report both the structural author phase and the consultant-gated verification condition.
  Verify by: check a compiling workflow with contract authored at `design` and verified at `implement` => output contains `acceptance contract      authored at design, verified at implement (when a consultant is bound)`.

[A10] If `duet workflows init <name>` is asked to create a workflow name that is already defined in any shipped, project, or user layer, then init SHALL refuse without writing the project workflow file.
  Verify by: run `duet workflows init full` and then run `duet workflows init personal` with `~/.config/duet/workflows/personal.ts` present => each exits non-zero, names the resolving layer, and leaves `.duet/workflows/full.ts` or `.duet/workflows/personal.ts` absent.

[A11] If `duet workflows init <name>` rejects a non-empty name containing a path separator or otherwise not satisfying the kebab-ish filename rule, then init SHALL NOT write outside `.duet/workflows/`.
  Verify by: run `duet workflows init ../escape` and `duet workflows init nested/name` => both exit non-zero and no `escape.ts`, `nested/name.ts`, or sibling directory outside `.duet/workflows/` is created.

[A12] When `duet workflows init <name>` succeeds, the seeded workflow SHALL compile through `duet workflows check <name>` before the user edits it.
  Verify by: run `duet workflows init trial-flow` followed immediately by `duet workflows check trial-flow` => check exits `0` and reports a `frame → build (fixer) → finish` structure with `trial-flow` as the workflow name.
