# Proposal: add-security-hardening

## Why

A security audit of the forked `vscode-claude-status` extension (v0.6.1) found 2 CRITICAL,
2 HIGH, and 5 MEDIUM vulnerabilities spanning credential access, external CDN code loading,
cache integrity, and path traversal:

| ID | Severity | Problem |
|----|----------|---------|
| C-1 | CRITICAL | `credentials.path` is not confined to `~/.claude/` → arbitrary file read |
| C-2 | CRITICAL | Keychain access uses `exec()` with string interpolation → shell injection |
| H-1 | HIGH | WebView CSP allows scripts from `cdn.jsdelivr.net` |
| H-2 | HIGH | Chart.js is loaded from an external CDN (no SRI, third-party host dependency) |
| M-1 | MEDIUM | Cache file is written with default permissions (readable by other users) |
| M-2 | MEDIUM | Cache is not validated on read → trusts tampered data |
| M-3 | MEDIUM | JSONL reading allows path traversal outside `~/.claude/projects/` |
| M-4 | MEDIUM | `credentials.path` can be overridden via workspace `.vscode/settings.json` |
| M-5 | MEDIUM | CSP `style-src 'unsafe-inline'` (accepted as a deliberate trade-off) |

## What Changes

- **C-2** → Keychain access avoids the shell (`execFile` with an argument array).
- **C-1** → Credentials path is validated to resolve inside `~/.claude/`.
- **M-4** → `credentials.path` setting is given `scope: "machine"`.
- **H-1** → CSP `script-src` is nonce-only, with no external CDN.
- **H-2** → Chart.js is bundled as a local WebView resource.
- **M-1** → Cache file is written with `0600` permissions.
- **M-2** → Cache is schema-validated on read (invalid → "no data").
- **M-3** → JSONL discovery rejects paths outside `~/.claude/projects/`.
- **M-5** → Documented in `design.md` as an accepted no-op (not a requirement).

## Impact

- Affected specs: `credentials-security`, `webview-security`, `cache-integrity`, `path-safety` (all new).
- Affected code: `src/data/apiClient.ts`, `src/data/cache.ts`, `src/data/jsonlReader.ts`,
  `src/webview/panel.ts`, `src/webview/chart-entry.ts` (new), `webpack.config.js`,
  `package.json`, `src/extension.ts`.
- New dependency: `chart.js@4.4.0` (moves from CDN to bundled).
- New tests under `src/test/suite/`.
