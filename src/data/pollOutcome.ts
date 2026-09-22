/**
 * Pure decisions of the quota poll loop: whether to call the provider, what a failure means for
 * the user, and when utilization counts as live.
 *
 * These used to be inline in DataManager, which reads the real ~/.claude and so cannot be put
 * under test. Each branch here was a defect at some point — a refused key polled every tick, an
 * outage shown as "not logged in", a stale 92% raising a threshold notification — so each is
 * kept small enough to be pinned by a table of cases.
 */
import {
  AnthropicAuthError,
  AnthropicTokenExpiredError,
  CredentialsUnavailableError,
  ClaudeProvider,
} from './apiClient';
import { PollBackoffReason, backoffReasonOf } from './authBackoff';

export type DataSource =
  'api' | 'cache' | 'stale' | 'no-credentials' | 'no-data' | 'local-only' | 'auth-rejected';

/** A reason to show next to data that is not live, when the reason is the user's to know. */
export type PollNotice = 'token-expired';

/**
 * A refused key or a moved payload backs off for the cache TTL — but never for less than five
 * minutes. The TTL setting goes down to 60 s, and the project rule is at most one call per five
 * minutes while idle; a pause tied to the TTL alone would poll a dead token every minute.
 */
export const MIN_PAUSE_SECONDS = 300;

/** A retryable failure (network, 5xx) is retried automatically no sooner than this. */
export const RETRY_DELAY_SECONDS = 300;

export function pauseSeconds(ttlSeconds: number): number {
  return Math.max(ttlSeconds, MIN_PAUSE_SECONDS);
}

interface CacheContext {
  hasCache: boolean
  cacheValid: boolean
  hasCostData: boolean
}

function fromCache(ctx: CacheContext): DataSource | null {
  if (!ctx.hasCache) { return null; }
  return ctx.cacheValid ? 'cache' : 'stale';
}

export interface FailureOutcome {
  backoff: PollBackoffReason | null
  /** True for a failure that is retried, but not before RETRY_DELAY_SECONDS. */
  retryDelay: boolean
  dataSource: DataSource
  notice: PollNotice | null
  rejectionStatus?: 401 | 403
}

/** What a failed poll means: the backoff it earns and what the user is shown. */
export function pollFailureOutcome(err: unknown, ctx: CacheContext): FailureOutcome {
  const costOr = (fallback: DataSource): DataSource => (ctx.hasCostData ? 'local-only' : fallback);
  const shown = (fallback: DataSource): DataSource => fromCache(ctx) ?? costOr(fallback);

  const backoff = backoffReasonOf(err);
  if (backoff === 'credentials') {
    return {
      backoff,
      retryDelay: false,
      dataSource: 'auth-rejected',
      notice: null,
      ...(err instanceof AnthropicAuthError ? { rejectionStatus: err.status } : {}),
    };
  }
  if (backoff === 'format') {
    return { backoff, retryDelay: false, dataSource: shown('no-data'), notice: null };
  }
  if (err instanceof AnthropicTokenExpiredError) {
    return { backoff: null, retryDelay: false, dataSource: shown('no-data'), notice: 'token-expired' };
  }
  // Only a missing credential says "not logged in". Before this, every failure without a cache
  // did, and an Anthropic outage told the user to log in again.
  if (err instanceof CredentialsUnavailableError) {
    return { backoff: null, retryDelay: false, dataSource: shown('no-credentials'), notice: null };
  }
  return { backoff: null, retryDelay: true, dataSource: shown('no-data'), notice: null };
}

/**
 * What to show for a provider that is not polled at all: no rate-limit data (Bedrock, API key,
 * custom endpoint, unknown) or rate-limit calls turned off by the user, with no cache.
 *
 * "Not logged in" belongs to `unknown` alone — that is what auto-detection returns when no
 * credential of any kind was found. A Bedrock user without local cost is not logged out.
 */
export function idleDataSource(provider: ClaudeProvider, hasCostData: boolean): DataSource {
  if (hasCostData) { return 'local-only'; }
  return provider === 'unknown' ? 'no-credentials' : 'no-data';
}

