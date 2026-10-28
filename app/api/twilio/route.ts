import { after } from "next/server";
import { getProvider, handleIncoming, ProviderHttpError } from "@/lib/whatsapp";

// Twilio WhatsApp Sandbox webhook ("When a message comes in").
// Paste https://<your-vercel-domain>/api/twilio in the Twilio Console.
export const maxDuration = 300;

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

export async function POST(request: Request) {
  const provider = getProvider("twilio");
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
        "twilio after() failed:",
        err instanceof Error ? err.message : err,
      ),
    ),
  );
  return new Response(EMPTY_TWIML, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
