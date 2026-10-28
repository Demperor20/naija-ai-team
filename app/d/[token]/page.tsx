import type { CSSProperties } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { Anton, Caveat, Work_Sans } from "next/font/google";
import {
  getCompanyByToken,
  getLedgerDaily,
  getWhoOwesMe,
  listAgentRunsByMessage,
  listCompanyMessages,
  listDecisions,
  listFiles,
  type FileRow,
} from "@/lib/db";
import {
  decisionToDTO,
  withPreviewUrls,
} from "@/lib/agents/run";
import { AGENTS } from "@/lib/agents/team";
import ProposalsClient, {
  type DashboardProposal,
} from "./ProposalsClient";

// Owner dashboard (AGENTS.md section 17) in the landing page's Noticeboard
// style. The URL token is the only auth: whoever holds the link sees it.
// Blocking per-request render: the token picks the company at runtime.
export const instant = false;

const anton = Anton({ weight: "400", subsets: ["latin"], display: "swap" });
const caveat = Caveat({ weight: ["600", "700"], subsets: ["latin"], display: "swap" });
const workSans = Work_Sans({ weight: ["400", "500", "700"], subsets: ["latin"], display: "swap" });

const ACCENT = "#B3122B";
const INK = "#1B1B1B";
const BOARD = "#E7D3AE";
const PAPER = "#FFFDF6";
const MUTED = "#5C5346";

const ANTON = anton.style.fontFamily;
const CAVEAT = caveat.style.fontFamily;

const container: CSSProperties = {
  maxWidth: 880,
  margin: "0 auto",
  paddingLeft: 20,
  paddingRight: 20,
};
const sectionHeading: CSSProperties = {
  margin: 0,
  fontFamily: ANTON,
  fontWeight: 400,
  fontSize: 30,
  letterSpacing: 1,
  textTransform: "uppercase",
};
const card: CSSProperties = {
  background: PAPER,
  padding: "20px 20px 18px",
  boxShadow: "0 10px 20px rgba(60,40,10,0.22)",
  position: "relative",
};
const emptyNote: CSSProperties = {
  margin: "12px 0 0",
  fontSize: 16,
  color: MUTED,
};