export type PollDecision = 'poll' | 'skip' | 'poll-if-jsonl-recent';

export interface PollDecisionInput {
  force: boolean
  /** The active backoff for this provider, already evaluated against `pauseSeconds(ttl)`. */
  pauseReason: PollBackoffReason | null
  /** When the last retryable failure for this provider happened, or null. */
  retryableFailureAt: number | null
  cache: 'none' | 'valid' | 'expired'
  now: number
}

/**
 * Whether this refresh calls the provider.
 *
 * The JSONL-activity test is returned as a third outcome rather than taken as an input: it walks
 * `stat` over the whole history tree, which on a large ~/.claude costs real time, and it is only
 * needed when the cache has expired.
 */
export function pollDecision(input: PollDecisionInput): PollDecision {
  if (input.force) { return 'poll'; }
  if (input.pauseReason !== null) { return 'skip'; }
  if (input.retryableFailureAt !== null) {
    const elapsed = input.now - input.retryableFailureAt;
    // A clock that stepped backwards must not hold the delay until real time catches up.
    if (elapsed >= 0 && elapsed < RETRY_DELAY_SECONDS * 1000) { return 'skip'; }
  }
  if (input.cache === 'none') { return 'poll'; }
  if (input.cache === 'expired') { return 'poll-if-jsonl-recent'; }
  return 'skip';
}

/**
 * What to show when this refresh did not poll by itself: skipped by `pollDecision`, lost the
 * cross-window lock, or found a fresh cache under the lock.
 *
 * All three go through here so an active credential pause survives them. The lock branches used
 * to return a bare cache/stale, which made the label flicker between "Login rejected" and plain
 * numbers whenever another window held the lock.
 */
export function noPollOutcome(
  input: CacheContext & { pauseReason: PollBackoffReason | null },
): DataSource {
  if (input.pauseReason === 'credentials') { return 'auth-rejected'; }
  return fromCache(input) ?? (input.hasCostData ? 'local-only' : 'no-data');
}

/**
 * Whether a failure recorded at `failureAt` has been overtaken by fresh data: another window
 * polled the same provider successfully and wrote the shared cache after it.
 */
export function supersededByCache(cacheUpdatedAt: string | undefined, failureAt: number | null): boolean {
  if (failureAt === null || cacheUpdatedAt === undefined) { return false; }
  const written = Date.parse(cacheUpdatedAt);
  return Number.isFinite(written) && written > failureAt;
}

/** A stored notice applies to the provider it was recorded for, and to nothing after a switch. */
export function activeNotice(
  stored: { provider: ClaudeProvider; notice: PollNotice | null } | null,
  provider: ClaudeProvider,
): PollNotice | null {
  return stored && stored.provider === provider ? stored.notice : null;
}

/**
 * Whether utilization and reset times are live enough to show, predict from, or notify on.
 *
 * Every consumer used to decide for itself and excluded only 'local-only', so in 'auth-rejected'
 * the utilization of an old cache surfaced everywhere — bars, prediction, "92% used" pop-ups.
 */
export function showsRateData(provider: ClaudeProvider, dataSource: DataSource): boolean {
  const supportsRateLimit = provider === 'claude-ai' || provider === 'z-ai';
  return supportsRateLimit && (dataSource === 'api' || dataSource === 'cache' || dataSource === 'stale');
}

/**
 * The state a startup snapshot is shown in until the first refresh. Only a snapshot that carried
 * live data becomes 'stale'; any other keeps its own state, or its zero utilization would read as
 * "5h: 0% [N ago]" — the very symptom of issue #8.
 */
export function snapshotDataSource(usage: { providerType: ClaudeProvider; dataSource: DataSource }): DataSource {
  return showsRateData(usage.providerType, usage.dataSource) ? 'stale' : usage.dataSource;
}

/** The usage payload for the dashboard, carrying the one decision the page must not re-derive. */
export function dashboardUsage<T extends { providerType: ClaudeProvider; dataSource: DataSource }>(
  usage: T,
): T & { showRateData: boolean } {
  return { ...usage, showRateData: showsRateData(usage.providerType, usage.dataSource) };
}
