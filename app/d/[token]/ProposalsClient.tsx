"use client";

import { useState } from "react";

export interface DashboardProposal {
  decision_id: string;
  title: string;
  description: string;
  owner: string | null;
  ownerName: string;
  priority: string | null;
  status: string;
  kind: string;
  payload: unknown;
  previewUrl: string | null;
}

interface LedgerRow {
  item?: unknown;
  quantity?: unknown;
  unit_price?: unknown;
  unitPrice?: unknown;
  amount?: unknown;
  confidence?: unknown;
}

function ledgerRowsOf(p: DashboardProposal): LedgerRow[] | null {
  if (p.kind !== "ledger") return null;
  const payload = p.payload as { entries?: unknown } | null;
  if (!payload || !Array.isArray(payload.entries)) return null;
  return payload.entries.filter(
    (e): e is LedgerRow => typeof e === "object" && e !== null,
  );
}

function naira(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n)
    ? `₦${n.toLocaleString("en-NG")}`
    : "—";
}

const ACCENT = "#B3122B";
const INK = "#1B1B1B";
const PAPER = "#FFFDF6";

export default function ProposalsClient({
  token,
  initial,
}: {
  token: string;
  initial: DashboardProposal[];
}) {
  const [proposals, setProposals] = useState(initial);
  const [changeFor, setChangeFor] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(decisionId: string, status: string, note?: string) {
    setError("");
    setBusy(decisionId);
    try {
      const res = await fetch("/api/d/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, decisionId, status, note }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        status?: string;
      };
      if (!data.ok) {
        setError(data.error || "Could not save your decision.");
        return;
      }
      setProposals((prev) =>
        prev.map((p) =>
          p.decision_id === decisionId
            ? { ...p, status: (data.status as string) ?? status }
            : p,
        ),
      );
      setChangeFor(null);
      setChangeNote("");
    } catch {
      setError("Could not save your decision. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");

  return (
    <div>
      {error && (
        <p
          style={{
            background: "#FDE8E8",
            color: "#7F1D1D",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 15,
          }}
        >
          {error}
        </p>
      )}
      {pending.length === 0 && (
        <p style={{ margin: "12px 0 0", fontSize: 16, color: "#5C5346" }}>
          Nothing waiting — your team will pin new proposals here.
        </p>
      )}
      <div style={{ display: "grid", gap: 18, marginTop: 16 }}>
        {pending.map((p, i) => {
          const rows = ledgerRowsOf(p);
          return (
            <article
              key={p.decision_id}
              style={{
                background: PAPER,
                padding: "22px 22px 20px",
                boxShadow: "0 10px 20px rgba(60,40,10,0.22)",
                transform: `rotate(${i % 2 === 0 ? -0.6 : 0.6}deg)`,
                position: "relative",
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: -11,
                  left: "42%",
                  width: 90,
                  height: 22,
                  background: "rgba(247,217,76,0.85)",
                  transform: "rotate(-3deg)",
                }}
              />
              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 1.5,
                  color: "#5C5346",
                }}
              >
                {p.ownerName ? `${p.ownerName.toUpperCase()} SUGGESTS` : "SUGGESTION FOR YOU"}
              </p>
              <h3 style={{ margin: "6px 0 0", fontSize: 21, lineHeight: 1.35 }}>
                {p.title}
              </h3>
              <p style={{ margin: "8px 0 0", fontSize: 16, lineHeight: 1.55 }}>
                {p.description}
              </p>
              {p.previewUrl && p.kind === "video" ? (
                <video
                  src={p.previewUrl}
                  controls
                  preload="metadata"
                  playsInline
                  style={{
                    marginTop: 12,
                    width: "100%",
                    maxHeight: 420,
                    borderRadius: 8,
                    background: "#000",
                  }}
                />
              ) : p.previewUrl && p.kind === "statement" ? (
                <p style={{ margin: "12px 0 0" }}>
                  <a
                    href={p.previewUrl}
                    download
                    style={{ color: INK, fontWeight: 700 }}
                  >
                    Download the statement (PDF)
                  </a>
                </p>
              ) : p.previewUrl ? (
                <img
                  src={p.previewUrl}
                  alt=""
                  style={{
                    marginTop: 12,
                    width: "100%",
                    borderRadius: 8,
                    border: "1px solid #E5DCC8",
                  }}
                />
              ) : null}
              {rows && rows.length > 0 && (
                <div
                  style={{
                    marginTop: 12,
                    overflowX: "auto",
                    border: "1px solid #E5DCC8",
                    borderRadius: 8,
                  }}
                >
                  <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "#5C5346", fontSize: 12 }}>
                        <th style={{ padding: "6px 8px", fontWeight: 500 }}>Item</th>
                        <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>Qty</th>
                        <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>Price</th>
                        <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, j) => {
                        const low =
                          typeof r.confidence === "number" && r.confidence < 0.7;
                        return (
                          <tr
                            key={j}
                            style={{
                              borderTop: "1px solid #EFE7D3",
                              background: low ? "#FEF3C7" : "transparent",
                            }}
                            title={low ? "Low confidence — check this row" : undefined}
                          >
                            <td style={{ padding: "6px 8px" }}>
                              {typeof r.item === "string" && r.item ? r.item : "—"}
                            </td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }}>
                              {typeof r.quantity === "number" ? r.quantity : "—"}
                            </td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }}>
                              {naira(r.unit_price ?? r.unitPrice)}
                            </td>
                            <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700 }}>
                              {naira(r.amount)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {changeFor === p.decision_id ? (
                <div style={{ marginTop: 12 }}>
                  <textarea
                    rows={2}
                    value={changeNote}
                    onChange={(e) => setChangeNote(e.target.value)}
                    placeholder="What should change?"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      borderRadius: 8,
                      border: "1px solid #C9BFA9",
                      padding: "10px 12px",
                      fontSize: 16,
                      fontFamily: "inherit",
                    }}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      type="button"
                      disabled={!changeNote.trim() || busy === p.decision_id}
                      onClick={() =>
                        decide(p.decision_id, "changes_requested", changeNote.trim())
                      }
                      style={{
                        flex: 1,
                        borderRadius: 8,
                        border: "none",
                        background: "#1D4ED8",
                        color: "#fff",
                        fontWeight: 700,
                        fontSize: 15,
                        padding: "11px 0",
                        opacity: !changeNote.trim() || busy === p.decision_id ? 0.5 : 1,
                      }}
                    >
                      Send note
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setChangeFor(null);
                        setChangeNote("");
                      }}
                      style={{
                        flex: 1,
                        borderRadius: 8,
                        border: "1px solid #C9BFA9",
                        background: "#fff",
                        fontWeight: 700,
                        fontSize: 15,
                        padding: "11px 0",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button
                    type="button"
                    disabled={busy === p.decision_id}
                    onClick={() => decide(p.decision_id, "approved")}
                    style={{
                      flex: 1,
                      borderRadius: 8,
                      border: "none",
                      background: ACCENT,
                      color: "#fff",
                      fontWeight: 700,
                      fontSize: 15,
                      padding: "11px 0",
                      opacity: busy === p.decision_id ? 0.5 : 1,
                    }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy === p.decision_id}
                    onClick={() => {
                      setChangeFor(p.decision_id);
                      setChangeNote("");
                    }}
                    style={{
                      flex: 1,
                      borderRadius: 8,
                      border: `2px solid ${INK}`,
                      background: "#fff",
                      fontWeight: 700,
                      fontSize: 15,
                      padding: "9px 0",
                    }}
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    disabled={busy === p.decision_id}
                    onClick={() => decide(p.decision_id, "rejected")}
                    style={{
                      flex: 1,
                      borderRadius: 8,
                      border: "1px solid #C9BFA9",
                      background: "#fff",
                      fontWeight: 700,
                      fontSize: 15,
                      padding: "11px 0",
                    }}
                  >
                    Reject
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {decided.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h3 style={{ margin: 0, fontSize: 15, color: "#5C5346" }}>
            Decided ({decided.length})
          </h3>
          <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 8 }}>
            {decided.map((p) => (
              <li
                key={p.decision_id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  background: PAPER,
                  borderRadius: 8,
                  padding: "10px 14px",
                  fontSize: 15,
                }}
              >
                <span>{p.title}</span>
                <span
                  style={{
                    flexShrink: 0,
                    borderRadius: 999,
                    padding: "3px 12px",
                    fontSize: 13,
                    fontWeight: 700,
                    background:
                      p.status === "approved"
                        ? "#DCFCE7"
                        : p.status === "changes_requested"
                          ? "#DBEAFE"
                          : "#E7E5E4",
                    color:
                      p.status === "approved"
                        ? "#166534"
                        : p.status === "changes_requested"
                          ? "#1D4ED8"
                          : "#57534E",
                  }}
                >
                  {p.status === "changes_requested" ? "Change requested" : p.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
