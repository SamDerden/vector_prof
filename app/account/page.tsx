import type { Metadata } from "next";
import AccountExperience from "./AccountExperience";

export const metadata: Metadata = {
  title: "Личный кабинет — Вектор",
  description: "Вход и регистрация в региональном навигаторе образовательных и профессиональных возможностей «Вектор»",
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return <AccountExperience />;
}
