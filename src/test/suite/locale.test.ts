import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// __dirname at runtime: <root>/out/test/suite → repo root is three levels up.
const ROOT = path.resolve(__dirname, '..', '..', '..');

// Discover shipped locales from disk instead of a hardcoded list, so a new
// `package.nls.<lang>.json` / `l10n/bundle.l10n.<lang>.json` is validated
// automatically and can never silently bypass the parity guard.
function discover(dir: string, re: RegExp): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir))
    .map((f) => re.exec(f)?.[1])
    .filter((lang): lang is string => lang !== undefined)
    .sort();
}

// package.nls.json is the English base and is excluded from the locale set.
const NLS_LOCALES = discover('.', /^package\.nls\.([a-z]{2}(?:-[a-z]+)?)\.json$/);
const BUNDLE_LOCALES = discover('l10n', /^bundle\.l10n\.([a-z]{2}(?:-[a-z]+)?)\.json$/);

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
  test('at least one locale is shipped', () => {
    assert.ok(NLS_LOCALES.length > 0, 'expected package.nls.<lang>.json files');
    assert.ok(BUNDLE_LOCALES.length > 0, 'expected l10n/bundle.l10n.<lang>.json files');
  });

  test('manifest and runtime bundles cover the same locale set', () => {
    // Every manifest locale must have a matching runtime bundle and vice versa,
    // so a language can never be half-localized.
    assert.deepStrictEqual(NLS_LOCALES, BUNDLE_LOCALES);
  });

  test('every package.nls.<lang>.json matches the base key set', () => {
    const base = readKeys('package.nls.json');
    for (const lang of NLS_LOCALES) {
      assertSameKeySet(base, readKeys(`package.nls.${lang}.json`), `package.nls.${lang}.json`);
    }
  });

  test('all l10n bundles share an identical key set', () => {
    // No English base bundle exists (English lives inline in the source), so use the
    // first shipped locale as the reference key set and require every other to match.
    const [reference, ...rest] = BUNDLE_LOCALES;
    const base = readKeys(`l10n/bundle.l10n.${reference}.json`);
    for (const lang of rest) {
      assertSameKeySet(base, readKeys(`l10n/bundle.l10n.${lang}.json`), `bundle.l10n.${lang}.json`);
    }
  });

  test('no locale has empty translations', () => {
    const files = [
      ...NLS_LOCALES.map((l) => `package.nls.${l}.json`),
      ...BUNDLE_LOCALES.map((l) => `l10n/bundle.l10n.${l}.json`),
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
    const [reference] = BUNDLE_LOCALES;
    const refEntries = readEntries(`l10n/bundle.l10n.${reference}.json`);
    const tokenCount = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
    for (const lang of BUNDLE_LOCALES) {
      const bundle = new Map(readEntries(`l10n/bundle.l10n.${lang}.json`));
      for (const [enKey] of refEntries) {
        const translated = bundle.get(enKey);
        assert.ok(translated !== undefined, `bundle.l10n.${lang}.json missing key ${JSON.stringify(enKey)}`);
        for (const token of ['{0}', '{1}', '{2}', '__N__', '__N2__']) {
          const re = new RegExp(token.replace(/[{}]/g, '\\$&'), 'g');
          // Require the exact same occurrence count as the English source key, so a
          // repeated placeholder cannot be silently dropped (e.g. two {0} → one {0}).
          assert.strictEqual(
            tokenCount(translated as string, re),
            tokenCount(enKey, re),
            `bundle.l10n.${lang}.json: key ${JSON.stringify(enKey)} lost placeholder ${token}`,
          );
        }
      }
    }
  });
});

// Collect every string literal passed to vscode.l10n.t (or the panel's `t` alias) in the
// shipped sources. The key parity above only compares bundles with each other; nothing checked
// that the code asks for a key that exists, so a one-character drift between the call and the
// bundle silently fell back to English for every non-English user.
//
// Every shipped source is scanned, not a fixed list: a new file calling l10n.t would otherwise
// drop out of the check while it kept passing. A call whose first argument is not a plain
// string literal cannot be checked, so it fails loudly instead of being skipped.
function shippedSources(): string[] {
  return (fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }) as string[])
    .map((f) => path.join('src', f).split(path.sep).join('/'))
    .filter((f) => f.endsWith('.ts') && !f.startsWith('src/test/'))
    .sort();
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0', '\n': '', '\r': '',
};

