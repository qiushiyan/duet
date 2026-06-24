# Vitest Patterns and Gotchas

Vitest-specific patterns you'll hit repeatedly during TDD.

## vi.mock Hoisting

`vi.mock` calls are hoisted to the top of the file — they execute before any imports, regardless of where you write them. This means you **cannot** reference variables defined in the file:

```typescript
import { vi } from 'vitest'

// WON'T WORK — mockFn doesn't exist yet when vi.mock runs
const mockFn = vi.fn()
vi.mock('./api', () => ({ fetch: mockFn })) // Error: mockFn is not defined

// WORKS — vi.hoisted is also hoisted, so the variable exists
const mockFn = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetch: mockFn }))
```

Use `vi.hoisted` whenever you need to reference a mock function both in the factory and in your tests (e.g., to change return values per test).

## vi.doMock for Per-Test Mocking

`vi.mock` applies to the entire file. When you need different mocks per test, use `vi.doMock` (not hoisted) with dynamic imports:

```typescript
import { expect, test, vi } from 'vitest'

test('handles production config', async () => {
  vi.doMock('./config', () => ({ env: 'production', apiUrl: 'https://api.prod.com' }))
  const { getApiUrl } = await import('./service')
  expect(getApiUrl()).toBe('https://api.prod.com')
  vi.doUnmock('./config')
})

test('handles staging config', async () => {
  vi.doMock('./config', () => ({ env: 'staging', apiUrl: 'https://api.staging.com' }))
  const { getApiUrl } = await import('./service')
  expect(getApiUrl()).toBe('https://api.staging.com')
  vi.doUnmock('./config')
})
```

Call `vi.resetModules()` between tests if module cache causes stale imports.

## Mock Clearing Hierarchy

Three levels, each more aggressive:

| Method | Clears call history | Removes implementation | Restores original |
|--------|:------------------:|:---------------------:|:-----------------:|
| `mockClear()` | yes | no | no |
| `mockReset()` | yes | yes | no |
| `mockRestore()` | yes | yes | yes (spies only) |

- **`mockClear`**: Use when you want to reset call counts between tests but keep the mock behavior
- **`mockReset`**: Use when you want a blank mock (returns `undefined`)
- **`mockRestore`**: Use on spies (`vi.spyOn`) to put the original function back

Global equivalents: `vi.clearAllMocks()`, `vi.resetAllMocks()`, `vi.restoreAllMocks()`.

`vi.restoreAllMocks()` (and the `restoreMocks` config option) only restores spies created with `vi.spyOn`. Automocked modules are unaffected. Calling `.mockRestore()` directly on an individual mock still resets its implementation and clears state.

**Recommended config** for TDD — set in `vitest.config.ts` so you never think about it:

```typescript
defineConfig({
  test: {
    restoreMocks: true,   // restores vi.spyOn spies after each test
    clearMocks: true,      // clears call history before each test
    unstubEnvs: true,      // restores vi.stubEnv after each test
    unstubGlobals: true,   // restores vi.stubGlobal after each test
  },
})
```

## Constructor Mocking

Mocks called with `new` construct the instance rather than calling `mock.apply`. This means mock implementations for constructors **must** use the `function` or `class` keyword — arrow functions will throw `<anonymous> is not a constructor`:

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

## onTestFinished for Inline Cleanup

When you need cleanup tied to a specific test (not a suite-wide hook), use `onTestFinished`. It always runs, even if the test fails:

```typescript
import { expect, onTestFinished, test } from 'vitest'

test('creates temp file', () => {
  const path = createTempFile('test data')
  onTestFinished(() => fs.unlinkSync(path))

  expect(fs.readFileSync(path, 'utf8')).toBe('test data')
})
```

This is especially useful for composable helpers:

```typescript
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

## Fixture Scoping

By default, fixtures from `test.extend` are created per test. For expensive resources, scope them to file or worker:

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

Use `{ auto: true }` for fixtures that should run for every test without being destructured (e.g., global setup):

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

## Async Timer Patterns

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

## Waiting for Async Behavior

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
