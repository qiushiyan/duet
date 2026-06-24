# When and How to Mock

## When to Mock

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

If you find yourself mocking internal code, it's a design signal — the code needs better interfaces, not more mocks. See [interface-design.md](interface-design.md).

## Mocking External Modules with vi.mock

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

### Partial Mocking

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

### Spy Mode

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

## Spying on Object Methods with vi.spyOn

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

Prefer `vi.spyOn` over `vi.fn` when the object already exists. Use `spy.mockRestore()` or the config option `restoreMocks: true` to clean up. Note: `restoreMocks` only restores spies created with `vi.spyOn` — automocks are unaffected.

## Referencing Mocks Before Imports with vi.hoisted

Because `vi.mock` is hoisted above imports, you can't reference normal variables inside the factory. Use `vi.hoisted` to declare variables that are also hoisted:

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

## Mocking Time

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

Use the async variants (`vi.advanceTimersByTimeAsync`) when timers trigger promises.

## Mocking Environment Variables

Environment is a system boundary:

```typescript
import { expect, test, vi } from 'vitest'

test('uses production API in prod mode', () => {
  vi.stubEnv('NODE_ENV', 'production')
  expect(getApiUrl()).toBe('https://api.prod.com')
  vi.unstubAllEnvs()
})
```

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock:

**1. Use dependency injection**

Pass external dependencies in rather than creating them internally:

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

**2. Prefer SDK-style interfaces over generic fetchers**

Create specific functions for each external operation instead of one generic function with conditional logic:

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

The SDK approach means:
- Each mock returns one specific shape
- No conditional logic in test setup
- Easier to see which endpoints a test exercises
- Type safety per endpoint

## Mock Cleanup

Always clean up mocks to prevent test pollution. Prefer global config over manual cleanup:

```typescript
// vitest.config.ts — recommended
defineConfig({
  test: {
    restoreMocks: true,   // restores vi.spyOn spies after each test
    clearMocks: true,      // clears call history before each test
    unstubEnvs: true,      // restores vi.stubEnv after each test
    unstubGlobals: true,   // restores vi.stubGlobal after each test
  },
})
```

If you need manual control, see [vitest-patterns.md](vitest-patterns.md) for the clearing hierarchy (`mockClear` vs `mockReset` vs `mockRestore`).
