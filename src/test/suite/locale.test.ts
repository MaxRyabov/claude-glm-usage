import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// __dirname at runtime: <root>/out/test/suite → repo root is three levels up.
const ROOT = path.resolve(__dirname, '..', '..', '..');

// Locales shipped alongside the English base. Add new language codes here.
const LOCALES = ['ja', 'zh-cn', 'ru'];

function readKeys(file: string): string[] {
  const obj = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf-8')) as Record<string, string>;
  return Object.keys(obj);
}

function readEntries(file: string): [string, string][] {
  const obj = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf-8')) as Record<string, string>;
  return Object.entries(obj);
}

function assertSameKeySet(base: string[], other: string[], label: string): void {
  const baseSet = new Set(base);
  const otherSet = new Set(other);
  const missing = base.filter((k) => !otherSet.has(k));
  const extra = other.filter((k) => !baseSet.has(k));
  assert.strictEqual(missing.length, 0, `${label} is missing keys: ${JSON.stringify(missing)}`);
  assert.strictEqual(extra.length, 0, `${label} has extra keys: ${JSON.stringify(extra)}`);
}

suite('localization key parity', () => {
  test('every package.nls.<lang>.json matches the base key set', () => {
    const base = readKeys('package.nls.json');
    for (const lang of LOCALES) {
      assertSameKeySet(base, readKeys(`package.nls.${lang}.json`), `package.nls.${lang}.json`);
    }
  });

  test('all l10n bundles share an identical key set', () => {
    // No English base bundle exists (English lives inline in the source), so use the
    // first shipped locale as the reference key set and require every other to match.
    const [reference, ...rest] = LOCALES;
    const base = readKeys(`l10n/bundle.l10n.${reference}.json`);
    for (const lang of rest) {
      assertSameKeySet(base, readKeys(`l10n/bundle.l10n.${lang}.json`), `bundle.l10n.${lang}.json`);
    }
  });

  test('no locale has empty translations', () => {
    const files = [
      ...LOCALES.map((l) => `package.nls.${l}.json`),
      ...LOCALES.map((l) => `l10n/bundle.l10n.${l}.json`),
    ];
    for (const file of files) {
      for (const [key, value] of readEntries(file)) {
        assert.ok(
          typeof value === 'string' && value.trim().length > 0,
          `${file}: empty translation for key ${JSON.stringify(key)}`,
        );
      }
    }
  });

  test('placeholders are preserved in translated runtime strings', () => {
    // {0}/{1} substitution tokens and __N__/__N2__ duration-format tokens must survive
    // translation, or the UI would render literal placeholders / lose values.
    const reference = readEntries('l10n/bundle.l10n.ja.json');
    const tokenCount = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
    for (const lang of LOCALES) {
      const bundle = new Map(readEntries(`l10n/bundle.l10n.${lang}.json`));
      for (const [enKey] of reference) {
        const translated = bundle.get(enKey);
        assert.ok(translated !== undefined, `bundle.l10n.${lang}.json missing key ${JSON.stringify(enKey)}`);
        for (const token of ['{0}', '{1}', '{2}', '__N__', '__N2__']) {
          const re = new RegExp(token.replace(/[{}]/g, '\\$&'), 'g');
          if (enKey.includes(token)) {
            assert.ok(
              tokenCount(translated as string, re) >= 1,
              `bundle.l10n.${lang}.json: key ${JSON.stringify(enKey)} lost placeholder ${token}`,
            );
          }
        }
      }
    }
  });
});
