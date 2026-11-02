# Naija AI Team: built for my world

**Meta Global AI Developer Hackathon · Indie developer track · Build for Your World category**
*Bring Meta's models into your domain. Solve a problem you know firsthand, free up time and mental space, and make something possible that wasn't before.*

---

## The problem I know firsthand

My wife sells on WhatsApp from home, and we have an 18-month-old baby.

Every day her business depends on things she has to make by hand, between feeding times, nap times and housework:

- **Posting to WhatsApp Status, every single day.** A Status disappears after 24 hours, so if she stops posting, sales stop.
- **Shooting product videos, then editing them in CapCut.**
- **Designing flyers in Canva.**
- **Updating her catalogue** whenever stock or prices change.
- **Replying to the same customer questions** ("How much?" "You dey deliver?") all day.
- **Keeping track of sales and who owes her**, usually in her head or a notebook.

That's four or five different apps and hours of work, for one small business, on top of looking after a family.

When I looked around, I saw the same thing everywhere:

- **The vendors I buy from on WhatsApp** live the same routine every day.
- **Stay-at-home mums selling from the house** juggle content, customers and childcare at the same time.
- **Market traders** work a full day serving customers face to face, and still have to keep their WhatsApp selling alive.
- **Bulk traders at hubs like Farin Gada Market in Jos**, where buyers from other parts of Nigeria buy vegetables in large quantities, have to post prices that **change often**, because transport and fuel costs keep moving. Buyers far away decide from those posts.

All of this is done **manually**, at the end of long, tiring days.

## What they told me

When I asked them whether they could stop doing this, the answer was always no: **their sales depend on it.** When I asked whether they would like something that takes these tasks off their hands, they were excited and glad.

Then came the same fear every time:

> "We hope this is not another app we have to download. We hope we don't have to learn how to use another app."

That one sentence shaped the whole design.

## What we built

**No new app. No new skills. Just the WhatsApp they already use.**

The owner sends what they already have, in the way they already talk:

| They send | They get back, ready to approve |
|---|---|
| A voice note, in English or Pidgin ("Tomato big basket 18k, carrot 25k per bag…") | A clear price board for Status and buyer groups |
| Product photos | Clean product pictures and a catalogue with names and prices |
| A short video of their shop or goods | A short vertical promo clip for Status and TikTok |
| A photo of their sales notebook, a receipt or a transfer screenshot | Recorded sales, costs and debts, with unclear lines flagged instead of guessed |
| "How did I do today?" | Sales, costs, profit, who owes them, and a monthly statement designed to share with a bank |

**Nothing goes out without the owner's approval.** Every flyer, price, catalogue and record arrives as a proposal they approve, change or reject with one short reply. Approved items become settled facts the team builds on.

## How it frees up time and mental space

| Task | Today | With Naija AI Team |
|---|---|---|
| Daily Status content | Shoot, edit in CapCut, design in Canva, post | Send a voice note or a video, approve, forward |
| Catalogue updates | Photograph, crop and type each item | Send photos, confirm prices |
| Price changes | Rewrite and resend the price list | One voice note |
| Customer questions | Type the same answers all day | Ready replies to copy and send |
| Bookkeeping | Memory, or a notebook nobody adds up | Snap the page; approve the entries |

**Testing so far:** every flow above was tested end to end — my wife's real selling routine (voice notes, product photos, notebook pages) over WhatsApp and the web demo, plus the scripted smoke suite in `scripts/` (12 checks covering chat, books, catalogue, flyers, video, security and both WhatsApp providers, all passing). Timed sessions with outside testers are the next step after submission.

## What becomes possible that wasn't before

- **A complete content and records team for a one-person business,** inside the app they already open a hundred times a day.
- **Verified records from a paper notebook.** Every number in the statement links back to the photo or voice note it came from, and was confirmed by the owner. Only about 4% of Nigeria's small businesses get bank loans, and weak records are one of the reasons lenders give ([Leadership, citing Stears, May 2026](https://leadership.ng/only-4-of-nigerian-msmes-secure-bank-loans-amid-236bn-funding-gap-report/)).
- **Daily prices that reach distant buyers faster,** for traders whose goods are perishable and whose prices change with the economy.

---

## Meta models in this project

| Model | What it does here |
|---|---|
| Muse Spark | The lead agent and specialist teammates: function calling, structured proposals, reading photos of notebooks, receipts and products |
| Muse Wonder | Understanding shop videos and audio; picking the best moments for promo clips |
| Muse Voice Transcribe | Voice notes to text |
| Muse Image | Backgrounds for flyers and price boards (exact prices and words are added by our code, so they're never misspelt) |
| SAM 3.1 | Cutting products out of photos for the catalogue |
| Muse Spark Open (via Baseten) | Two teammates running on Meta's open weights |
| Muse Code | Wrote most of the code in this repository |

**About the WhatsApp connection:** the app is built for Meta's WhatsApp Cloud API. While our Meta business account was under review during the hackathon, we tested through Twilio's WhatsApp Sandbox, which also runs on WhatsApp. One setting (`WHATSAPP_PROVIDER`) switches between them.

## Safety and privacy

- The approval rule is enforced in code: agents can only create proposals; only the owner's reply confirms them.
- Text read from photos, voice notes and videos is treated as data, never as instructions.
- Records are not accounting or tax advice. The statement says it is designed to share with lenders, not audited.
- Real testers' photos and voice notes are kept out of this public repository. Customer data follows the Nigeria Data Protection Act 2023.

---

## What was built during the hackathon

**This repository was created empty on Oct 26, 2026, and everything in it was built during the hackathon.** The git history shows every step.

**Before the hackathon:** I explored the idea of an AI startup team in an earlier web prototype that used a workflow tool and a non-Meta model. No code from that prototype is in this repository. The agent role descriptions in `prompts/` were rewritten from that prototype's prompts for Nigerian small businesses, WhatsApp and Meta's models.

One line per day, newest first. Only list what is finished and working.

| Date | What was built | Meta models used |
|---|---|---|
| Nov 2 | Submission prep: judging guide in README, timeline update, repo cleanup | — |
| Nov 1 | Rest — no work on the project | — |
| Oct 31 | Debugging and manual end-to-end testing over WhatsApp and web | Muse Spark |
| Oct 30 | Image-generation fixes for Vercel; holding-message and preview checks | Muse Spark, Muse Image |
| Oct 29 | Baseten open weights (Sales + Plans teammates); Twilio/media/decision bug fixes; README | Muse Spark, Muse Spark Open |
| Oct 28 | Flyers + catalogue rendering; statement PDF, dashboard, Try-it uploads; hardening (rate limits, injection tests); Twilio Sandbox provider | Muse Spark, Muse Image, SAM 3.1, Muse Wonder, Muse Voice Transcribe |
| Oct 27 | Meta API client, agent team + loop, Try-it page, WhatsApp webhook + dry run; Noticeboard landing page; Books agent + media pipeline + ledger proposals | Muse Spark, Muse Wonder, Muse Voice Transcribe |
| Oct 26 | Spec (`AGENTS.md`), Nigeria-first prompts (`prompts/`), database (`supabase/schema.sql`); Next.js scaffold | — |