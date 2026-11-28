# Инвентарь backend API

Дата сверки: 28.11.2026. Источник — `origin/main` `992bdf741ab431764f00e60a06b120e26cc718bb`.

Это список маршрутов, у которых в этом коммите есть handler. Поле или HTTP-метод, которого нет в handler, здесь не указан как существующий. Исторические документы не заменяют этот список: [backend/docs/API.md](../backend/docs/API.md), [backend/docs/FRONTEND_API_ADDITIONS.md](../backend/docs/FRONTEND_API_ADDITIONS.md), [docs/release-2026-11-26/API.md](release-2026-11-26/API.md).

Публичный URL для браузера — тот же путь `/api/...`. Frontend Next.js проксирует его rewrite-правилом `source: /api/:path*` → `${BACKEND_INTERNAL_URL}/api/:path*` (`next.config.ts`, по умолчанию `http://localhost:3000`). Отдельного API-пути rewrite не добавляет. В `backend/next.config.ts` своих rewrite нет. Других `route.ts` / `route.js` вне `backend/app/api` нет.

Проверка списка: `node scripts/check-api-route-inventory.mjs`. Скрипт сверяет экспорты `GET`/`POST`/`PUT`/`PATCH`/`DELETE` в `backend/app/api/**/route.ts` с таблицей раздела «Маршруты main».

## Общие правила сессии

Заголовок `X-Session-ID` — UUID. Тело `sessionId` у маршрутов, которые читают заголовок, не используется как идентификатор сессии.

- Нет заголовка: `401`, `X-Session-ID header is required`.
- Не UUID: `400`, `X-Session-ID must be a valid UUID`.
- Сессии нет: `404`, `Session not found`. У `POST /api/track/select` неизвестный UUID создаёт сессию.
- Истёк срок (`expires_at`): `410`, `Session expired. Start a new session.`
- Cookie proof включается при `NODE_ENV=production` или `SESSION_PROOF_ENFORCED=true`. Имя cookie: `vector_session_proof_<uuid без дефисов>`, HttpOnly. Чужой или пустой proof: `403`, `Session ownership verification required`. Секрет `SESSION_PROOF_SECRET` короче 32 байт при включённом proof: `503`, `Session ownership is not configured`. Вне этих флагов proof не требуется.
- JSON-ошибка: `{ "error": "...", "details": ... }`. `details` есть не у всех ошибок.
- Zod: `422`, `Validation failed`. Не-JSON тело у JSON-маршрутов: `400`.
- Лимит чтения/записи на сессию: `429`, `Too many requests. Retry later.`, `details.code = rate_limited`, `details.retryAfterMs`.
- Необработанное исключение: `500`, `Internal server error`.
- Устаревшая схема PostgreSQL на маршрутах, которые это ловят: `503`, `Database schema is outdated. Run npm run db:migrate`.

Аккаунт — отдельные cookie, не `X-Session-ID`:

- `vector_auth_session` — HttpOnly, `SameSite=strict`, 7 суток.
- `vector_csrf` — не HttpOnly. На изменяющих запросах заголовок `x-csrf-token` должен совпасть и с cookie, и с записью сессии. Иначе `403`, `csrf_token_invalid`.
- Нет или просрочена сессия аккаунта: `401`, `not_authenticated`. `GET /api/auth/me` в этом случае отвечает `200` и `{ "authenticated": false, "user": null }`.

`Content-Type` запросов с телом: `application/json`. Исключение — `GET /api/route/export/pdf`: ответ `application/pdf`.

## Маршруты main

35 пар метод+путь. Успешный статус — в колонке STATUS. Ошибки — в разделах ниже.

