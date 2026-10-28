import { NextResponse } from "next/server";
import {
  getCompanyByToken,
  getDecision,
  isUuid,
  setDecisionStatus,
} from "@/lib/db";
import { applyDecision } from "@/lib/decisions";

// POST /api/d/decide — the dashboard's Approve / Change / Reject buttons.
// The dashboard has no session cookie, so the company comes from the
// dashboard token (the same capability as the /d/[token] URL itself).
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Please send a valid request." },
      { status: 400 },
    );
  }
  const { token, decisionId, status, note } = body;
  if (typeof token !== "string" || !token) {
    return NextResponse.json(
      { ok: false, error: "This dashboard link is not valid." },
      { status: 401 },
    );
  }
  const company = await getCompanyByToken(token);
  if (!company) {
    return NextResponse.json(
      { ok: false, error: "This dashboard link is not valid." },
      { status: 401 },
    );
  }
  if (typeof decisionId !== "string" || !decisionId) {
    return NextResponse.json(
      { ok: false, error: "That proposal was not found." },
      { status: 400 },
    );
  }
  const decision =
    isUuid(decisionId) &&
    (await getDecision(company.id, decisionId).catch(() => null));
  if (!decision) {
    return NextResponse.json(
      { ok: false, error: "That proposal was not found." },
      { status: 400 },
    );
  }
  if (
    status !== "approved" &&
    status !== "rejected" &&
    status !== "changes_requested"
  ) {
    return NextResponse.json(
      { ok: false, error: "Please choose Approve, Change or Reject." },
      { status: 400 },
    );
  }
  try {
    const row = await setDecisionStatus(
      company.id,
      decisionId,
      status,
      typeof note === "string" ? note : undefined,
    );
    if (status === "approved") {
      try {
        await applyDecision(company.id, decisionId);
      } catch (err) {
        console.error(
          `dashboard apply failed for ${decisionId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return NextResponse.json({
      ok: true,
      decisionId: row.decision_id,
      status: row.status,
    });
  } catch (err) {
    console.error(
      "POST /api/d/decide failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { ok: false, error: "Could not save your decision. Please try again." },
      { status: 500 },
    );
  }
}
