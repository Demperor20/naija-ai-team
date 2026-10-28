import { after } from "next/server";
import { getProvider, handleIncoming, ProviderHttpError } from "@/lib/whatsapp";

export const maxDuration = 300;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (
    mode === "subscribe" &&
    expected &&
    token === expected &&
    challenge
  ) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("forbidden", { status: 403 });
}

export async function POST(request: Request) {
  const provider = getProvider("meta");
  let messages;
  try {
    messages = await provider.parseIncoming(request);
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      return new Response("forbidden", { status: err.status });
    }
    throw err;
  }
  after(() =>
    (async () => {
      for (const message of messages) {
        await handleIncoming(provider, message);
      }
    })().catch((err) =>
      console.error(
        "whatsapp after() failed:",
        err instanceof Error ? err.message : err,
      ),
    ),
  );
  return Response.json({ ok: true });
}
