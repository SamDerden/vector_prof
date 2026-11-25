import { NextRequest } from "next/server";

import { handleAccount } from "@/lib/auth/account-store-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return handleAccount("verify", request);
}
