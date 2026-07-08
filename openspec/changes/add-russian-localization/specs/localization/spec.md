## ADDED Requirements

### Requirement: Russian manifest localization
The extension SHALL provide a `package.nls.ru.json` resolving every `%key%` placeholder used in
`package.json` to a Russian translation, with a key set identical to the base `package.nls.json`.

#### Scenario: Display language is Russian
- **WHEN** the VSCode display language is `ru`
- **THEN** command titles, the setting category, setting descriptions and `enumDescriptions` render
  in Russian

#### Scenario: Missing manifest key
- **WHEN** a `%key%` placeholder has no entry in `package.nls.ru.json`
- **THEN** VSCode falls back to the English value from `package.nls.json` without error

### Requirement: Russian runtime localization
The extension SHALL provide an `l10n/bundle.l10n.ru.json` translating the runtime strings passed to
`vscode.l10n.t()` (status bar, notifications, dashboard), preserving all `{0}`/`{1}` and
`__N__`/`__N2__` placeholders and leading glyphs.

#### Scenario: Status bar and dashboard in Russian
- **WHEN** the VSCode display language is `ru`
- **THEN** the status bar text/tooltip, notifications and the dashboard render in Russian with
  numeric values, percentages and reset times substituted correctly into the placeholders

#### Scenario: Untranslated runtime string
- **WHEN** a `vscode.l10n.t()` source string has no entry in `l10n/bundle.l10n.ru.json`
- **THEN** the extension shows the English source string without error

### Requirement: Locale key parity
The extension SHALL keep every localized bundle in parity with its base: each
`package.nls.<lang>.json` carries exactly the key set of `package.nls.json`, and all
`l10n/bundle.l10n.<lang>.json` bundles share an identical key set, with no missing, extra or empty
values.

#### Scenario: Parity is enforced by tests
- **WHEN** the test suite runs
- **THEN** a locale parity test fails if any locale is missing a key, has an extra key, or has an
  empty translation
