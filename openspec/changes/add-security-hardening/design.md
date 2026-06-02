# Design: add-security-hardening

## Context

The extension reads Claude Code credentials and usage data from `~/.claude/` and renders a
dashboard in a VS Code WebView. The audit findings cluster into four capabilities, each
addressed below with the non-obvious technical decisions.

## Decisions

### 1. `exec` → `execFile` for Keychain (C-2)
Replace `execAsync(\`/usr/bin/security ... -s "${SERVICE}" -w\`)` with
`execFileAsync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w'])`.
Arguments are passed as an array and no shell is spawned, so command injection is impossible
even under future refactors.

### 2. Credentials path validation (C-1)
Add `validateCredentialsPath()` that resolves the path and requires it to live inside
`path.resolve(~/.claude)`; otherwise it throws. Exported so it can be unit-tested.

### 3. Two-config webpack (H-2)
`webpack.config.js` exports an array: (a) the extension host with `target: 'node'`, and
(b) a `chart-bundle` with `target: 'web'`. webpack 5 cannot mix targets in one config, so a
config array is the clean way to bundle Chart.js for the browser-like WebView context.

### 4. Pass `ExtensionContext` into `DashboardPanel`
The panel needs `extensionPath` to compute `asWebviewUri()` for the local Chart.js bundle
and to populate `localResourceRoots` (currently an empty array). `createOrShow()` is updated
to receive and forward `context`.

### 5. `scope: "machine"` for `credentials.path` (M-4)
Marking the setting machine-scoped prevents a malicious or mistaken workspace
`.vscode/settings.json` from redirecting credential reads.

### 6. Keep `style-src 'unsafe-inline'` (M-5, accepted no-op)
VS Code injects inline styles via CSS variables, so a full removal would require extracting
all styles and hashing them. This vector is not exploitable without a script injection, and
`script-src` is already locked to a nonce. We accept `style-src 'unsafe-inline'` as a
deliberate trade-off and do **not** raise a requirement for it.

## Testing strategy

Pure helpers (`validateCredentialsPath`, `validateCacheFile`, `isSafePath`) are exported so
they can be unit-tested without the electron host doing I/O. The `0600` permission assertion
is guarded by `process.platform !== 'win32'` (POSIX mode bits are meaningless on Windows).
WebView CSP is verified by asserting on the `getWebviewContent()` output string.