/** The value of a JS string literal body, with every escape resolved as JS resolves it. */
function unescapeLiteral(body: string): string {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_all, esc: string) => {
    if (esc.length > 1) { return String.fromCodePoint(parseInt(esc.replace(/[ux{}]/g, ''), 16)); }
    return SIMPLE_ESCAPES[esc] ?? esc;
  });
}

function runtimeL10nKeys(): { file: string; key: string }[] {
  // `l10n.t(` anywhere, or a bare `t(` alias (the panel binds one); not `x.t(` or `foo_t(`.
  const call = /(?:\bl10n\.t|(?<![.\w$])t)\(\s*/g;
  const out: { file: string; key: string }[] = [];
  const unreadable: string[] = [];
  for (const file of shippedSources()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    for (const m of src.matchAll(call)) {
      const start = m.index + m[0].length;
      const quote = src[start];
      const literal = quote === "'" || quote === '"'
        ? new RegExp(`${quote}((?:[^${quote}\\\\\\n]|\\\\[\\s\\S])*)${quote}`, 'y')
        : null;
      if (literal) { literal.lastIndex = start; }
      const lm = literal?.exec(src);
      if (!lm) {
        unreadable.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
        continue;
      }
      out.push({ file, key: unescapeLiteral(lm[1]) });
    }
  }
  assert.deepStrictEqual(unreadable, [], 'l10n calls whose key is not a plain string literal cannot be checked');
  return out;
}

suite('runtime strings reach the bundles', () => {
  test('every l10n.t literal in the sources is a key of each bundle', () => {
    const keys = runtimeL10nKeys();
    // Positive control: the scanner must see the strings this suite exists for.
    assert.ok(keys.some((k) => k.key === 'Claude Code is not logged in.\nRun: claude auth login'),
      'the scanner must find the not-logged-in hint, real newline included');
    assert.ok(keys.length > 50, `suspiciously few literals found: ${keys.length}`);
    for (const lang of BUNDLE_LOCALES) {
      const bundle = new Set(readKeys(`l10n/bundle.l10n.${lang}.json`));
      const missing = keys.filter((k) => !bundle.has(k.key));
      assert.deepStrictEqual(missing, [], `${lang} bundle lacks keys used in code`);
    }
  });

  test('no hint suggests the non-existent `claude login` command', () => {
    const bare = /claude login/;
    for (const k of runtimeL10nKeys()) {
      assert.ok(!bare.test(k.key), `${k.file}: ${JSON.stringify(k.key)}`);
    }
    for (const lang of BUNDLE_LOCALES) {
      for (const [key, value] of readEntries(`l10n/bundle.l10n.${lang}.json`)) {
        assert.ok(!bare.test(value), `${lang}: ${JSON.stringify(key)}`);
      }
    }
  });

  test('the rejected-login hint names the refresh command as the palette does', () => {
    const hint = 'Anthropic rejected your Claude Code login.\nRun: claude auth login, then "Claude+GLM: Refresh Now"';
    assert.ok(runtimeL10nKeys().some((k) => k.key === hint), 'the hint must be used in code');
    const refreshTitle = (file: string): string | undefined =>
      (JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf-8')) as Record<string, string>)['cmd.refresh'];
    const enTitle = refreshTitle('package.nls.json');
    assert.ok(enTitle, 'package.nls.json has cmd.refresh');
    assert.ok(hint.includes(enTitle), 'English hint vs package.nls.json');
    for (const lang of BUNDLE_LOCALES) {
      const translated = Object.fromEntries(readEntries(`l10n/bundle.l10n.${lang}.json`))[hint] as string | undefined;
      const title = refreshTitle(`package.nls.${lang}.json`);
      assert.ok(title, `package.nls.${lang}.json has cmd.refresh`);
      assert.ok(translated !== undefined, `bundle.l10n.${lang}.json lacks the key ${JSON.stringify(hint)}`);
      assert.ok(translated.includes(title), `${lang}: ${JSON.stringify(translated)} must contain ${JSON.stringify(title)}`);
    }
  });
});
