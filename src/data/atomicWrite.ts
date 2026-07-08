import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Atomically write JSON to disk: serialize to a sibling temp file, flush it to disk
 * (fsync), then rename over the target. A crash mid-write can therefore never leave a
 * half-written or corrupt cache file — the previous file stays intact until the rename,
 * which is atomic on the same filesystem. Pattern borrowed from the CodeDash project.
 *
 * `mode` is applied to the temp file before the rename so the final file inherits it
 * (used for the 0600 rate-limit cache). Write failures are surfaced to the caller; the
 * temp file is best-effort cleaned up.
 */
export async function atomicWriteJson(
  filePath: string,
  obj: unknown,
  mode?: number,
): Promise<void> {
  const dir = path.dirname(filePath);
  // Unique-ish temp name without Math.random/Date.now (unavailable in some sandboxes);
  // pid + a module-level counter keeps concurrent writers from colliding.
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${tmpCounter++}`);

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, 'w', mode);
    await handle.writeFile(JSON.stringify(obj), 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (handle) { try { await handle.close(); } catch { /* ignore */ } }
    try { await fs.unlink(tmpPath); } catch { /* temp may not exist */ }
    throw err;
  }
}

let tmpCounter = 0;
