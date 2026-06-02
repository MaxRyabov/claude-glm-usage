## ADDED Requirements

### Requirement: Keychain access avoids the shell
The extension SHALL read macOS Keychain credentials using `execFile` with an argument
array, never via a shell-interpolated command string.

#### Scenario: Keychain read uses argument array
- **WHEN** the extension reads credentials from the macOS Keychain
- **THEN** it invokes `/usr/bin/security` with discrete arguments and no shell interpolation

### Requirement: Credentials path confined to ~/.claude
The extension SHALL reject any `credentials.path` that resolves outside `~/.claude/`.

#### Scenario: Path inside ~/.claude is accepted
- **WHEN** `credentials.path` resolves to `~/.claude/.credentials.json`
- **THEN** the path is accepted

#### Scenario: Path outside ~/.claude is rejected
- **WHEN** `credentials.path` resolves to `/etc/passwd` or escapes via `..`
- **THEN** the extension throws and does not read the file

### Requirement: credentials.path is machine-scoped
The `claudeStatus.credentials.path` setting SHALL be machine-scoped and SHALL NOT be
overridable by workspace settings.

#### Scenario: Workspace override is ignored
- **WHEN** `.vscode/settings.json` sets `claudeStatus.credentials.path`
- **THEN** the value is ignored because the setting scope is `machine`
