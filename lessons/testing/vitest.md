# Vitest

Vitest-specific APIs, patterns, and gotchas for the TDD loop. **TS-Vitest projects only** — skip this doc for other stacks. The tool-agnostic discipline is in [tdd-loop.md](tdd-loop.md); the mocking/fixture strategy is in [mocking-and-fixtures.md](mocking-and-fixtures.md).

> _Lesson · testing. Consolidates `tdd/vitest-patterns.md` + `tdd/tests.md` + the Vitest CLI/coverage notes from `tdd/SKILL.md` & `tdd/refactoring.md`. Upstream baseline: `.upstream/tdd/tests.md`._

## The bar

- Loop on a single test with `vitest -t "name" --run`; keep `vitest` (watch mode) running for continuous feedback; `vitest --changed --run` runs only what your edits affect.
- Stub the backlog with `test.todo`; guard async tests with `expect.assertions(n)` so a callback that never fires can't pass green.
- Set `restoreMocks` / `clearMocks` in config so mock state never leaks between tests.
- `vi.mock` is **hoisted** — reference mock fns via `vi.hoisted`.
- Use the **async** timer variants (`advanceTimersByTimeAsync`) whenever fake timers drive promises.

## Running tests in the loop

```bash
# Run only tests matching a name pattern
vitest -t "confirms order" --run

# Run a specific test file
vitest src/checkout.test.ts --run

# Run tests affected by your uncommitted changes
vitest --changed --run
```

Use watch mode (`vitest` without `--run`) for continuous feedback — it reruns affected tests automatically as you save files.

**Stub planned behaviors with `test.todo`** to create a visible backlog in your test output. Each `todo` becomes a vertical slice to implement:

```ts
import { describe, test } from 'vitest'

describe('checkout', () => {
  test.todo('confirms order with valid cart')
  test.todo('rejects empty cart')
  test.todo('applies discount code')
  test.todo('handles payment failure gracefully')
})
```

**Refactoring safety net.** Watch mode reruns only affected tests as you save. Shuffle test order to catch hidden inter-test dependencies:

```bash
vitest --sequence.shuffle
```

If tests pass individually but fail when shuffled, they share state they shouldn't — fix the coupling before it becomes a real bug.

**Coverage as feedback, not a goal.** After a TDD cycle, run `vitest run --coverage` to spot boundary paths you missed. Don't chase a number — use it to reveal blind spots.

## Behavior-focused tests: good vs bad

**Good** — tests observable behavior through real interfaces:

```typescript
import { expect, test } from 'vitest'

test('user can checkout with valid cart', async () => {
  const cart = createCart()
  cart.add(product)
  const result = await checkout(cart, paymentMethod)
  expect(result.status).toBe('confirmed')
})
```

Characteristics: tests behavior callers care about, uses public API only, survives internal refactors, describes WHAT not HOW, one logical assertion per test.

**Bad** — coupled to internal structure:

```typescript
import { expect, test, vi } from 'vitest'

// BAD: tests implementation details
test('checkout calls paymentService.process', async () => {
  const mockPayment = vi.fn()
  vi.mock('./paymentService', () => ({ process: mockPayment }))
  await checkout(cart, payment)
  expect(mockPayment).toHaveBeenCalledWith(cart.total)
})
```

Red flags: mocking internal collaborators, testing private methods, asserting on call counts/order of internal functions, the test breaking on a behavior-preserving refactor, a name that describes HOW not WHAT, and verifying through external means instead of through the interface.

**Verify through the interface, not around it:**

```typescript
// BAD: bypasses interface to verify
test('createUser saves to database', async () => {
  await createUser({ name: 'Alice' })
  const row = await db.query('SELECT * FROM users WHERE name = ?', ['Alice'])
  expect(row).toBeDefined()
})

// GOOD: verifies through interface
test('createUser makes user retrievable', async () => {
  const user = await createUser({ name: 'Alice' })
  const retrieved = await getUser(user.id)
  expect(retrieved.name).toBe('Alice')
})
```

## Guarding against false greens

Async tests can silently pass if a callback never fires — your assertion never runs, but the test is green. Declare how many assertions must run:

```typescript
import { expect, test } from 'vitest'

test('calls handler on error', async () => {
  expect.assertions(1) // test fails if the callback never fires

  await processWithErrorHandler(badInput, (error) => {
    expect(error.code).toBe('INVALID')
  })
})
```

Use `expect.hasAssertions()` when you don't know the exact count but want at least one:

```typescript
test('processes all items', async () => {
  expect.hasAssertions()

  for (const item of items) {
    const result = await process(item)
    expect(result.ok).toBe(true)
  }
})
```

If a test passes without asserting anything, it's testing nothing.

## Custom matchers as domain language

When your domain has specific invariants, custom matchers make tests read like specifications:

