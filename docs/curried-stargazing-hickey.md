# План: Исправление проблем безопасности в форке vscode-claude-status (через OpenSpec)

## Контекст

Расширение `vscode-claude-status` (v0.6.1) показывает статистику использования Claude Code
в status bar VS Code. При аудите безопасности были выявлены **2 CRITICAL, 2 HIGH и 5 MEDIUM**
уязвимостей. Пользователь форкает репозиторий и хочет последовательно закрыть все найденные
проблемы.

**Как исполняется этот план.** Вся разработка идёт строго через **OpenSpec**: создаётся
один change `add-security-hardening`, и **ни одна строка кода не правится вне задач,
описанных в его `tasks.md`**. Жизненный цикл: **Branch → Propose → Apply → Verify → PR →
Archive**. Автоматические тесты пишутся в рамках задач и **запускаются на этапе верификации**.

Все пути файлов указаны относительно корня репозитория `vscode-claude-status`.

OpenSpec уже инициализирован (`openspec/changes/`, `openspec/specs/`). Доступны скиллы
[`openspec-propose`](#stage-0), `openspec-apply-change`, `openspec-archive-change`
(и алиасы `opsx:*`).

---

## Stage 0 — Ветка + Propose

### 0.1. Создать feature-ветку

⛔ Правило репозитория: **никогда не пушить напрямую в `main`**. До любой работы создаём
выделенную ветку от `main`:

```bash
git checkout main && git pull
git checkout -b fix/security-hardening
```

Префикс `fix/` — по [`CLAUDE.md` → Git Branch Convention](../CLAUDE.md) (аудит = bug-fix
работа). Все коммиты (OpenSpec-артефакты, код, тесты) идут в эту ветку; поставка — через
**Pull Request**, а не прямой push.

### 0.2. Propose: создать OpenSpec change

Запустить скилл **`/openspec-propose`** и создать
`openspec/changes/add-security-hardening/` со структурой:

```
openspec/changes/add-security-hardening/
├── proposal.md
├── design.md
├── tasks.md
└── specs/
    ├── credentials-security/spec.md
    ├── webview-security/spec.md
    ├── cache-integrity/spec.md
    └── path-safety/spec.md
```

После создания — **провалидировать**:

```bash
npx openspec validate add-security-hardening --strict   # если CLI установлен
```

Если CLI недоступен — полагаться на встроенную валидацию скилла `openspec-propose`
(каждое требование должно иметь хотя бы один `#### Scenario:`).

Ниже — точный контент артефактов.

---

### `proposal.md`

**Why** — аудит выявил уязвимости доступа к учётным данным, загрузки кода из внешнего CDN,
целостности кэша и path traversal:

| ID | Severity | Проблема |
|----|----------|----------|
| C-1 | CRITICAL | `credentials.path` не ограничен `~/.claude/` → чтение произвольных файлов |
| C-2 | CRITICAL | Доступ к Keychain через `exec()` со строковой интерполяцией → shell-инъекция |
| H-1 | HIGH | CSP WebView разрешает скрипты с `cdn.jsdelivr.net` |
| H-2 | HIGH | Chart.js грузится с внешнего CDN (нет SRI, зависимость от стороннего хоста) |
| M-1 | MEDIUM | Кэш-файл пишется с правами по умолчанию (читаем другими пользователями) |
| M-2 | MEDIUM | Кэш не валидируется при чтении → доверие к подменённым данным |
| M-3 | MEDIUM | Чтение JSONL допускает path traversal за пределы `~/.claude/projects/` |
| M-4 | MEDIUM | `credentials.path` переопределяется через workspace `.vscode/settings.json` |
| M-5 | MEDIUM | CSP `style-src 'unsafe-inline'` (принимается как осознанный компромисс) |

**What Changes** (одно требование на находку):
- C-2 → доступ к Keychain без shell (`execFile` с массивом аргументов).
- C-1 → путь к credentials подтверждается внутри `~/.claude/`.
- M-4 → настройка `credentials.path` имеет `scope: "machine"`.
- H-1 → CSP `script-src` только по nonce, без внешних CDN.
- H-2 → Chart.js бандлится как локальный ресурс WebView.
- M-1 → кэш пишется с правами `0600`.
- M-2 → кэш валидируется по схеме при чтении (невалидный → "no data").
- M-3 → обнаружение JSONL отклоняет пути за пределами `~/.claude/projects/`.
- M-5 → задокументировано в `design.md` как принятый no-op (не требование).

---

### `design.md` — технические решения

1. **`exec` → `execFile` (C-2).** Аргументы передаются массивом
   (`['find-generic-password', '-s', SERVICE, '-w']`), shell не запускается — инъекция
   невозможна даже при будущем рефакторинге.
2. **Валидация пути credentials (C-1).** `validateCredentialsPath()` резолвит путь и
   требует, чтобы он лежал внутри `path.resolve(~/.claude)`; иначе — `throw`.
3. **Двухконфигурационный webpack (H-2).** `webpack.config.js` экспортирует массив:
   (a) extension host — `target: 'node'`; (b) chart-bundle — `target: 'web'`. Разные
   таргеты невозможны в одном конфиге webpack 5.
4. **`ExtensionContext` в `DashboardPanel`.** Чтобы получить `extensionPath` для
   `asWebviewUri()` и заполнить `localResourceRoots` (сейчас пустой массив, `panel.ts:1248`).
5. **`scope: "machine"` для `credentials.path` (M-4).** Запрещает переопределение через
   workspace-настройки.
6. **CSP `style-src 'unsafe-inline'` остаётся (M-5, Вариант A).** VS Code инжектит инлайн-
   стили через CSS-переменные; полный отказ требует выноса всех стилей + хеширования и не
   эксплуатируем без инъекции скрипта (а `script-src` уже строгий по nonce). Принимается
   как осознанный компромисс.

---

### Spec-дельты (`## ADDED Requirements`, каждое требование — со сценарием)

**`specs/credentials-security/spec.md`**

```markdown
## ADDED Requirements

### Requirement: Keychain access avoids the shell
The extension SHALL read macOS Keychain credentials using `execFile` with an argument
array, never via a shell-interpolated command string.

#### Scenario: Keychain read uses argument array
- WHEN the extension reads credentials from the macOS Keychain
- THEN it invokes `/usr/bin/security` with discrete arguments and no shell interpolation

### Requirement: Credentials path confined to ~/.claude
The extension SHALL reject any `credentials.path` that resolves outside `~/.claude/`.

#### Scenario: Path inside ~/.claude is accepted
- WHEN `credentials.path` resolves to `~/.claude/.credentials.json`
- THEN the path is accepted

#### Scenario: Path outside ~/.claude is rejected
- WHEN `credentials.path` resolves to `/etc/passwd` or escapes via `..`
- THEN the extension throws and does not read the file

### Requirement: credentials.path is machine-scoped
The `claudeStatus.credentials.path` setting SHALL be machine-scoped and not overridable
by workspace settings.

#### Scenario: Workspace override is ignored
- WHEN `.vscode/settings.json` sets `claudeStatus.credentials.path`
- THEN the value is ignored because the setting scope is `machine`
```

**`specs/webview-security/spec.md`**

```markdown
## ADDED Requirements

### Requirement: No external script sources in WebView
The dashboard WebView CSP `script-src` SHALL allow only nonce-tagged scripts and SHALL NOT
reference any external CDN.

#### Scenario: CSP forbids CDN scripts
- WHEN the dashboard HTML is generated
- THEN the CSP `script-src` contains the nonce and does NOT contain `cdn.jsdelivr.net`

### Requirement: Chart.js bundled as a local resource
Chart.js SHALL be served from a bundled local WebView resource, not a remote URL.

#### Scenario: Chart.js loaded from extension bundle
- WHEN the dashboard loads the chart library
- THEN it loads `dist/chart-bundle.js` via `asWebviewUri`, not an `https://` CDN URL
```

**`specs/cache-integrity/spec.md`**

```markdown
## ADDED Requirements

### Requirement: Cache file written with restrictive permissions
The cache file SHALL be written with mode `0600` on POSIX systems.

#### Scenario: Cache written rw for owner only
- WHEN the extension writes the cache file
- THEN the file mode is `0600` (owner read/write, no group/other access)

### Requirement: Cache validated on read
The extension SHALL schema-validate the cache file on read and SHALL degrade gracefully
to "no data" when validation fails.

#### Scenario: Invalid cache yields no data
- WHEN the cache file has a wrong version, malformed JSON, or out-of-range fields
- THEN the read returns null and the extension shows "no data" without crashing
```

**`specs/path-safety/spec.md`**

```markdown
## ADDED Requirements

### Requirement: JSONL discovery confined to ~/.claude/projects
JSONL file discovery SHALL reject any path that resolves outside `~/.claude/projects/`.

#### Scenario: Traversal path is rejected
- WHEN a discovered path (e.g. via symlink) resolves outside `~/.claude/projects/`
- THEN that path is filtered out and not read
```

---

## Stage 1–3 — Apply (реализация)

Запустить скилл **`/openspec-apply-change`** для `add-security-hardening` и выполнять
задачи из `tasks.md` по порядку. Контент `tasks.md` — ниже; в каждом этапе
**каждая задача реализации сопровождается задачей-тестом**.

> **Требование тестируемости:** чистые помощники `validateCredentialsPath`,
> `validateCacheFile`, `isSafePath` **должны быть `export`нуты**, чтобы юнит-тесты могли их
> импортировать.

### `tasks.md`

```markdown
## 1. CRITICAL — credentials
- [ ] 1.1 Replace exec→execFile in readCredentialsFromKeychain() (apiClient.ts:59-69)
- [ ] 1.2 Add + EXPORT validateCredentialsPath(); call in readCredentials() (apiClient.ts:71-88)
- [ ] 1.3 Add "scope":"machine" to claudeStatus.credentials.path (package.json:165-172)
- [ ] 1.4 TEST: src/test/suite/credentials.test.ts — path accept/reject (см. Tests)
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
- [ ] 4.2 npx openspec validate add-security-hardening --strict (if CLI present)
- [ ] 4.3 Manual smoke checks (см. Manual verification)
```

### Эталонные правки кода (для задач выше)

**Задача 1.1 — `src/data/apiClient.ts` (~строка 59):**
```typescript
import { execFile } from 'child_process';
const execFileAsync = promisify(execFile);
// ...
const { stdout } = await execFileAsync(
  '/usr/bin/security',
  ['find-generic-password', '-s', MACOS_KEYCHAIN_SERVICE, '-w']
);
```

**Задача 1.2 — `src/data/apiClient.ts`, `readCredentials()`:**
```typescript
export function validateCredentialsPath(p: string): string {
  const resolved = path.resolve(p);
  const claudeDir = path.resolve(path.join(os.homedir(), '.claude'));
  if (!resolved.startsWith(claudeDir + path.sep) && resolved !== claudeDir) {
    throw new Error(`Credentials path must be inside ~/.claude/: ${resolved}`);
  }
  return resolved;
}
// в readCredentials():
const rawPath = customPath ?? path.join(os.homedir(), '.claude', '.credentials.json');
const credPath = validateCredentialsPath(rawPath);
```

**Задача 1.3 — `package.json` (`claudeStatus.credentials.path`):**
```json
"claudeStatus.credentials.path": {
  "type": ["string", "null"],
  "default": null,
  "scope": "machine",
  "description": "%config.credentials.path.desc%"
}
```

**Задача 2.2 — новый `src/webview/chart-entry.ts`:**
```typescript
import Chart from 'chart.js/auto';
(window as any).Chart = Chart;
```

**Задача 2.3 — `webpack.config.js` (массив конфигов):**
```javascript
const path = require('path');

/** @type {import('webpack').Configuration[]} */
module.exports = [
  {
    name: 'extension',
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: { path: path.resolve(__dirname, 'dist'), filename: 'extension.js', libraryTarget: 'commonjs2' },
    externals: { vscode: 'commonjs vscode' },
    resolve: { extensions: ['.ts', '.js'] },
    module: { rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }] },
    devtool: 'nosources-source-map',
  },
  {
    name: 'chart-bundle',
    target: 'web',
    mode: 'production',
    entry: './src/webview/chart-entry.ts',
    output: { path: path.resolve(__dirname, 'dist'), filename: 'chart-bundle.js' },
    resolve: { extensions: ['.ts', '.js'] },
    module: { rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }] },
    devtool: false,
  },
];
```

**Задача 2.4 / 2.6 — `src/webview/panel.ts`:** передать `context` в `DashboardPanel`,
выставить `localResourceRoots`, загрузить бандл локально:
```typescript
localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'dist'))]
// ...
const chartBundleUri = this.panel.webview.asWebviewUri(
  vscode.Uri.file(path.join(context.extensionPath, 'dist', 'chart-bundle.js'))
);
// в HTML:  <script nonce="${nonce}" src="${chartBundleUri}"></script>
```
И обновить вызов `DashboardPanel.createOrShow()` в `src/extension.ts` — передать `context`.

**Задача 2.5 — `src/webview/panel.ts` CSP (строки ~121-127):**
```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'nonce-${nonce}';
  style-src 'self' 'unsafe-inline';
  img-src data:;
  connect-src 'none';
