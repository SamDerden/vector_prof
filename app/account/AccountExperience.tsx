"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AuthProvider, useAuth } from "./AuthProvider";
import { AuthPanel, CodePanel, type AuthMode } from "./AuthForms";
import { AccountCabinet } from "./AccountCabinet";
import type { AccountUser } from "@/lib/auth-api";
import "./account.css";

type Screen = "login" | "register" | "forgot" | "verify" | "reset" | "cabinet";

function VectorMark() {
  return (
    <svg className="account-mark" viewBox="0 0 44 44" aria-hidden="true">
      <defs>
        <linearGradient id="account-logo-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1bf5c4" />
          <stop offset="48%" stopColor="#0bcad7" />
          <stop offset="100%" stopColor="#3659e8" />
        </linearGradient>
      </defs>
      <path d="M6 4.5C6 2.8 7.8 1.8 9.3 2.7L39 20.1c1.7 1 1.7 3.3 0 4.3L9.3 41.3C7.8 42.2 6 41.2 6 39.5Z" fill="url(#account-logo-gradient)" />
      <path d="M9 5.5 31.5 22 9 38.5 17 22Z" fill="#54f3ce" opacity=".8" />
      <path d="m17 22 22-1.9c1.7 1 1.7 3.3 0 4.3L9 41.3Z" fill="#12b5e3" opacity=".75" />
      <path d="m9 5.5 22.5 16.5-14.5 0Z" fill="#0fe4a9" opacity=".7" />
    </svg>
  );
}

function AccountExperience() {
  const { loading, authenticated, error, refresh, applyUser } = useAuth();
  const [screen, setScreen] = useState<Screen>("login");
  const [email, setEmail] = useState("");
  const [flash, setFlash] = useState<string>("");

  // Keep the visible screen in sync with the auth cookie. Without this the
  // cabinet could be shown after the cookie expires, or the login form could
  // stay on screen for an already signed-in visitor.
  useEffect(() => {
    if (loading) return;
    setScreen((current) => {
      if (authenticated) return "cabinet";
      if (current === "cabinet") return "login";
      return current;
    });
  }, [loading, authenticated]);

  const handleAuthenticated = useCallback(
    (next: AccountUser) => {
      applyUser(next);
      setFlash("");
      setScreen("cabinet");
    },
    [applyUser]
  );

  const handleSignedOut = useCallback(
    (reason?: string) => {
      applyUser(null);
      setFlash(reason ?? "");
      setScreen("login");
    },
    [applyUser]
  );

  if (loading) {
    return (
      <main className="account-shell">
        <div className="account-skeleton" aria-busy="true" aria-label="Проверяем состояние входа">
          <div />
          <div />
        </div>
      </main>
    );
  }

  return (
    <main className="account-shell">
      <div className="account-topline">
        <Link href="/" className="account-home-link">
          <VectorMark />
          <b>Вектор</b>
        </Link>
        <Link href="/" className="account-link-quiet">
          ← На главную
        </Link>
      </div>

      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}

      {screen === "cabinet" && authenticated ? (
        <AccountCabinet onSignedOut={handleSignedOut} />
      ) : screen === "verify" ? (
        <CodePanel
          email={email}
          purpose="verify"
          onBack={() => setScreen("register")}
          onDone={() => {
            setScreen("login");
            setFlash("Контакт подтверждён. Войди с паролем, который указал при регистрации.");
          }}
          onSwitchToLogin={() => setScreen("login")}
        />
      ) : screen === "reset" ? (
        <CodePanel
          email={email}
          purpose="reset"
          onBack={() => setScreen("forgot")}
          onDone={() => {
            setFlash("Пароль изменён. Войди с новым паролем — прежние устройства отключены.");
            setScreen("login");
          }}
          onSwitchToLogin={() => setScreen("login")}
        />
      ) : (
        <>
          <AuthPanel
            initialMode={(screen === "forgot" ? "forgot" : screen === "register" ? "register" : "login") as AuthMode}
            initialEmail={email}
            reason={flash || null}
            onAuthenticated={handleAuthenticated}
            onRegistered={(value) => setEmail(value)}
            onOpenVerify={(value) => {
              setEmail(value);
              setScreen("verify");
            }}
          />
          <div className="account-secondary-actions">
            {email && (
              <button type="button" className="account-link-quiet" onClick={() => setScreen("reset")}>
                Уже есть код для сброса или подтверждения? Ввести его →
              </button>
            )}
            <button
              type="button"
              className="account-link-quiet"
              onClick={async () => {
                await refresh();
              }}
            >
              Я подтвердил контакт — проверить вход
            </button>
          </div>
        </>
      )}
    </main>
  );
}

export default function AccountPage() {
  return (
    <AuthProvider>
      <AccountExperience />
    </AuthProvider>
  );
}
