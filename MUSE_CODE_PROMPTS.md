# Muse Code prompts, in order

How to use this file:
1. In VS Code's terminal, inside the project folder, run `muse`.
2. Copy ONE prompt (the text inside the grey box), paste it into Muse Code and press Enter.
3. Let it work. When it asks permission to run a command or edit files, read what it says and allow it if it matches the prompt.
4. Do the **You check** step. If it fails, paste the error back into Muse Code with: "This failed. Fix it, then tell me how to re-test."
5. When it passes, save your progress (see the bottom of this file), then move to the next prompt.

Never paste your keys into Muse Code's chat. Keys go only in `.env.local`.

---

## Prompt 0 — Orientation (5 min)

```
Read AGENTS.md, MUSE_CODE_PROMPTS.md, HACKATHON.md, every file in prompts/ and supabase/schema.sql. Do not write any code yet. Explain back to me in plain English, in under 12 bullet points: what we are building, the order of the tasks, and which parts use which Meta model. List any questions or anything in AGENTS.md that looks wrong or unclear.
```

**You check:** the summary describes a WhatsApp + Try-it AI business team on Meta models, built from an empty repo. Answer any questions it asks.

---

## Prompt 1 — Create the app (15 min)

```
Task 1 from AGENTS.md. Create a new Next.js app (latest stable, App Router, TypeScript, Tailwind CSS, ESLint, no src folder, import alias @/*, npm) in THIS folder, keeping AGENTS.md, MUSE_CODE_PROMPTS.md, HACKATHON.md, .env.example, prompts/ and supabase/ untouched. If create-next-app refuses because the folder isn't empty, create it in a temporary folder and move the files in. Make sure .gitignore ignores .env*.local and node_modules. Replace the starter home page with a simple placeholder that says "Naija AI Team: coming soon". Run npm run build and npm run dev, and tell me what URL to open.
```

**You check:** http://localhost:3000 shows "Naija AI Team: coming soon". Stop the server with Ctrl+C.

---

## Prompt 2 — Talk to Meta's model (30 min)

```
Task 2 from AGENTS.md. Create lib/meta.ts with an exported async function chat({ messages, tools?, jsonSchema?, model?, timeoutMs? }). It calls the Meta Model API chat completions endpoint at META_API_BASE with META_API_KEY; the default model is META_TEXT_MODEL. Check Meta's official API docs for the exact request and response format, including function calling (tools and tool_calls) and structured output (JSON schema). Retry up to 2 times on network errors and on 429/5xx responses with a short backoff. Return { text, toolCalls, raw, model, ms }. Never log the API key.
Then create scripts/meta-smoke.ts, loading .env.local, that: (1) asks "Reply with one short sentence: what is the capital of Nigeria?" and prints the answer and ms; (2) calls chat with a jsonSchema {reply: string, decisions: array of {title, description}} and prints the parsed JSON; (3) calls chat with one tool get_time and shows that the model asks to call it. Install tsx (and dotenv if needed) as dev dependencies. Run it with npx tsx scripts/meta-smoke.ts and show me the output.
```

**You check:** all three tests print sensible results. Paste me the output: I'll confirm Meta's API behaves as the spec expects.

---

## Prompt 3 — Database helpers (30 min)