| METHOD | PATH | AUTH | REQUEST | RESPONSE | STATUS | SOURCE FILE | FRONTEND USAGE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/health` | нет | — | `status`, `database`, `service`, `aiConfigured`, `revision`, `sessionOwnership`, `generationWorker`, `readiness` | 200 | `backend/app/api/health/route.ts` | `scripts/check-backend.mjs`, `e2e/journey.spec.ts` |
| POST | `/api/track/select` | `X-Session-ID`; proof при флаге | JSON: `trackType` обязателен | `sessionId`, `trackType`, `status` | 200 | `backend/app/api/track/select/route.ts` | `lib/demo-backend.ts` |
| GET | `/api/session` | `X-Session-ID`; proof при флаге | — | снимок сессии; `activeJob` только если задача генерации ещё идёт | 200 | `backend/app/api/session/route.ts` | `lib/demo-backend.ts`, `e2e/journey.spec.ts` |
| GET | `/api/diagnostic/questions` | нет | query `grade` необязателен, целое 1–11 | без grade: `{ data, count }`; с grade: `{ grade, questionnaire }` | 200 | `backend/app/api/diagnostic/questions/route.ts` | `app/page.tsx` |
| POST | `/api/diagnostic/submit` | `X-Session-ID`; proof при флаге | JSON: `answers` обязателен | `diagnosticId`, `savedAnswers`, `clarificationId`, `savedClarificationAnswers`, `status: submitted` | 201 | `backend/app/api/diagnostic/submit/route.ts` | `lib/demo-backend.ts` |
| GET | `/api/diagnostic/latest` | `X-Session-ID`; proof при флаге | — | `diagnosticId`, `submittedAt`, `answers`, `clarification` | 200 | `backend/app/api/diagnostic/latest/route.ts` | вызова из `app/` и `lib/` нет; есть `backend/app/page.tsx` и скрипты |
| GET | `/api/clarification/questions` | нет | query `grade` необязателен, целое 1–11 | `{ data, count }` | 200 | `backend/app/api/clarification/questions/route.ts` | `lib/demo-backend.ts` |
| POST | `/api/clarification/submit` | `X-Session-ID`; proof при флаге | JSON: `answers` обязателен, 1–6 | `clarificationId`, `savedAnswers`, `status: submitted` | 201 | `backend/app/api/clarification/submit/route.ts` | `lib/demo-backend.ts` |
| POST | `/api/recommendations/generate` | `X-Session-ID`; proof при флаге | JSON `{}` или `clarificationAnswers`; заголовок `Idempotency-Key` — UUID, необязателен | сохранённый результат или задача в работе | 201 или 202 | `backend/app/api/recommendations/generate/route.ts` | `lib/demo-backend.ts`, `e2e/journey.spec.ts` |
| GET | `/api/recommendations/jobs/:requestId` | `X-Session-ID`; proof при флаге | path `requestId` — UUID | задача, ошибка пайплайна или сохранённая рекомендация | 200, 202 или 502 | `backend/app/api/recommendations/jobs/[requestId]/route.ts` | `lib/demo-backend.ts` |
| GET | `/api/recommendations` | `X-Session-ID`; proof при флаге | — | последняя рекомендация, `status: saved` | 200 | `backend/app/api/recommendations/route.ts` | вызова из `app/` и `lib/` нет |
| GET | `/api/professions` | нет | — | `{ data, count, source }`; `id` — UUID из PostgreSQL, если строка найдена | 200 | `backend/app/api/professions/route.ts` | вызова из `app/` и `lib/` нет; `e2e/account.spec.ts` |
| GET | `/api/professions/:id` | нет | path: `prof_###` или UUID | `{ data }` | 200 | `backend/app/api/professions/[id]/route.ts` | вызова из `app/` и `lib/` нет |
| GET | `/api/trials` | нет | query `region` (по умолчанию Екатеринбург), `limit` 1–100 (по умолчанию 20) | `{ data, count }`; при недоступной БД — срез freeze и `source` | 200 | `backend/app/api/trials/route.ts` | вызова из `app/` и `lib/` нет |
| GET | `/api/education-route` | `X-Session-ID`; proof при флаге | query `professionKey` обязателен | маршрут | 200 | `backend/app/api/education-route/route.ts` | `lib/education-route.ts`, `lib/route-actions.ts` |
| PUT | `/api/education-route` | `X-Session-ID`; proof при флаге | JSON: `professionKey`, `completed`, `saved`, `version` | маршрут | 201 или 200 | `backend/app/api/education-route/route.ts` | `lib/education-route.ts` |
| GET | `/api/reflection` | `X-Session-ID`; proof при флаге | — | `{ data, count }` | 200 | `backend/app/api/reflection/route.ts` | вызова из `app/` и `lib/` нет |
| POST | `/api/reflection` | `X-Session-ID`; proof при флаге | JSON: `rating` обязателен | `id`, `created_at`, `status: saved`; при шаге ещё `journeyStep`, `stage`, `ageTier` | 201 | `backend/app/api/reflection/route.ts` | `app/PrimaryExperience.tsx` |
| GET | `/api/demo/students` | нет | — | `{ data, count }`, `Cache-Control: no-store` | 200 | `backend/app/api/demo/students/route.ts` | `lib/demo-backend.ts` |
| POST | `/api/auth/register` | нет | JSON: `email`, `password` | `{ status: accepted }` | 202 | `backend/app/api/auth/register/route.ts` | `lib/auth-api.ts` `register` |
| POST | `/api/auth/verify` | нет | JSON: `email`, `code` | `{ status: verified }` | 200 | `backend/app/api/auth/verify/route.ts` | `lib/auth-api.ts` `verify` |
| POST | `/api/auth/verification/resend` | нет | JSON: `email` | `{ status: accepted }` | 202 | `backend/app/api/auth/verification/resend/route.ts` | `lib/auth-api.ts` |
| POST | `/api/auth/login` | нет | JSON: `email`, `password` | `{ user }` и cookie аккаунта | 200 | `backend/app/api/auth/login/route.ts` | `lib/auth-api.ts` `login` |
| POST | `/api/auth/logout` | cookie аккаунта + CSRF | JSON `{}` | `{ status: ok }`, cookie очищаются | 200 | `backend/app/api/auth/logout/route.ts` | `lib/auth-api.ts`, `e2e/account.spec.ts` |
| GET | `/api/auth/me` | cookie аккаунта, если есть | — | `{ authenticated, user }` | 200 | `backend/app/api/auth/me/route.ts` | `lib/auth-api.ts` `fetchMe` |
| POST | `/api/auth/password/forgot` | нет | JSON: `email` | `{ status: accepted }` | 202 | `backend/app/api/auth/password/forgot/route.ts` | `lib/auth-api.ts` |
| POST | `/api/auth/password/reset` | нет | JSON: `email`, `code`, `password` | `{ status: reset }` | 200 | `backend/app/api/auth/password/reset/route.ts` | `lib/auth-api.ts` |
| POST | `/api/auth/link-session` | cookie аккаунта + CSRF + proof анонимной сессии | заголовок `X-Session-ID` | `{ status: linked, session }` | 200 | `backend/app/api/auth/link-session/route.ts` | `lib/auth-api.ts` `linkSession` |
| GET | `/api/account` | cookie аккаунта | — | `user`, `sessions`, `profile`, `limits` | 200 | `backend/app/api/account/route.ts` | `lib/auth-api.ts` `fetchAccount` |
| DELETE | `/api/account` | cookie аккаунта + CSRF | JSON: `password` | `{ status: deleted }` | 200 | `backend/app/api/account/route.ts` | `lib/auth-api.ts` `deleteAccount` |
| POST | `/api/feedback` | `X-Session-ID`; proof при флаге | JSON: четыре оценки, `request_id` | `{ status: saved, replayed }` | 201 или 200 | `backend/app/api/feedback/route.ts` | `app/RouteActions.tsx` |
| GET | `/api/profession-assistant/conversations` | cookie аккаунта | query `conversation_id` необязателен | `{ data }` | 200 | `backend/app/api/profession-assistant/conversations/route.ts` | вызова из `app/` и `lib/` нет |
| DELETE | `/api/profession-assistant/conversations` | cookie аккаунта + CSRF | query `conversation_id` обязателен | пустое тело | 204 | `backend/app/api/profession-assistant/conversations/route.ts` | вызова из `app/` и `lib/` нет |
| POST | `/api/profession-assistant/message` | cookie аккаунта + CSRF | JSON: `profession_id`, `session_id`, `request_id`, `question` | `conversation_id`, `status`, `answer`, `sources`, `source_type` | 200 | `backend/app/api/profession-assistant/message/route.ts` | вызова из `app/` и `lib/` нет |
| GET | `/api/route/export/pdf` | cookie аккаунта | query `route_id` обязателен, `version` необязателен | байты PDF | 200 | `backend/app/api/route/export/pdf/route.ts` | `app/RouteActions.tsx` |

