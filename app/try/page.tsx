"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AGENTS } from "@/lib/agents/team";

type Phase = "intake" | "assembling" | "chat";

interface ChatMessage {
  agent: string;
  ownerMessage: string;
  reply: string;
  createdAt: string;
}

interface Proposal {
  decision_id: string;
  title: string;
  description: string;
  category: string | null;
  owner: string | null;
  priority: string | null;
  status: string;
  channel_id: string;
  owner_note: string | null;
  createdAt: string;
}

interface ApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

const STAGES = ["Idea", "Building", "Running", "Growing"];
const KICKOFF_TIMEOUT_MS = 150_000;

async function postJSON(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<ApiResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return (await res.json()) as ApiResponse;
}

function agentByChannel(channelId: string) {
  return AGENTS.find((a) => a.channel === channelId) ?? AGENTS[0];
}

function agentByName(displayName: string) {
  return AGENTS.find((a) => a.displayName === displayName) ?? AGENTS[0];
}

function agentNameOfKey(key: string | null): string {
  if (!key) return "";
  return AGENTS.find((a) => a.key === key)?.displayName ?? key;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900",
  approved: "bg-green-100 text-green-900",
  rejected: "bg-stone-200 text-stone-700",
  changes_requested: "bg-blue-100 text-blue-900",
};

const MARKDOWN_STYLES = [
  "[&_p]:my-2",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold",
  "[&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_table]:my-2 [&_table]:w-full [&_table]:text-sm",
  "[&_th]:py-1 [&_th]:pr-3 [&_th]:text-left",
  "[&_td]:border-t [&_td]:border-stone-200 [&_td]:py-1 [&_td]:pr-3",
  "[&_a]:text-green-800 [&_a]:underline",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-green-800 [&_blockquote]:pl-3 [&_blockquote]:text-stone-700",
  "[&_code]:rounded [&_code]:bg-stone-100 [&_code]:px-1",
].join(" ");

const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base text-stone-900 placeholder:text-stone-400 focus:border-green-900 focus:outline-none";
const labelClass = "mb-1 block text-sm font-medium text-stone-700";

