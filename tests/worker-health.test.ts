import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  classifyError,
  currentTerminalError,
  probeRole,
  retryDecision,
  scanTerminalErrors,
  transcriptShowsPromptAccepted,
  type ErrorClass,
  type RetryState,
  type Verdict,
} from '../src/worker-health.ts';
import {
  claudeApiError,
  claudeApiRetry,
  claudeAssistantText,
  claudeMetadata,
  claudeResultError,
  claudeUserToolResult,
  codexErrorEvent,
  codexFunctionOutput,
  jsonl,
} from './helpers/transcripts.ts';

const NOW = Date.parse('2026-06-20T12:00:00.000Z');
/** ISO timestamp `ms` before NOW. */
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SEC = 1_000;
const MIN = 60_000;

describe('transcriptShowsPromptAccepted (S5 — the per-turn acceptance proof)', () => {
  const turnStart = Date.parse('2026-06-20T12:00:00.000Z');
  const rec = (type: string, atMs: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type, timestamp: new Date(atMs).toISOString(), ...extra });

  test('a user/assistant/result record at/after the turn start ⇒ accepted', () => {
    for (const t of ['user', 'assistant', 'result']) {
      expect.soft(transcriptShowsPromptAccepted(rec(t, turnStart + SEC), turnStart)).toBe(true);
    }
    // exactly at the boundary counts (the >= lower bound).
    expect.soft(transcriptShowsPromptAccepted(rec('user', turnStart), turnStart)).toBe(true);
  });

  test('only records BEFORE the turn start (a resumed session whose new prompt never landed) ⇒ false', () => {
    // The load-bearing case: a persistent session holds prior turns' records, so a
    // whole-transcript scan would false-positive — the lower bound rejects them.
    const tail = [rec('user', turnStart - MIN), rec('assistant', turnStart - 30 * SEC)].join('\n');
    expect(transcriptShowsPromptAccepted(tail, turnStart)).toBe(false);
  });

  test('only system/init records at/after the start (process launched, prompt not accepted) ⇒ false', () => {
    const tail = rec('system', turnStart + SEC, { subtype: 'init' });
    expect(transcriptShowsPromptAccepted(tail, turnStart)).toBe(false);
  });

  test('an empty transcript ⇒ false', () => {
    expect(transcriptShowsPromptAccepted('', turnStart)).toBe(false);
  });
});

describe('classifyError — first-match-wins taxonomy', () => {
  test.for<[string, ErrorClass]>([
    ['claude worker turn failed (success): Prompt is too long', 'context-overflow'],
    ['prompt is too long: 1013202 tokens > 1000000 maximum', 'context-overflow'],
    ['API Error: 403 Request not allowed. Please run /login', 'login-required'],
    ['Invalid API key · please check', 'login-required'],
    ['Your credit balance is too low to continue', 'quota-billing'],
    ['usage limit reached — resets at 5pm', 'quota-billing'],
    ['403 Request not allowed', 'auth'],
    ['authentication_error', 'auth'],
    ['API Error: 429 too many requests', 'rate-limit'],
    ['Overloaded', 'rate-limit'],
    ['fetch failed: ECONNRESET', 'network'],
    ['getaddrinfo ENOTFOUND api.example.com', 'dns'],
    ['500 Internal server error', 'server'],
    ['something nobody planned for', 'unknown'],
  ])('%s → %s', ([text, cls]) => {
    expect(classifyError(text)).toBe(cls);
  });

  test('order matters: a 403 carrying /login is login-required, a bare 403 is auth', () => {
    expect.soft(classifyError('403 Request not allowed. Please run /login')).toBe('login-required');
    expect.soft(classifyError('403 Request not allowed')).toBe('auth');
  });
});

