# Naija AI Team — hackathon submission

Meta Global AI Developer Hackathon · Indie developer track · **Build for Your World** category · Building period Oct 26 – Nov 4, 2026.

**Everything in this repository was built during the hackathon.** The repository was created empty on Oct 26, 2026, and the git history shows every step.

## The idea and the problem

I have carried this idea for a very long time, because I have lived the problem firsthand. I live in Nigeria. I have been to the markets, I have sat with traders and small-business owners, and I have asked them what is hard about running their business. As a digital skills trainer with Google Digital Skills for Africa, I have heard these problems directly from the people living them, over and over again:

- The owner does everything: selling, record-keeping, marketing, pricing — mostly from memory, in a notebook, or not at all.
- There is no affordable help. An accountant, a designer, a marketer each cost money a small shop does not have.
- New apps do not stick. People are tired of downloading apps, registering, and learning new systems. Technology adoption is slow, and attention is already spent.

This hackathon was the right opportunity to finally build something about it. And "Build for Your World" is exactly what this is: I am building for my world, from firsthand knowledge of the problem, for the people I have trained and traded beside.

## The solution

**Naija AI Team** is an AI business team for Nigerian founders and small-business owners, delivered where they already are: on **WhatsApp**. An owner sends a text, voice note, photo or short shop video. An AI lead reads it, delegates to specialist teammates (books, products, flyers, promotions, and more), and replies with a short message plus **proposals** the owner approves, changes or rejects with one tap. Approved proposals become settled facts every teammate builds on. Nothing is done, sent, posted or paid for without approval.

## Impact: time and mental space back

The point of this solution is to free up the two things a small-business owner never has enough of: **time and mental space**.

- No more end-of-day bookkeeping from memory: snap the sales notebook or forward a voice note, and the books are recorded, totalled, and answerable ("How did I do this week?", "Who owes me?").
- No more blank page for marketing: product photos become cutouts, catalogues, flyers and promo videos the owner just approves.
- No more guessing on compliance and pricing: answers grounded in sources, in naira, sized for small budgets.

Every one of those is an hour back, and one less thing carried in the owner's head.

## Why WhatsApp — no new app, no onboarding

This app is purposely meant to work **inside WhatsApp**. There is no app to download, no account to register, no new system to learn. Owners adopt it inside the ecosystem they already use every day, because that is the only adoption path that works here: people are tired of "one more app", and every registration screen loses them.

The numbers are why this bet is right: over **50 million people** use WhatsApp in Nigeria, and over **30 million** already leverage WhatsApp Business to sell their goods and services. The customers are already there. The sellers are already there. Naija AI Team simply joins the conversation.

## A note for judges: why there is a web demo

The whole essence and scope of this product is WhatsApp. But a WhatsApp number is hard for judges to test fairly in a short review, so I built a separate landing page and a web **Try-it** page that runs the exact same team, agents and approval flow over the web. If you are judging this: open `/try`, assemble the team for a test business, and approve a proposal or two. Everything you see there is what happens inside WhatsApp.

## Beyond the hackathon

Meta is building AI agents for WhatsApp, and that is good news for this project, not competition for it. Naija AI Team is different in one important way: it is **Nigeria-first and business-deep** — an approval-driven team that keeps books, builds catalogues, cites compliance sources, and speaks the owner's language, shaped by firsthand knowledge of how this market actually works. That depth is also data: real usage showing how Nigerian sellers work with AI inside WhatsApp.

I am very open to partnering with the Meta team to explore this — to learn from that usage together and to grow AI adoption among Nigerian businesses as Meta's AI agents arrive in Nigeria.

## Before the hackathon

I explored the idea of an AI startup team in an earlier web prototype that used a workflow tool and a non-Meta model. **No code from that prototype is in this repository.** The agent role descriptions in `prompts/` were rewritten from that prototype's prompts for Nigerian small businesses, WhatsApp and Meta's models.

## Built during the hackathon

One line per build, newest first.

| Date | What was built | Meta models used |
|---|---|---|
| Oct 27 | Product cutouts (SAM masks), products, 1080×1350 catalogue image, image previews on proposal cards | SAM 3.1, Muse Spark |
| Oct 27 | Voice/image/video intake, Books ledger with server checks, `books_summary` and `who_owes_me` tools | Muse Spark, Muse Voice Transcribe, Muse Wonder |
| Oct 27 | Agent team + run loop, landing and Try-it pages, WhatsApp webhook (onboarding, chat, approval buttons) | Muse Spark |
| Oct 26 | Spec (`AGENTS.md`), Nigeria-first prompts for 7 agents (`prompts/`), database (`supabase/schema.sql`), Next.js scaffold | — |

## Meta models in this project

| Model | What it does here |
|---|---|
| Muse Spark | CEO + specialists, function calling, structured proposals, reading photos |
| Muse Wonder | Shop-video highlights, verbatim-transcript fallback |
| Muse Voice Transcribe | WhatsApp voice notes to text |
| Muse Image | Flyers and WhatsApp Status images (Prompt 11) |
| SAM 3.1 | Cutting products out of photos for catalogues |
| Muse Code | Wrote most of the code in this repository |
