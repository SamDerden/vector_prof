# Личный кабинет: frontend

Статус: фронтенд готов и работает против контракта из `backend/docs/ACCOUNT_AUTH_API.md`.
Бэкенд-эндпоинтов `/api/auth/*` и `/api/account` в этой ветке ещё нет, поэтому всё, что
описано как «сервер», проверено только на контракте и на временном mock-сервере, который
удалён из рабочего дерева.

## 1. Маршруты и точки входа

| Что | Где |
|---|---|
| Личный кабинет, вход, регистрация, коды, сброс пароля | `/account` (`app/account/page.tsx`) |
| Кнопка «Личный кабинет» в шапке главной | `app/page.tsx`, `.account-entry` в `app/globals.css` |

Страница помечена `robots: noindex, nofollow` и не участвует в навигации диагностики.
Аккаунт не обязателен: анонимный сценарий на главной не изменён.

## 2. Файлы

```
lib/auth-api.ts          клиент API: cookies, CSRF, ошибки, тайпинги контракта
lib/account-view.ts      нормализация /api/account и форматирование (устойчиво к неполным полям)
lib/session-store.ts     + adoptOwnSessionId(): «продолжить сессию в этом браузере»
app/account/page.tsx     серверная обёртка с metadata
app/account/AccountExperience.tsx  оркестратор экранов (login/register/forgot/verify/reset/cabinet)
app/account/AuthProvider.tsx       /api/auth/me, состояние входа
app/account/AuthForms.tsx          формы входа, регистрации, forgot+reset, экран кода
app/account/AccountCabinet.tsx     кабинет: сессии, привязка, выход, удаление
app/account/account.css            стили, адаптив до 320px
tests/account-cabinet.test.mjs     контрактные тесты (13 шт.), добавлены в frontend-ci
```

## 3. Правила, которые соблюдает фронт

1. `vector_auth_session` никогда не читается из JavaScript — только HttpOnly-cookie.
   Все запросы идут same-origin через существующий прокси `/api/:path*`.
2. Для `POST /api/auth/logout`, `POST /api/auth/link-session`, `DELETE /api/account`
   значение cookie `vector_csrf` отправляется в заголовке `X-CSRF-Token`.
   Для анонимных `register/login/verify/resend/forgot/reset` CSRF не отправляется.
3. `X-Session-ID` — только локатор. `link-session` передаёт его заголовком, тело пустое.
   Владение доказывает proof-cookie, поэтому в UI явно написано, что привязать можно только
   сессию из этого браузера, и разобраны ответы `403` (нет proof) и `409` (демо/чужой владелец).
4. `userId` из клиента нигде не отправляется и не используется как доказательство прав.
5. Ошибки бэкенда маппятся в стабильные русские сообщения: сырые английские коды
   (`registration_not_configured`, `csrf_token_invalid`, …) в интерфейс не попадают.
6. `503 registration_not_configured` и `503` удаления аккаунта — штатные состояния
   «функция выключена решением Product Owner», а не ошибка формы.

## 4. Экраны

- **Вход**: email + пароль, показ/скрытие пароля, ссылки на регистрацию и восстановление.
- **Регистрация**: email + пароль 12–128 символов с валидацией inline. Ответ сервера
  нейтрален («запрос принят»), форма не утверждает, что аккаунт создан. После успешного
  ответа доступна кнопка «Ввести код подтверждения».
- **Подтверждение контакта**: код 4–8 цифр, повторная отправка с 60-секундным cooldown
  (учитывается `details.retryAfterMs` / `Retry-After`), понятные состояния
  «код истёк», «слишком много попыток».
- **Забыл пароль**: запрос кода → ввод кода и нового пароля. Сообщение одинаково для
  существующего и несуществующего адреса.
- **Кабинет**: профиль (email, статус, класс, муниципалитет), список своих сессий
  (до 50), прогресс по трём этапам, детали сессии, «продолжить в этом браузере»,
  привязка локальной анонимной сессии или сессии по UUID, выход, удаление аккаунта
  с повторным паролем и объяснением fail-closed поведения.

## 5. Обратная совместимость и деградация

- `/api/account` нормализуется терпимо: поддержаны `sessionId`/`session_id`/`id`,
  `schoolGrade`/`school_grade`/`grade`, `progress.*` или плоские флаги. Неизвестное поле
  не роняет экран, отсутствующее — не выдумывается.
- `401/410` при загрузке кабинета или действии переводит на экран входа с пояснением,
  а не показывает пустой кабинет.
- Пока бэкенд не задеплоен, `/api/*` отвечает 500 (прокси без апстрима): экран входа
  остаётся работоспособным и показывает корректное сообщение об ошибке сети/сервера.

## 6. Проверки

```
npx tsc --noEmit                 # чисто
npm run build                    # чисто, /account 12.2 kB
node --experimental-strip-types --import ./tests/register-relative-ts.mjs \
  --test tests/account-cabinet.test.mjs                       # 13/13
node --experimental-strip-types --import ./tests/register-relative-ts.mjs \
  --test tests/demo-session-isolation.test.mjs tests/demo-backend.test.mjs   # 13/13
node --test tests/frontend-contract.test.mjs                  # ok
```

Визуальный smoke: `tests/responsive-smoke.mjs` теперь проверяет и `/account`
(10 ширин от 320 до 2560, горизонтальный скролл, наличие полей формы).
В песочнице браузер не скачивается, поэтому прогон responsive-теста остаётся за CI.

## 7. Что нужно от бэкенда, чтобы включить вживую

1. Смержить реализацию `ACCOUNT_AUTH_API.md` (миграция `012_account_auth.sql`,
   `backend/lib/auth/*`, `backend/app/api/auth/*`, `backend/app/api/account/route.ts`).
2. Настроить `AUTH_DELIVERY_URL`, `AUTH_DELIVERY_TOKEN`, `SESSION_PROOF_SECRET`,
   `AUTH_CHALLENGE_SECRET` и `AUTH_IDENTIFIER_MODE=email`.
3. Включить флаги после решений PO: `AUTH_REGISTRATION_ENABLED`,
   `AUTH_DATA_RETENTION_POLICY_APPROVED`, `AUTH_MINOR_DATA_POLICY_APPROVED`,
   `AUTH_ACCOUNT_DELETION_ENABLED`.
4. Подтвердить на стенде точную форму ответа `GET /api/account`: фронт ожидает
   `user`, `sessions[]`, `profile`, `limits`, но устойчив к переименованиям.

Пока флаги выключены, регистрация честно показывает «регистрация пока недоступна»,
а вход и привязка сессий работают для уже существующих аккаунтов.
