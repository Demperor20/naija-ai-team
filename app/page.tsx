import Link from "next/link";
import { AGENTS } from "@/lib/agents/team";

const BLURBS: Record<string, string> = {
  ceo: "Leads your team, sets priorities, reports back.",
  product: "Shapes what you sell and what to do first.",
  marketing: "Gets you noticed: messages, posts, promos.",
  design: "Name, look, flyers and catalogue pages.",
  engineering: "Tools and build plans that fit your budget.",
  sales: "Customers, pricing, offers and follow-ups.",
  compliance: "Registration, tax ID and basic rules.",
};

const STEPS = [
  {
    title: "Introduce your business",
    body: "Tell the team what you sell, who buys, and your 90-day goal. Two minutes, on the web or WhatsApp.",
  },
  {
    title: "Chat with your team",
    body: "Ask anything. The CEO plans the work, specialists research and draft, and everything stays in plain language.",
  },
  {
    title: "Approve with one tap",
    body: "Every recommendation arrives as a proposal. Approve, request changes or reject — nothing happens without your OK.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-stone-50 text-stone-900">
      <div className="mx-auto max-w-2xl px-5 pb-16">
        <header className="flex items-center justify-between py-6">
          <p className="font-display text-lg font-semibold text-green-950">
            Naija AI Team
          </p>
          <Link
            href="/try"
            className="rounded-lg border border-green-900 px-4 py-2 text-sm font-medium text-green-900"
          >
            Try it
          </Link>
        </header>

        <section className="mt-8">
          <h1 className="font-display text-4xl font-semibold leading-tight text-green-950">
            Your AI business team on WhatsApp.
          </h1>
          <p className="mt-4 text-lg leading-7 text-stone-700">
            Seven AI teammates for Nigerian founders: they research, plan and
            draft while you run your shop. You approve everything with one
            tap.
          </p>
          <Link
            href="/try"
            className="mt-6 inline-block rounded-lg bg-green-900 px-6 py-3 font-medium text-white"
          >
            Try it now
          </Link>
        </section>

        <section className="mt-14">
          <h2 className="font-display text-2xl font-semibold text-green-950">
            How it works
          </h2>
          <ol className="mt-6 space-y-6">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-900 text-sm font-semibold text-white">
                  {i + 1}
                </span>
                <div>
                  <p className="font-semibold text-green-950">{step.title}</p>
                  <p className="mt-1 leading-6 text-stone-700">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-14">
          <h2 className="font-display text-2xl font-semibold text-green-950">
            Meet the team
          </h2>
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
                  <p className="font-medium text-green-950">
                    {agent.displayName}
                  </p>
                  <p className="text-sm text-stone-600">
                    {BLURBS[agent.key]}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-12 border-t border-stone-200 pt-6 text-sm leading-6 text-stone-600">
          The rule: nothing is launched, sent, posted or paid for without
          your approval. Approved decisions become settled facts the whole
          team builds on.
        </p>
      </div>
    </main>
  );
}
