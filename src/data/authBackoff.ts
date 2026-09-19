/**
 * Suppression of quota polling after a failure that repeating cannot fix.
 *
 * This exists because fixing the "rejected key reads as 0% used" bug makes the request pattern
 * worse unless something stops it: such a failure now throws instead of returning a cacheable
 * success, nothing is written to the cache, and the poll scheduler treats a missing cache as a
 * reason to call — on every 60-second tick, two HTTP requests at a time. The project's rule is
 * at most one call per five minutes when idle.
 *
 * Two failure classes qualify. A refused credential will still be refused in five minutes, and
 * a payload whose shape we cannot read will not start parsing on its own. Network and upstream
 * faults are transient and deliberately stay retryable.
 *
 * The reason is kept alongside the timestamp because only one of the two is the user's to act
 * on: a refused credential is named in the interface, a format drift is not.
 *
 * Kept as a pure, injectable-clock module so the policy can be tested without standing up a
 * DataManager, which reads the real ~/.claude.
 */
export type PollBackoffReason = 'credentials' | 'format';

export class PollBackoff<P> {
  private startedAt: number | null = null;
  private provider: P | null = null;
  private reason: PollBackoffReason | null = null;

  record(provider: P, reason: PollBackoffReason, now: number = Date.now()): void {
    this.startedAt = now;
    this.provider = provider;
    this.reason = reason;
  }

  clear(): void {
    this.startedAt = null;
    this.provider = null;
    this.reason = null;
  }

  /**
   * The reason polling is currently suppressed for this provider, or null when it is not.
   * Expiry is self-clearing, so a recovered key resumes polling on the next tick.
   */
  activeReason(provider: P, ttlSeconds: number, now: number = Date.now()): PollBackoffReason | null {
    if (this.startedAt === null || this.provider !== provider) { return null; }
    if ((now - this.startedAt) / 1000 >= ttlSeconds) {
      this.clear();
      return null;
    }
    return this.reason;
  }

  isActive(provider: P, ttlSeconds: number, now: number = Date.now()): boolean {
    return this.activeReason(provider, ttlSeconds, now) !== null;
  }
}
