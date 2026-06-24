# Refactor Candidates

After TDD cycle, look for:

- **Duplication** -> Extract function/class
- **Long methods** -> Break into private helpers (keep tests on public interface)
- **Shallow modules** -> Combine or deepen
- **Feature envy** -> Move logic to where data lives
- **Primitive obsession** -> Introduce value objects
- **Existing code** the new code reveals as problematic

## Refactoring Safely with Vitest

**Watch mode** is your refactoring safety net. Run `vitest` (watch mode) and it reruns only affected tests as you save — immediate feedback on every change.

**Shuffle test order** to catch hidden dependencies between tests:

```bash
vitest --sequence.shuffle
```

If tests pass individually but fail when shuffled, they share state they shouldn't. Fix the coupling before it becomes a real bug.

**Never refactor while RED.** Get to GREEN first, then refactor with confidence.
