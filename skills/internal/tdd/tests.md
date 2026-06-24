# Good and Bad Tests

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

```typescript
import { expect, test } from 'vitest'

// GOOD: Tests observable behavior
test('user can checkout with valid cart', async () => {
  const cart = createCart()
  cart.add(product)
  const result = await checkout(cart, paymentMethod)
  expect(result.status).toBe('confirmed')
})
```

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```typescript
import { expect, test, vi } from 'vitest'

// BAD: Tests implementation details
test('checkout calls paymentService.process', async () => {
  const mockPayment = vi.fn()
  vi.mock('./paymentService', () => ({ process: mockPayment }))
  await checkout(cart, payment)
  expect(mockPayment).toHaveBeenCalledWith(cart.total)
})
```

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting on call counts/order of internal functions
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means instead of interface

```typescript
import { expect, test } from 'vitest'

// BAD: Bypasses interface to verify
test('createUser saves to database', async () => {
  await createUser({ name: 'Alice' })
  const row = await db.query('SELECT * FROM users WHERE name = ?', ['Alice'])
  expect(row).toBeDefined()
})

// GOOD: Verifies through interface
test('createUser makes user retrievable', async () => {
  const user = await createUser({ name: 'Alice' })
  const retrieved = await getUser(user.id)
  expect(retrieved.name).toBe('Alice')
})
```

## Guarding Against False Greens

Async tests can silently pass if a callback never fires — your assertion never runs, but the test is green. Use `expect.assertions(n)` to declare how many assertions must run:

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

This is a safety net for the RED-GREEN loop. If your test passes without asserting anything, it's not testing behavior — it's testing nothing.

## Custom Matchers as Domain Language

When your domain has specific invariants, custom matchers make tests read like specifications instead of implementation checks:

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

## Parameterized Behavior Tests

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

## Multiple Assertions on One Behavior

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

## Test Isolation with Fixtures

Use `test.extend` to inject dependencies cleanly instead of `beforeEach`/`afterEach` chains. Fixtures are lazy (only initialized when destructured) and handle their own cleanup:

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

See [interface-design.md](interface-design.md) for more on designing code that works well with fixtures.

## Transaction-Style Isolation

For tests that touch shared state (like a database), use `aroundEach` to wrap each test in a transaction that rolls back:

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