export default function TryPage() {
  const [phase, setPhase] = useState<Phase>("intake");
  const [ownerName, setOwnerName] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetCustomer, setTargetCustomer] = useState("");
  const [goals, setGoals] = useState("");
  const [stage, setStage] = useState("Idea");
  const [formError, setFormError] = useState("");

  const [channel, setChannel] = useState("general");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [changeFor, setChangeFor] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const pollRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending, phase]);

  const loadHistory = useCallback(async (channelId: string) => {
    const data = await postJSON("/api/team", {
      action: "history",
      channelId,
      limit: 20,
    });
    if (data.ok) setMessages(data.messages as ChatMessage[]);
  }, []);

  const loadDecisions = useCallback(async () => {
    const data = await postJSON("/api/team", {
      action: "decisions",
      status: "all",
    });
    if (data.ok) setProposals(data.decisions as Proposal[]);
  }, []);

  async function startTeam(e: FormEvent) {
    e.preventDefault();
    setFormError("");
    if (
      !ownerName.trim() ||
      !name.trim() ||
      !description.trim() ||
      !goals.trim()
    ) {
      setFormError(
        "Please fill in your name, business name, what you sell, and your goal.",
      );
      return;
    }
    setPhase("assembling");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KICKOFF_TIMEOUT_MS);
    try {
      const data = await postJSON(
        "/api/start",
        {
          ownerName: ownerName.trim(),
          name: name.trim(),
          oneLiner: description.trim().slice(0, 140),
          description: description.trim(),
          targetCustomer: targetCustomer.trim() || undefined,
          goals: goals.trim(),
          stage,
        },
        controller.signal,
      );
      window.clearTimeout(timer);
      if (!data.ok) {
        setFormError(data.error || "Something went wrong. Please try again.");
        setPhase("intake");
        return;
      }
      setMessages([
        {
          agent: data.kickoff.agentName as string,
          ownerMessage: "",
          reply: data.kickoff.reply as string,
          createdAt: new Date().toISOString(),
        },
      ]);
      setProposals(data.kickoff.decisions as Proposal[]);
      setPhase("chat");
    } catch {
      // The kickoff timed out in the browser, but the server keeps working.
      // Poll history until the reply appears.
      window.clearTimeout(timer);
      setPhase("chat");
      setSyncing(true);
      setMessages([]);
      let tries = 0;
      stopPolling();
      pollRef.current = window.setInterval(async () => {
        tries++;
        try {
          const data = await postJSON("/api/team", {
            action: "history",
            channelId: "general",
            limit: 5,
          });
          if (data.ok && (data.messages as ChatMessage[]).length > 0) {
            setMessages(data.messages as ChatMessage[]);
            await loadDecisions();
            setSyncing(false);
            stopPolling();
          } else if (tries >= 36) {
            setSyncing(false);
            setError(
              "Your team is taking longer than expected. Please refresh in a minute.",
            );
            stopPolling();
          }
        } catch {
          // Keep polling.
        }
      }, 5000);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    setError("");
    try {
      const data = await postJSON("/api/team", {
        action: "message",
        channelId: channel,
        message: text,
      });
      if (!data.ok) {
        setError(data.error || "Sorry, something went wrong. Please try again.");
        setDraft(text);
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          agent: data.agentName as string,
          ownerMessage: text,
          reply: data.reply as string,
          createdAt: new Date().toISOString(),
        },
      ]);
      const fresh = data.decisions as Proposal[];
      if (fresh?.length) {
        setProposals((prev) => {
          const ids = new Set(prev.map((p) => p.decision_id));
          return [...fresh.filter((p) => !ids.has(p.decision_id)), ...prev];
        });
      }
    } catch {
      setError("Sorry, something went wrong. Please try again.");
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  async function pickChannel(channelId: string) {
    if (channelId === channel) return;
    setChannel(channelId);
    setError("");
    try {
      await loadHistory(channelId);
    } catch {
      setError("Could not load that conversation. Please try again.");
    }
  }

  async function decide(decisionId: string, status: string, note?: string) {
    setError("");
    try {
      const data = await postJSON("/api/team", {
        action: "decide",
        decisionId,
        status,
        note,
      });
      if (!data.ok) {
        setError(data.error || "Could not save your decision. Please try again.");
        return;
      }
      setProposals((prev) =>
        prev.map((p) =>
          p.decision_id === decisionId
            ? { ...p, status: data.status as string, owner_note: note ?? p.owner_note }
            : p,
        ),
      );
      setChangeFor(null);
      setChangeNote("");
    } catch {
      setError("Could not save your decision. Please try again.");
    }
  }

  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");

  if (phase === "intake") {
    return (
      <main className="min-h-screen bg-stone-50 text-stone-900">
        <div className="mx-auto max-w-2xl px-5 py-10">
          <p className="font-display text-lg font-semibold text-green-950">
            Naija AI Team
          </p>
          <h1 className="font-display mt-6 text-3xl font-semibold text-green-950">
            Tell the team about your business
          </h1>
          <p className="mt-2 leading-6 text-stone-700">
            Two minutes. Your CEO reads it and the team gets to work.
          </p>
          <form onSubmit={startTeam} className="mt-6 space-y-4">
            <div>
              <label className={labelClass} htmlFor="ownerName">
                Your name
              </label>
              <input
                id="ownerName"
                className={inputClass}
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="e.g. Nkechi"
                autoComplete="name"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="name">
                Business name
              </label>
              <input
                id="name"
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Mama Nkechi Kitchen"
                autoComplete="organization"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="description">
                What you sell or plan to build
              </label>
              <textarea
                id="description"
                className={inputClass}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Jollof, small chops and zobo in Yaba, Lagos"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="targetCustomer">
                Who are your customers? <span className="font-normal">(optional)</span>
              </label>
              <input
                id="targetCustomer"
                className={inputClass}
                value={targetCustomer}
                onChange={(e) => setTargetCustomer(e.target.value)}
                placeholder="e.g. Office workers and party hosts"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="goals">
                Your 3-month goal
              </label>
              <input
                id="goals"
                className={inputClass}
                value={goals}
                onChange={(e) => setGoals(e.target.value)}
                placeholder="e.g. 50 regular customers in 90 days"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="stage">
                Stage
              </label>
              <select
                id="stage"
                className={inputClass}
                value={stage}
                onChange={(e) => setStage(e.target.value)}
              >
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            {formError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                {formError}
              </p>
            )}
            <button
              type="submit"
              className="w-full rounded-lg bg-green-900 px-6 py-3 font-medium text-white"
            >
              Assemble my team
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (phase === "assembling") {
    return (
      <main className="min-h-screen bg-stone-50 text-stone-900">
        <div className="mx-auto max-w-2xl px-5 py-10">
          <h1 className="font-display text-3xl font-semibold text-green-950">
            Assembling your team
          </h1>
          <p className="mt-2 leading-6 text-stone-700">
            Your CEO is reading your answers. This takes about a minute.
          </p>
          <ul className="mt-6 divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
            {AGENTS.map((agent) => (
              <li key={agent.key} className="flex items-center gap-3 px-4 py-3">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                  style={{ backgroundColor: agent.colour }}
                >
                  {agent.initials}
                </span>
                <div>
                  <p className="font-medium text-green-950">{agent.displayName}</p>
                  <p className="animate-pulse text-sm text-stone-500">
                    Getting ready…
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-stone-50 text-stone-900">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 pb-4">
        <header className="flex items-center justify-between py-4">
          <p className="font-display text-lg font-semibold text-green-950">
            Naija AI Team
          </p>
          <p
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              pending.length > 0
                ? "bg-amber-100 text-amber-900"
                : "bg-green-100 text-green-900"
            }`}
          >
            Pending approvals: {pending.length}
          </p>
        </header>

        <div className="flex gap-2 overflow-x-auto pb-2">
          {AGENTS.map((agent) => {
            const active = channel === agent.channel;
            return (
              <button
                key={agent.key}
                type="button"
                onClick={() => pickChannel(agent.channel)}
                className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium ${
                  active
                    ? "border-green-900 bg-green-900 text-white"
                    : "border-stone-300 bg-white text-stone-700"
                }`}
              >
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ backgroundColor: agent.colour }}
                >
                  {agent.initials}
                </span>
                {agent.key === "ceo" ? "CEO" : agent.displayName.split(" ")[0]}
              </button>
            );
          })}
        </div>

        {error && (
          <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        {syncing && (
          <p className="mt-2 animate-pulse rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Your team is still working — the reply will appear here.
          </p>
        )}

        <div className="mt-3 flex-1 space-y-4">
          {messages.map((m, i) => {
            const agent = agentByName(m.agent);
            return (
              <div key={`${m.createdAt}-${i}`} className="space-y-2">
                {m.ownerMessage && (
                  <div className="ml-10 rounded-xl rounded-br-sm bg-green-900 px-4 py-2.5 text-[15px] leading-6 text-white">
                    {m.ownerMessage}
                  </div>
                )}
                <div className="mr-4 rounded-xl rounded-bl-sm border border-stone-200 bg-white px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white"
                      style={{ backgroundColor: agent.colour }}
                    >
                      {agent.initials}
                    </span>
                    <p className="text-sm font-semibold text-green-950">
                      {m.agent}
                    </p>
                  </div>
                  <div className={`${MARKDOWN_STYLES} text-[15px] leading-6 text-stone-800`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.reply}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            );
          })}
          {sending && (
            <p className="animate-pulse text-sm text-stone-500">
              {agentByChannel(channel).displayName} is thinking…
            </p>
          )}
          <div ref={bottomRef} />
        </div>

        {pending.length > 0 && (
          <section className="mt-6">
            <h2 className="font-display text-xl font-semibold text-green-950">
              Proposals for you ({pending.length})
            </h2>
            <div className="mt-3 space-y-3">
              {pending.map((p) => (
                <div
                  key={p.decision_id}
                  className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3"
                >
                  <p className="font-semibold text-green-950">{p.title}</p>
                  <p className="mt-1 text-sm leading-6 text-stone-700">
                    {p.description}
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    {agentNameOfKey(p.owner)}
                    {p.priority ? ` · ${p.priority} priority` : ""}
                  </p>
                  {changeFor === p.decision_id ? (
                    <div className="mt-2 space-y-2">
                      <textarea
                        className={inputClass}
                        rows={2}
                        value={changeNote}
                        onChange={(e) => setChangeNote(e.target.value)}
                        placeholder="What should change?"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={!changeNote.trim()}
                          onClick={() =>
                            decide(p.decision_id, "changes_requested", changeNote.trim())
                          }
                          className="flex-1 rounded-lg bg-blue-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                        >
                          Send note
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setChangeFor(null);
                            setChangeNote("");
                          }}
                          className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => decide(p.decision_id, "approved")}
                        className="flex-1 rounded-lg bg-green-900 px-3 py-2 text-sm font-medium text-white"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setChangeFor(p.decision_id);
                          setChangeNote("");
                        }}
                        className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700"
                      >
                        Change
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(p.decision_id, "rejected")}
                        className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {decided.length > 0 && (
          <section className="mt-6">
            <h2 className="text-sm font-semibold text-stone-500">
              Decided ({decided.length})
            </h2>
            <ul className="mt-2 space-y-2">
              {decided.map((p) => (
                <li
                  key={p.decision_id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2"
                >
                  <p className="text-sm text-stone-700">{p.title}</p>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[p.status] ?? "bg-stone-200 text-stone-700"}`}
                  >
                    {p.status === "changes_requested"
                      ? "Change requested"
                      : p.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <form
          onSubmit={send}
          className="sticky bottom-0 -mx-4 mt-6 flex gap-2 border-t border-stone-200 bg-stone-50 px-4 pb-2 pt-3"
        >
          <input
            className={inputClass}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Ask ${agentByChannel(channel).displayName}…`}
            aria-label="Message your team"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="shrink-0 rounded-lg bg-green-900 px-5 py-2.5 font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
    </main>
  );
}