describe('scanTerminalErrors — error-bearing records only (the honesty guarantee)', () => {
  test('discussion ABOUT an error is never counted', () => {
    const t = jsonl(claudeAssistantText('we hit a 403 and usage limits earlier — here is the fix'));
    expect(scanTerminalErrors(t, 'claude')).toEqual([]);
  });

  test('a run of api_retry events with no terminal error counts zero (classify on terminal only)', () => {
    const t = jsonl(claudeApiRetry({ ts: ago(9 * SEC) }), claudeApiRetry({ ts: ago(6 * SEC) }), claudeApiRetry({ ts: ago(3 * SEC) }));
    expect(scanTerminalErrors(t, 'claude')).toEqual([]);
  });

  test('a terminal API-error record is classified', () => {
    const t = jsonl(claudeApiError('API Error: 429 — temporarily limiting requests', { ts: ago(SEC) }));
    const hits = scanTerminalErrors(t, 'claude');
    expect.soft(hits).toHaveLength(1);
    expect.soft(hits[0]?.errorClass).toBe('rate-limit');
  });

  test('a terminal is_error result is classified', () => {
    const hits = scanTerminalErrors(jsonl(claudeResultError('500 Internal server error')), 'claude');
    expect(hits[0]?.errorClass).toBe('server');
  });

  test('a codex tool SUCCESS (exited with code 0) is never an error', () => {
    expect(scanTerminalErrors(jsonl(codexFunctionOutput('build done — exited with code 0')), 'codex')).toEqual([]);
  });

  test('a codex tool output carrying a hard-failure signature is flagged', () => {
    const hits = scanTerminalErrors(jsonl(codexFunctionOutput('npm error: getaddrinfo ENOTFOUND registry.npmjs.org')), 'codex');
    expect(hits[0]?.errorClass).toBe('dns');
  });

  test('an explicit codex error event is flagged and classified from its payload', () => {
    // The error-event branch classifies on the whole payload, so the signature
    // is matched wherever it sits in the record — not just a fixed field.
    const hits = scanTerminalErrors(jsonl(codexErrorEvent('stream error: 500 Internal server error')), 'codex');
    expect.soft(hits).toHaveLength(1);
    expect.soft(hits[0]?.errorClass).toBe('server');
  });

  test('a codex error event carrying a transient network signature classifies as network', () => {
    const hits = scanTerminalErrors(jsonl(codexErrorEvent('disconnected before completion: ECONNRESET')), 'codex');
    expect(hits[0]?.errorClass).toBe('network');
  });

  test('a codex error event with the signature PAST 200 chars still classifies (#4 — whole payload)', () => {
    // A long prefix pushes the signature past any fixed slice; classification
    // must run over the full serialized payload, not a truncated head, or this
    // reports `unknown`. The display text is still truncated by normalize.
    const longPrefix = `request ${'x'.repeat(300)} failed: `;
    const hits = scanTerminalErrors(jsonl(codexErrorEvent(`${longPrefix}500 Internal server error`)), 'codex');
    expect.soft(hits).toHaveLength(1);
    expect.soft(hits[0]?.errorClass).toBe('server'); // not 'unknown'
    expect.soft(hits[0]?.text.length).toBeLessThanOrEqual(200); // display still normalized
  });
});

