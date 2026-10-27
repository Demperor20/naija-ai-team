import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Anton, Caveat, Work_Sans } from "next/font/google";

// Landing page: "Noticeboard" design (built during the hackathon, Oct 27, 2026).
// Only this file changes. The Try-it page (/try), the API routes and the agents are untouched.

const anton = Anton({ weight: "400", subsets: ["latin"], display: "swap" });
const caveat = Caveat({ weight: ["600", "700"], subsets: ["latin"], display: "swap" });
const workSans = Work_Sans({ weight: ["400", "500", "700"], subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Naija AI Team: snap, send, sell on WhatsApp",
  description:
    "Snap your goods and send them on WhatsApp. Get back flyers, a catalogue, prices and replies for your customers. Nothing goes out until you approve it.",
};

// Colours
const ACCENT = "#B3122B"; // stamp red
const INK = "#1B1B1B";
const BOARD = "#E7D3AE"; // kraft noticeboard
const PAPER = "#FFFDF6";
const TAPE = "rgba(247,217,76,0.85)";
const YELLOW = "#F7D94C";

const ANTON = anton.style.fontFamily;
const CAVEAT = caveat.style.fontFamily;

// Optional: set WHATSAPP_PUBLIC_NUMBER (digits only, e.g. 2348031234567) in .env.local and Vercel
// once your WhatsApp number works. Until then the WhatsApp buttons go to the Try-it page.
const WA_NUMBER = (process.env.WHATSAPP_PUBLIC_NUMBER ?? "").replace(/\D/g, "");
const WA_LINK = WA_NUMBER
  ? `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent("Hello! I want to try Naija AI Team.")}`
  : "/try";
const WA_LABEL = WA_NUMBER ? `+${WA_NUMBER}` : "[YOUR NUMBER]";

// Shared styles
const container: CSSProperties = { maxWidth: 1160, margin: "0 auto", paddingLeft: 24, paddingRight: 24 };
const posterHeading: CSSProperties = {
  margin: 0,
  fontFamily: ANTON,
  fontWeight: 400,
  fontSize: "clamp(40px, 6vw, 58px)",
  lineHeight: 1,
  letterSpacing: 1,
  textTransform: "uppercase",
};
const solidButton: CSSProperties = {
  background: ACCENT,
  color: "#FFFFFF",
  textDecoration: "none",
  fontWeight: 700,
  fontSize: 18,
  padding: "15px 24px",
  borderRadius: 6,
  display: "inline-block",
};
const outlineButton: CSSProperties = {
  color: INK,
  textDecoration: "none",
  fontWeight: 700,
  fontSize: 18,
  padding: "13px 22px",
  borderRadius: 6,
  border: `2px solid ${INK}`,
  display: "inline-block",
};

export default function Home() {
  return (
    <div
      className={workSans.className}
      style={{ color: INK, background: BOARD, minHeight: "100vh", minWidth: 0, overflowX: "clip" }}
    >
      {/* Nav */}
      <header style={{ background: INK, color: "#FFFFFF" }}>
        <div
          style={{
            ...container,
            paddingTop: 16,
            paddingBottom: 16,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
          }}
        >
          <Link href="/" style={{ fontFamily: ANTON, fontSize: 26, letterSpacing: 1, color: "#FFFFFF", textDecoration: "none" }}>
            NAIJA AI TEAM
          </Link>
          <nav style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 20, fontSize: 16 }}>
            <a href="#how" style={{ color: "#FFFFFF", textDecoration: "none" }}>
              How it works
            </a>
            <Link href="/try" style={{ ...solidButton, fontSize: 16, padding: "11px 20px" }}>
              Try it free
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero board */}
      <section
        style={{
          ...container,
          paddingTop: 56,
          paddingBottom: 64,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 40,
        }}
      >
        <div style={{ flex: "1 1 440px", minWidth: 0, position: "relative" }}>
          <div
            style={{
              background: PAPER,
              padding: "36px 34px 40px",
              boxShadow: "0 18px 30px rgba(60,40,10,0.25)",
              transform: "rotate(-1.5deg)",
              position: "relative",
            }}
          >
            <Tape style={{ top: -14, left: "40%", width: 110, height: 28, transform: "rotate(-4deg)" }} />
            <p style={{ margin: 0, fontFamily: CAVEAT, fontSize: 28, color: "#A00D24" }}>Attention, all business owners!</p>
            <h1
              style={{
                margin: "6px 0 0",
                fontFamily: ANTON,
                fontWeight: 400,
                fontSize: "clamp(60px, 10vw, 92px)",
                lineHeight: 0.95,
                letterSpacing: 1,
                textTransform: "uppercase",
              }}
            >
              Snap.
              <br />
              Send.
              <br />
              <span style={{ color: ACCENT }}>Sell.</span>
            </h1>
            <p style={{ margin: "20px 0 0", fontSize: 19, lineHeight: 1.55, maxWidth: 460 }}>
              Snap your goods and send them on WhatsApp. Get back flyers, a catalogue, prices and replies for your customers.
            </p>
            <p style={{ margin: "14px 0 0", fontFamily: CAVEAT, fontSize: 30, lineHeight: 1.1 }}>
              ...and nothing goes out until you approve it!
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
              <a href={WA_LINK} style={solidButton}>
                Chat on WhatsApp
              </a>
              <Link href="/try" style={outlineButton}>
                Try it in your browser
              </Link>
            </div>
          </div>
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              right: -10,
              bottom: -34,
              width: 118,
              height: 118,
              borderRadius: "50%",
              background: ACCENT,
              color: "#FFFFFF",
              display: "grid",
              placeItems: "center",
              textAlign: "center",
              transform: "rotate(12deg)",
              fontFamily: ANTON,
              fontSize: 22,
              lineHeight: 1.05,
              boxShadow: "0 8px 16px rgba(0,0,0,0.25)",
            }}
          >
            FREE
            <br />
            TO TRY
          </div>
        </div>

        {/* Polaroids */}
        <div
          style={{
            flex: "1 1 440px",
            minWidth: 0,
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 22,
          }}
        >
          <Polaroid caption="Mama's kitchen, Yaba" rotate={-4} pin={<Tape style={{ top: -10, left: "30%", width: 70, height: 20, transform: "rotate(6deg)" }} />}>
            <KitchenScene />
          </Polaroid>
          <Polaroid caption="Tomato stall, market day" rotate={3} offset pin={<Pin color={ACCENT} style={{ top: -12, left: 12 }} />}>
            <MarketScene />
          </Polaroid>
          <Polaroid caption="Corner shop, open late" rotate={2} pin={<Tape style={{ top: -10, right: 24, width: 70, height: 20, transform: "rotate(-8deg)" }} />}>
            <ShopScene />
          </Polaroid>
          <Polaroid caption="Tailor, new designs" rotate={-3} offset pin={<Pin color="#1D4ED8" style={{ top: -12, right: 14 }} />}>
            <FashionScene />
          </Polaroid>
        </div>
      </section>

      {/* How it works: index cards */}
      <section id="how" style={{ background: INK, color: "#FFFFFF" }}>
        <div style={{ ...container, paddingTop: 72, paddingBottom: 84 }}>
          <h2 style={posterHeading}>How it works</h2>
          <p style={{ margin: "10px 0 0", fontFamily: CAVEAT, fontSize: 28, color: YELLOW }}>Three steps. No new app.</p>
          <div
            style={{
              marginTop: 36,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 26,
            }}
          >
            <IndexCard number="1" title="Snap or talk" rotate={-1.5}>
              Send a photo of your goods or a voice note about your business, in English or Pidgin.
            </IndexCard>
            <IndexCard number="2" title="We prepare it" rotate={1}>
              A flyer, a catalogue, a price list or the right reply for your customer comes back in your chat.
            </IndexCard>
            <IndexCard number="3" title="You stamp it" rotate={-0.5}>
              Approve, ask for a change, or say no. Nothing is posted or sent without your OK.
            </IndexCard>
          </div>
        </div>
      </section>

      {/* What you go get: price tags */}
      <section style={{ ...container, paddingTop: 80, paddingBottom: 80 }}>
        <h2 style={posterHeading}>What you go get</h2>
        <div
          style={{
            marginTop: 36,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 22,
          }}
        >
          <PriceTag title="FLYERS" yellow rotate={-1}>
            Ready for your WhatsApp Status, with your real price.
          </PriceTag>
          <PriceTag title="CATALOGUE" rotate={1}>
            Clean photos of everything you sell, in one place.
          </PriceTag>
          <PriceTag title="GOOD PRICES" rotate={-0.5}>
            Prices in naira that cover your costs and leave profit.
          </PriceTag>
          <PriceTag title="QUICK REPLIES" yellow rotate={1.5}>
            The right answer to &quot;how much?&quot; and &quot;you dey deliver?&quot;
          </PriceTag>
          <PriceTag title="PAPERWORK HELP" rotate={-1}>
            Simple steps to register your business name.
          </PriceTag>
        </div>
      </section>

      {/* Stamp */}
      <section
        style={{
          ...container,
          paddingBottom: 80,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 48,
        }}
      >
        <div style={{ flex: "1 1 380px", minWidth: 0 }}>
          <h2 style={posterHeading}>Nothing leaves without your stamp.</h2>
          <p style={{ margin: "16px 0 0", fontSize: 19, lineHeight: 1.55, maxWidth: 480 }}>
            Every idea comes to you first. You decide what gets posted, what gets sent and what price you charge.
          </p>
        </div>
        <div style={{ flex: "1 1 380px", minWidth: 0, display: "flex", justifyContent: "center" }}>
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              background: PAPER,
              padding: 28,
              boxShadow: "0 14px 26px rgba(60,40,10,0.25)",
              transform: "rotate(1.5deg)",
              position: "relative",
            }}
          >
            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: 1.5, color: "#5C5346" }}>SUGGESTION FOR YOU</p>
            <p style={{ margin: "8px 0 0", fontSize: 20, fontWeight: 700, lineHeight: 1.4 }}>
              Make a &quot;buy 2, get 1 free&quot; deal on puff-puff this Saturday and post the flyer at 7 AM.
            </p>
            <p style={{ margin: "12px 0 0", fontFamily: CAVEAT, fontSize: 24, color: "#5C5346" }}>Change · Reject · Approve</p>
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                right: 18,
                bottom: 18,
                border: `5px solid ${ACCENT}`,
                color: ACCENT,
                fontFamily: ANTON,
                fontSize: 34,
                letterSpacing: 3,
                padding: "4px 14px",
                borderRadius: 8,
                transform: "rotate(-14deg)",
              }}
            >
              APPROVED
            </div>
          </div>
        </div>
      </section>

      {/* CTA with tear-off tabs */}
      <section id="try" style={{ ...container, paddingBottom: 88 }}>
        <div style={{ background: "#FFFFFF", boxShadow: "0 16px 30px rgba(60,40,10,0.25)", transform: "rotate(-0.6deg)" }}>
          <div style={{ padding: "48px 40px 32px", textAlign: "center" }}>
            <p style={{ margin: 0, fontFamily: CAVEAT, fontSize: 30, color: ACCENT }}>Business owners wanted!</p>
            <h2 style={{ ...posterHeading, fontSize: "clamp(40px, 7vw, 64px)", margin: "6px auto 0", maxWidth: 820 }}>
              Your business. Your phone. Your helper.
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 12, marginTop: 28 }}>
              <a href={WA_LINK} style={{ ...solidButton, padding: "15px 26px" }}>
                Chat on WhatsApp
              </a>
              <Link href="/try" style={{ ...outlineButton, padding: "13px 24px" }}>
                Try it in your browser
              </Link>
            </div>
          </div>
          <div style={{ display: "flex", borderTop: "2px dashed #8C8070", overflow: "hidden" }}>
            {Array.from({ length: 8 }, (_, i) => (
              <a
                key={i}
                href={WA_LINK}
                style={{
                  flex: "1 1 0",
                  minWidth: 0,
                  height: 130,
                  borderRight: i < 7 ? "2px dashed #8C8070" : "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  writingMode: "vertical-rl",
                  fontWeight: 700,
                  fontSize: 14,
                  color: INK,
                  textDecoration: "none",
                }}
              >
                WhatsApp {WA_LABEL}
              </a>
            ))}
          </div>
        </div>
      </section>

      <footer style={{ background: INK, color: "#D8CFC0" }}>
        <div
          style={{
            ...container,
            paddingTop: 26,
            paddingBottom: 26,
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: 12,
            fontSize: 15,
          }}
        >
          <span style={{ fontFamily: ANTON, letterSpacing: 1, color: "#FFFFFF" }}>NAIJA AI TEAM</span>
          <span>Made in Nigeria, for Nigerian businesses.</span>
        </div>
      </footer>
    </div>
  );
}

