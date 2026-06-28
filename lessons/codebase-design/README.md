# Codebase Design

Module-design vocabulary and structural patterns. Shared language for designing **deep modules** — a lot of behaviour behind a small interface, at a clean seam, testable through that interface.

| Lesson | Role | Read when |
|--------|------|-----------|
| [`deep-modules.md`](deep-modules.md) | The vocabulary (module, interface, depth, seam, adapter, leverage, locality) and the core principles (deletion test, interface-is-test-surface, one-vs-two adapters, make illegal states unrepresentable). **Start here.** | always |
| [`deepening.md`](deepening.md) | How to deepen a cluster of shallow modules safely, by dependency category, and how its tests change. | when restructuring an existing cluster |
| [`design-it-twice.md`](design-it-twice.md) | Parallel sub-agent pattern to explore several radically different interfaces before committing. | when the interface is uncertain |

The test-side counterparts live in [`../testing/`](../testing/README.md) — `deep-modules.md` owns the testability *principles*; `testing/` owns the test *mechanics*.
