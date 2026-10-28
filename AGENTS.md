# AGENTS.md — instructions for coding agents (Muse Code)

Read this whole file before writing any code. Follow it exactly. When something here conflicts with a guess, this file wins. When it conflicts with Meta's official API docs, the docs win: tell the user what you changed and why.

## 1. What we are building

**Naija AI Team**: an AI business team for Nigerian founders and small-business owners, delivered on **WhatsApp** and on a web **Try-it** page.

An owner sends a text, voice note, photo or short shop video. An **AI Co-Founder / CEO** agent reads it, delegates to specialist agents, and replies with:
1. a short message, and
2. **proposals** the owner approves, changes or rejects with one tap.

Approved proposals become **settled facts** that every agent builds on. Nothing is "done", sent, posted or paid for without approval.

Hackathon: Meta Global AI Developer Hackathon, Indie developer track, Build for Your World category. Deadline: Wed Nov 4, 9:00 PM ET. **This repo started empty on Oct 26, 2026. Write all code fresh; never copy code from other projects.**

## 2. Hard rules (never break these)

1. **Every AI call uses a Meta model:** through the Meta Model API, or Meta open-weight models served by Baseten. No OpenAI, Anthropic or other model providers anywhere, including in dependencies.
2. **All Meta API code lives in `lib/meta.ts`.** Nothing else calls `api.meta.ai` directly. Model IDs come from environment variables.
3. **No secrets in the repo or the browser.** Keys come from `process.env` on the server only. No environment variable in this project uses the `NEXT_PUBLIC_` prefix. Never log keys.
4. **The approval rule is enforced in code, not just prompts.** Agents can only create proposals with `status = 'pending'`, and nothing in a proposal's `payload` (ledger entries, products, files) takes effect until `applyDecision()` runs after the owner approves. Only the owner's tap (web button or WhatsApp button) changes a status.
5. **Every database read or write is scoped to one company id**, which the server takes from the signed session cookie or the WhatsApp phone number, never from the request body.
6. **Small, testable steps.** After each task, `npm run build` must pass, and the task's smoke test must pass. Then stop and report.
7. **Ask before deleting files** or changing `supabase/schema.sql`.

## 3. Stack