Before this prompt: `supabase/schema.sql` has been run in Supabase, and `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are in `.env.local`.

```
Task 3 from AGENTS.md. Install @supabase/supabase-js. Create lib/db.ts, server only, with a Supabase client using SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and typed helpers for every table in supabase/schema.sql: createCompany, getCompany, getCompanyByToken, getApprovedDecisions, getRecentMessages(companyId, channelId, limit), saveMessage, saveDecisions (returns rows with decision_id), setDecisionStatus(companyId, decisionId, status, note), listDecisions(companyId, status), saveAgentRun, plus whatsapp_users and whatsapp_seen helpers. Every helper that touches company data must filter by companyId. Make lib/db.ts importable from scripts too. Create scripts/db-smoke.ts that creates a test company, saves a message and a decision, reads them back, approves the decision, prints everything, then deletes the test company. Run it and show me the output.
```

**You check:** the script prints the saved and read-back rows, and the decision ends as `approved`.

---

## Prompt 4 — The agent team (1–2 hours)

```
Task 4 from AGENTS.md, sections 6 and 7. Create lib/agents/team.ts (7 agents with key, display name, channel, colour, initials), lib/agents/prompts.ts (loads prompts/_shared.md + prompts/<key>.md with fs at runtime; make sure Next.js includes the prompts folder in the server bundle on Vercel, e.g. with outputFileTracingIncludes), lib/agents/context.ts (company profile, numbered APPROVED DECISIONS with owner notes, last 10 messages oldest first, a NEW COMPANY CREATED block for kickoff with the intake answers, the OWNER MESSAGE, and SOURCE), lib/agents/tools.ts (web_search via the Firecrawl search API returning title, url and a short snippet for up to 5 results; one delegate_<key> tool per specialist with a single 'brief' string), and lib/agents/run.ts with runTeam() exactly as AGENTS.md section 7 describes: tool loop, parallel tool calls, structured final JSON with one retry, saving the message, decisions and agent_runs, and returning the section 6 shape.
Then create scripts/team-smoke.ts that creates a test company "Mama Nkechi Kitchen" (owner Nkechi; sells jollof, small chops and zobo in Yaba, Lagos; customers: office workers and party hosts; goal: 50 regular customers in 90 days), runs a kickoff, prints the reply, the decisions and the agent_runs steps, then asks in channel 'sales': "How should I price small chops for parties?" and prints the result. Keep the test company. Run it and show me the output.
```

**You check:** the kickoff makes sense for a Lagos food business, there are 1–3 proposals, and the printed trace shows the CEO delegating to at least one specialist. Paste me the output if anything looks weak.

---

## Prompt 5 — Landing page and Try-it page (1–2 hours)

```
Task 5 from AGENTS.md, sections 6 and 8. Create lib/session.ts (signed httpOnly cookie with the company id, HMAC-SHA256 with SESSION_SECRET, 30-day expiry), app/api/start/route.ts and app/api/team/route.ts exactly per section 6 (company id only from the cookie), the landing page app/page.tsx, and the Try-it page app/try/page.tsx per section 8: intake form, an "Assembling your team" screen showing the 7 teammates while the kickoff runs, then a chat view with a teammate picker (CEO by default, plus the 6 specialists), messages with agent name and initials, markdown rendering for replies (react-markdown), proposal cards with Approve / Change (asks for a note) / Reject that call the decide action and update in place, and a pending-approvals count. If the kickoff request times out in the browser, poll history until the reply appears. Mobile-first. Run npm run build, then tell me exactly how to test it with npm run dev.
```

**You check:** run `npm run dev` and open http://localhost:3000/try. Fill in the intake for a made-up business and check: the kickoff appears, you can chat with the Sales teammate, Approve turns a card green, and the pending count drops. Also check it on your phone's screen size: in Chrome, View → Developer → Developer Tools → the phone icon.

**Then put it online:** commit and push, and import the repo into Vercel (the plan doc's Day 1 has the steps).

---

## Prompt 6 — WhatsApp in and out (Day 2)

Before this prompt: the WhatsApp lock is cleared, and the permanent token and IDs are in `.env.local` and Vercel (plan doc, Day 2).

```
Task 6 from AGENTS.md, section 9. Create lib/whatsapp.ts (sendText with automatic splitting at 4,096 characters; sendButtons with exactly 3 reply buttons Approve / Change / Reject and ids "<decisionId>:approved", "<decisionId>:changes_requested", "<decisionId>:rejected"; sendImage and sendDocument by uploading media first; downloadMedia(mediaId) returning a Buffer and mime type; verifySignature(rawBody, header) using WHATSAPP_APP_SECRET). Check Meta's WhatsApp Cloud API docs for the current Graph API version and payload formats. Create app/api/whatsapp/route.ts: GET returns hub.challenge when hub.verify_token matches WHATSAPP_VERIFY_TOKEN; POST verifies the signature, returns 200 immediately, and does the work in after(): skip duplicates via whatsapp_seen; a new phone goes through onboarding (ask one at a time: your name, business name, what you sell or plan to build, your goal for the next 3 months; then create the company with source 'whatsapp', run the kickoff and send the dashboard link); a known phone + text → send "Got it — the team is on it.", run runTeam with channel 'whatsapp' and source 'whatsapp', send the reply, then one button message per decision; a button reply sets the decision status (for Change, store awaiting_note_for and ask "What should change?"; the next text becomes owner_note and goes to the CEO as a revision request). Unsupported message types get a polite reply. Errors always send "Sorry, something went wrong. Please try again." Run npm run build and tell me how to test with the WhatsApp test number.
```

**You check:** after deploying, message the test number from your phone: onboarding → kickoff → proposals with buttons → tap Approve → the status changes in Supabase.

---

## Prompts for Days 3–7

I'll write these with you on the day, once we see how Days 1–2 went. Same pattern each time: one task, one smoke test, then commit.

- Day 3: voice notes → `transcribe()` in lib/meta.ts, audio conversion, keyword biasing.
- Day 4: photos into Muse Spark; the Designer's make_flyer tool with Muse Image + exact text overlay.
- Day 5: SAM 3.1 cutouts.
- Day 6: shop video → catalogue; compliance sources shown in WhatsApp.
- Day 7: dashboard `/d/[token]` with the agent trace; voice, photo and video upload on the Try-it page; a pre-loaded demo business.

---

## Saving progress (after every passing check)

Ask Muse Code:
```
Commit all changes with a short clear message and push to GitHub. Do not commit .env.local.
```
Then add one line for today to the table in HACKATHON.md.
