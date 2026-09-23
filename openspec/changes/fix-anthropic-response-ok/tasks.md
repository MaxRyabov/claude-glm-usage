## 1. Классы отказов

- [x] 1.1 `src/data/authBackoff.ts`: базовые классы `CredentialRejectedError`, `QuotaFormatError`, функция `backoffReasonOf(err)`, чистый запрос `PollBackoff.recordedAt(provider)`; модуль остаётся без импортов
- [x] 1.2 `src/data/apiClient.ts`: `ZaiAuthError`/`ZaiFormatError` наследуют базовые; добавить `AnthropicAuthError` (поле `status: 401 | 403`), `AnthropicFormatError`, `AnthropicTokenExpiredError`, `CredentialsUnavailableError`
- [x] 1.3 Тесты `backoffReasonOf` и `recordedAt` в наборе `Poll backoff`: все классы z.ai и Anthropic, `AnthropicTokenExpiredError` и `CredentialsUnavailableError` → `null`, обычный `Error`, не-`Error` значение

## 2. Учётные данные и классификация ответа Anthropic

- [x] 2.1 `readCredentials` возвращает токен и `expiresAt`; нет файла/токена/Keychain или путь вне `~/.claude` → `CredentialsUnavailableError`; файл не разбирается как JSON → обычный `Error`. `DataManager.fetchZaiRateLimit` без URL или токена → `CredentialsUnavailableError`. `detectProvider` Keychain при истёкшем файле не читает
- [x] 2.2 Чистая функция проверки срока (правдоподобие по A1 шаг 2, запас 60 с) и чистая функция выбора записи с бо́льшим сроком между файлом и Keychain (внедряемое чтение Keychain); вызывается только в `fetchRateLimitData`, только на darwin при пути по умолчанию
- [x] 2.3 `fetchRateLimitData`: шаги 3–6 A1 по пяти именам заголовков; тело отменяется всегда после чтения статуса и заголовков; сообщения — только код статуса
- [x] 2.4 Новый набор `Anthropic failure classification` в `anthropicRateLimit.test.ts` (существующие тесты не трогать): истёкший токен, истекает через 30 с, через 120 с, `expiresAt` строкой, в секундах (< 1e12), дальше года; 401, 403, 401 и 403 с заголовками, 500, 529, 200 без заголовков, 200 только с посторонним заголовком `anthropic-ratelimit-unified-status`, 400 и 404 без заголовков, 429 без заголовков, 429 с `denied` и `ok: false`; учётных данных нет → `CredentialsUnavailableError`; путь вне `~/.claude` → `CredentialsUnavailableError`; битый JSON → не `CredentialsUnavailableError`
- [x] 2.5 В каждом тесте позитивно проверить число вызовов заглушки `fetchImpl` (0 для пропуска запроса, 1 для остальных) и код статуса в сообщении
- [x] 2.6 Тест: сообщение 401 не содержит токена фикстуры, при этом сначала позитивно проверить, что токен ушёл в заголовок `Authorization` заглушки
- [x] 2.7 Тесты: тело отменяется и в успешном ответе, и в ветках ошибки (заглушка `body.cancel` со счётчиком); ошибка отмены не ломает результат
- [x] 2.8 Тесты выбора между файлом и Keychain: истёкший файл + свежий Keychain → Keychain; Keychain недоступен → файл; свежий файл, не darwin или путь задан пользователем → Keychain не читается (счётчик)

## 3. Решение об опросе и исходы

- [x] 3.1 Новый модуль `src/data/pollOutcome.ts`: `pollFailureOutcome` (A6), `idleDataSource` (A6), `pollDecision` с исходами `'poll' | 'skip' | 'poll-if-jsonl-recent'` и паузой `max(TTL, 300 с)` (A7), `noPollOutcome` (A7), `showsRateData`, `snapshotDataSource`, `dashboardUsage` (A8)
- [x] 3.2 `pollOutcome.test.ts`, `pollFailureOutcome`: 5 причин × {кэш свежий, кэш протух, кэша нет} × `hasCostData`; ни одна причина, кроме отсутствия учётных данных, не даёт `no-credentials`
- [x] 3.3 Тесты `idleDataSource`: `unknown`, `claude-ai`, `z-ai`, `aws-bedrock`, `api-key`, `custom-endpoint` × `hasCostData`; `no-credentials` только у `unknown`
- [x] 3.4 Тесты `pollDecision`: ручное обновление при паузе и при задержке; пауза при TTL 60 с (держится 300 с) и при TTL 900 с (держится 900 с); задержка повтора до и после 300 с, с кэшем и без; кэш протух → `'poll-if-jsonl-recent'`; кэш того же провайдера новее момента неудачи снимает паузу, задержку и пометку; более старый кэш и кэш другого провайдера — не снимают
- [x] 3.5 Тесты `noPollOutcome`: активная пауза `'credentials'` → `auth-rejected` с кэшем и без; пометка `token-expired` своего провайдера сохраняется, чужого — нет
- [x] 3.6 Тесты `showsRateData` (каждый `dataSource` × провайдеры), `snapshotDataSource` (живые данные → `stale`, остальное — без изменений), `dashboardUsage` (`showRateData` совпадает с `showsRateData`)
- [x] 3.7 `DataManager`: `shouldCallApi` через `pollDecision` (ленивый `wasJsonlUpdatedRecently`); `catch` через `pollFailureOutcome`; ветки «замок у соседа», «свежий кэш под замком» и «без опроса» через `noPollOutcome`; ветка без поддержки ограничений через `idleDataSource`; поля `pollNotice` (с провайдером), `rejectionStatus`, время повторяемой неудачи; успех снимает всё. Убрать лишние импорты `Zai*`
- [x] 3.8 `ClaudeUsageData`: `pollNotice?`, `rejectionStatus?`; `getPrediction` не передаёт утилизацию при ложном `showsRateData`; `loadFromDisk` через `snapshotDataSource`