- **Next.js** (latest stable, App Router, TypeScript, Tailwind CSS), created in Task 1 inside this folder. Hosted on **Vercel**.
- **Supabase Postgres** for data and file storage, used only from the server with the service-role key (`@supabase/supabase-js`). **No user accounts or login** in this version.
- **Firecrawl** search API for the agents' web search. It is search, not a model.
- Smoke tests are TypeScript files in `scripts/`, run with `npx tsx scripts/<name>.ts`, loading `.env.local` (use `dotenv` or Node's `--env-file`).

## 4. Environment variables

All server-only. Listed in `.env.example`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `META_API_KEY`, `META_API_BASE`, `META_TEXT_MODEL` (Muse Spark), `META_REASONING_MODEL` (Muse Wonder: video and audio understanding, hard reasoning), `META_IMAGE_MODEL` (Muse Image), `META_TRANSCRIBE_MODEL` (Muse Voice Transcribe), `META_SAM_MODEL` (SAM 3.1), `FIRECRAWL_API_KEY`, `SESSION_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_DRY_RUN` (1 = log sends instead of calling WhatsApp), `WHATSAPP_PUBLIC_NUMBER` (shown on the landing page).

## 5. Architecture and file map

```
WhatsApp ──► app/api/whatsapp/route.ts ─┐
                                        ├──► lib/agents/run.ts  runTeam()
Try-it page ► app/api/team/route.ts ────┘        │
              app/api/start/route.ts (intake)    ├─ lead agent "Your team" (Muse Spark, function calling)
Dashboard ──► app/d/[token]/page.tsx             │    ├─ delegate_product / _marketing / _design /
                                                 │    │  _engineering / _sales / _compliance / _books
                                                 │    └─ web_search (Firecrawl)
                                                 ├─ lib/agents/context.ts (profile + approved + history)
                                                 └─ lib/db.ts (Supabase, service role)
lib/meta.ts  ◄── the ONLY place that calls Meta (chat, vision, image, transcribe, SAM)
```

| File | Purpose |
|---|---|
| `lib/meta.ts` | `chat()` (messages, tools, JSON schema output, retries, timeout); later `generateImage()`, `transcribe()`, `segment()` |
| `lib/db.ts` | Server Supabase client + typed helpers for every table in `supabase/schema.sql` |
| `lib/session.ts` | Signed, httpOnly cookie holding the Try-it company id (HMAC with `SESSION_SECRET`) |
| `lib/agents/team.ts` | The 8 agents: key, display name, channel, colour, initials |
| `lib/agents/prompts.ts` | Loads `prompts/_shared.md` + `prompts/<key>.md` |
| `lib/agents/context.ts` | Builds the context block for each run |
| `lib/agents/tools.ts` | Tool definitions and handlers: `web_search`, `delegate_*` |
| `lib/agents/run.ts` | `runTeam()`: the agent loop, structured output, saving messages, decisions and trace |
| `lib/whatsapp.ts` | Send text, buttons, image, document; download media; verify signature (Day 2) |
| `app/page.tsx` | Landing page |
| `app/try/page.tsx` | Try-it: intake form, then chat with the team and proposal cards |
| `app/d/[token]/page.tsx` | Owner dashboard (Day 7): decisions, files, agent trace |
| `app/api/start/route.ts` | Intake → create company → set cookie → run kickoff |
| `app/api/team/route.ts` | Chat, history, decisions, decide (section 6) |
| `app/api/whatsapp/route.ts` | WhatsApp webhook (Day 2) |

## 6. Contracts

**`POST /api/start`** body `{ ownerName, name, oneLiner, description, targetCustomer?, goals, stage }` → creates a company (source `tryit`), sets the session cookie, runs the kickoff → `{ ok: true, companyId, dashboardUrl, kickoff: <message response> }`.

**`POST /api/team`** body `{ action, channelId?, message?, decisionId?, status?, note?, limit? }`. Company comes from the cookie.
- `message` → `{ ok: true, reply, agent, agentName, channelId, decisions: Decision[] }`
- `history` → `{ ok: true, messages: [{ agent, ownerMessage, reply, createdAt }] }` (agent = display name)
- `decisions` (`status`: pending | approved | rejected | changes_requested | all) → `{ ok: true, decisions: Decision[] }`
- `decide` → `{ ok: true, decisionId, status }`
- Errors → `{ ok: false, error: "<plain-English message>" }`

`Decision = { decision_id, title, description, category, owner, priority, status, channel_id, owner_note, createdAt, kind, payload, previewUrl? }` (previewUrl = the flyer, catalogue or video file to show on the card)

Channels: `general` (CEO), `product`, `marketing`, `design`, `engineering`, `sales`, `compliance`, `books`; `whatsapp` (always the CEO).

Agent keys and the plain display names owners see (never show job titles like CEO or Co-Founder): `ceo` Your team · `product` Plans · `marketing` Promotion · `design` Flyers & Catalogue · `engineering` Tools & Costs · `sales` Prices & Customers · `compliance` Paperwork · `books` Books.

Every agent's **final** answer is JSON:
```json
{ "reply": "string", "decisions": [ { "title": "string", "description": "string", "category": "string", "owner": "agent key", "priority": "high|medium|low", "kind": "general|ledger|product|flyer|video|catalogue|statement", "payload": {} } ] }
```
Request it with the Meta API's structured-output option (JSON schema). If parsing fails, retry once with "Return only valid JSON matching the schema." If it fails again, return `{ reply: <raw text>, decisions: [] }`. Never crash.

## 7. The agent loop (`runTeam`)

Input: `{ companyId, channelId, message, source: 'tryit'|'whatsapp', isKickoff?, attachments? }`

1. Load context: company, all **approved** decisions, last 10 messages in this channel (oldest first).
2. Pick the agent: CEO for `general`, `whatsapp` and kickoff; otherwise the channel's agent.
3. System prompt = `prompts/_shared.md` + `prompts/<key>.md` + today's date + `SOURCE: whatsapp` or `SOURCE: web`.
4. User content = the context block: COMPANY PROFILE, APPROVED DECISIONS (numbered, with owner notes), RECENT CONVERSATION, then either NEW COMPANY CREATED (kickoff, with the intake answers) or OWNER MESSAGE.
5. Call `chat()` with tools. CEO: `web_search` + one `delegate_<key>` per specialist (input: `brief`). Specialists: `web_search` only.
6. Loop while the model returns tool calls (max 8 rounds for the CEO, 5 for specialists). Run independent tool calls in parallel. A `delegate_*` call runs that specialist's own loop and returns its JSON as the tool result.
7. Final round: structured JSON (section 6).
8. Save one `messages` row, one `decisions` row per proposal (status `pending`), and one `agent_runs` row per step (agent, model, step, short detail, ms).
9. Return the section 6 message shape with the saved `decision_id`s.

Timeouts: each `chat()` call 90 s; a whole run ≤ 280 s. Routes that call `runTeam` set `export const maxDuration = 300`.

## 8. Web pages

Look and feel: clean, calm and trustworthy. Off-white background, deep green accent, one serif display font for headlines and a clean sans-serif for text. Mobile-first: most Nigerian users are on phones. No stock photos or invented testimonials.

- **Landing (`/`)**: one-line promise ("Your AI business team on WhatsApp"), 3 steps, the 7 teammates, a "Try it now" button to `/try`, and a WhatsApp button once the number exists.
- **Try-it (`/try`)**: intake form (owner name, business name, what you sell or plan to build, who your customers are, your 3-month goal, stage) → "Assembling your team" while the kickoff runs → chat view: messages with the agent's name and initials, proposal cards with **Approve / Change / Reject**, a "Pending approvals" count. Day 7 adds voice recording, photo and video upload.
- **Dashboard (`/d/[token]`)** (Day 7): looks up the company by `access_token`; shows approved and pending decisions, generated files, and an agent trace per message (which agent, which Meta model, how long).

## 9. WhatsApp rules (Day 2+)

- Return HTTP 200 within a few seconds; do the work afterwards with `after()` from `next/server`.
- Verify `X-Hub-Signature-256` with `WHATSAPP_APP_SECRET` on every POST.
- Skip duplicate deliveries using `whatsapp_seen`.
- Send "Got it — the team is on it." immediately, then the real reply.
- Formatting: `*bold*`, `_italic_`, plain lists; no markdown tables or `#` headings; split messages over 4,096 characters.
- Each proposal is one interactive message with 3 reply buttons, `Approve`, `Change` and `Reject` (≤ 20 characters each), with ids `<decisionId>:approved`, `:changes_requested` and `:rejected`. "Change" asks "What should change?" and saves the next text as `owner_note`.
- A new phone number goes through onboarding (4 questions, one at a time), then the kickoff, then a message with the owner's dashboard link.

## 10. Nigeria context (all agents)

Prices in naira (₦). Customers mostly buy through WhatsApp, Instagram and walk-ins. Budgets are small; data and power cost money; recommend cheap, phone-first actions. Compliance answers must cite official sources (see `prompts/compliance.md`).

## 11. Media pipeline (Day 3+)

Everything the owner sends goes through **`lib/media.ts`** before any agent sees it:

1. **Store** the original in the Supabase Storage bucket `files` under `<companyId>/<yyyy-mm-dd>/<uuid>.<ext>` and add a `files` row (`kind`, `mime`, `made_by: 'owner'`, `message_id`, `meta`).
2. **Describe** it for the agents, by type:
   - **audio** → `transcribe()` in `lib/meta.ts` (Muse Voice Transcribe over its real-time WebSocket; convert to the audio format the docs require with `ffmpeg-static`). If that fails, fall back to `META_REASONING_MODEL` (Muse Wonder) with the audio file as input and ask for a verbatim transcript. Reply first with `I heard: "<transcript>"` so mistakes are visible.
   - **image** → Muse Spark vision: classify it as `sales_record` (notebook, receipt, POS slip, transfer screenshot), `product_photo`, `price_list` or `other`, plus a one-paragraph description.
   - **video** → Muse Wonder video understanding: a list of products seen (name, best timestamp in seconds) and 3–5 highlight moments (start, end, why).
3. **Route**: the description, transcript and file ids go into `runTeam()` as `attachments`, so the CEO can delegate (see `prompts/ceo.md`).

Limits: accept images ≤ 10 MB, audio ≤ 3 minutes, video ≤ 60 seconds and ≤ 16 MB (WhatsApp's own limit). Reject larger files with a friendly message.

## 12. Proposal types and `applyDecision()`

Every proposal has a `kind` and a `payload`. When the owner taps Approve, **`lib/decisions.ts` → `applyDecision(companyId, decisionId)`** runs once (set `applied_at`; never apply twice):

| kind | payload | On approve |
|---|---|---|
| `general` | `{}` | nothing else; it becomes an approved decision the team builds on |
| `ledger` | `{ entries: [...] }` (shape in section 13) | insert entries into `ledger_entries` with `status: 'confirmed'`, linked to the decision and source file |
| `product` | `{ product_ids: [...] }` | set those products to `approved` |
| `flyer`, `catalogue`, `video`, `statement` | `{ file_id }` | mark the file approved (in `files.meta.approved = true`); on WhatsApp, send the file to the owner ready to forward or post |

Reject → nothing applied. Change → the owner's note goes back to the agent that made it, which makes a new proposal.

## 13. Books (Day 4)

- New agent `books` (`prompts/books.md`). Entry shape: `{ entry_date, kind: sale|expense|debt_given|debt_paid|stock_in, item, quantity, unit_price, amount, counterparty, payment_method, confidence }`, amounts in naira.
- The Books agent gets the image (or transcript) and the last 30 confirmed entries (for duplicate checks), and returns one `ledger` proposal per batch.
- Server-side checks before saving the proposal: amounts are numbers ≥ 0; `quantity × unit_price ≈ amount` when both exist (flag it in the reply if not); dates are not in the future.
- Queries come from the views `ledger_daily` and `who_owes_me` (see `supabase/schema-v3.sql`): "how did I do this week", "who owes me".

## 14. Catalogue and flyers (Day 5)

- **Cutout**: `segment()` in `lib/meta.ts` calls SAM 3.1 with the photo and a text prompt naming the product; `lib/images.ts` (using `sharp`) applies the mask and places the product on a clean background in the brand colour → a `cutout` file.
- **Products**: Flyers & Catalogue names each product; prices come from the owner (Prices & Customers asks for missing ones). New products are `pending` inside a `product` proposal.
- **Catalogue image**: `lib/images.ts` lays out approved products (cutout, name, price) in a grid, 1080×1350, brand colours → a `catalogue` file and a `catalogue` proposal.
- **Flyer**: the `make_flyer` tool calls `generateImage()` (Muse Image) for a background with NO text, then `lib/images.ts` writes the exact headline, price and call to action on top with an embedded font (Work Sans and Anton TTF files in `assets/fonts/`, from Google Fonts, Open Font License). 1080×1920 for Status. → a `flyer` file and a `flyer` proposal.

## 15. Marketing videos (Day 6)

- Input: an owner video (≤ 60 s). Muse Wonder returns highlight moments; Promotion writes captions, an opening line and a call to action (`prompts/marketing.md`).
- `lib/video.ts` uses `ffmpeg-static` to: cut the chosen moments, crop/scale to vertical 1080×1920, burn in captions with the embedded font, add a 2-second end card (business name + "Order on WhatsApp"), keep total length 15–30 s, H.264 + AAC, ≤ 16 MB → a `marketing_video` file and a `video` proposal.
- Run it as a `media_jobs` row (`queued → running → done/failed`) so a slow render never blocks the chat. Tell the owner "Your video is cooking, I'll send it in a few minutes."
- If the video job is too heavy for Vercel's time or memory limits, keep output at 720×1280 and ≤ 20 s.

## 16. Statement (Day 7)

`lib/statement.ts` builds a one- or two-page PDF (with `pdf-lib`) for a chosen month: business name, owner, totals (sales, costs, profit), weekly breakdown, top items, money owed to the business, and a list of every confirmed entry with its date and a short code linking to its source file. Footer: "Records confirmed by the owner from their own notebook photos, receipts and voice notes. Designed to share with lenders; not audited accounts." → a `statement` file and proposal.

## 17. Dashboard and Try-it upgrades (Day 7)

- `/d/[token]`: this week's sales, costs, profit (from `ledger_daily`); who owes me; pending proposals; the catalogue; generated flyers and videos; a statement download; and an agent trace per message (agent, Meta model, step, ms).
- `/try`: add a record button (browser `MediaRecorder` → audio upload), photo upload and video upload, all through the same `lib/media.ts` → `runTeam()` path with `source: 'tryit'`. Proposal cards show previews (image, video player) and the entries table for `ledger` proposals.

## 18. Definition of done for any task

- `npm run build` passes with no type errors.
- The task's smoke test passes, or you explain exactly why not.
- No secrets in the repo; no unrelated files changed.
- You report: files changed, how to test, and anything the user must do by hand.
