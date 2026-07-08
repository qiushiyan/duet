# Design It Twice

Your first interface idea is rarely your best. Before committing to one, produce several **radically different** designs for the same module, then choose — or graft. From Ousterhout's *A Philosophy of Software Design*.

Uses the vocabulary in [deep-modules.md](deep-modules.md) — **module**, **interface**, **seam**, **adapter**, **leverage**.

## The bar

- **Three designs, different in kind** — not three shades of one idea. Each takes a different constraint seriously enough to distort the interface around it.
- **Generate them independently.** Design two must not be anchored on design one. Parallel sub-agents get this for free; alone, you get it by writing each design's constraint down first and holding the others out of view. Sequential authorship converges, and that convergence is the failure this pattern exists to prevent.
- **Compare on depth, locality, and seam placement** — where leverage concentrates, where change concentrates, where the seam falls — not on taste.
- **Land on a recommendation.** The strongest design and why, or a hybrid grafting the best of each. A menu is not a design.

## Frame the problem space first

Make the constraints concrete before generating anything:

- What any interface here must satisfy.
- The dependencies it relies on, and which category they fall into ([deepening.md](deepening.md)).
- A rough code sketch — a way to make the constraints tangible, not a proposal.

Whoever will judge the designs should be reading this framing while the alternatives are being written.

## The constraints that pull designs apart

Each design gets one constraint, and follows it further than feels comfortable — a constraint applied timidly yields the design you'd have written anyway:

- **Minimal** — one to three entry points. Maximise leverage per entry point.
- **Flexible** — many use cases, room to extend.
- **Common case** — make the default caller's path trivial, even at the expense of the rare one.
- **Ports and adapters** — when the dependency crosses a seam you don't own ([deepening.md](deepening.md)).

Each design states its interface (types, methods, params — plus invariants, ordering, error modes), a usage example from the caller's side, what stays hidden behind the seam, its dependency strategy and adapters, and where its leverage is high and where it's thin.

Name things in the project's domain language (`CONTEXT.md`) and the vocabulary of [deep-modules.md](deep-modules.md), so designs stay comparable rather than each inventing its own words.

## Choosing

Present the designs one at a time — each is absorbed on its own terms — then compare them in prose, contrasting depth, locality, and seam placement. Recommend the strongest and say why. When elements combine well, propose the hybrid rather than picking a weaker whole.

---

> _Lesson · codebase-design. Consolidates `improve-codebase-architecture/INTERFACE-DESIGN.md` + `DESIGN-IT-TWICE.md` (deduped — they were the same pattern). Upstream baseline: `.upstream/codebase-design/DESIGN-IT-TWICE.md`._
