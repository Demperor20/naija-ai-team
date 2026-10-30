// scripts/hold-smoke.ts — offline check for withHoldMessage
// (lib/whatsapp/handle.ts): a fast task sends no holding message, a slow
// task sends exactly one, and the hold always completes before the result
// is delivered. No API or database.
// Run: npx tsx scripts/hold-smoke.ts
import { withHoldMessage } from "../lib/whatsapp/handle";

function fail(msg: string): never {
  throw new Error(msg);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // Fast task: no hold.
  let holds = 0;
  const fast = await withHoldMessage(
    async () => {
      await sleep(5);
      return "answer";
    },
    async () => {
      holds++;
    },
    100,
  );
  if (fast !== "answer") fail("fast task lost its return value.");
  if (holds !== 0) fail(`fast task sent ${holds} holding messages.`);
  console.log("fast task: no hold, value passed through");

  // Slow task: exactly one hold, and it completes before the result is
  // delivered (the hold is still in flight when the task finishes).
  const events: string[] = [];
  const slow = await withHoldMessage(
    async () => {
      await sleep(120);
      events.push("task-done");
      return 42;
    },
    async () => {
      await sleep(60);
      events.push("hold-sent");
    },
    100,
  );
  if (slow !== 42) fail("slow task lost its return value.");
  events.push("delivered");
  if (events.join(",") !== "task-done,hold-sent,delivered") {
    fail(`slow task ordering wrong: ${events.join(",")}.`);
  }
  console.log("slow task: one hold, hold completed before delivery");

  // Failing task: the error still propagates and the hold is awaited.
  let holdFinished = false;
  try {
    await withHoldMessage(
      async () => {
        await sleep(80);
        throw new Error("boom");
      },
      async () => {
        await sleep(10);
        holdFinished = true;
      },
      20,
    );
    fail("failing task did not throw.");
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "boom") throw err;
  }
  if (!holdFinished) fail("hold was not awaited on task failure.");
  console.log("failing task: error propagated, hold awaited");

  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