">
```

**Задача 3.1 — `src/data/cache.ts`, `writeCache()`:**
```typescript
await fs.writeFile(getCachePath(), JSON.stringify(cache, null, 2), {
  encoding: 'utf-8',
  mode: 0o600,
});
```

**Задача 3.2 — `src/data/cache.ts`, валидация при чтении:**
```typescript
export function validateCacheFile(data: unknown): CacheFile | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.version !== 2) return null;
  if (typeof d.updatedAt !== 'string' || isNaN(new Date(d.updatedAt).getTime())) return null;
  const u = d.usageData;
  if (!u || typeof u !== 'object') return null;
  const ud = u as Record<string, unknown>;
  if (typeof ud.utilization5h !== 'number' || ud.utilization5h < 0 || ud.utilization5h > 1) return null;
  if (typeof ud.utilization7d !== 'number' || ud.utilization7d < 0 || ud.utilization7d > 1) return null;
  if (typeof ud.reset5hAt !== 'number' || ud.reset5hAt < 0) return null;
  if (typeof ud.reset7dAt !== 'number' || ud.reset7dAt < 0) return null;
  if (typeof ud.limitStatus !== 'string' ||
      !['allowed', 'allowed_warning', 'denied'].includes(ud.limitStatus)) return null;
  return d as unknown as CacheFile;
}
// readCache(): const parsed = JSON.parse(content); return validateCacheFile(parsed);
```

**Задача 3.3 — `src/data/jsonlReader.ts`:**
```typescript
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
export function isSafePath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(path.resolve(CLAUDE_PROJECTS_DIR) + path.sep);
}
// findAllJsonlFiles(): отфильтровать результат — files.filter(f => isSafePath(f))
```

---

## Tests

Все тесты — в стиле существующих (`assert`, Mocha, electron-host), компилируются
`tsc → out/` и обнаруживаются `out/test/**/*.test.js` (`.vscode-test.mjs`).

| Test файл | Кейсы | Покрывает требование |
|-----------|-------|----------------------|
| `src/test/suite/credentials.test.ts` (new) | `validateCredentialsPath` принимает `~/.claude/.credentials.json`; **бросает** для `/etc/passwd`; бросает для `~/.claude/../evil`. | credentials-security: confined path (C-1) |
| `src/test/suite/cache.test.ts` (extend) | `validateCacheFile`: валидный v2 → объект; неверный `version` → null; `utilization5h` вне `[0,1]` → null; неверный `limitStatus` → null; не-объект → null. Плюс проверка mode `0600` после `writeCache`, **обёрнутая в `if (process.platform !== 'win32')`** (на этой Windows-машине пропускается, исполняется в CI/macOS). | cache-integrity (M-1, M-2) |
| `src/test/suite/jsonlReader.test.ts` (extend) | `isSafePath`: файл под `~/.claude/projects/` → true; соседний путь снаружи → false; `../` traversal → false. | path-safety (M-3) |
| `src/test/suite/panel.test.ts` (new) | `getWebviewContent(nonce, {})`: строка CSP **не содержит** `cdn.jsdelivr.net`; `script-src` содержит `'nonce-`; в HTML нет `<script src="https://cdn.jsdelivr.net...">`. | webview-security (H-1, H-2) |
| `src/test/suite/manifest.test.ts` (new) | Читает `package.json`: `claudeStatus.credentials.path` имеет `"scope":"machine"`; `chart.js` присутствует в `dependencies`. | M-4, H-2 |

