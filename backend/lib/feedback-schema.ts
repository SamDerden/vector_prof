import { z } from "zod";
export const feedbackInput=z.object({
 request_id:z.string().uuid(), route_id:z.string().uuid().nullable().default(null),
 clarity:z.number().int().min(1).max(5), recommendations:z.number().int().min(1).max(5),
 navigation:z.number().int().min(1).max(5), usefulness:z.number().int().min(1).max(5),
 comment:z.string().trim().max(2000).default("")
}).strict();
