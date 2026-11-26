import { z } from "zod";
import type { NormalizedProfession } from "./ai/catalog.ts";

export const assistantInput = z.object({
 profession_id: z.string().regex(/^prof_\d{3,4}$/),
 conversation_id: z.string().uuid().nullable().default(null),
 session_id: z.string().uuid(),
 request_id: z.string().uuid(),
 question: z.string().trim().min(1).max(2000),
}).strict();
export function classifyQuestion(question: string): "relevant" | "out_of_domain" | "needs_clarification" {
 if (/ignore.*instructions|system prompt|системн.{0,10}промпт|игнорируй.{0,30}инструкц|раскрой.{0,20}инструкц|напиши.{0,20}(сочинение|реферат)|реши.{0,15}(уравнение|задач)/i.test(question)) return "out_of_domain";
 if (/професс|работ|учить|учиться|учёб|учеб|учиться|предмет|навык|зарплат|заработ|поступ|карьер|колледж|вуз|университет|сложно|нравится|подходит|сколько|почему|попроб|расскажи|что делает|услови|перспектив/i.test(question)) return "relevant";
 return "needs_clarification";
}
export function professionContext(p: NormalizedProfession, grade: number) {
 return { profession_id: p.profession_id, name: p.name, grade,
 description: grade <= 4 ? p.description_1_4 : grade <= 8 ? p.description_5_8 : p.description_9_11,
 skills: p.skills.map(s => ({name:s.name, description: grade <= 4 ? s.description_1_4 : grade <= 8 ? s.description_5_8 : s.description_9_11})),
 programs:p.programs.slice(0,15).map(x=>({id:x.program_id,name:x.name})),
 trials:p.trials.slice(0,15).map(x=>({id:x.trial_id,title:x.title})),
 };
}
export function safeAssistantAnswer(text: string) {
 // Links come exclusively from server-selected sources, never from generated text.
 const value = text.trim();
 if (!value || value.length > 12000 || /https?:|www\./i.test(value)) throw new Error("assistant_invalid_output");
 return value;
}
export function positiveSetting(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum: number) {
 const value = Number(env[key] ?? fallback);
 if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${key}`);
 return value;
}
