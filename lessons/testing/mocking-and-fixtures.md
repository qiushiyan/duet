# Mocking & Fixtures

Where to mock, how to mock each kind of boundary, and how to inject dependencies with fixtures. This is the mocking cookbook plus the DI strategy; the cross-cutting Vitest gotchas (hoisting order, the clearing hierarchy, constructor mocks, async-timer flushing) are in [vitest.md](vitest.md).

## The bar

- **Mock only at system boundaries** — external APIs, databases (prefer a real test DB or transaction rollback), time/randomness, environment variables, sometimes the filesystem.
- **Never mock your own modules or internal collaborators.** Mocking code you control is a design signal — fix the interface (reshape it into a [deep module](../codebase-design/deep-modules.md)), don't add mocks.
- **Inject dependencies, don't construct them** inside the unit under test.
- **Prefer SDK-style interfaces over generic fetchers** — each operation independently mockable, no conditional logic in the mock.
- **To observe a boundary without faking it**, prefer `vi.spyOn` / spy mode over a full fake.
- **Use `test.extend` fixtures as the DI mechanism**, not `beforeEach`/`afterEach` chains of shared mutable state.
- **Fixture shapes come from the real writer, never the reader's assumption** — mirror what production actually writes; a hand-guessed shape pins your misreading into the suite.

## When to mock

Mock at **system boundaries** only:

- External APIs (payment, email, third-party services)
- Databases (sometimes — prefer a test DB or transaction rollback)
- Time and randomness
- Environment variables
- File system (sometimes)

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control

If you find yourself mocking internal code, it's a **design signal** — the code needs better interfaces, not more mocks. Reshape it into a [deep module](../codebase-design/deep-modules.md) instead.

## Mocking external modules with vi.mock

Use `vi.mock` to replace an entire external module at the boundary:

```typescript
import { expect, test, vi } from 'vitest'

// vi.mock is hoisted to the top of the file — it runs before imports
vi.mock('./stripe-client', () => ({
  chargeCard: vi.fn(() => Promise.resolve({ status: 'succeeded', id: 'ch_123' })),
}))

import { chargeCard } from './stripe-client'

test('checkout confirms order when payment succeeds', async () => {
  const result = await checkout(cart)
  expect(result.status).toBe('confirmed')
})
```

