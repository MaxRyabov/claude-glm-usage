/**
 * Suppression of quota polling after the provider refuses our credentials.
 *
 * This exists because fixing the "rejected key reads as 0% used" bug makes the request
 * pattern worse unless something stops it: a refused key now throws instead of returning a
 * cacheable success, nothing is written to the cache, and the poll scheduler treats a missing
 * cache as a reason to call — on every 60-second tick, two HTTP requests at a time. The
 * project's rule is at most one call per five minutes when idle.
 *
 * Kept as a pure, injectable-clock module so the policy can be tested without standing up a
 * DataManager, which reads the real ~/.claude.
 */
export class AuthBackoff<P> {
  private rejectedAt: number | null = null;
  private rejectedFor: P | null = null;

  /** Records a refusal. Only credential refusals belong here — see `isActive`. */
  record(provider: P, now: number = Date.now()): void {
    this.rejectedAt = now;
    this.rejectedFor = provider;
  }

  clear(): void {
    this.rejectedAt = null;
    this.rejectedFor = null;
  }

  /**
   * Whether polling is currently suppressed for this provider.
   *
   * Network and upstream failures are deliberately never recorded: those are transient and
   * worth retrying, whereas a revoked key will still be revoked in five minutes. Expiry is
   * self-clearing so a recovered key resumes polling on the next tick.
   */
  isActive(provider: P, ttlSeconds: number, now: number = Date.now()): boolean {
    if (this.rejectedAt === null || this.rejectedFor !== provider) { return false; }
    if ((now - this.rejectedAt) / 1000 >= ttlSeconds) {
      this.clear();
      return false;
    }
    return true;
  }
}