## Флаги, PostgreSQL и AI

«Proof» — cookie `vector_session_proof_*`, только если включён session proof. «AI» — вызов шлюза в этом handler. Каталог freeze читается с диска и сам по себе шлюз не вызывает.

| PATH | X-Session-ID | Proof | CSRF | PostgreSQL | Feature flag | AI gateway |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /api/health` | нет | нет | нет | да, `SELECT 1` | нет | нет; `aiConfigured` только проверяет переменные |
| `POST /api/track/select` | да | при создании, если флаг | нет | да | session proof; бюджеты сессий | нет |
| `GET /api/session` | да | да, если флаг | нет | да | нет | нет |
| `GET /api/diagnostic/questions` | нет | нет | нет | нет | нет | нет |
| `POST /api/diagnostic/submit` | да | да, если флаг | нет | да | нет | нет |
| `GET /api/diagnostic/latest` | да | да, если флаг | нет | да | нет | нет |
| `GET /api/clarification/questions` | нет | нет | нет | нет | нет | нет |
| `POST /api/clarification/submit` | да | да, если флаг | нет | да | нет | нет |
| `POST /api/recommendations/generate` | да | да, если флаг | нет | да | `GENERATION_WORKER_ENABLED=true` ставит задачу и отвечает 202 | да, если воркер выключен и пайплайн дошёл до модели |
| `GET /api/recommendations/jobs/:requestId` | да | да, если флаг | нет | да | нет | нет, только чтение |
| `GET /api/recommendations` | да | да, если флаг | нет | да | нет | нет |
| `GET /api/professions` | нет | нет | нет | да, необязательно: ошибка БД не скрывает freeze | нет | нет |
| `GET /api/professions/:id` | нет | нет | нет | да для UUID и для подстановки `id`; карточка freeze живёт и без БД | нет | нет |
| `GET /api/trials` | нет | нет | нет | да; при ошибке — freeze | нет | нет |
| `GET /api/education-route` | да | да, если флаг | нет | да | нет | нет |
| `PUT /api/education-route` | да | да, если флаг | нет | да | нет | нет |
| `GET /api/reflection` | да | да, если флаг | нет | да | нет | нет |
| `POST /api/reflection` | да | да, если флаг | нет | да | шаг маршрута требует миграцию 011, иначе 503 | нет |
| `GET /api/demo/students` | нет | нет | нет | нет | нет | нет |
| `POST /api/auth/register` | нет | нет | нет | да | доставка почты; иначе 503 `registration_not_configured` | нет |
| `POST /api/auth/verify` | нет | нет | нет | да | нет | нет |
| `POST /api/auth/verification/resend` | нет | нет | нет | да | нет | нет |
| `POST /api/auth/login` | нет | нет | нет | да | нет | нет |
| `POST /api/auth/logout` | нет | нет | да | да | нет | нет |
| `GET /api/auth/me` | нет | нет | нет | да, если cookie есть | нет | нет |
| `POST /api/auth/password/forgot` | нет | нет | нет | да | нет | нет |
| `POST /api/auth/password/reset` | нет | нет | нет | да | нет | нет |
| `POST /api/auth/link-session` | да | да, владение анонимной сессией | да | да | нет | нет |
| `GET /api/account` | нет | нет | нет | да | нет | нет |
| `DELETE /api/account` | нет | нет | да | да | `AUTH_ACCOUNT_DELETION_ENABLED=true`, иначе 503 `deletion_disabled` | нет |
| `POST /api/feedback` | да | да, если флаг | нет | да | нет | нет |
| `GET /api/profession-assistant/conversations` | нет | нет | нет | да | нет | нет |
| `DELETE /api/profession-assistant/conversations` | нет | нет | да | да | нет | нет |
| `POST /api/profession-assistant/message` | нет; `session_id` в теле должен принадлежать аккаунту | нет | да | да | `ASSISTANT_ENABLED=true`, иначе 503 `assistant_not_enabled`; нужны `ASSISTANT_DAILY_LIMIT` и `ASSISTANT_RETENTION_DAYS` | да, только если вопрос классифицирован как `relevant` и не про актуальные зарплаты/вакансии |
| `GET /api/route/export/pdf` | нет | нет | нет | да; маршрут должен принадлежать аккаунту | нет | нет |

## Сложные контракты

### Регистрация, подтверждение, пароль, сессия аккаунта

Пароль: строка 12–128 символов. Email приводится к нижнему регистру. Код в JSON ответа не возвращается.

```json
{ "email": "student@example.com", "password": "long-enough-password" }
```

`POST /api/auth/register` → `202` `{ "status": "accepted" }`. Ошибки: `400 validation`, `429 rate_limited` (`details.retryAfterMs` 3600000, 5 запросов в час на email), `503 registration_not_configured`, если почтовый транспорт не готов.

`POST /api/auth/verify`:

```json
{ "email": "student@example.com", "code": "123456" }
```

`200` `{ "status": "verified" }`. Ошибки: `400 invalid_code`, `400 code_expired`, `429 too_many_attempts` (5 попыток).

`POST /api/auth/verification/resend`: `{ "email" }` → `202` `{ "status": "accepted" }` и для неизвестного адреса. Чаще одного раза в 60 секунд: `429`.

`POST /api/auth/login` тем же телом, что регистрация. `200`:

```json
{
  "user": {
    "id": "uuid",
    "email": "student@example.com",
    "phone": null,
    "status": "active",
    "verifiedAt": "2026-11-28T12:00:00.000Z",
    "createdAt": "2026-11-28T12:00:00.000Z"
  }
}
```

Плюс cookie `vector_auth_session` и `vector_csrf`. Неверный пароль, неподтверждённый аккаунт и неизвестный email: `401 invalid_credentials`. Лимит: 5 попыток за 900 секунд, `429`.

`POST /api/auth/logout` требует CSRF. `200` `{ "status": "ok" }`.

`GET /api/auth/me`: `200` `{ "authenticated": true, "user": { ... } }` или `{ "authenticated": false, "user": null }`.

`POST /api/auth/password/forgot`: `{ "email" }` → `202` `{ "status": "accepted" }` и если аккаунта нет. `400 validation`, `429` (5 в час).

`POST /api/auth/password/reset`:

```json
{ "email": "student@example.com", "code": "123456", "password": "another-long-password" }
```

`200` `{ "status": "reset" }`. Те же коды ошибок, что у verify, плюс `400 validation` для короткого пароля.

`GET /api/account` → `200`:

```json
{
  "user": { "id": "uuid", "email": "student@example.com", "phone": null, "status": "active", "verifiedAt": null, "createdAt": null },
  "sessions": [],
  "profile": null,
  "limits": { "maxSessions": 50 }
}
```

У элемента `sessions`: `sessionId`, `trackType`, `schoolGrade`, `municipality`, `sessionMode`, `createdAt`, `updatedAt`, `expiresAt`, `hasDiagnostic`, `hasRecommendation`, `hasRoute`.

`DELETE /api/account`: `{ "password" }`, CSRF, флаг удаления. `200` `{ "status": "deleted" }`. `401 invalid_credentials`, `403 csrf_token_invalid`, `503 deletion_disabled`.

`POST /api/auth/link-session`: CSRF и `X-Session-ID`. Proof cookie должен доказывать, что анонимная сессия создана в этом браузере. `200` `{ "status": "linked", "session": { ... } }`. `403` с русским текстом, если proof не подходит. `404 validation`, если сессии навигатора нет. `409` с русским текстом, если сессия демо или уже у другого аккаунта.

На main нет `POST /api/auth/login/code` и `POST /api/auth/login/code/verify`.

### Трек, диагностика, уточнения, рефлексия

`POST /api/track/select`:

```json
{ "trackType": "interests", "schoolGrade": 7, "confidenceBefore": "medium" }
```

`trackType`: `explore`, `interests`, `known_direction`. `schoolGrade` — целое 1–11, необязателен. `confidenceBefore`: `low`, `medium`, `high`, необязателен. `demoStudentId` — целое 1–15, необязателен; тогда сессия демо. `200`: `{ "sessionId", "trackType", "status": "selected" }`. Неверный JSON — `400`. Неверная схема — `422`.

`GET /api/diagnostic/questions?grade=7` отдаёт анкету как в `bilet_questions_master.json`. У вопроса поле `id`, не `question_id`. Без `grade` — список `{ questionnaire_name, note, questionCount }`. Плохой `grade`: `400`. Нет анкеты: `404`.

`POST /api/diagnostic/submit`:

```json
{
  "answers": [
    { "questionId": "bilet_q1_subjects", "answer": ["Математика", "Информатика"] }
  ]
}
```

`answers`: 1–100, уникальные `questionId`. `answer` — непустая строка до 1000 символов, конечное число, boolean или массив строк. Необязательный `clarificationAnswers` (1–6) можно передать здесь. Сессии нет: `404` `Session not found. Select a track first.`

`GET /api/clarification/questions?grade=4` для 1–4 класса берёт младший набор. Без `grade` и для 5–11 — основной набор из 6 вопросов. У вопроса `question_id`.

`POST /api/clarification/submit`: `{ "answers": [ { "questionId", "answer" } ] }`. Нет диагностики: `409`. Чужой вопрос или значение: `422`.

`POST /api/reflection`:

```json
{ "rating": "useful", "comment": "Хочу попробовать", "recommendationId": "uuid", "journeyStep": 4 }
```

`rating`: `useful`, `unsure`, `not_useful`. `comment` до 1000 символов. `recommendationId` необязателен и должен принадлежать сессии, иначе `404`. `journeyStep` — целое 1–4. `stage` может быть только `final` (это шаг 4). `stage: final` вместе с шагом меньше 4: `422`. `201`: `{ "id", "created_at", "status": "saved" }`.

### Генерация

Необязательный заголовок `Idempotency-Key` должен быть UUID, иначе `400`. Пустое тело допустимо. Необязательное тело:

```json
{
  "clarificationAnswers": [
    { "questionId": "agent_q5_format", "answer": "offline" }
  ]
}
```

Порядок в коде: сессия существует; есть диагностика, иначе `409`; если уточнения переданы, они проверяются; в профиле есть числовой `schoolGrade`, иначе `409` `School grade is required before Sofi recommendations`.

`202`, пока задача не сохранила результат:

```json
{
  "requestId": "uuid",
  "jobStatus": "pending",
  "status": "in_progress",
  "retryAfterMs": 2000
}
```

`jobStatus` здесь `pending` или `running`. При `GENERATION_WORKER_ENABLED=true` новый запуск остаётся в очереди и тоже отвечает `202`.

`201` — результат сохранён или повторно прочитан. Поля включают `recommendationId`, `sessionId`, `summary`, `hypotheses`, `trials`, `nextStep`, `nextStepOptions`, `model`, `createdAt`, `status: generated`. У новой записи Софи ещё `interestTags`, `warnings`, `disclaimer`, `generation`. Повтор по тому же ключу добавляет `requestId`, `jobStatus: completed`, `replayed: true`.

`GET /api/recommendations/jobs/:requestId`: `202` с тем же видом `in_progress`, если задача ещё идёт; `200` с сохранённой рекомендацией и `jobStatus: completed`; `502` `AI service request failed` и `details.errorCode`, если задача упала. Не UUID и чужая задача: `404` `Generation job not found`.

`GET /api/recommendations`: `200`, `status: saved`. Нет записи: `404`.

Бюджет PostgreSQL на генерацию: 120 запросов в минуту глобально и 5 в минуту на сессию. Повтор уже идущей или сохранённой задачи бюджет не списывает. `429` на этом маршруте ставит заголовок `Retry-After: 60`.

### Каталог и маршрут

`GET /api/professions` читает freeze. Элемент `data`: `profession_id`, `external_id`, `id` (UUID или `null`), `name`, `title`, `description`, `industry_name`, `riasec`, `demand_level_region`, `salary_median_region`, `vacancies_count`, `program_count`, `trial_count`. Плюс `count` и `source`.

`GET /api/professions/prof_001` для id из freeze отдаёт карточку: `skills`, `education_programs`, `trials`, `vacancy_history`. Если id нет ни в freeze, ни в PostgreSQL: `404` `{ "error": "Profession not found" }`. Ошибка чтения UUID-карточки: `500`.

`GET /api/trials?region=Екатеринбург&limit=20`. Пустой или нецелый `limit`: `400`. При ошибке SQL ответ строится из freeze и добавляет `source`; регион в этом запасном ответе не фильтруется.

`GET /api/education-route?professionKey=prof_001`. `professionKey`: `none`, UUID или `prof_` и 3–4 цифры. Нет строки: `404` `Education route not found`.

`PUT /api/education-route`:

```json
{
  "professionKey": "prof_001",
  "completed": [0, 1],
  "saved": ["trial_001"],
  "version": 1
}
```

`completed` — целые 0–4, без повторов, не больше 5. `saved` — до 40 id вида `prog_###`, `trial_###`, UUID или `program:` плюс такой id. `version: null` создаёт маршрут и отвечает `201`. Совпадающая версия обновляет и отвечает `200`, версия в ответе на 1 больше. Чужая версия: `409` `Education route version conflict`, в `details.route` текущая запись. Ответ:

```json
{
  "route_id": "uuid",
  "professionKey": "prof_001",
  "completed": [0, 1],
  "saved": ["trial_001"],
  "version": 2,
  "updatedAt": "2026-11-28T12:00:00.000Z"
}
```

`route_id` есть, когда строка прочитана из PostgreSQL.

### Отзыв, PDF, мастерская

`POST /api/feedback`:

```json
{
  "request_id": "uuid",
  "route_id": null,
  "clarity": 4,
  "recommendations": 5,
  "navigation": 4,
  "usefulness": 5,
  "comment": ""
}
```

Четыре оценки — целые 1–5. `comment` до 2000 символов, по умолчанию пустая строка. `route_id` должен принадлежать этой сессии, иначе `404 route_not_found`. Первая запись: `201` `{ "status": "saved", "replayed": false }`. Повтор того же `request_id`: `200`, `replayed: true`, новая строка не пишется. Лимит: 10 запросов в час на сессию.

`GET /api/route/export/pdf?route_id=<uuid>&version=2`. Аккаунт должен владеть сессией маршрута. `version` необязателен; если передан, это положительное целое и оно должно совпасть с текущей версией, иначе `409 route_version_conflict`. Нет маршрута: `404 route_not_found`. Плохой id: `400 invalid_route_id`. Ответ: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="vector-route.pdf"`.

`POST /api/profession-assistant/message`. Пока `ASSISTANT_ENABLED` не равен `true`, handler отвечает `503 assistant_not_enabled` и модель не вызывает.

```json
{
  "profession_id": "prof_001",
  "conversation_id": null,
  "session_id": "uuid-сессии-этого-аккаунта",
  "request_id": "uuid",
  "question": "Чему учат на этой профессии?"
}
```

`profession_id` — `prof_` и 3–4 цифры из каталога. Профиль сессии должен иметь класс 1–11, иначе `404 profile_not_found`. Нет профессии: `404 profession_not_found`. Чужой `conversation_id`: `404 conversation_not_found`. Тот же `request_id` и тот же вопрос: `200` и `replayed: true`. Тот же `request_id` и другой вопрос: `409 request_id_conflict`.

`200`:

```json
{
  "conversation_id": "uuid",
  "status": "success",
  "answer": "текст без URL",
  "sources": [{ "id": "prof_001", "title": "Каталог Вектора: …" }],
  "source_type": "internal"
}
```

`status` также бывает `out_of_domain`, `needs_clarification`, `insufficient_data`. Провайдер не ответил: `502 assistant_provider_unavailable`. Нет квот в окружении: `503 assistant_policy_not_configured`. Лимит: `429`.

`GET /api/profession-assistant/conversations` — до 50 диалогов. С `conversation_id` — до 100 сообщений. `DELETE` с этим query и CSRF: `204`. Без id у DELETE: `400 conversation_id_required`.

## Маршруты только в PR #16

PR #16 открыт, в `main` не влит: https://github.com/SamDerden/vector_prof/pull/16, head `5f44881053353af6082388f50e2c0d59ccf0ff42`. Эти два handler есть только в `feature/be-01-02-login-codes-smtp`. На `main` их нет, и этот документ не считает их доступными.

| METHOD | PATH | AUTH | REQUEST | RESPONSE | STATUS | SOURCE FILE |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/auth/login/code` | нет | JSON: `email` | `{ status: accepted }` | 202 | `backend/app/api/auth/login/code/route.ts` |
| POST | `/api/auth/login/code/verify` | нет | JSON: `email`, `code` из 6 цифр | `{ user }` и cookie аккаунта | 200 | `backend/app/api/auth/login/code/verify/route.ts` |