The hoisting rule (and why you can't reference file-scope variables in the factory) is in [vitest.md](vitest.md#vimock-hoisting).

### Partial mocking

Keep most of a module real, mock only the boundary function:

```typescript
import { vi } from 'vitest'

vi.mock(import('./notifications'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    // Only mock the external email call, keep everything else real
    sendEmail: vi.fn(() => Promise.resolve({ sent: true })),
  }
})
```

### Spy mode

Track calls to a real module without changing its behavior. Useful for verifying that a boundary was called without faking the implementation:

```typescript
import { vi } from 'vitest'

vi.mock('./analytics', { spy: true })

import { trackEvent } from './analytics'

test('checkout tracks purchase event', async () => {
  await checkout(cart)
  expect(trackEvent).toHaveBeenCalledWith('purchase', expect.objectContaining({ total: cart.total }))
})
```

## Spying on object methods with vi.spyOn

Use `vi.spyOn` when you have an object instance and want to observe or replace a single method:

```typescript
import { expect, test, vi } from 'vitest'

test('logs warning when inventory is low', () => {
  const spy = vi.spyOn(console, 'warn')
  addToCart(lowStockItem)
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('low stock'))
  spy.mockRestore()
})
```

Prefer `vi.spyOn` over `vi.fn` when the object already exists. Clean up with `spy.mockRestore()` or the config option `restoreMocks: true`. Note: `restoreMocks` only restores spies created with `vi.spyOn` — automocks are unaffected.

## Changing mock behavior per test with vi.hoisted

Because `vi.mock` is hoisted above imports, you can't reference normal variables inside the factory. Use `vi.hoisted` to declare variables that are also hoisted — the way to vary a mock's return value per test:

```typescript
import { vi } from 'vitest'

const mockCharge = vi.hoisted(() => vi.fn())

vi.mock('./stripe-client', () => ({
  chargeCard: mockCharge,
}))

import { chargeCard } from './stripe-client'

test('handles payment failure', async () => {
  mockCharge.mockRejectedValueOnce(new Error('card declined'))
  const result = await checkout(cart)
  expect(result.status).toBe('failed')
  expect(result.error).toBe('card declined')
})
```

(More on the hoisting mechanics in [vitest.md](vitest.md#vimock-hoisting).)

## Mocking time

Time is a system boundary. Use fake timers when behavior depends on time:

```typescript
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('session expires after 30 minutes', () => {
  const session = createSession()
  expect(session.isValid()).toBe(true)

  vi.advanceTimersByTime(30 * 60 * 1000)
  expect(session.isValid()).toBe(false)
})

test('invoice uses current date', () => {
  vi.setSystemTime(new Date('2025-06-15'))
  const invoice = createInvoice(order)
  expect(invoice.date).toBe('2025-06-15')
})
```

When the timers trigger promises, use the async variants (`vi.advanceTimersByTimeAsync`) — see [vitest.md](vitest.md#async-timer-patterns).

## Mocking environment variables

Environment is a system boundary:

```typescript
import { expect, test, vi } from 'vitest'

test('uses production API in prod mode', () => {
  vi.stubEnv('NODE_ENV', 'production')
  expect(getApiUrl()).toBe('https://api.prod.com')
  vi.unstubAllEnvs()
})
```

## Designing for mockability

At system boundaries, design interfaces that are easy to mock.

**1. Use dependency injection.** Pass external dependencies in rather than creating them internally:

```typescript
// Easy to mock — accept the dependency
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total)
}

// Hard to mock — creates its own dependency
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY)
  return client.charge(order.total)
}
```

**2. Prefer SDK-style interfaces over generic fetchers.** Create specific functions for each external operation instead of one generic function with conditional logic:

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
}

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
}
```

The SDK approach means each mock returns one specific shape, there's no conditional logic in test setup, it's easy to see which endpoints a test exercises, and you get type safety per endpoint.

> The general interface principles that make this possible ("accept dependencies / return results / small surface") live in [deep-modules.md](../codebase-design/deep-modules.md#designing-for-testability) — this doc covers the mock-side mechanics.

## Fixtures as the DI mechanism

In Vitest, `test.extend` is the natural way to wire up dependency injection for tests. Instead of `beforeEach`/`afterEach` chains that accumulate shared mutable state, fixtures declare their own setup and teardown:

```typescript
import { test as base } from 'vitest'

interface TestFixtures {
  paymentClient: PaymentClient
  orderService: OrderService
}

const test = base.extend<TestFixtures>({
  // System boundary — mocked
  paymentClient: async ({}, use) => {
    const mock = createMockPaymentClient()
    await use(mock)
  },
  // Internal code — real implementation, injected with mock boundary
  orderService: async ({ paymentClient }, use) => {
    await use(new OrderService(paymentClient))
  },
})

test('order confirms when payment succeeds', async ({ orderService }) => {
  const result = await orderService.checkout(validCart)
  expect(result.status).toBe('confirmed')
})
```

This pattern keeps:

- **Boundary code mocked** (`paymentClient`) — it talks to Stripe, so we fake it
- **Internal code real** (`orderService`) — it's ours, we test it as-is
- **Cleanup automatic** — each fixture handles its own teardown in the callback after `use()`
- **Dependencies explicit** — `orderService` declares it needs `paymentClient`, Vitest wires it up

Fixtures are lazy: if a test doesn't destructure `paymentClient`, it's never created. This keeps tests fast when they only need a subset of fixtures.

## Fixture shapes come from the real writer

A fixture is a claim about what production data looks like. Derive it from the **code that actually writes the data** (or capture a real sample), never from your reading of the code that consumes it — otherwise the suite encodes the same wrong assumption as the code under test, and both pass together.

The failure mode this guards: a reader compares ledger entries against phase names, so the fixtures are written with phase names too — but the *writer* records machine-state names. Every test passes; every real record misclassifies. A green suite whose fixtures were guessed from the reader proves only that the code agrees with itself.

Practical forms, strongest first:

- **Round-trip through the real writer**: have the test call the production write path and assert on what the read path makes of it — the shape can never drift.
- **Capture a real sample** (a recorded log line, an actual state file) and pin it as the fixture, with a comment naming its source.
- If you must hand-write the shape, **cite the writer** (file and line of the code that produces it) in a comment, so the next editor checks the writer, not the reader.

When a bug survives a green suite, check the fixtures first: if they were derived from the same assumption as the code, the tests were pinning the bug.

## Composing fixtures like deep modules

Fixtures compose by extending from another extended test. Each layer adds depth behind a simple destructuring interface — the [deep modules](../codebase-design/deep-modules.md) pattern applied to test setup:

```typescript
// fixtures/db-test.ts — base layer: provides a database
import { test as base } from 'vitest'

export const test = base.extend<{ db: Database }>({
  db: async ({}, use) => {
    const db = await createTestDatabase()
    await use(db)
    await db.destroy()
  },
})

// fixtures/user-test.ts — adds users on top of database
import { test as dbTest } from './db-test'

export const test = dbTest.extend<{ user: User; admin: User }>({
  user: async ({ db }, use) => {
    await use(await db.createUser({ role: 'member' }))
  },
  admin: async ({ db }, use) => {
    await use(await db.createUser({ role: 'admin' }))
  },
})
```

Tests destructure only what they need — the entire dependency chain resolves automatically:

```typescript
import { test } from './fixtures/user-test'

// db, user, and admin are all wired up — test just asks for { admin }
test('admin can delete users', async ({ admin, db }) => {
  const target = await db.createUser({ role: 'member' })
  await deleteUser(target.id, { actor: admin })
  expect(await db.findUser(target.id)).toBeNull()
})
```

Small interface (destructure what you need), deep implementation (the fixture chain handles creation, wiring, cleanup). Each layer is independently testable and reusable across test files.

For fixture **scoping** (`scope: 'file'`), **auto** fixtures, and inline `onTestFinished` cleanup, see [vitest.md](vitest.md#fixtures-isolation-scoping-cleanup).

## Mock cleanup

Always clean up mocks to prevent test pollution. Prefer global config over manual cleanup — set `restoreMocks`, `clearMocks`, `unstubEnvs`, and `unstubGlobals` in `vitest.config.ts` so you never think about it. The exact config block and the manual clearing hierarchy (`mockClear` vs `mockReset` vs `mockRestore`) are in [vitest.md](vitest.md#mock-clearing-hierarchy).

---

> _Lesson · testing. Consolidates `tdd/mocking.md` (full) + `tdd/interface-design.md`. Upstream baseline: `.upstream/tdd/mocking.md`._
