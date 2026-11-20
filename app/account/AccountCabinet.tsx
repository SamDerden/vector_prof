"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  accountErrorMessage,
  deleteAccount,
  fetchAccount,
  isAccountApiError,
  linkSession,
  logout,
} from "@/lib/auth-api";
import {
  formatDate,
  formatDateTime,
  localOwnSessionId,
  maskedIdentifier,
  normalizeOverview,
  shortSessionId,
  trackLabel,
  userStatusLabel,
  type SessionCard,
} from "@/lib/account-view";
import type { AccountUser } from "@/lib/auth-api";
import { adoptOwnSessionId } from "@/lib/session-store";
import { useAuth } from "./AuthProvider";

type Props = {
  onSignedOut: (reason?: string) => void;
};

type LinkState = "idle" | "busy" | "linked" | "error";

export function AccountCabinet({ onSignedOut }: Props) {
  const { user, refresh } = useAuth();
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(() => normalizeOverview(null));
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<SessionCard | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");

  const [linkState, setLinkState] = useState<LinkState>("idle");
  const [linkError, setLinkError] = useState("");
  const [localSession, setLocalSession] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const [showManual, setShowManual] = useState(false);

  const [dangerOpen, setDangerOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteDisabled, setDeleteDisabled] = useState(false);

  const loadAccount = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await fetchAccount();
      const normalized = normalizeOverview(data);
      setOverview(normalized);
      setSelected((current) => (current ? normalized.sessions.find((item) => item.id === current.id) ?? null : null));
    } catch (caught) {
      if (isAccountApiError(caught) && (caught.status === 401 || caught.status === 410)) {
        onSignedOut("Сессия входа истекла. Войди заново.");
        return;
      }
      setLoadError(accountErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [onSignedOut]);

  useEffect(() => {
    setLocalSession(localOwnSessionId());
    void loadAccount();
  }, [loadAccount]);

  const sessions = overview.sessions;
  const linkedIds = useMemo(() => new Set(sessions.map((item) => item.id)), [sessions]);
  const localNotLinked = Boolean(localSession && !linkedIds.has(localSession));
  const profileUser: AccountUser | null = overview.user ?? user;

  async function handleLink(sessionId: string) {
    if (linkState === "busy") return;
    setLinkError("");
    setActionNotice("");
    setLinkState("busy");
    try {
      await linkSession({ sessionId });
      setLinkState("linked");
      setActionNotice("Сессия привязана к аккаунту. Теперь её данные доступны после входа с любого устройства.");
      setShowManual(false);
      setManualId("");
      await loadAccount();
    } catch (caught) {
      setLinkState("error");
      const error = isAccountApiError(caught) ? caught : null;
      if (error?.status === 401 || error?.status === 410) {
        onSignedOut("Сессия входа истекла. Войди заново.");
        return;
      }
      if (error?.status === 404) {
        setLinkError("Такой анонимной сессии на сервере нет — возможно, истёк срок её жизни.");
      } else if (error?.status === 403) {
        setLinkError(
          "Сервер не подтвердил владение сессией. Привязать можно только сессию, созданную в этом браузере, пока действует её cookie-подтверждение."
        );
      } else if (error?.status === 409) {
        setLinkError("Эту сессию нельзя привязать: например, это демо-сессия или у неё уже есть другой владелец.");
      } else {
        setLinkError(accountErrorMessage(caught));
      }
    }
  }

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    setActionError("");
    try {
      await logout();
    } catch (caught) {
      // A logout that fails with 401 has already achieved the desired result.
      const status = isAccountApiError(caught) ? caught.status : 0;
      if (status !== 401) {
        setActionError(accountErrorMessage(caught));
        setSigningOut(false);
        return;
      }
    }
    await refresh();
    onSignedOut();
  }

  async function handleDelete(event: React.FormEvent) {
    event.preventDefault();
    if (deleting) return;
    setDeleteError("");
    if (!deletePassword) {
      setDeleteError("Введи текущий пароль, чтобы подтвердить удаление.");
      return;
    }
    setDeleting(true);
    try {
      await deleteAccount({ password: deletePassword });
      setDeletePassword("");
      await refresh();
      onSignedOut("Аккаунт и связанные с ним данные удалены.");
    } catch (caught) {
      const error = isAccountApiError(caught) ? caught : null;
      if (error?.code === "feature_disabled" || error?.status === 503) {
        setDeleteDisabled(true);
        setDeleteError(
          "Удаление аккаунта выключено на сервере до утверждения политики хранения данных. Напиши в поддержку, чтобы удалить аккаунт вручную."
        );
      } else if (error?.status === 403) {
        setDeleteError("Пароль не подошёл или устарел CSRF-токен. Обнови страницу и попробуй снова.");
      } else {
        setDeleteError(accountErrorMessage(caught));
      }
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="account-cabinet">
        <div className="account-skeleton" aria-busy="true" aria-label="Загружаем личный кабинет">
          <div />
          <div />
          <div />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="account-cabinet">
        <div className="account-card account-card-message">
          <h2>Не удалось загрузить кабинет</h2>
          <p>{loadError}</p>
          <button type="button" className="pill primary" onClick={() => void loadAccount()}>
            Повторить
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="account-cabinet">
      <header className="account-cabinet-head">
        <div>
          <span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</span>
          <h1>Привет{profileUser?.email ? `, ${profileUser.email.split("@")[0]}` : ""}!</h1>
          <p>
            Здесь собраны твои диагностики и маршруты. Аккаунт нужен, чтобы не потерять результаты при очистке браузера и
            открыть их на другом устройстве.
          </p>
        </div>
        <img src="/assets/mascots/snegurochka/snegurochka_greet_left.png" alt="Снегурочка приветствует" />
      </header>

      {(actionNotice || actionError) && (
        <div className={actionError ? "account-error" : "account-notice"} role={actionError ? "alert" : "status"}>
          {actionError || actionNotice}
        </div>
      )}

      <div className="account-grid">
        <section className="account-card" aria-labelledby="account-sessions-title">
          <div className="account-card-head">
            <h2 id="account-sessions-title">Мои сессии</h2>
            <span className="account-counter">
              {sessions.length}
              {overview.limits?.maxSessions ? ` / ${overview.limits.maxSessions}` : ""}
            </span>
          </div>

          {localNotLinked && (
            <div className="account-link-banner">
              <div>
                <b>В этом браузере есть анонимная сессия</b>
                <p>
                  Сессия <code>{shortSessionId(localSession!)}</code> ещё не привязана к аккаунту. Привязка сохранит уже
                  пройденную диагностику — проходить её заново не нужно.
                </p>
              </div>
              <button
                type="button"
                className="pill primary small"
                disabled={linkState === "busy"}
                onClick={() => void handleLink(localSession!)}
              >
                {linkState === "busy" ? "Привязываем…" : "Привязать сессию"}
              </button>
            </div>
          )}

          {linkError && (
            <p className="account-error" role="alert">
              {linkError}
            </p>
          )}

          {sessions.length === 0 ? (
            <div className="account-empty">
              <p>К аккаунту пока не привязана ни одна диагностика.</p>
              <p className="account-muted">
                Пройди диагностику на главной странице, а затем вернись сюда и нажми «Привязать сессию» — результаты
                сохранятся в аккаунте.
              </p>
              <a className="pill primary small" href="/">
                Пройти диагностику →
              </a>
            </div>
          ) : (
            <ul className="account-session-list">
              {sessions.map((session) => {
                const isLocal = session.id === localSession;
                return (
                  <li key={session.id} className={selected?.id === session.id ? "account-session selected" : "account-session"}>
                    <button
                      type="button"
                      className="account-session-main"
                      onClick={() => setSelected(selected?.id === session.id ? null : session)}
                      aria-expanded={selected?.id === session.id}
                    >
                      <span className="account-session-title">
                        {session.grade ? `${session.grade} класс` : "Класс не указан"}
                        {session.municipality ? ` · ${session.municipality}` : ""}
                      </span>
                      <span className="account-session-sub">{trackLabel(session.trackType)}</span>
                      <span className="account-session-meta">
                        Обновлена {formatDate(session.updatedAt ?? session.createdAt)}
                        {isLocal ? " · это устройство" : ""}
                      </span>
                      <span className="account-session-progress" aria-label={`Заполнено этапов: ${session.progress} из 3`}>
                        <i className={session.hasDiagnostic ? "done" : ""} title="Диагностика" />
                        <i className={session.hasRecommendation ? "done" : ""} title="Рекомендации" />
                        <i className={session.hasRoute ? "done" : ""} title="Маршрут" />
                      </span>
                    </button>
                    {selected?.id === session.id && (
                      <div className="account-session-detail">
                        <dl>
                          <div>
                            <dt>Идентификатор</dt>
                            <dd>
                              <code>{shortSessionId(session.id)}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>Создана</dt>
                            <dd>{formatDateTime(session.createdAt)}</dd>
                          </div>
                          <div>
                            <dt>Последнее изменение</dt>
                            <dd>{formatDateTime(session.updatedAt)}</dd>
                          </div>
                          <div>
                            <dt>Привязана к аккаунту</dt>
                            <dd>{session.linked ? "Да" : "Нет"}</dd>
                          </div>
                          <div>
                            <dt>Диагностика</dt>
                            <dd>{session.hasDiagnostic ? "Пройдена" : "Не пройдена"}</dd>
                          </div>
                          <div>
                            <dt>Рекомендации</dt>
                            <dd>{session.hasRecommendation ? "Готовы" : "Нет"}</dd>
                          </div>
                          <div>
                            <dt>Маршрут</dt>
                            <dd>{session.hasRoute ? "Сохранён" : "Нет"}</dd>
                          </div>
                        </dl>
                        <div className="account-session-actions">
                          <button
                            type="button"
                            className="pill outline small"
                            onClick={() => {
                              adoptOwnSessionId(session.id, { grade: session.grade });
                              setActionNotice("Сессия выбрана для этого браузера. Открываем главную страницу…");
                              window.setTimeout(() => {
                                window.location.href = "/";
                              }, 600);
                            }}
                          >
                            Продолжить в этом браузере →
                          </button>
                        </div>
                        <p className="account-muted">
                          Сессия станет активной на этом устройстве. Полные ответы диагностики читаются на главной
                          странице — они не показываются здесь, чтобы данные не открывались на чужом экране.
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="account-manual">
            {!showManual ? (
              <button type="button" className="account-link-quiet" onClick={() => setShowManual(true)}>
                Привязать сессию по идентификатору
              </button>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = manualId.trim();
                  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
                    setLinkError("Идентификатор должен быть UUID сессии.");
                    return;
                  }
                  void handleLink(value);
                }}
              >
                <label className="account-field" htmlFor="account-manual-session">
                  <span>Идентификатор анонимной сессии</span>
                  <input
                    id="account-manual-session"
                    type="text"
                    value={manualId}
                    onChange={(event) => setManualId(event.target.value)}
                    placeholder="00000000-0000-4000-8000-000000000000"
                    disabled={linkState === "busy"}
                  />
                  <small>
                    Подходит только сессия, созданная в этом браузере: сервер дополнительно проверяет подтверждение
                    владения.
                  </small>
                </label>
                <div className="account-auth-actions">
                  <button type="submit" className="pill primary small" disabled={linkState === "busy"}>
                    Привязать
                  </button>
                  <button
                    type="button"
                    className="account-link-quiet"
                    onClick={() => {
                      setShowManual(false);
                      setLinkError("");
                    }}
                  >
                    Отмена
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>

        <aside className="account-aside">
          <section className="account-card" aria-labelledby="account-profile-title">
            <h2 id="account-profile-title">Профиль</h2>
            <dl className="account-facts">
              <div>
                <dt>Email</dt>
                <dd>{profileUser?.email ?? maskedIdentifier(user)}</dd>
              </div>
              <div>
                <dt>Статус</dt>
                <dd>
                  <span className="account-badge">{userStatusLabel(profileUser)}</span>
                </dd>
              </div>
              <div>
                <dt>Класс</dt>
                <dd>{overview.grade ? `${overview.grade}` : "не указан"}</dd>
              </div>
              <div>
                <dt>Муниципалитет</dt>
                <dd>{overview.municipality ?? "не указан"}</dd>
              </div>
            </dl>
            <div className="account-aside-actions">
              <button type="button" className="pill outline small" onClick={() => void loadAccount()}>
                Обновить данные
              </button>
              <button type="button" className="account-link-quiet" onClick={() => void handleLogout()} disabled={signingOut}>
                {signingOut ? "Выходим…" : "Выйти из аккаунта"}
              </button>
            </div>
          </section>

          <section className="account-card account-tips">
            <h2>Как это устроено</h2>
            <ul>
              <li>Диагностика хранится в сессии, а аккаунт лишь подтверждает, что сессия твоя.</li>
              <li>Пароль и код подтверждения не хранятся в браузере и не попадают в аналитику.</li>
              <li>Анонимная сессия живёт 7 дней. Привязанная к аккаунту — не исчезает по этому сроку.</li>
              <li>Демо-профили нельзя привязать к личному аккаунту — это ограничение сервера.</li>
            </ul>
          </section>

          <section className="account-card account-danger" aria-labelledby="account-danger-title">
            <h2 id="account-danger-title">Удаление аккаунта</h2>
            <p className="account-muted">
              Удаление стирает аккаунт, его сессии, диагностики, рекомендации и маршруты без возможности восстановления.
            </p>
            {!dangerOpen ? (
              <button type="button" className="pill outline small account-danger-toggle" onClick={() => setDangerOpen(true)}>
                Удалить аккаунт
              </button>
            ) : (
              <form onSubmit={handleDelete} noValidate>
                <label className="account-field" htmlFor="account-delete-password">
                  <span>Текущий пароль</span>
                  <input
                    id="account-delete-password"
                    type="password"
                    value={deletePassword}
                    onChange={(event) => setDeletePassword(event.target.value)}
                    autoComplete="current-password"
                    disabled={deleting || deleteDisabled}
                  />
                </label>
                <div className="account-auth-actions">
                  <button type="submit" className="pill primary small" disabled={deleting || deleteDisabled}>
                    {deleting ? "Удаляем…" : "Удалить безвозвратно"}
                  </button>
                  <button
                    type="button"
                    className="account-link-quiet"
                    onClick={() => {
                      setDangerOpen(false);
                      setDeletePassword("");
                      setDeleteError("");
                    }}
                  >
                    Отмена
                  </button>
                </div>
              </form>
            )}
            {deleteError && (
              <p className="account-error" role="alert">
                {deleteError}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
