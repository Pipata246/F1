# Кошелёк TON: как это устроено и как тестировать

## Важно: безопасность и «всё через бэк»

**Баланс и история живут только в PostgreSQL (Supabase).**  
Клиент (Telegram Mini App) **не может** сам увеличить баланс или подделать историю: у анонимного ключа Supabase нет прав на `users.balance` и `wallet_operations` (RLS закрыт).

Что делает фронт:

- Показывает числа **только из ответов** вашего бэкенда `POST /api/user` (`authSession`, `getWalletInfo`, `getWalletHistory`).
- Для пополнения открывает Tonkeeper и формирует транзакцию **в блокчейне** (сумма и комментарий). Это не «начисление на сайте», а обычный перевод TON.

Что делает бэкенд:

1. **Проверяет `initData`** подписью Telegram (`TELEGRAM_BOT_TOKEN`). Без валидной подписи действия пользователя не выполняются.
2. **Читает/пишет БД** только с **service role** ключом на сервере (Vercel), не в браузере.
3. **Вывод:** `requestWithdrawal` → RPC `wallet_request_withdrawal` **атомарно** уменьшает `balance` и создаёт запись в `wallet_operations`.
4. **Пополнение:** после перевода в сеть cron (`/api/wallet-cron`) находит входящую транзакцию на `TON_DEPOSIT_ADDRESS`, сопоставляет **комментарий** с `users.deposit_memo` и вызывает RPC `wallet_credit_deposit` (идемпотентно по хешу tx).

### Заявки на пополнение (`deposit_intents`)

Это **отдельная запись в БД на бэке**, а не «красивость на фронте»:

1. Пользователь нажимает пополнить и вводит сумму → `createDepositIntent` (проверка `initData`) создаёт строку со статусом `pending` и сроком `expires_at`.
2. После успешной отправки транзакции из кошелька → `submitDepositIntent` ставит `submitted` и продлевает срок ожидания зачисления (по умолчанию до ~48 ч, настраивается `DEPOSIT_INTENT_SUBMIT_TTL_MIN`).
3. **Баланс `users.balance` увеличивается только внутри** `wallet_credit_deposit`, которую вызывает **только cron** с `service_role`, когда видит реальную входящую транзакцию в сети.
4. Если пользователь не оплатил и время вышло → cron помечает заявку `expired`, **баланс не трогается**.
5. После зачисления cron связывает заявку с операцией в `wallet_operations`; в истории остаётся одна завершённая операция по кошельку (заявка `completed` с привязкой скрывается из дублирования в `getWalletHistory`).

Если TON ушли с кошелька, а баланс в БД не вырос — значит cron не отработал или не сопоставил memo/адрес: смотри лог ответа `/api/wallet-cron` (строки `deposits:`), переменные `CRON_SECRET`, `TON_DEPOSIT_ADDRESS`, `TONAPI_KEY` и **расписание cron** (раз в сутки может быть слишком редко для тестов).

Итог: «нарисовать» баланс в интерфейсе можно только локально у себя в браузере; **истинное значение** всегда определяется сервером при следующем запросе.

---

## SQL

Файл `**db/supabase_wallet_install.sql`** рассчитан на то, что `**users.balance` уже есть**. Он добавляет:

- `deposit_memo`;
- таблицу `wallet_operations` + RLS «всё запрещено для public»;
- функции `wallet_request_withdrawal`, `wallet_credit_deposit`, `wallet_complete_withdrawal`, `wallet_fail_withdrawal`;
- при необходимости — `set_updated_at()` для триггера;
- таблицу `deposit_intents` (заявки на пополнение).

Если кошелёк уже ставился раньше без `deposit_intents`, выполните отдельно **`db/supabase_deposit_intents.sql`**.

Выполните файл целиком в **Supabase → SQL Editor**.

---

## Переменные окружения

См. `**.env.example`** в корне репозитория — скопируйте блоки в Vercel (или свой хостинг).

Минимум для кошелька:


| Переменная                                  | Зачем                                           |
| ------------------------------------------- | ----------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                        | Проверка `initData`                             |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | БД (только на сервере)                          |
| `WEBAPP_URL`                                | URL приложения (manifest / fallback)            |
| `TELEGRAM_MINIAPP_URL`                      | `https://t.me/...` — возврат из Tonkeeper в TMA |
| `TON_DEPOSIT_ADDRESS`                       | Адрес приёма депозитов (mainnet)                |
| `CRON_SECRET`                               | Защита вызова `/api/wallet-cron`                |
| `TON_HOT_WALLET_MNEMONIC`                   | Отправка выводов (cron)                         |
| `TONAPI_KEY`                                | Рекомендуется для TonAPI                        |


Mainnet: **не задавайте** `TON_TESTNET` (или не ставьте в `1`).

---

## Как тестировать (пошагово)

1. Выполнить `**db/supabase_wallet_install.sql`** без ошибок.
2. Залить проект на Vercel, заполнить env из `**.env.example`**.
3. Убедиться, что в **Vercel → Cron** настроен вызов `/api/wallet-cron` с заголовком `**Authorization: Bearer <CRON_SECRET>`** (как требует ваш `wallet-cron.js`).
  Для быстрых тестов депозита можно временно сделать расписание чаще или дергать endpoint вручную (с секретом).
4. Открыть мини-приложение **из Telegram**, пройти регистрацию.
5. **Профиль / Баланс:** цифра должна совпадать с `users.balance` в Supabase Table Editor.
6. **Пополнение:** вкладка «Баланс» → Пополнить → отправить небольшую сумму с **правильным комментарием** (memo с сервера). Подождать срабатывания cron → баланс в БД и в UI вырастет.
7. **Вывод:** указать свой TON-адрес и сумму → в БД сразу уменьшится `balance`, появится строка в `wallet_operations` → cron отправит TON с горячего кошелька.
8. **История:** кнопка в UI запрашивает `getWalletHistory` — список строится из `wallet_operations` на бэке.

---

## Если что-то не сходится

- **Manifest TonConnect 500:** проверьте `WEBAPP_URL` и что `GET /api/tonconnect-manifest` открывается по HTTPS.
- **Депозит не зачисляется:** memo в транзакции не совпал с `deposit_memo` пользователя; мало `TONAPI_KEY` / лимиты TonAPI; cron не запускался или неверный `CRON_SECRET`.
- **Вывод не уходит:** мнемоника / версия кошелька; сеть mainnet/testnet; логи функции `wallet-cron` в Vercel.

Файлы кода для ориентира: `api/user.js` (сессия, вывод, история), `api/wallet-cron.js` (депозиты и отправка выводов), `api/tonconnect-manifest.js`.