describe('probeRole — verdict precedence', () => {
  // jsonl + opts → expected verdict, scoped against the injected NOW.
  test.for<{ name: string; jsonl: string; opts: Parameters<typeof probeRole>[1]; verdict: Verdict }>([
    {
      name: 'in flight, wrote 8s ago → working',
      jsonl: jsonl(claudeUserToolResult({ ts: ago(8 * SEC) })),
      opts: { schema: 'claude', now: NOW, inFlightSince: NOW - 60 * SEC },
      verdict: 'working',
    },
    {
      name: 'in flight, quiet 12m → long-inference',
      jsonl: jsonl(claudeUserToolResult({ ts: ago(12 * MIN) })),
      opts: { schema: 'claude', now: NOW, inFlightSince: NOW - 13 * MIN },
      verdict: 'long-inference',
    },
    {
      name: 'in flight, quiet 40m → silent/stuck',
      jsonl: jsonl(claudeUserToolResult({ ts: ago(40 * MIN) })),
      opts: { schema: 'claude', now: NOW, inFlightSince: NOW - 41 * MIN },
      verdict: 'silent/stuck',
    },
    {
      name: 'in flight + retriesSince + api_retry this turn → retrying',
      jsonl: jsonl(claudeAssistantText('thinking', { ts: ago(30 * SEC) }), claudeApiRetry({ ts: ago(5 * SEC) })),
      opts: { schema: 'claude', now: NOW, inFlightSince: NOW - 60 * SEC, retriesSince: NOW - 60 * SEC },
      verdict: 'retrying',
    },
    {
      name: 'api_retry OLDER than retriesSince + a recent write → NOT retrying (stale-retry, #3)',
      jsonl: jsonl(claudeApiRetry({ ts: ago(2 * MIN) }), claudeUserToolResult({ ts: ago(5 * SEC) })),
      opts: { schema: 'claude', now: NOW, inFlightSince: NOW - 10 * SEC, retriesSince: NOW - 10 * SEC },
      verdict: 'working',
    },
    {
      name: 'retriesSince OMITTED (orchestrator window) + api_retry inside window → NOT retrying',
      jsonl: jsonl(claudeApiRetry({ ts: ago(5 * SEC) }), claudeUserToolResult({ ts: ago(5 * SEC) })),
      opts: { schema: 'claude', now: NOW, inFlightSince: NOW - 120 * SEC },
      verdict: 'working',
    },
    {
      name: 'terminal error 30s ago → crashed (overrides idle)',
      jsonl: jsonl(claudeApiError('API Error: 500 Internal server error', { ts: ago(30 * SEC) })),
      opts: { schema: 'claude', now: NOW },
      verdict: 'crashed',
    },
    {
      name: 'not in flight, no recent error → idle',
      jsonl: jsonl(claudeUserToolResult({ ts: ago(5 * SEC) })),
      opts: { schema: 'claude', now: NOW },
      verdict: 'idle',
    },
  ])('$name', ({ jsonl: j, opts, verdict }) => {
    expect(probeRole(j, opts).verdict).toBe(verdict);
  });

  test('a recent terminal error SUPERSEDED by later activity is not crashed (recovered, #1)', () => {
    // Error at -60s, then a normal write at -20s: the worker recovered inside
    // the 3-min window. The error stays visible, but the verdict is not crashed.
    const t = jsonl(
      claudeApiError('API Error: 500 Internal server error', { ts: ago(60 * SEC) }),
      claudeAssistantText('recovered — continuing', { ts: ago(20 * SEC) }),
    );
    expect.soft(probeRole(t, { schema: 'claude', now: NOW }).verdict).toBe('idle'); // not in flight
    expect.soft(probeRole(t, { schema: 'claude', now: NOW, inFlightSince: NOW - 90 * SEC }).verdict).toBe('working'); // in flight, wrote 20s ago
    // The error is still reported either way (only the verdict reflects recovery).
    expect.soft(probeRole(t, { schema: 'claude', now: NOW }).recentErrors).toHaveLength(1);
  });

  test('a terminal error that IS the latest event is still crashed', () => {
    const t = jsonl(
      claudeAssistantText('working', { ts: ago(60 * SEC) }),
      claudeApiError('API Error: 500 Internal server error', { ts: ago(20 * SEC) }),
    );
    expect(probeRole(t, { schema: 'claude', now: NOW }).verdict).toBe('crashed');
  });

  test('last-activity skips trailing metadata records (the 494961h bug)', () => {
    // A content record 10s ago, then a metadata record with NO timestamp and a
    // pr-link metadata record WITH a (far newer) timestamp — both must be skipped.
    const t = jsonl(
      claudeAssistantText('working on it', { ts: ago(10 * SEC) }),
      claudeMetadata('last-prompt'),
      { type: 'pr-link', timestamp: ago(0), prUrl: 'https://example/pr/1' },
    );
    const health = probeRole(t, { schema: 'claude', now: NOW, inFlightSince: NOW - 60 * SEC });
    // Age is from the content record (~10s), not the trailing pr-link (~0s).
    expect.soft(health.lastActivityAgeMs).toBeGreaterThanOrEqual(9 * SEC);
    expect.soft(health.lastActivityAgeMs).toBeLessThan(12 * SEC);
    expect.soft(health.verdict).toBe('working');
  });

  test('retries are scoped to this turn when retriesSince is given', () => {
    const t = jsonl(claudeApiRetry({ ts: ago(5 * MIN) }), claudeApiRetry({ ts: ago(10 * SEC) }), claudeApiRetry({ ts: ago(5 * SEC) }));
    // Only the two newer than retriesSince (1 min ago) count.
    expect(probeRole(t, { schema: 'claude', now: NOW, inFlightSince: NOW - MIN, retriesSince: NOW - MIN }).retries).toBe(2);
  });
});

describe('currentTerminalError — the live error shared with the crashed verdict (#2)', () => {
  test('a recent, unsuperseded terminal error is live (named, with its class)', () => {
    const t = jsonl(claudeApiError('API Error: 500 Internal server error', { ts: ago(30 * SEC) }));
    expect(currentTerminalError(t, 'claude', NOW)?.errorClass).toBe('server');
  });

  test('a recent error SUPERSEDED by later activity is NOT live (undefined)', () => {
    const t = jsonl(
      claudeApiError('API Error: fetch failed: ECONNRESET', { ts: ago(60 * SEC) }),
      claudeAssistantText('recovered — continuing', { ts: ago(10 * SEC) }),
    );
    expect(currentTerminalError(t, 'claude', NOW)).toBeUndefined();
  });

  test('a STALE terminal error (beyond the recent window) is not live', () => {
    const t = jsonl(claudeApiError('API Error: 500 Internal server error', { ts: ago(5 * MIN) }));
    expect(currentTerminalError(t, 'claude', NOW)).toBeUndefined();
  });

  test('no terminal error → undefined', () => {
    expect(currentTerminalError(jsonl(claudeAssistantText('all good', { ts: ago(5 * SEC) })), 'claude', NOW)).toBeUndefined();
  });

  test('agrees with the crashed verdict on the same transcript (one rule, two consumers)', () => {
    const live = jsonl(claudeApiError('API Error: 500 Internal server error', { ts: ago(30 * SEC) }));
    const recovered = jsonl(
      claudeApiError('API Error: 500 Internal server error', { ts: ago(60 * SEC) }),
      claudeAssistantText('recovered', { ts: ago(10 * SEC) }),
    );
    expect.soft(probeRole(live, { schema: 'claude', now: NOW }).verdict).toBe('crashed');
    expect.soft(currentTerminalError(live, 'claude', NOW)).toBeDefined();
    expect.soft(probeRole(recovered, { schema: 'claude', now: NOW }).verdict).not.toBe('crashed');
    expect.soft(currentTerminalError(recovered, 'claude', NOW)).toBeUndefined();
  });
});