/* ---------- Small building blocks ---------- */

function Tape({ style }: { style: CSSProperties }) {
  return <div aria-hidden="true" style={{ position: "absolute", background: TAPE, ...style }} />;
}

function Pin({ color, style }: { color: string; style: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        width: 16,
        height: 16,
        borderRadius: "50%",
        background: color,
        boxShadow: "0 2px 3px rgba(0,0,0,0.4)",
        ...style,
      }}
    />
  );
}

function Polaroid({
  caption,
  rotate,
  offset = false,
  pin,
  children,
}: {
  caption: string;
  rotate: number;
  offset?: boolean;
  pin: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure
      style={{
        margin: offset ? "18px 0 0" : 0,
        background: "#FFFFFF",
        padding: "10px 10px 14px",
        boxShadow: "0 12px 22px rgba(60,40,10,0.25)",
        transform: `rotate(${rotate}deg)`,
        position: "relative",
      }}
    >
      {pin}
      {children}
      <figcaption style={{ marginTop: 8, fontFamily: CAVEAT, fontSize: 24, textAlign: "center" }}>{caption}</figcaption>
    </figure>
  );
}

function IndexCard({ number, title, rotate, children }: { number: string; title: string; rotate: number; children: ReactNode }) {
  return (
    <div
      style={{
        background: PAPER,
        color: INK,
        padding: "30px 26px 28px",
        transform: `rotate(${rotate}deg)`,
        position: "relative",
        backgroundImage: `repeating-linear-gradient(${PAPER} 0 31px, #D9E3F0 31px 32px)`,
      }}
    >
      <Pin color={ACCENT} style={{ top: -9, left: "50%", width: 18, height: 18, boxShadow: "none" }} />
      <div style={{ fontFamily: CAVEAT, fontSize: 64, lineHeight: 0.8, color: ACCENT }}>{number}</div>
      <h3 style={{ margin: "14px 0 0", fontSize: 22 }}>{title}</h3>
      <p style={{ margin: "8px 0 0", fontSize: 17, lineHeight: 1.85 }}>{children}</p>
    </div>
  );
}