function lagosDay(offsetDays: number): string {
  const now = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function naira(n: number): string {
  return `₦${Math.round(n).toLocaleString("en-NG")}`;
}

function isApproved(f: FileRow): boolean {
  const meta = f.meta as Record<string, unknown> | null;
  return !!meta && meta.approved === true;
}

function displayNameOf(key: string | null): string {
  if (!key) return "";
  return AGENTS.find((a) => a.key === key)?.displayName ?? key;
}

function shortModel(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  // Always rendered per request: the token picks the company at runtime.
  await connection();
  const { token } = await params;
  const company = await getCompanyByToken(token);

  if (!company) {
    return (
      <div
        className={workSans.className}
        style={{ color: INK, background: BOARD, minHeight: "100vh" }}
      >
        <main style={{ ...container, paddingTop: 80, paddingBottom: 80 }}>
          <div style={card}>
            <h1 style={{ ...sectionHeading, fontSize: 26 }}>
              This dashboard link doesn&apos;t work
            </h1>
            <p style={{ margin: "12px 0 0", fontSize: 17, lineHeight: 1.6 }}>
              Ask your team on WhatsApp for a fresh dashboard link.
            </p>
            <p style={{ margin: "16px 0 0" }}>
              <Link href="/try" style={{ color: INK, fontWeight: 700 }}>
                Or try the demo in your browser
              </Link>
            </p>
          </div>
        </main>
      </div>
    );
  }

  const [weekRows, owedRows, decisionRows, files, messages] = await Promise.all([
    getLedgerDaily(company.id, lagosDay(-6), lagosDay(0)),
    getWhoOwesMe(company.id, 10),
    listDecisions(company.id, "all"),
    listFiles(company.id),
    listCompanyMessages(company.id, 15),
  ]);
  const weekSales = weekRows.reduce((a, r) => a + (Number(r.sales) || 0), 0);
  const weekCosts = weekRows.reduce((a, r) => a + (Number(r.expenses) || 0), 0);
  const debtors = owedRows.filter((r) => (Number(r.balance) || 0) > 0);

  const proposals: DashboardProposal[] = (
    await withPreviewUrls(
      company.id,
      decisionRows.map(decisionToDTO),
    )
  ).map((d) => ({
    decision_id: d.decision_id,
    title: d.title,
    description: d.description,
    owner: d.owner,
    ownerName: displayNameOf(d.owner),
    priority: d.priority,
    status: d.status,
    kind: d.kind,
    payload: d.payload,
    previewUrl: d.previewUrl,
  }));

  const approvedFiles = files.filter(isApproved);
  const catalogue = approvedFiles.find((f) => f.kind === "catalogue") ?? null;
  const flyers = approvedFiles.filter((f) => f.kind === "flyer");
  const videos = approvedFiles.filter((f) => f.kind === "marketing_video");
  const statements = files.filter((f) => f.kind === "statement");
  const latestStatement =
    statements.find(isApproved) ?? statements[0] ?? null;

  const traces = await Promise.all(
    messages.map(async (m) => ({
      message: m,
      runs: await listAgentRunsByMessage(m.id),
    })),
  );

  return (
    <div
      className={workSans.className}
      style={{ color: INK, background: BOARD, minHeight: "100vh" }}
    >
      <header style={{ background: INK, color: "#FFFFFF" }}>
        <div
          style={{
            ...container,
            paddingTop: 18,
            paddingBottom: 18,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <p style={{ margin: 0, fontFamily: ANTON, fontSize: 24, letterSpacing: 1 }}>
            {company.name}
          </p>
          <p style={{ margin: 0, fontFamily: CAVEAT, fontSize: 24, color: "#F7D94C" }}>
            {company.owner_name}&apos;s dashboard
          </p>
        </div>
      </header>

      <main style={{ ...container, paddingTop: 36, paddingBottom: 72 }}>
        {/* This week */}
        <section>
          <h2 style={sectionHeading}>This week</h2>
          <div
            style={{
              marginTop: 16,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 16,
            }}
          >
            {[
              { label: "Sales", value: naira(weekSales), rotate: -1 },
              { label: "Costs", value: naira(weekCosts), rotate: 1 },
              {
                label: "Profit",
                value: naira(weekSales - weekCosts),
                rotate: -0.5,
              },
            ].map((s) => (
              <div
                key={s.label}
                style={{ ...card, transform: `rotate(${s.rotate}deg)` }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 1.5,
                    color: MUTED,
                  }}
                >
                  {s.label.toUpperCase()}
                </p>
                <p
                  style={{
                    margin: "4px 0 0",
                    fontFamily: ANTON,
                    fontSize: 34,
                    letterSpacing: 0.5,
                  }}
                >
                  {s.value}
                </p>
              </div>
            ))}
          </div>
          {weekRows.length === 0 && (
            <p style={emptyNote}>
              No sales recorded in the last 7 days yet. Send your notebook or
              receipts to Books to get started.
            </p>
          )}
        </section>

        {/* Who owes me */}
        <section style={{ marginTop: 44 }}>
          <h2 style={sectionHeading}>Who owes me</h2>
          {debtors.length === 0 ? (
            <p style={emptyNote}>Nobody owes the business money.</p>
          ) : (
            <div style={{ ...card, marginTop: 16 }}>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {debtors.map((d) => (
                  <li
                    key={d.counterparty}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "8px 0",
                      borderBottom: "1px dashed #D8CDB4",
                      fontSize: 17,
                    }}
                  >
                    <span>{d.counterparty}</span>
                    <strong>{naira(Number(d.balance) || 0)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Proposals */}
        <section style={{ marginTop: 44 }}>
          <h2 style={sectionHeading}>Proposals</h2>
          <p style={{ margin: "8px 0 0", fontFamily: CAVEAT, fontSize: 26, color: ACCENT }}>
            Stamp what you like — nothing goes out without your OK.
          </p>
          <div style={{ marginTop: 4 }}>
            <ProposalsClient token={token} initial={proposals} />
          </div>
        </section>

        {/* Catalogue */}
        <section style={{ marginTop: 44 }}>
          <h2 style={sectionHeading}>Catalogue</h2>
          {catalogue ? (
            <div style={{ ...card, marginTop: 16, transform: "rotate(0.5deg)" }}>
              <img
                src={catalogue.url}
                alt="Product catalogue"
                style={{ width: "100%", borderRadius: 6 }}
              />
            </div>
          ) : (
            <p style={emptyNote}>
              No catalogue yet. Ask Flyers &amp; Catalogue to cut out your
              products and lay one out.
            </p>
          )}
        </section>

        {/* Flyers and videos */}
        <section style={{ marginTop: 44 }}>
          <h2 style={sectionHeading}>Flyers &amp; videos</h2>
          {flyers.length === 0 && videos.length === 0 ? (
            <p style={emptyNote}>
              No flyers or videos yet. Ask Promotion or Flyers &amp; Catalogue
              to make one.
            </p>
          ) : (
            <div
              style={{
                marginTop: 16,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 16,
              }}
            >
              {flyers.map((f, i) => (
                <div
                  key={f.id}
                  style={{
                    ...card,
                    padding: 10,
                    transform: `rotate(${i % 2 === 0 ? -1 : 1}deg)`,
                  }}
                >
                  <img
                    src={f.url}
                    alt="Flyer"
                    style={{ width: "100%", borderRadius: 4 }}
                  />
                </div>
              ))}
              {videos.map((f) => (
                <div key={f.id} style={{ ...card, padding: 10 }}>
                  <video
                    src={f.url}
                    controls
                    preload="metadata"
                    playsInline
                    style={{
                      width: "100%",
                      maxHeight: 420,
                      borderRadius: 4,
                      background: "#000",
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Statement */}
        <section style={{ marginTop: 44 }}>
          <h2 style={sectionHeading}>Statement</h2>
          {latestStatement ? (
            <div style={{ ...card, marginTop: 16 }}>
              <p style={{ margin: 0, fontSize: 17 }}>
                <a
                  href={latestStatement.url}
                  download
                  style={{ color: INK, fontWeight: 700 }}
                >
                  Download the latest statement (PDF)
                </a>
              </p>
              <p style={{ margin: "6px 0 0", fontSize: 14, color: MUTED }}>
                {isApproved(latestStatement)
                  ? "Approved by you."
                  : "Waiting for your approval above."}{" "}
                Designed to share with lenders; not audited accounts.
              </p>
            </div>
          ) : (
            <p style={emptyNote}>
              No statement yet. Ask Books to “send my statement” after you
              approve some sales.
            </p>
          )}
        </section>

        {/* Agent trace */}
        <section style={{ marginTop: 44 }}>
          <h2 style={sectionHeading}>How the team worked</h2>
          {traces.length === 0 ? (
            <p style={emptyNote}>No conversations yet.</p>
          ) : (
            <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
              {traces.map(({ message, runs }) => (
                <details
                  key={message.id}
                  style={{ ...card, padding: "14px 18px" }}
                >
                  <summary
                    style={{ cursor: "pointer", fontSize: 16, lineHeight: 1.5 }}
                  >
                    <strong>{message.agent_name}</strong>
                    {message.owner_message
                      ? ` — ${message.owner_message.slice(0, 90)}${message.owner_message.length > 90 ? "…" : ""}`
                      : ""}
                    <span style={{ color: MUTED, fontSize: 14 }}>
                      {" "}
                      · {runs.length} step{runs.length === 1 ? "" : "s"} ·{" "}
                      {new Date(message.created_at).toLocaleString("en-GB", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </summary>
                  <ol
                    style={{
                      margin: "12px 0 0",
                      padding: 0,
                      listStyle: "none",
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    {runs.length === 0 && (
                      <li style={{ fontSize: 14, color: MUTED }}>
                        No steps recorded.
                      </li>
                    )}
                    {runs.map((r) => (
                      <li
                        key={r.id}
                        style={{
                          fontSize: 14,
                          lineHeight: 1.5,
                          borderTop: "1px dashed #D8CDB4",
                          paddingTop: 8,
                        }}
                      >
                        <span
                          style={{
                            display: "inline-block",
                            borderRadius: 999,
                            background: "#EFE9D8",
                            padding: "1px 10px",
                            fontSize: 12,
                            fontWeight: 700,
                            marginRight: 8,
                          }}
                        >
                          {displayNameOf(r.agent_key) || r.agent_key}
                        </span>
                        <span style={{ color: MUTED }}>
                          {shortModel(r.model)} · {r.step}
                          {r.ms !== null && r.ms !== undefined
                            ? ` · ${(r.ms / 1000).toFixed(1)}s`
                            : ""}
                        </span>
                        {r.provider === "baseten" && (
                          <span
                            title="Served by the Meta open-weight model Muse Spark Open"
                            style={{
                              display: "inline-block",
                              borderRadius: 999,
                              background: "#DCFCE7",
                              color: "#166534",
                              padding: "1px 10px",
                              fontSize: 12,
                              fontWeight: 700,
                              marginLeft: 8,
                            }}
                          >
                            open weights
                          </span>
                        )}
                        {r.detail && (
                          <span style={{ display: "block", marginTop: 2 }}>
                            {r.detail}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer style={{ background: INK, color: "#D8CFC0" }}>
        <div
          style={{
            ...container,
            paddingTop: 22,
            paddingBottom: 22,
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: 10,
            fontSize: 14,
          }}
        >
          <span style={{ fontFamily: ANTON, letterSpacing: 1, color: "#FFFFFF" }}>
            NAIJA AI TEAM
          </span>
          <span>Keep this link private — it opens your dashboard.</span>
        </div>
      </footer>
    </div>
  );
}
