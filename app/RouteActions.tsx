"use client";
import { useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { savedRouteForExport, routeActionError } from '@/lib/route-actions';
import { sessionHeader, type SessionScope } from '@/lib/session-store';

const questions = [
  ['clarity', 'Насколько понятна диагностика?'],
  ['recommendations', 'Насколько подходят рекомендации?'],
  ['navigation', 'Насколько удобно пользоваться сайтом?'],
  ['usefulness', 'Насколько полезен маршрут?'],
] as const;

export default function RouteActions({ scope, storageKey, professionKey }: { scope: SessionScope; storageKey: string; professionKey: string }) {
  const [downloading, setDownloading] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  // Keep the same payload and id after a network error: a retry cannot create a duplicate.
  const pending = useRef<{ fingerprint: string; body: Record<string, unknown> } | null>(null);
  const inFlight = useRef(false);

  async function download() {
    if (downloading) return;
    setDownloading(true); setPdfError('');
    try {
      const { routeId, version } = await savedRouteForExport(scope, storageKey, professionKey, localStorage);
      const response = await fetch(`${API_BASE}/api/route/export/pdf?route_id=${encodeURIComponent(routeId)}&version=${version}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(routeActionError(response.status));
      if (!response.headers.get('content-type')?.includes('application/pdf')) throw new Error('Сервер не вернул PDF. Попробуй позже.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'vector-route.pdf';
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setPdfError(error instanceof Error ? error.message : 'Не удалось скачать маршрут.'); }
    finally { setDownloading(false); }
  }

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || sent) return;
    const fields = new FormData(event.currentTarget);
    const values = Object.fromEntries(questions.map(([key]) => [key, Number(fields.get(key))]));
    const content = { ...values, comment: String(fields.get('comment') || '').trim() };
    const fingerprint = JSON.stringify(content);
    if (!pending.current || pending.current.fingerprint !== fingerprint) pending.current = { fingerprint, body: { ...content, request_id: crypto.randomUUID() } };
    inFlight.current = true; setSending(true); setFeedbackError('');
    try {
      const headers = sessionHeader(scope, localStorage);
      if (!headers) throw new Error('Сначала пройди диагностику, чтобы оставить отзыв.');
      const response = await fetch(`${API_BASE}/api/feedback`, { method: 'POST', credentials: 'same-origin', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(pending.current.body) });
      if (!response.ok) throw new Error(routeActionError(response.status));
      const result = await response.json().catch(() => null);
      if (result?.status !== 'saved') throw new Error('Сервер не подтвердил сохранение отзыва. Попробуй позже.');
      setSent(true);
    } catch (error) { setFeedbackError(error instanceof Error ? error.message : 'Отзыв не отправлен. Попробуй ещё раз.'); }
    finally { inFlight.current = false; setSending(false); }
  }

  if (scope.mode === 'demo') return <section className="vector-journey-panel"><p>Это демонстрационный маршрут. Пройди свою диагностику, чтобы скачать личный маршрут и оставить отзыв.</p></section>;
  return <section className="vector-journey-panel route-actions">
    <h2>Сохрани маршрут и поделись впечатлением</h2>
    <p>PDF содержит сохранённые шаги и выбранные возможности. Для скачивания <a href="/account">войди в кабинет</a> и привяжи диагностику.</p>
    <button type="button" className="pill primary" disabled={downloading} onClick={() => void download()}>{downloading ? 'Готовим PDF…' : 'Скачать маршрут PDF'}</button>
    {pdfError && <p role="alert">{pdfError}</p>}
    {sent ? <p role="status">Спасибо! Твой отзыв сохранён.</p> : <form onSubmit={send}>
      <h3>Как тебе Вектор?</h3><p>1 — совсем не подходит, 5 — полностью подходит.</p>
      <fieldset disabled={sending} className="route-feedback-fields">
        <legend>Твои оценки</legend>
        {questions.map(([key, title]) => <label key={key}>{title}<select name={key} required defaultValue=""><option value="" disabled>Выбери оценку</option>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}</select></label>)}
        <label>Комментарий — по желанию<textarea name="comment" maxLength={2000} rows={3} placeholder="Что было удобно, а что стоит улучшить? Не указывай ФИО и контакты." /></label>
      </fieldset>
      {feedbackError && <p role="alert">{feedbackError}</p>}
      <button className="pill outline" type="submit" disabled={sending}>{sending ? 'Отправляем…' : 'Отправить отзыв'}</button>
    </form>}
  </section>;
}
