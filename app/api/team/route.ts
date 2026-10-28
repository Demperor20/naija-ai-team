import { after, NextResponse } from "next/server";
import {
  getRecentMessages,
  listDecisions,
  setDecisionStatus,
  type DecisionStatus,
} from "@/lib/db";
import { drainCompanyVideoJobs } from "@/lib/video";
import { getSessionCompanyId } from "@/lib/session";
import {
  decisionToDTO,
  runTeam,
  withPreviewUrls,
} from "@/lib/agents/run";
import { applyDecision } from "@/lib/decisions";
import {
  checkCompanyRateLimit,
  RATE_LIMIT_MESSAGE,
} from "@/lib/rate-limit";

export const maxDuration = 300;

const DECISION_FILTERS: ReadonlyArray<string> = [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "all",
];
const DECIDE_STATUSES: ReadonlyArray<string> = [
  "approved",
  "rejected",
  "changes_requested",
];

function channelOf(body: Record<string, unknown>): string {
  return typeof body.channelId === "string" && body.channelId
    ? body.channelId
    : "general";
}

export async function POST(request: Request) {
  const companyId = await getSessionCompanyId();
  if (!companyId) {
    return NextResponse.json(
      {
        ok: false,
        error: "Your session expired. Please start again from the Try-it page.",
      },
      { status: 401 },
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Please send a valid request." },
      { status: 400 },
    );
  }
  const action = body.action;
  try {
    switch (action) {
      case "message": {
        if (typeof body.message !== "string" || !body.message.trim()) {
          return NextResponse.json(
            { ok: false, error: "Please write a message first." },
            { status: 400 },
          );
        }
        if (!(await checkCompanyRateLimit(companyId)).allowed) {
          return NextResponse.json(
            { ok: false, error: RATE_LIMIT_MESSAGE },
            { status: 429 },
          );
        }
        const result = await runTeam({
          companyId,
          channelId: channelOf(body),
          message: body.message.trim(),
          source: "tryit",
        });
        // Queued video renders run after the response, so the chat never
        // waits on them; the finished video arrives as its own proposal.
        after(() =>
          drainCompanyVideoJobs(companyId).catch((err) =>
            console.error(
              "team video drain failed:",
              err instanceof Error ? err.message : err,
            ),
          ),
        );
        return NextResponse.json(result);
      }
      case "history": {
        const limit =
          typeof body.limit === "number" && body.limit > 0
            ? Math.min(Math.floor(body.limit), 50)
            : 20;
        const rows = await getRecentMessages(
          companyId,
          channelOf(body),
          limit,
        );
        return NextResponse.json({
          ok: true,
          messages: rows.map((m) => ({
            agent: m.agent_name,
            ownerMessage: m.owner_message,
            reply: m.reply,
            createdAt: m.created_at,
          })),
        });
      }
      case "decisions": {
        const status =
          typeof body.status === "string" ? body.status : "all";
        if (!DECISION_FILTERS.includes(status)) {
          return NextResponse.json(
            { ok: false, error: "Please send a valid request." },
            { status: 400 },
          );
        }
        const rows = await listDecisions(
          companyId,
          status as DecisionStatus | "all",
        );
        return NextResponse.json({
          ok: true,
          decisions: await withPreviewUrls(
            companyId,
            rows.map(decisionToDTO),
          ),
        });
      }
      case "decide": {
        const { decisionId, status, note } = body;
        if (typeof decisionId !== "string" || !decisionId) {
          return NextResponse.json(
            { ok: false, error: "That proposal was not found." },
            { status: 400 },
          );
        }
        if (typeof status !== "string" || !DECIDE_STATUSES.includes(status)) {
          return NextResponse.json(
            { ok: false, error: "Please choose Approve, Change or Reject." },
            { status: 400 },
          );
        }
        const row = await setDecisionStatus(
          companyId,
          decisionId,
          status as DecisionStatus,
          typeof note === "string" ? note : undefined,
        );
        if (status === "approved") {
          // The status change above is the source of truth; a failed apply
          // must not turn the owner's tap into an error.
          try {
            await applyDecision(companyId, decisionId);
          } catch (err) {
            console.error(
              `decide apply failed for ${decisionId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
        return NextResponse.json({
          ok: true,
          decisionId: row.decision_id,
          status: row.status,
        });
      }
      default:
        return NextResponse.json(
          { ok: false, error: "Unknown action." },
          { status: 400 },
        );
    }
  } catch (err) {
    console.error(
      `POST /api/team (${String(action)}) failed:`,
      err instanceof Error ? err.message : err,
    );
    const message =
      err instanceof Error && err.message.includes("not found")
        ? "That proposal was not found."
        : "Sorry, something went wrong. Please try again.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
