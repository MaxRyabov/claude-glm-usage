# Proposal: add-russian-localization

## Why

The extension is already fully internationalized and ships English (base), Japanese (`ja`) and
Chinese Simplified (`zh-cn`). All user-facing strings are externalized via the two VSCode
localization mechanisms — `%key%` manifest placeholders (`package.nls*.json`) and
`vscode.l10n.t()` runtime bundles (`l10n/bundle.l10n.*.json`). Russian-speaking users currently
see the English fallback for every string. Adding a `ru` locale is a data-only change: no source
code touches, because every string is already wrapped.

## What Changes

- Add `package.nls.ru.json` — Russian translations of the 37 manifest keys (command titles,
  setting descriptions, `enumDescriptions`, display name / description).
- Add `l10n/bundle.l10n.ru.json` — Russian translations of the 104 runtime strings (status bar,
  notifications, dashboard). English source strings remain the JSON keys; `{0}`/`{1}` and
  `__N__`/`__N2__` placeholders and leading emoji/arrow glyphs are preserved verbatim.
- Add `README.ru.md` and a `[Русский](README.ru.md)` entry to the language switcher in every README.
- Add `src/test/suite/locale.test.ts` — a parity test guarding that every locale carries exactly the
  same key set as its base, so future string additions cannot silently drift across languages.

VSCode auto-selects the matching bundle from `vscode.env.language`, so no manifest registration is
required — the `ru` files load automatically when the display language is Russian. Untranslated or
future keys fall back to English by design.

## Impact

- Affected specs: `localization` (new capability).
- Affected files: `package.nls.ru.json` (new), `l10n/bundle.l10n.ru.json` (new), `README.ru.md`
  (new), `README.md` / `README.ja.md` / `README.zh.md` (language switcher line),
  `src/test/suite/locale.test.ts` (new), `CHANGELOG.md`.
- No source-code changes, no new runtime dependencies. Fully backward compatible: non-Russian
  locales are unaffected, and any missing key degrades gracefully to English.
