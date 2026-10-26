import { NextResponse } from "next/server";
import { createCompany } from "@/lib/db";
import { setSessionCookie } from "@/lib/session";
import { runTeam } from "@/lib/agents/run";

export const maxDuration = 300;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Please send valid details." },
      { status: 400 },
    );
  }
  const { ownerName, name, oneLiner, description, targetCustomer, goals, stage } =
    body;
  if (
    !isNonEmptyString(ownerName) ||
    !isNonEmptyString(name) ||
    !isNonEmptyString(oneLiner) ||
    !isNonEmptyString(description) ||
    !isNonEmptyString(goals) ||
    !isNonEmptyString(stage)
  ) {
    return NextResponse.json(
      { ok: false, error: "Please fill in every required field." },
      { status: 400 },
    );
  }
  if (targetCustomer !== undefined && typeof targetCustomer !== "string") {
    return NextResponse.json(
      { ok: false, error: "Please send valid details." },
      { status: 400 },
    );
  }
  try {
    const company = await createCompany({
      ownerName: ownerName.trim(),
      name: name.trim(),
      oneLiner: oneLiner.trim(),
      description: description.trim(),
      targetCustomer:
        typeof targetCustomer === "string" && targetCustomer.trim()
          ? targetCustomer.trim()
          : undefined,
      goals: goals.trim(),
      stage: stage.trim(),
      source: "tryit",
    });
    await setSessionCookie(company.id);
    const kickoff = await runTeam({
      companyId: company.id,
      channelId: "general",
      message: "(New business signed up)",
      source: "tryit",
      isKickoff: true,
    });
    return NextResponse.json({
      ok: true,
      companyId: company.id,
      dashboardUrl: `/d/${company.access_token}`,
      kickoff,
    });
  } catch (err) {
    console.error(
      "POST /api/start failed:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      {
        ok: false,
        error:
          "Sorry, something went wrong setting up your team. Please try again.",
      },
      { status: 500 },
    );
  }
}
