# Tasks: add-security-hardening

## 1. CRITICAL — credentials
- [ ] 1.1 Replace exec→execFile in readCredentialsFromKeychain() (apiClient.ts:59-69)
- [ ] 1.2 Add + EXPORT validateCredentialsPath(); call in readCredentials() (apiClient.ts:71-88)
- [ ] 1.3 Add "scope":"machine" to claudeStatus.credentials.path (package.json:165-172)
- [ ] 1.4 TEST: src/test/suite/credentials.test.ts — path accept/reject cases
- [ ] 1.5 TEST: src/test/suite/manifest.test.ts — credentials.path scope === "machine"

## 2. HIGH — webview / CDN
- [ ] 2.1 npm install chart.js@4.4.0 (add to dependencies)
- [ ] 2.2 Add src/webview/chart-entry.ts (re-export Chart to window)
- [ ] 2.3 Convert webpack.config.js to two-config array (node extension + web chart-bundle)
- [ ] 2.4 Pass ExtensionContext into DashboardPanel; set localResourceRoots (panel.ts:1241-1250)
- [ ] 2.5 Update CSP: drop cdn.jsdelivr.net from script-src (panel.ts:121-127)
- [ ] 2.6 Load Chart.js via asWebviewUri(dist/chart-bundle.js) (panel.ts:501)
- [ ] 2.7 TEST: src/test/suite/panel.test.ts — CSP has no jsdelivr; nonce present
- [ ] 2.8 TEST: src/test/suite/manifest.test.ts — chart.js in dependencies

## 3. MEDIUM — cache + path safety
- [ ] 3.1 writeCache(): mode 0o600 (cache.ts:35-54)
- [ ] 3.2 Add + EXPORT validateCacheFile(); use in readCache() (cache.ts:24-33)
- [ ] 3.3 Add + EXPORT isSafePath(); filter findAllJsonlFiles() results (jsonlReader.ts:65-91)
- [ ] 3.4 TEST: extend cache.test.ts — validateCacheFile cases + 0600 (POSIX-guarded)
- [ ] 3.5 TEST: extend jsonlReader.test.ts — isSafePath cases

## 4. Verification
- [ ] 4.1 npm run compile-tests && npm run lint && npm test (all green)
- [ ] 4.2 npx openspec validate add-security-hardening --strict
- [ ] 4.3 Manual smoke checks (Keychain read; Dashboard charts; cache 0600; traversal rejected)