## 4. Уведомления, статус-бар, дашборд, l10n

- [x] 4.1 `notificationDecision.ts`: `rateSignalsFor(data)` → `null` без живых данных; тест. `extension.ts` `checkAndNotify`: при `null` пропускать и `checkWindowResets`, и `decideRateLimitNotifications`
- [x] 4.2 `buildLabel`/`buildTooltip` по таблице A4; при пометке `token-expired` — строка причины; `🤖 Login expired` без цвета ошибки вместо `no-data` при `token-expired`
- [x] 4.3 `panel.ts`: хост отправляет `dashboardUsage(usage)`; скрипт использует `showRateData` для полос и графика прогноза вместо собственных условий; причины в подвале через `t(...)`
- [x] 4.4 Ключи в `l10n/bundle.l10n.{ru,ja,zh-cn}.json`: новые строки и замена ключа `no-credentials`; с настоящим переносом строки; в переводах название команды обновления — из `package.nls.<lang>.json`
- [x] 4.5 Тесты `statusBar.test.ts`: все строки таблицы A4 (401 и без статуса: есть `claude auth login`, нет `ANTHROPIC_AUTH_TOKEN`; 403: есть `403`, нет `claude auth login`; z.ai; `no-credentials` для `claude-ai`, `z-ai`, `unknown` — у `unknown` оба пути); нигде нет `claude login` без `auth`; пометка `token-expired`; `Login expired` без цвета ошибки. Каждая новая строка `l10n.t` есть ключ в `bundle.l10n.ru.json`
- [x] 4.6 Тест: английская подсказка 401 содержит `cmd.refresh` из `package.nls.json`, а её перевод в каждом бандле — `cmd.refresh` из соответствующего `package.nls.<lang>.json`
- [x] 4.7 Тест `panel.test.ts`: скрипт веб-представления не содержит собственных условий `dataSource !== 'local-only'` и читает `showRateData`

## 5. Документация

- [x] 5.1 `docs/DATA.md`, раздел об API Anthropic и «When to Call the API»: срок токена, классификация ответа, пауза `max(TTL, 300 с)`, задержка повтора
- [x] 5.2 README EN/RU/JA/ZH: `claude login` → `claude auth login` в таблице провайдеров (строка отвергнутого ключа — в релизном PR 1.2.1)
- [x] 5.3 `CHANGELOG.md`, `[Unreleased]` → `### Fixed`: запись со ссылкой на #8 и исправление команды входа
- [x] 5.4 Завести issue «показывать причину дрейфа формата» (вынесено из этого change); в описании PR отметить, что «повторяемые» теперь значит «не чаще раза в 5 минут»

## 6. Проверка

- [x] 6.1 Скан `src/**/*.ts`, `l10n/*.json`, `openspec/**/*.md` на управляющие символы (ord < 32, кроме `\n`, `\t`, `\r`)
- [x] 6.2 `rm -rf out && npm run pretest`, `npm run lint`, полный `npx vscode-test`; при блокировке установщиком VS Code — наборы через mocha с заглушкой `vscode`, и сказать об этом прямо
- [x] 6.3 Проверить, что каждый новый тест умеет падать: временно откатить соответствующую правку и убедиться в красном
- [x] 6.4 Пробный архив change на копии `openspec/` в scratchpad: слияние проходит без ошибок
- [x] 6.5 Однострочную проводку, не покрытую тестами (вызовы в `extension.ts`, `panel.ts`, `DataManager`), перечислить в описании PR как проверенную чтением, а не тестом