describe('retryDecision — the one retry policy (#5, pure)', () => {
  const transient: ErrorClass[] = ['network', 'server', 'rate-limit'];
  const neverRetried: ErrorClass[] = ['context-overflow', 'login-required', 'quota-billing', 'dns', 'unknown'];

  test('default-off (retryInfra 0) flags every class, never retries', () => {
    for (const cls of [...transient, 'auth', ...neverRetried] as ErrorClass[]) {
      expect.soft(retryDecision(cls, undefined, 0)).toEqual({ action: 'flag', errorClass: cls });
    }
  });

  test.for<ErrorClass>(['network', 'server', 'rate-limit'])('a transient %s with budget retries, carrying its class forward', (cls) => {
    const d = retryDecision(cls, undefined, 2);
    expect.soft(d.action).toBe('retry');
    if (d.action === 'retry') {
      expect.soft(d.nextRetryState).toEqual({ attempts: 1, lastClass: cls });
      expect.soft(d.delayMs).toBe(2_000); // first backoff
    }
  });

  test.for<ErrorClass>(['context-overflow', 'login-required', 'quota-billing', 'dns', 'unknown'])('a non-transient %s flags even with budget', (cls) => {
    expect(retryDecision(cls, undefined, 5)).toEqual({ action: 'flag', errorClass: cls });
  });

  test('auth retries once', () => {
    expect(retryDecision('auth', undefined, 5)).toEqual({ action: 'retry', delayMs: 2_000, nextRetryState: { attempts: 1, lastClass: 'auth' } });
  });

  test('a second CONSECUTIVE auth escalates as login-required — even at retryInfra=1 (#3)', () => {
    const afterFirstAuth: RetryState = { attempts: 1, lastClass: 'auth' };
    // Escalation precedes the exhaustion check, so budget 1 (already exhausted) still escalates.
    expect.soft(retryDecision('auth', afterFirstAuth, 1)).toEqual({ action: 'flag', errorClass: 'login-required' });
    // And with budget to spare it still escalates — a second auth is never retried.
    expect.soft(retryDecision('auth', afterFirstAuth, 5)).toEqual({ action: 'flag', errorClass: 'login-required' });
  });

  test('a non-auth class after an auth retry is NOT an escalation (only consecutive auth escalates)', () => {
    expect(retryDecision('network', { attempts: 1, lastClass: 'auth' }, 5).action).toBe('retry');
  });

  test('exhaustion (attempts ≥ budget) flags with the class', () => {
    expect(retryDecision('network', { attempts: 2, lastClass: 'network' }, 2)).toEqual({ action: 'flag', errorClass: 'network' });
  });

  test('backoff grows exponentially and caps at 30s', () => {
    const delayAt = (attempts: number) => {
      const d = retryDecision('network', { attempts, lastClass: 'network' }, 100);
      return d.action === 'retry' ? d.delayMs : -1;
    };
    expect.soft(delayAt(0)).toBe(2_000);
    expect.soft(delayAt(1)).toBe(4_000);
    expect.soft(delayAt(2)).toBe(8_000);
    expect.soft(delayAt(5)).toBe(30_000); // 2_000 * 2**5 = 64_000, capped
  });
});

describe('real transcripts parse honestly', () => {
  test('claude: only the genuine isApiErrorMessage records are counted (nested is_error tool-results are not)', () => {
    const text = readFileSync('examples/claude-code-session.jsonl', 'utf8');
    const genuine = (text.match(/"isApiErrorMessage":true/g) ?? []).length;
    const hits = scanTerminalErrors(text, 'claude');
    // Ties hits to error-BEARING records: nested tool-result is_error and prose are excluded.
    expect(hits).toHaveLength(genuine);
  });

  test('codex: a healthy rollout yields no spurious errors and a sane (non-1970) activity age', () => {
    const text = readFileSync('examples/codex-session.jsonl', 'utf8');
    expect.soft(scanTerminalErrors(text, 'codex')).toEqual([]);
    const health = probeRole(text, { schema: 'codex', now: NOW });
    expect.soft(health.lastActivityAgeMs).toBeDefined();
    const impliedTs = NOW - (health.lastActivityAgeMs ?? 0);
    expect.soft(impliedTs).toBeGreaterThan(Date.parse('2025-01-01')); // not the epoch-0 bug
  });
});