function PriceTag({ title, yellow = false, rotate, children }: { title: string; yellow?: boolean; rotate: number; children: ReactNode }) {
  return (
    <div
      style={{
        background: yellow ? YELLOW : "#FFFFFF",
        borderRadius: "8px 40px 40px 8px",
        padding: "24px 28px 24px 52px",
        position: "relative",
        transform: `rotate(${rotate}deg)`,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 18,
          top: "50%",
          width: 16,
          height: 16,
          marginTop: -8,
          borderRadius: "50%",
          background: BOARD,
          border: `2px solid ${INK}`,
        }}
      />
      <h3 style={{ margin: 0, fontFamily: ANTON, fontWeight: 400, fontSize: 26, letterSpacing: 0.5 }}>{title}</h3>
      <p style={{ margin: "6px 0 0", fontSize: 16, lineHeight: 1.5 }}>{children}</p>
    </div>
  );
}

/* ---------- Illustrations (swap for real photos later) ---------- */

const sceneStyle: CSSProperties = { display: "block", width: "100%", height: "auto" };

function KitchenScene() {
  return (
    <svg viewBox="0 0 240 160" role="img" aria-label="Home kitchen: a pot of food, bottles of zobo and a phone taking a photo" style={sceneStyle}>
      <rect x="0" y="0" width="240" height="160" fill="#FCE3C4" />
      <rect x="0" y="118" width="240" height="42" fill="#A0643C" />
      <rect x="26" y="104" width="104" height="14" rx="3" fill="#3B3B3B" />
      <rect x="40" y="64" width="76" height="42" rx="10" fill="#C0392B" />
      <rect x="34" y="58" width="88" height="9" rx="4" fill="#922B21" />
      <rect x="72" y="50" width="12" height="9" rx="3" fill="#922B21" />
      <path d="M58 44 C52 36 64 30 58 22 M78 42 C72 34 84 28 78 20 M98 44 C92 36 104 30 98 22" stroke="#FFFFFF" strokeWidth="4" fill="none" strokeLinecap="round" />
      <rect x="140" y="80" width="16" height="38" rx="5" fill="#7B1E3A" />
      <rect x="143" y="72" width="10" height="10" rx="2" fill="#2E2E2E" />
      <rect x="162" y="80" width="16" height="38" rx="5" fill="#7B1E3A" />
      <rect x="165" y="72" width="10" height="10" rx="2" fill="#2E2E2E" />
      <rect x="190" y="40" width="34" height="60" rx="6" fill="#1D1D1D" />
      <rect x="193" y="46" width="28" height="44" rx="3" fill="#BDF4C9" />
      <path d="M184 34 l-8 -8 M207 30 v-10 M230 34 l6 -6" stroke="#F2B705" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function MarketScene() {
  const stripes = [0, 30, 60, 90, 120, 150, 180, 210];
  return (
    <svg viewBox="0 0 240 160" role="img" aria-label="Market stall with a striped awning and baskets of tomatoes and peppers" style={sceneStyle}>
      <rect x="0" y="0" width="240" height="160" fill="#DFF3E4" />
      {stripes.map((x, i) => (
        <rect key={x} x={x} y="18" width="30" height="28" fill={i % 2 === 0 ? "#D9542B" : "#FFF4D6"} />
      ))}
      <rect x="12" y="46" width="6" height="64" fill="#6B4226" />
      <rect x="222" y="46" width="6" height="64" fill="#6B4226" />
      <rect x="8" y="104" width="224" height="14" fill="#8B5A2B" />
      <rect x="20" y="118" width="200" height="42" fill="#A9713D" />
      <ellipse cx="62" cy="102" rx="36" ry="10" fill="#C8963E" />
      <circle cx="46" cy="92" r="9" fill="#E53935" />
      <circle cx="62" cy="92" r="9" fill="#E53935" />
      <circle cx="78" cy="92" r="9" fill="#E53935" />
      <circle cx="54" cy="80" r="8" fill="#C62828" />
      <circle cx="70" cy="80" r="8" fill="#C62828" />
      <ellipse cx="130" cy="102" rx="32" ry="10" fill="#C8963E" />
      <circle cx="116" cy="93" r="7" fill="#F57C00" />
      <circle cx="130" cy="93" r="7" fill="#F57C00" />
      <circle cx="144" cy="93" r="7" fill="#F57C00" />
      <circle cx="123" cy="83" r="7" fill="#EF6C00" />
      <circle cx="137" cy="83" r="7" fill="#EF6C00" />
      <ellipse cx="194" cy="102" rx="30" ry="10" fill="#C8963E" />
      <circle cx="182" cy="92" r="8" fill="#8E5BA8" />
      <circle cx="196" cy="92" r="8" fill="#8E5BA8" />
      <circle cx="210" cy="92" r="8" fill="#8E5BA8" />
      <circle cx="189" cy="81" r="7" fill="#7B4A94" />
      <circle cx="203" cy="81" r="7" fill="#7B4A94" />
    </svg>
  );
}

function ShopScene() {
  return (
    <svg viewBox="0 0 240 160" role="img" aria-label="Provision shop with full shelves and a chat message at the counter" style={sceneStyle}>
      <rect x="0" y="0" width="240" height="160" fill="#E3ECFA" />
      <rect x="28" y="10" width="26" height="22" fill="#F2B705" />
      <rect x="58" y="12" width="20" height="20" fill="#D9542B" />
      <rect x="82" y="8" width="30" height="24" fill="#2E7D32" />
      <rect x="116" y="12" width="22" height="20" fill="#1565C0" />
      <rect x="142" y="10" width="26" height="22" fill="#F2B705" />
      <rect x="172" y="8" width="38" height="24" fill="#8E24AA" />
      <rect x="20" y="32" width="200" height="6" fill="#6D4C41" />
      <rect x="28" y="50" width="34" height="22" fill="#1565C0" />
      <rect x="66" y="52" width="22" height="20" fill="#F2B705" />
      <rect x="92" y="48" width="28" height="24" fill="#D9542B" />
      <rect x="124" y="50" width="30" height="22" fill="#2E7D32" />
      <rect x="158" y="52" width="22" height="20" fill="#8E24AA" />
      <rect x="184" y="48" width="28" height="24" fill="#F2B705" />
      <rect x="20" y="72" width="200" height="6" fill="#6D4C41" />
      <rect x="0" y="118" width="240" height="42" fill="#455A64" />
      <rect x="118" y="84" width="104" height="28" rx="10" fill="#FFFFFF" />
      <path d="M200 112 l10 0 l-2 8 z" fill="#FFFFFF" />
      <rect x="128" y="93" width="62" height="4" rx="2" fill="#9E9E9E" />
      <rect x="128" y="101" width="40" height="4" rx="2" fill="#BDBDBD" />
    </svg>
  );
}

function FashionScene() {
  return (
    <svg viewBox="0 0 240 160" role="img" aria-label="Fashion rail with three dresses and a measuring tape" style={sceneStyle}>
      <rect x="0" y="0" width="240" height="160" fill="#F8E1EC" />
      <line x1="16" y1="30" x2="224" y2="30" stroke="#5D4037" strokeWidth="5" strokeLinecap="round" />
      <path d="M66 30 v8 M120 30 v8 M174 30 v8" stroke="#5D4037" strokeWidth="3" />
      <path d="M50 40 L82 40 L96 120 L36 120 Z" fill="#D9542B" />
      <circle cx="56" cy="62" r="3" fill="#FFFFFF" />
      <circle cx="72" cy="78" r="3" fill="#FFFFFF" />
      <circle cx="58" cy="96" r="3" fill="#FFFFFF" />
      <circle cx="80" cy="104" r="3" fill="#FFFFFF" />
      <circle cx="70" cy="54" r="3" fill="#FFFFFF" />
      <path d="M104 40 L136 40 L148 120 L92 120 Z" fill="#1565C0" />
      <path d="M100 70 L140 70" stroke="#F2B705" strokeWidth="6" />
      <path d="M97 92 L143 92" stroke="#F2B705" strokeWidth="6" />
      <path d="M158 40 L190 40 L202 120 L146 120 Z" fill="#F2B705" />
      <path d="M152 80 L196 80" stroke="#0F3D2E" strokeWidth="4" strokeDasharray="6 5" />
      <path d="M8 142 C60 126 100 156 150 140 S214 130 234 146" stroke="#F2B705" strokeWidth="7" fill="none" strokeLinecap="round" />
    </svg>
  );
}
