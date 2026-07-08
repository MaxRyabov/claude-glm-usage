import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Cross-window guard for the rate-limit API poll. Every VSCode window runs its own
// extension instance but they all share one quota and one on-disk rate-limit cache, so
// when the cache TTL expires only the window that wins this lock should hit the API;
// the others reuse the winner's result via the shared cache written moments later.
//
// The lock is a file created with the O_EXCL ('wx') flag — atomic on every platform.
// A crashed owner is handled by an mtime-based staleness takeover.

/** A poll (one small /v1/messages request) finishes in seconds; anything older is a dead owner. */
const LOCK_STALE_MS = 30_000;

function getLockPath(dirOverride?: string): string {
  return path.join(dirOverride ?? path.join(os.homedir(), '.claude'), 'vscode-claude-status-api.lock');
}

/**
 * Try to become the polling window. Returns true when the lock was acquired (caller MUST
 * `releaseApiPollLock()` when done) and false when another live window holds it.
 * Environment failures other than "lock already exists" (e.g. missing ~/.claude,
 * read-only FS) return true so locking problems never suppress polling entirely —
 * that degrades to the previous per-window behavior.
 */
export async function acquireApiPollLock(dirOverride?: string): Promise<boolean> {
  const lockPath = getLockPath(dirOverride);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(String(process.pid), 'utf-8');
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { return true; }
      // Lock exists — held by a live poller, or left behind by a crashed one.
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) { return false; }
      } catch {
        // Vanished between open and stat (owner just released) — retry the acquire.
        continue;
      }
      // Stale: remove and retry once. If several windows race the takeover, 'wx'
      // guarantees a single winner on the second attempt.
      try { await fs.unlink(lockPath); } catch { /* another window took it over */ }
    }
  }
  return false;
}

/** Release the lock if this process still owns it (best-effort; errors are ignored). */
export async function releaseApiPollLock(dirOverride?: string): Promise<void> {
  const lockPath = getLockPath(dirOverride);
  try {
    // Only unlink our own lock: after a stale takeover the file may belong to another
    // window, and blindly unlinking would let a third window start a duplicate poll.
    const owner = await fs.readFile(lockPath, 'utf-8');
    if (owner.trim() === String(process.pid)) {
      await fs.unlink(lockPath);
    }
  } catch {
    // already gone or unreadable — nothing to release
  }
}
