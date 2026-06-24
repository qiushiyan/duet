# Interface Design for Testability

Good interfaces make testing natural:

1. **Accept dependencies, don't create them**

   ```typescript
   // Testable
   function processOrder(order, paymentGateway) {}

   // Hard to test
   function processOrder(order) {
     const gateway = new StripeGateway()
   }
   ```

2. **Return results, don't produce side effects**

   ```typescript
   // Testable
   function calculateDiscount(cart): Discount {}

   // Hard to test
   function applyDiscount(cart): void {
     cart.total -= discount
   }
   ```

3. **Small surface area**
   - Fewer methods = fewer tests needed
   - Fewer params = simpler test setup

## Fixtures as the DI Mechanism

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
- **Boundary code mocked** (paymentClient) — it talks to Stripe, so we fake it
- **Internal code real** (orderService) — it's ours, we test it as-is
- **Cleanup automatic** — each fixture handles its own teardown in the callback after `use()`
- **Dependencies explicit** — `orderService` declares it needs `paymentClient`, Vitest wires it up

Fixtures are lazy: if a test doesn't destructure `paymentClient`, it's never created. This keeps tests fast when they only need a subset of fixtures.

## Composing Fixtures Like Deep Modules

Fixtures compose by extending from another extended test. Each layer adds depth behind a simple destructuring interface — the deep modules pattern applied to test setup:

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

Small interface (destructure what you need), deep implementation (fixture chain handles creation, wiring, cleanup). Each layer is independently testable and reusable across test files.