`POST /api/auth/login/code` отвечает `202` и для неизвестного email. Письмо уходит только активному аккаунту. `400 validation`. Лимиты: 1 запрос в 60 секунд и 5 в час, `429 rate_limited`.

`POST /api/auth/login/code/verify` при любой неудаче, включая просрочку и лимит попыток, отвечает `400 invalid_code`. Успех ставит те же cookie, что вход по паролю. CSRF на этих двух POST нет. PostgreSQL нужен. Отдельного feature flag у handler нет; миграция `014_login_codes.sql` в этом PR расширяет `purpose` до `login`.

Клиент этих путей лежит в той же ветке: `lib/auth-api.ts`, функции запроса и подтверждения кода. В `main` этих функций нет.

## Запланированные маршруты, которых в коде нет

Отдельного HTTP-маршрута самостоятельных проб (`self_guided_steps`) в `backend/app/api` нет. Шаги лежат в данных freeze и в ответ `GET /api/trials` или `GET /api/professions/:id` не подставляются.

Других путей, которые frontend `main` вызывает, а handler не экспортирует, нет.

## Frontend: отсутствующие и устаревшие вызовы

Сверены `app/`, `lib/` и `backend/app/page.tsx` коммита `992bdf7`.

Вызовов несуществующего пути на `main` нет. `lib/auth-api.ts` на `main` не вызывает вход по коду.