Каждый тест трассируется 1:1 на требование спецификации (колонка справа).

---

## Stage 4 — Верификация

### Автоматический гейт (тесты запускаются здесь)

```bash
npm run compile-tests   # tsc -> out/ (компилирует и новые тесты)
npm run lint            # eslint src
npm test                # vscode-test: гоняет ВСЕ out/test/**/*.test.js, включая новые
npx openspec validate add-security-hardening --strict   # если CLI установлен
```

Все четыре шага должны быть зелёными перед открытием PR.

### Manual verification (вторичные smoke-проверки)

**После Stage 1 (CRITICAL):**
- macOS: `readCredentialsFromKeychain()` всё ещё читает токен из Keychain.
- `.vscode/settings.json` с `claudeStatus.credentials.path` → `/etc/passwd` → ошибка.
- Workspace-уровень `credentials.path` игнорируется (только machine scope).

**После Stage 2 (HIGH):**
- Открыть Dashboard — графики Chart.js (prediction, hourly) рисуются из локального бандла.
- DevTools WebView: `script-src` НЕ содержит `cdn.jsdelivr.net`.
- `dist/chart-bundle.js` создаётся при `npm run package`; `<script src="vscode-webview-resource://...chart-bundle.js">`.

**После Stage 3 (MEDIUM):**
- `ls -la ~/.claude/vscode-claude-status-cache.json` → права `-rw-------` (0600).
- Подменить кэш на невалидный JSON — расширение не падает, показывает "no data".
- Симлинки в `~/.claude/projects/`, указывающие наружу, отклоняются.

