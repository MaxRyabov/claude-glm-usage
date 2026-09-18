# Tasks: add-russian-localization

## 1. Manifest strings (package.nls)
- [x] 1.1 Create `package.nls.ru.json` with Russian translations for all 37 keys of
  `package.nls.json` (keep key names identical; do not translate product names Claude Code, GLM,
  z.ai, AWS Bedrock, API Key)

## 2. Runtime strings (l10n bundle)
- [x] 2.1 Create `l10n/bundle.l10n.ru.json` translating all 104 keys of `l10n/bundle.l10n.ja.json`
  (English source string stays as the JSON key; Russian is the value)
- [x] 2.2 Preserve `{0}`/`{1}` and `__N__`/`__N2__` placeholders and leading glyphs
  (🤖 ↻ → ▲ ▼ ⚠️ 💸 ⛔ ⚙ $ %) exactly

## 3. Documentation
- [x] 3.1 Create `README.ru.md` mirroring `README.ja.md` / `README.zh.md` (badges/images/links unchanged)
- [x] 3.2 Add `[Русский](README.ru.md)` to the language switcher line in `README.md`, `README.ja.md`,
  `README.zh.md`, and `README.ru.md`
- [x] 3.3 Add a `## [Unreleased]` entry to `CHANGELOG.md`

## 4. Tests
- [x] 4.1 TEST: `src/test/suite/locale.test.ts` — every `package.nls.<lang>.json` has the same key
  set as `package.nls.json`; every `l10n/bundle.l10n.<lang>.json` shares an identical key set; no
  missing or extra keys; no empty values

## 5. Final gate
- [x] 5.1 `npm run lint` clean
- [x] 5.2 `npm test` fully green (incl. new locale parity test)
- [ ] 5.3 Manual check in Extension Development Host with display language `ru`
- [ ] 5.4 Archive the OpenSpec change and open PR `feat/russian-localization` → `main`
