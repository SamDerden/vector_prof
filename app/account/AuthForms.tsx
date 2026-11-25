"use client";

import { useEffect, useState } from "react";
import {
  PASSWORD_MIN,
  accountErrorMessage,
  forgotPassword,
  isAccountApiError,
  isEmail,
  login,
  register,
  resendVerification,
  resetPassword,
  validatePassword,
  verify,
  type AccountUser,
} from "@/lib/auth-api";

export type AuthMode = "login" | "register" | "forgot";

type Props = {
  initialMode?: AuthMode;
  /** Email carried over between login → register → verify → forgot screens. */
  initialEmail?: string;
  /** Hidden entry point used by «Привязать сессию» when the user is a guest. */
  reason?: string | null;
  onAuthenticated: (user: AccountUser) => void;
  onRegistered?: (email: string) => void;
  onClose?: () => void;
  /** Opens the one-time code screen after an accepted registration request. */
  onOpenVerify?: (email: string) => void;
};

const RESEND_COOLDOWN_SECONDS = 60;

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  placeholder,
  hint,
  disabled,
  inputMode,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  inputMode?: "email" | "numeric" | "text";
}) {
  return (
    <label className="account-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        inputMode={inputMode}
        disabled={disabled}
        required
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function AuthPanel({
  initialMode = "login",
  initialEmail = "",
  reason,
  onAuthenticated,
  onRegistered,
  onClose,
  onOpenVerify,
}: Props) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotStep, setForgotStep] = useState<"request" | "reset">("request");
  const [resetCode, setResetCode] = useState("");

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    if (initialEmail) setEmail(initialEmail);
  }, [initialEmail]);

  const passwordProblem = mode === "login" ? null : validatePassword(password);

  function switchMode(next: AuthMode) {
    setMode(next);
    setError("");
    setNotice("");
    setBlocked(false);
    setPassword("");
    setResetCode("");
    setForgotStep("request");
  }

  function switchForgotStep(next: "request" | "reset") {
    setForgotStep(next);
    setError("");
    setNotice("");
  }

  async function submitLogin(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!isEmail(email)) {
      setError("Введи email в формате name@example.ru.");
      return;
    }
    if (!password) {
      setError("Введи пароль.");
      return;
    }
    setBusy(true);
    try {
      const result = await login({ email, password });
      onAuthenticated(result.user);
    } catch (caught) {
      const apiError = isAccountApiError(caught) ? caught : null;
      if (apiError?.code === "registration_not_configured" || apiError?.code === "feature_disabled") {
        setBlocked(true);
      }
      setError(accountErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitRegister(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    if (!isEmail(email)) {
      setError("Введи email в формате name@example.ru.");
      return;
    }
    if (passwordProblem) {
      setError(passwordProblem);
      return;
    }
    setBusy(true);
    try {
      await register({ email, password });
      onRegistered?.(email);
      // The backend answers registration with an account-existence-neutral
      // message, so nothing here may claim that a new account was created.
      setNotice(
        "Запрос принят. Если регистрация сейчас включена на сервере, на этот адрес придёт код подтверждения — проверь входящие и папку «Спам»."
      );
    } catch (caught) {
      if (isAccountApiError(caught) && (caught.code === "registration_not_configured" || caught.code === "feature_disabled")) {
        setBlocked(true);
      }
      setError(accountErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitForgot(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    if (!isEmail(email)) {
      setError("Введи email в формате name@example.ru.");
      return;
    }
    setBusy(true);
    try {
      await forgotPassword({ email });
      // The backend answers the same way for a known and an unknown contact.
      setNotice("Если такой аккаунт существует, код для сброса пароля отправлен на почту.");
      setForgotStep("reset");
    } catch (caught) {
      setError(accountErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    if (!isEmail(email)) {
      setError("Введи email в формате name@example.ru.");
      return;
    }
    if (!/^\d{4,8}$/.test(resetCode.trim())) {
      setError("Код состоит из 4–8 цифр. Проверь письмо.");
      return;
    }
    const problem = validatePassword(password);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await resetPassword({ email, code: resetCode, password });
      setNotice("Пароль изменён, прежние сессии на других устройствах завершены. Теперь войди с новым паролем.");
      setPassword("");
      setResetCode("");
      setForgotStep("request");
      window.setTimeout(() => switchMode("login"), 1200);
    } catch (caught) {
      setError(accountErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-auth" aria-labelledby="account-auth-title">
      <div className="account-auth-art" aria-hidden="true">
        <img src="/assets/mascots/snegurochka/snegurochka_lie_laptop.png" alt="" />
        <img src="/assets/mascots/leshii/leshii_wave_left.png" alt="" />
      </div>
      <div className="account-auth-body">
        {onClose && (
          <button type="button" className="account-link-quiet account-auth-close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        )}
        <span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ · ВЕКТОР</span>
        <h1 id="account-auth-title">
          {mode === "login" ? "Вход в аккаунт" : mode === "register" ? "Создать аккаунт" : "Восстановление доступа"}
        </h1>
        <p className="account-auth-lead">
          {mode === "login"
            ? "Войди, чтобы вернуться к своим диагностикам, рекомендациям и маршруту с любого устройства."
            : mode === "register"
              ? "Аккаунт сохраняет результаты диагностики. Без входа анонимная сессия живёт 7 дней."
              : "Пришлём одноразовый код на почту. Он действует ограниченное время."}
        </p>

        {reason && mode === "login" && <div className="account-hint">{reason}</div>}

        <div className="account-tabs" role="tablist" aria-label="Способ входа">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "login"}
            className={mode === "login" ? "active" : ""}
            onClick={() => switchMode("login")}
          >
            Вход
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register"}
            className={mode === "register" ? "active" : ""}
            onClick={() => switchMode("register")}
          >
            Регистрация
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "forgot"}
            className={mode === "forgot" ? "active" : ""}
            onClick={() => switchMode("forgot")}
          >
            Забыл пароль
          </button>
        </div>

        {mode === "login" && (
          <form onSubmit={submitLogin} noValidate>
            <Field
              id="account-login-email"
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="username"
              placeholder="student@example.ru"
              inputMode="email"
              disabled={busy}
            />
            <label className="account-field" htmlFor="account-login-password">
              <span>Пароль</span>
              <span className="account-field-row">
                <input
                  id="account-login-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder={`Не короче ${PASSWORD_MIN} символов`}
                  disabled={busy}
                  required
                />
                <button
                  type="button"
                  className="account-link-quiet"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                >
                  {showPassword ? "Скрыть" : "Показать"}
                </button>
              </span>
            </label>
            <div className="account-auth-actions">
              <button type="submit" className="pill primary" disabled={busy}>
                {busy ? "Проверяем…" : "Войти"}
              </button>
              <button type="button" className="account-link-quiet" onClick={() => switchMode("forgot")}>
                Забыл пароль
              </button>
            </div>
          </form>
        )}

        {mode === "register" && (
          <form onSubmit={submitRegister} noValidate>
            <Field
              id="account-register-email"
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              placeholder="student@example.ru"
              inputMode="email"
              disabled={busy}
              hint="На этот адрес придёт код подтверждения."
            />
            <label className="account-field" htmlFor="account-register-password">
              <span>Пароль</span>
              <span className="account-field-row">
                <input
                  id="account-register-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  placeholder={`${PASSWORD_MIN}–128 символов`}
                  disabled={busy}
                  required
                />
                <button
                  type="button"
                  className="account-link-quiet"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                >
                  {showPassword ? "Скрыть" : "Показать"}
                </button>
              </span>
              <small className={password && passwordProblem ? "account-field-warning" : undefined}>
                {password && passwordProblem ? passwordProblem : `От ${PASSWORD_MIN} до 128 символов. Не используй пароль от других сервисов.`}
              </small>
            </label>
            <p className="account-legal">
              Регистрируясь, ты соглашаешься с правилами обработки данных. Если тебе меньше 14 лет, попроси взрослого помочь.
            </p>
            <div className="account-auth-actions">
              <button type="submit" className="pill primary" disabled={busy}>
                {busy ? "Создаём…" : "Зарегистрироваться"}
              </button>
            </div>
          </form>
        )}

        {mode === "forgot" && (
          <form onSubmit={forgotStep === "request" ? submitForgot : submitReset} noValidate>
            <Field
              id="account-forgot-email"
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
              placeholder="student@example.ru"
              inputMode="email"
              disabled={busy}
              hint="Ответ не раскрывает, есть ли такой аккаунт."
            />
            {forgotStep === "request" ? (
              <div className="account-auth-actions">
                <button type="submit" className="pill primary" disabled={busy}>
                  {busy ? "Отправляем…" : "Отправить код"}
                </button>
                <button type="button" className="account-link-quiet" onClick={() => switchForgotStep("reset")}>
                  У меня уже есть код
                </button>
              </div>
            ) : (
              <>
                <Field
                  id="account-reset-code"
                  label="Код из письма"
                  type="text"
                  value={resetCode}
                  onChange={(value) => setResetCode(value.replace(/\D/g, "").slice(0, 8))}
                  autoComplete="one-time-code"
                  placeholder="123456"
                  inputMode="numeric"
                  disabled={busy}
                />
                <Field
                  id="account-forgot-password"
                  label="Новый пароль"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete="new-password"
                  placeholder={`${PASSWORD_MIN}–128 символов`}
                  disabled={busy}
                  hint={password && passwordProblem ? passwordProblem : `От ${PASSWORD_MIN} до 128 символов.`}
                />
                <div className="account-auth-actions">
                  <button type="submit" className="pill primary" disabled={busy}>
                    {busy ? "Меняем пароль…" : "Изменить пароль"}
                  </button>
                  <button type="button" className="account-link-quiet" onClick={() => switchForgotStep("request")}>
                    Запросить код заново
                  </button>
                </div>
              </>
            )}
          </form>
        )}

        {notice && (
          <p className="account-notice" role="status">
            {notice}
          </p>
        )}
        {mode === "register" && notice && onOpenVerify && (
          <div className="account-auth-actions">
            <button type="button" className="pill outline" onClick={() => onOpenVerify(email)}>
              Ввести код подтверждения →
            </button>
          </div>
        )}
        {error && (
          <p className="account-error" role="alert">
            {error}
          </p>
        )}
        {blocked && (
          <p className="account-hint">
            Это ограничение на стороне сервера, а не ошибка формы. Пока настройки не включены, продолжить можно только
            существующим аккаунтом.
          </p>
        )}
      </div>
    </section>
  );
}

/** One-time code confirmation screen (registration and password reset share it). */
export function CodePanel({
  email,
  purpose,
  onDone,
  onBack,
  onSwitchToLogin,
}: {
  email: string;
  purpose: "verify" | "reset";
  onDone: (payload: { user?: AccountUser; email: string }) => void;
  onBack: () => void;
  onSwitchToLogin?: () => void;
}) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [verified, setVerified] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    if (!/^\d{4,8}$/.test(code.trim())) {
      setError("Код состоит из 4–8 цифр. Проверь письмо.");
      return;
    }
    if (purpose === "reset") {
      const problem = validatePassword(password);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setBusy(true);
    try {
      if (purpose === "verify") {
        await verify({ email, code });
        setVerified(true);
        setNotice("Контакт подтверждён. Теперь войди с паролем, который указал при регистрации.");
        onDone({ email });
      } else {
        await resetPassword({ email, code, password });
        setNotice("Пароль изменён. Все прежние сессии на других устройствах завершены — войди заново.");
        onDone({ email });
      }
    } catch (caught) {
      setError(accountErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (busy || cooldown > 0) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (purpose === "verify") {
        await resendVerification({ email });
      } else {
        await forgotPassword({ email });
      }
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setNotice("Новый код отправлен. Прежний код больше не действует.");
    } catch (caught) {
      const retry = isAccountApiError(caught) ? caught.retryAfterMs : undefined;
      if (retry) setCooldown(Math.ceil(retry / 1000));
      setError(accountErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="account-auth" aria-labelledby="account-code-title">
      <div className="account-auth-art" aria-hidden="true">
        <img src="/assets/mascots/snegurochka/snegurochka_tablet.png" alt="" />
        <img src="/assets/mascots/leshii/leshii_reading.png" alt="" />
      </div>
      <div className="account-auth-body">
        <button type="button" className="account-link-quiet account-back" onClick={onBack}>
          ← Назад
        </button>
        <span className="eyebrow">{purpose === "verify" ? "ПОДТВЕРЖДЕНИЕ КОНТАКТА" : "НОВЫЙ ПАРОЛЬ"}</span>
        <h1 id="account-code-title">{purpose === "verify" ? "Введи код из письма" : "Код и новый пароль"}</h1>
        <p className="account-auth-lead">
          Код отправлен на <b>{email}</b>. Он одноразовый, действует ограниченное время и блокируется после нескольких
          неверных попыток.
        </p>
        <form onSubmit={submit} noValidate>
          <Field
            id="account-code"
            label="Код из письма"
            type="text"
            value={code}
            onChange={(value) => setCode(value.replace(/\D/g, "").slice(0, 8))}
            autoComplete="one-time-code"
            placeholder="123456"
            inputMode="numeric"
            disabled={busy || verified}
          />
          {purpose === "reset" && (
            <Field
              id="account-reset-password"
              label="Новый пароль"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              placeholder={`${PASSWORD_MIN}–128 символов`}
              disabled={busy}
              hint={password && validatePassword(password) ? validatePassword(password)! : `От ${PASSWORD_MIN} до 128 символов.`}
            />
          )}
          <div className="account-auth-actions">
            <button type="submit" className="pill primary" disabled={busy || verified}>
              {busy ? "Проверяем…" : purpose === "verify" ? "Подтвердить" : "Изменить пароль"}
            </button>
            {!verified && (
              <button type="button" className="account-link-quiet" onClick={resend} disabled={busy || cooldown > 0}>
                {cooldown > 0 ? `Отправить снова через ${cooldown} с` : "Отправить код снова"}
              </button>
            )}
          </div>
        </form>
        {notice && (
          <p className="account-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="account-error" role="alert">
            {error}
          </p>
        )}
        {(verified || purpose === "reset") && onSwitchToLogin && (
          <button type="button" className="pill outline" onClick={onSwitchToLogin}>
            Перейти ко входу →
          </button>
        )}
      </div>
    </section>
  );
}