---

## Stage 5 — PR + Archive

1. Открыть **Pull Request** из ветки `fix/security-hardening` в `main` (никогда не пушить в
   `main` напрямую).
2. После мержа PR — запустить скилл **`/openspec-archive-change`**: переместить
   `add-security-hardening` в `openspec/changes/archive/` и влить дельты в
   `openspec/specs/`.

---

## Сводка изменений по файлам

| Файл | Изменения | Задача |
|------|-----------|--------|
| `src/data/apiClient.ts` | `exec`→`execFile` (C-2); `export validateCredentialsPath()` (C-1) | 1.1, 1.2 |
| `src/data/cache.ts` | `mode: 0o600` (M-1); `export validateCacheFile()` (M-2) | 3.1, 3.2 |
| `src/data/jsonlReader.ts` | `export isSafePath()` фильтрация (M-3) | 3.3 |
| `src/webview/panel.ts` | CSP без CDN (H-1); локальная загрузка Chart.js (H-2); `context` + `localResourceRoots` | 2.4–2.6 |
| `src/webview/chart-entry.ts` | **Новый** — entry point бандла Chart.js | 2.2 |
| `webpack.config.js` | Двухконфигурационный: extension (node) + chart-bundle (web) | 2.3 |
| `package.json` | `scope:"machine"` (M-4); `chart.js` в dependencies | 1.3, 2.1 |
| `src/extension.ts` | Передать `context` в `DashboardPanel.createOrShow()` | 2.4 |
| `src/test/suite/credentials.test.ts` | **Новый** — тесты пути credentials | 1.4 |
| `src/test/suite/panel.test.ts` | **Новый** — тесты CSP/Chart bundle | 2.7 |
| `src/test/suite/manifest.test.ts` | **Новый** — scope + dependency | 1.5, 2.8 |
| `src/test/suite/cache.test.ts` | Расширить — `validateCacheFile` + 0600 | 3.4 |
| `src/test/suite/jsonlReader.test.ts` | Расширить — `isSafePath` | 3.5 |
| `openspec/changes/add-security-hardening/**` | **Новый** — proposal, design, specs, tasks | 0.2 |

---

## Порядок реализации

```
Branch (fix/security-hardening)
   └─ Propose (/openspec-propose → validate)
        └─ Apply (/openspec-apply-change):  Stage 1 (CRITICAL) → Stage 2 (HIGH) → Stage 3 (MEDIUM)
             └─ Verify:  compile-tests → lint → test → openspec validate → manual smoke
                  └─ PR в main
                       └─ Archive (/openspec-archive-change)
```

1. **Stage 1** независим — делается первым, тестируется сразу.
2. **Stage 2** самый объёмный (webpack, panel.ts, новый файл).
3. **Stage 3** — в любом порядке после 1–2.
4. Код не считается готовым, пока **автоматический гейт верификации не зелёный**.
