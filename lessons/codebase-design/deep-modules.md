# Deep Modules

Design **deep modules**: a lot of behaviour behind a small interface, placed at a clean seam, testable through that interface. Use this language and these principles wherever code is being designed or restructured. The aim is leverage for callers, locality for maintainers, testability for everyone, and a codebase that stays **navigable** — for humans and AI agents alike.

## The bar

Skim these as a lens; read on for the why.

- **Depth is a property of the interface, not the implementation.** A deep module puts a lot of behaviour behind a small interface. It can be internally composed of small, mockable, swappable parts — they just aren't part of the interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep — a "yes, it concentrates complexity" is the signal you want.
- **Smell for shallowness.** Understanding one concept makes you bounce between many small modules; or tightly-coupled modules leak across their seams. Both say the seam is in the wrong place.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is the wrong shape.
- **The two-adapter rule.** One adapter is a hypothetical seam; two make it real. A seam earns its place where something actually varies across it — otherwise it is indirection wearing a seam's clothes.
- **Make illegal states unrepresentable.** Encode invariants in types/constructors so a caller *can't* express a bad value; validate untrusted input once at the boundary (*parse, don't validate*), not at every read. A real violation should fail loudly, not get a fallback that hides the bug.
- When shaping an interface, ask: can I **reduce the methods**? **simplify the parameters**? **hide more complexity inside**?

## Glossary

Use these terms exactly — don't substitute "component," "service," "API," or "boundary." Consistent language is the whole point.

**Module** — anything with an interface and an implementation. Deliberately scale-agnostic: a function, class, package, or tier-spanning slice. _Avoid_: unit, component, service.

**Interface** — everything a caller must know to use the module correctly: the type signature, but also invariants, ordering constraints, error modes, required configuration, and performance characteristics. _Avoid_: API, signature (too narrow — they refer only to the type-level surface).

**Implementation** — what's inside a module, its body of code. Distinct from **Adapter**: a thing can be a small adapter with a large implementation (a Postgres repo) or a large adapter with a small implementation (an in-memory fake). Reach for "adapter" when the seam is the topic; "implementation" otherwise.

**Depth** — leverage at the interface: the amount of behaviour a caller (or test) can exercise per unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits behind a small interface, **shallow** when the interface is nearly as complex as the implementation.

**Seam** _(from Michael Feathers)_ — a place where you can alter behaviour without editing in that place; the *location* at which a module's interface lives. Where to put the seam is its own design decision, distinct from what goes behind it. _Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter** — a concrete thing that satisfies an interface at a seam. Describes *role* (what slot it fills), not substance (what's inside).

**Leverage** — what callers get from depth: more capability per unit of interface they learn. One implementation pays back across N call sites and M tests.

**Locality** — what maintainers get from depth: change, bugs, knowledge, and verification concentrate in one place rather than spreading across callers. Fix once, fixed everywhere.

**Name modules after domain concepts.** Good seams usually already have names in the project's domain language — `CONTEXT.md` is a map to where they belong. If `CONTEXT.md` defines "Order," it's "the Order intake module" — not "the FooBarHandler," and not "the Order service."

## Deep vs shallow

The deep-module idea comes from John Ousterhout's *A Philosophy of Software Design*. (We adopt the concept but measure depth as **leverage**, not his implementation-to-interface line ratio — see [Rejected framings](#rejected-framings).)

A **deep** module is a small interface — few methods, simple params — over a large implementation that hides the complexity. A **shallow** one is a large interface over a thin implementation that mostly passes through; its caller learns nearly as much as it would have by writing the code itself.

A deep module can still have **internal seams** — private to its implementation, used by its own tests — alongside the **external seam** at its interface. Don't expose internal seams through the interface just because tests use them.

## Make illegal states unrepresentable

Encode a module's invariants in its types and constructors so a caller *can't* express an invalid value, and validate untrusted input once at the boundary (*parse, don't validate*) rather than guarding at every call site. It is depth in the small: the check lives behind the interface (**leverage** — callers receive a value they can already trust), the invariant has one home (**locality**), and a whole class of downstream defensive branches simply stops existing.

Where a state can't cheaply be made unrepresentable, validate at that **one** boundary — not everywhere it's read — and let a real violation fail loudly rather than papering it over with a fallback that hides the bug.

## Designing for testability

Good interfaces make testing natural:

1. **Accept dependencies, don't create them.**

   ```typescript
   // Testable
   function processOrder(order, paymentGateway) {}

   // Hard to test
   function processOrder(order) {
     const gateway = new StripeGateway()
   }
   ```

2. **Return results, don't produce side effects.**

   ```typescript
   // Testable
   function calculateDiscount(cart): Discount {}

   // Hard to test
   function applyDiscount(cart): void {
     cart.total -= discount
   }
   ```

3. **Small surface area.** Fewer methods = fewer tests needed. Fewer params = simpler test setup.

**Don't extract a pure function *just* to make it testable.** If the real logic lives in how that function is *called*, a testable fragment buys little: the extracted piece is a shallow module with no **locality**, and the bug simply moves into the (still-untested) caller. Deepen the module so the behaviour worth testing sits behind the interface, instead of carving out an easy-to-test sliver.

The mechanics — *where* to mock, *how* to wire dependencies into tests — live in [../testing/mocking-and-fixtures.md](../testing/mocking-and-fixtures.md). The consequence for the tests themselves is that a test reaching past the interface is testing the wrong thing; [../testing/test-quality.md](../testing/test-quality.md) names that shape and what to do about it.

## Rejected framings

- **Depth as ratio of implementation-lines to interface-lines** (Ousterhout): rewards padding the implementation. We use depth-as-leverage instead.
- **"Interface" as the TypeScript `interface` keyword or a class's public methods**: too narrow — interface here includes every fact a caller must know.
- **"Boundary"**: overloaded with DDD's bounded context. Say **seam** or **interface**.

## Going deeper

- **Deepening a cluster of shallow modules** given its dependencies — [deepening.md](deepening.md).
- **Exploring several radically different interfaces** before committing — [design-it-twice.md](design-it-twice.md).

---

> _Lesson · codebase-design. Consolidates `improve-codebase-architecture/SKILL.md` + `LANGUAGE.md` + `tdd/deep-modules.md`. Upstream baseline: `.upstream/codebase-design/SKILL.md`._
