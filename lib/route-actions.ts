import { API_BASE } from './api';
import { readLocalRoute } from './education-route';
import { sessionHeader, type SessionScope } from './session-store';

export async function savedRouteForExport(scope: SessionScope, storageKey: string, professionKey: string, storage: Storage, fetchImpl: typeof fetch = fetch) {
  const headers = sessionHeader(scope, storage);
  if (!headers) throw new Error('Сначала пройди диагностику и сохрани маршрут.');
  const local = readLocalRoute(storage, storageKey, professionKey);
  if (local.pending || local.remote) throw new Error('Дождись сохранения маршрута и разреши конфликт версий перед скачиванием.');
  const response = await fetchImpl(`${API_BASE}/api/education-route?professionKey=${encodeURIComponent(professionKey)}`, { headers, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Не удалось прочитать сохранённый маршрут. Попробуй ещё раз.');
  const route = await response.json();
  const current = readLocalRoute(storage, storageKey, professionKey);
  if (current.stamp !== local.stamp || current.pending || current.remote || route.version !== current.version || route.professionKey !== professionKey) throw new Error('Маршрут изменился. Дождись сохранения и повтори скачивание.');
  if (typeof route.route_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(route.route_id)) throw new Error('Скачивание ещё недоступно на сервере.');
  return { routeId: route.route_id as string, version: route.version as number };
}

export function routeActionError(status: number): string {
  if (status === 401 || status === 403) return 'Войди в личный кабинет и привяжи свою диагностику к аккаунту.';
  if (status === 404) return 'Маршрут недоступен или эта функция ещё не включена на сервере.';
  if (status === 409) return 'Маршрут изменился. Повтори скачивание актуальной версии.';
  if (status === 429) return 'Слишком много запросов. Подожди немного и повтори.';
  return 'Не удалось выполнить запрос. Попробуй ещё раз.';
}