```typescript
import { expect, test } from 'vitest'

expect.extend({
  toBeValidEmail(received) {
    const pass = /^[^@]+@[^@]+\.[^@]+$/.test(received)
    return {
      pass,
      message: () => `expected "${received}" to be a valid email`,
    }
  },
  toBeWithinBudget(received, budget) {
    const pass = received.total >= 0 && received.total <= budget
    return {
      pass,
      message: () =>
        `expected total ${received.total} to be within budget ${budget}`,
    }
  },
})

test('registration returns valid contact info', async () => {
  const user = await register({ name: 'Alice', email: 'alice@co.com' })
  expect(user.email).toBeValidEmail()
})

test('order stays within budget', async () => {
  const order = await createOrder(items, { maxBudget: 500 })
  expect(order).toBeWithinBudget(500)
})
```

Define custom matchers in a setup file so they're available across all tests. This turns `expect(x).toBeGreaterThanOrEqual(0)` into `expect(order).toBeWithinBudget(500)` — tests document business rules, not arithmetic.

## Parameterized behavior tests

When multiple inputs should produce predictable outputs, use `test.for` (preferred) or `test.each` to avoid duplication while keeping tests behavior-focused:

```typescript
import { expect, test } from 'vitest'

// test.for is preferred — doesn't spread arrays, provides TestContext
test.for([
  { input: 'valid@email.com', valid: true },
  { input: 'no-at-sign', valid: false },
  { input: '', valid: false },
  { input: 'user@domain.co.uk', valid: true },
])('validates email "$input" -> $valid', ({ input, valid }, { expect }) => {
  expect(isValidEmail(input)).toBe(valid)
})
```

Use parameterized tests for **data variations of the same behavior**, not as a way to cram multiple unrelated behaviors into one test.

## Multiple assertions on one behavior

When a single behavior has multiple observable effects, use `expect.soft` to check all of them without short-circuiting on the first failure:

```typescript
import { expect, test } from 'vitest'

test('order summary reflects cart contents', () => {
  const cart = createCart()
  cart.add(itemA)
  cart.add(itemB)
  const summary = cart.getSummary()

  expect.soft(summary.itemCount).toBe(2)
  expect.soft(summary.total).toBe(itemA.price + itemB.price)
  expect.soft(summary.items).toContainEqual({ name: itemA.name, qty: 1 })
})
```

All failures are reported together, so you get the full picture on the first run.

## Fixtures: isolation, scoping, cleanup

Use `test.extend` to inject dependencies cleanly instead of `beforeEach`/`afterEach` chains. Fixtures are lazy (only initialized when destructured) and handle their own cleanup. (For the DI *strategy* — what to mock, composing fixtures like deep modules — see [mocking-and-fixtures.md](mocking-and-fixtures.md).)

```typescript
import { test as base } from 'vitest'

const test = base.extend<{ cart: Cart; catalog: Catalog }>({
  catalog: async ({}, use) => {
    const catalog = await createTestCatalog()
    await use(catalog)
    await catalog.teardown()
  },
  cart: async ({ catalog }, use) => {
    const cart = createCart(catalog)
    await use(cart)
  },
})

// Each test gets a fresh cart and catalog — no shared mutable state
test('adding item increases count', async ({ cart, catalog }) => {
  const item = catalog.getItem('widget')
  cart.add(item)
  expect(cart.itemCount).toBe(1)
})
```

**Transaction-style isolation.** For tests that touch shared state (like a database), use `aroundEach` to wrap each test in a transaction that rolls back:

```typescript
import { aroundEach, test } from 'vitest'

aroundEach(async (runTest) => {
  await db.beginTransaction()
  await runTest()
  await db.rollback()
})

test('inserting a user', async () => {
  await createUser({ name: 'Alice' })
  const user = await getUser('Alice')
  expect(user).toBeDefined()
  // Rolled back automatically — next test starts clean
})
```

**Fixture scoping.** By default, fixtures are created per test. For expensive resources, scope them to file or worker:

```typescript
import { test as base } from 'vitest'

const test = base.extend({
  // Created once per file, shared across tests (read-only use)
  dbConnection: [
    async ({}, use) => {
      const conn = await connectToTestDb()
      await use(conn)
      await conn.close()
    },
    { scope: 'file' },
  ],
})
```

Use `{ auto: true }` for fixtures that should run for every test without being destructured (e.g. global setup):

```typescript
const test = base.extend({
  logging: [
    async ({}, use) => {
      setupTestLogging()
      await use()
      teardownTestLogging()
    },
    { auto: true },
  ],
})
```

**`onTestFinished` for inline cleanup.** When you need cleanup tied to a specific test (not a suite-wide hook), use `onTestFinished` — it always runs, even if the test fails, and composes inside helpers:

