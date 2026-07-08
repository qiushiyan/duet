# Deepening

How to deepen a cluster of shallow modules safely, given its dependencies. Assumes the vocabulary in [deep-modules.md](deep-modules.md) — **module**, **interface**, **seam**, **adapter**, and the **two-adapter rule**.

## The bar

- **Classify the candidate's dependencies first** — the category dictates how the deepened module is tested across its seam.
- **The two-adapter rule decides whether a port exists at all** ([deep-modules.md](deep-modules.md)). Production plus test is the usual pair that earns one.
- **Replace, don't layer.** Tests at the deepened interface *replace* the shallow modules' unit tests — but they exist before those are deleted, never after.

## Dependency categories

When assessing a candidate for deepening, classify its dependencies. The category determines how the deepened module is tested across its seam.

### 1. In-process

Pure computation, in-memory state, no I/O. Always deepenable — merge the modules and test through the new interface directly. No adapter needed.

### 2. Local-substitutable

Dependencies that have local test stand-ins (PGLite for Postgres, in-memory filesystem). Deepenable if the stand-in exists. The deepened module is tested with the stand-in running in the test suite. The seam is internal; no port at the module's external interface.

### 3. Remote but owned (Ports & Adapters)

Your own services across a network boundary (microservices, internal APIs). Define a **port** (interface) at the seam. The deep module owns the logic; the transport is injected as an **adapter**. Tests use an in-memory adapter. Production uses an HTTP/gRPC/queue adapter.

Recommendation shape: *"Define a port at the seam, implement an HTTP adapter for production and an in-memory adapter for testing, so the logic sits in one deep module even though it's deployed across a network."*

### 4. True external (Mock)

Third-party services (Stripe, Twilio, etc.) you don't control. The deepened module takes the external dependency as an injected port; tests provide a mock adapter.

Category 3 and 4 are the two that produce a port, because they are the two where a second adapter genuinely exists. Categories 1 and 2 tempt you into one anyway — a single-adapter port around pure computation is indirection, not a seam.

## Testing strategy: replace, don't layer

Deepening moves the test surface. The old shallow modules' unit tests were written against interfaces that are about to stop existing, so they become waste — but *waste is not the same as safe to delete first*.

The order is what keeps coverage:

1. Write the new tests at the deepened module's interface. **The interface is the test surface**; they assert observable outcomes through it, never internal state.
2. Check each old test's behaviour has a home in the new suite — by behaviour, not by topic. A test whose branch has no new twin is coverage you are about to lose, and it is telling you the new interface doesn't reach something the old one did.
3. Then delete the old tests.

Deleting first and backfilling second is how a deepening quietly sheds coverage while the suite stays green. The discipline generalizes: [../testing/test-quality.md](../testing/test-quality.md) covers deleting tests safely, and the shapes to reject when writing their replacements.

Where the seam is a mock or injected adapter, the mechanics live in [../testing/mocking-and-fixtures.md](../testing/mocking-and-fixtures.md).

---

> _Lesson · codebase-design. Consolidates `improve-codebase-architecture/DEEPENING.md`. Upstream baseline: `.upstream/codebase-design/DEEPENING.md`._
