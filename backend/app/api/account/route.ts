import { NextRequest } from "next/server";

import { handleAccount } from "@/lib/auth/account-store-pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handleAccount("overview", request);
}

export function DELETE(request: NextRequest) {
  return handleAccount("remove", request);
}