Расхождения клиента и handler, код не менялся:

- `register()` в `lib/auth-api.ts` помечает `password` как необязательный и может отправить тело без него. Handler требует пароль 12–128 символов и отвечает `400 validation`.
- Типы ответов auth-клиента содержат `message`. Handler кладёт код в `error` и статус в `status`. Разбор ошибки в клиенте читает `payload.error`, поэтому тип шире ответа.
- `AccountOverview.progress` в клиенте необязателен. `GET /api/account` поле `progress` не возвращает. Клиент его не требует.
- `README.md` до этой сверки писал `GET / POST` для `/api/education-route`. Handler и `lib/education-route.ts` используют `GET` и `PUT`. `POST` у этого пути нет.

Маршруты `main`, которые продукт в `app/` и `lib/` не вызывает:

- `GET /api/diagnostic/latest`
- `GET /api/recommendations`
- `GET /api/professions` и `GET /api/professions/:id` (профессии приходят внутри рекомендации; список дергает только e2e)
- `GET /api/trials`
- `GET /api/reflection`
- `GET` и `DELETE /api/profession-assistant/conversations`
- `POST /api/profession-assistant/message`

`backend/app/page.tsx` — отдельная страница backend, не кабинет Дмитрия. Она вызывает session, track, diagnostic questions/submit, clarification questions/submit, generate и reflection.