```typescript
import { expect, onTestFinished, test } from 'vitest'

function useTempDb() {
  const db = createTempDatabase()
  onTestFinished(() => db.destroy())
  return db
}

test('query works', () => {
  const db = useTempDb() // auto-destroyed after test
  db.insert({ name: 'Alice' })
  expect(db.count()).toBe(1)
})
```

## vi.mock hoisting

`vi.mock` calls are hoisted to the top of the file — they execute before any imports, regardless of where you write them. You **cannot** reference variables defined in the file unless they're also hoisted:

```typescript
import { vi } from 'vitest'

// WON'T WORK — mockFn doesn't exist yet when vi.mock runs
const mockFn = vi.fn()
vi.mock('./api', () => ({ fetch: mockFn })) // Error: mockFn is not defined

// WORKS — vi.hoisted is also hoisted, so the variable exists
const mockFn = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetch: mockFn }))
```

Use `vi.hoisted` whenever you need to reference a mock function both in the factory and in your tests (e.g. to change return values per test).

## vi.doMock for per-test mocking

`vi.mock` applies to the entire file. When you need different mocks per test, use `vi.doMock` (not hoisted) with dynamic imports:

```typescript
import { expect, test, vi } from 'vitest'

test('handles production config', async () => {
  vi.doMock('./config', () => ({ env: 'production', apiUrl: 'https://api.prod.com' }))
  const { getApiUrl } = await import('./service')
  expect(getApiUrl()).toBe('https://api.prod.com')
  vi.doUnmock('./config')
})
```

Call `vi.resetModules()` between tests if the module cache causes stale imports.

## Mock clearing hierarchy

Three levels, each more aggressive:

| Method | Clears call history | Removes implementation | Restores original |
|--------|:------------------:|:---------------------:|:-----------------:|
| `mockClear()` | yes | no | no |
| `mockReset()` | yes | yes | no |
| `mockRestore()` | yes | yes | yes (spies only) |

- **`mockClear`**: reset call counts between tests but keep the mock behavior
- **`mockReset`**: blank mock (returns `undefined`)
- **`mockRestore`**: on spies (`vi.spyOn`), put the original function back

Global equivalents: `vi.clearAllMocks()`, `vi.resetAllMocks()`, `vi.restoreAllMocks()`. Note `vi.restoreAllMocks()` (and the `restoreMocks` config option) only restores spies created with `vi.spyOn`; automocked modules are unaffected. Calling `.mockRestore()` directly on an individual mock still resets its implementation and clears its state.

**Recommended config** for TDD — set in `vitest.config.ts` so you never think about it:

```typescript
defineConfig({
  test: {
    restoreMocks: true,   // restores vi.spyOn spies after each test
    clearMocks: true,     // clears call history before each test
    unstubEnvs: true,     // restores vi.stubEnv after each test
    unstubGlobals: true,  // restores vi.stubGlobal after each test
  },
})
```

## Constructor mocking

Mocks called with `new` construct the instance rather than calling `mock.apply`. Mock implementations for constructors **must** use the `function` or `class` keyword — arrow functions throw `<anonymous> is not a constructor`:

```typescript
import { vi } from 'vitest'

const spy = vi.spyOn(cart, 'Apples')
  // WRONG — arrow function can't be a constructor
  .mockImplementation(() => ({ getApples: () => 0 }))
  // RIGHT — function keyword
  .mockImplementation(function () {
    this.getApples = () => 0
  })
  // RIGHT — class keyword
  .mockImplementation(class MockApples {
    getApples() { return 0 }
  })
```

## Async timer patterns

When fake timers trigger async code (promises inside `setTimeout`), use the async variants:

```typescript
import { expect, test, vi } from 'vitest'

test('retry with backoff', async () => {
  vi.useFakeTimers()
  const result = retryWithBackoff(fetchData, { maxRetries: 3 })

  // Use async variant — allows microtasks (promises) to flush
  await vi.advanceTimersByTimeAsync(1000)
  await vi.advanceTimersByTimeAsync(2000)
  await vi.advanceTimersByTimeAsync(4000)

  await expect(result).resolves.toBeDefined()
  vi.useRealTimers()
})
```

The non-async `vi.advanceTimersByTime` won't flush promise callbacks — your test will hang or give wrong results.

## Waiting for async behavior

Use `vi.waitFor` when testing behavior that settles asynchronously without a direct promise to await:

```typescript
import { expect, test, vi } from 'vitest'

test('element appears after load', async () => {
  triggerLoad()

  await vi.waitFor(() => {
    expect(document.querySelector('.loaded')).toBeTruthy()
  }, { timeout: 5000, interval: 100 })
})
```

Prefer `expect.poll` for simpler polling assertions:

```typescript
await expect.poll(() => getStatus()).toBe('ready')
```