## Расхождения документации и реализации

Старые файлы оставлены. Ниже то, что в них больше не совпадает с `992bdf7`.

- [backend/docs/API.md](../backend/docs/API.md) описывает путь ученика и пишет, что личного кабинета нет. На `main` есть `/api/auth/*`, `/api/account`, отзыв, PDF, мастерская и `GET/PUT /api/education-route`.
- Там же у вопроса диагностики указано поле `question_id`. В анкете поле называется `id`. В теле submit по-прежнему `questionId`.
- Там же `GET /api/clarification/questions` описан без query `grade`. Handler его принимает.
- Там же `GET /api/session` не упоминает `activeJob`. Handler добавляет его для `pending` и `running`.
- Там же каталог описан как чтение активных строк PostgreSQL с `500` при ошибке. `GET /api/professions` отдаёт freeze и при ошибке БД. `GET /api/trials` при ошибке SQL тоже отдаёт freeze.
- [backend/docs/FRONTEND_API_ADDITIONS.md](../backend/docs/FRONTEND_API_ADDITIONS.md) датирован 11.11.2026 и веткой `fix/backend-integration-stability`. Блок `readiness`, 410, 429 и proof на `main` есть. Документ не покрывает аккаунт и PM.
- [docs/release-2026-11-26/API.md](release-2026-11-26/API.md) совпадает с мастерской, отзывом и PDF на `main`. Это не полный список API.
- Корневой `README.md` не перечислял auth, feedback, PDF и мастерскую и указывал `POST` для образовательного маршрута. Ссылка на этот инвентарь добавлена, исторический `backend/docs/API.md` сохранён.

## Тесты, которые держат контракт

Не каждый маршрут покрыт отдельным файлом. Основные:

- сессия, диагностика, уточнения, рекомендации, рефлексия: `backend/tests/session-security.test.ts`, `backend/tests/generation-stand.integration.test.ts`;
- каталог: `backend/tests/runtime-catalog.test.ts`;
- генерация и бюджеты: `backend/tests/main-integration-contracts.test.ts`, `tests/generation-resume.test.ts`;
- аккаунт: `backend/tests/account-auth.test.ts`, `tests/account-cabinet.test.mjs`, `e2e/account.spec.ts`;
- маршрут, отзыв, PDF, мастерская: `backend/tests/pm-features.integration.test.ts`, `tests/education-route.test.ts`;
- демо-ученики: `tests/frontend-contract.test.mjs`.

Вход по email-коду этими тестами `main` не покрыт: маршрута в этом коммите нет. Тесты кода живут в PR #16.
