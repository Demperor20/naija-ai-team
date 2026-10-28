// lib/whatsapp/text.ts — shared text helpers (both providers).

// Digits only: "+234 803..." and "whatsapp:+234..." both become 234803....
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

// Split long text into chunks of at most maxLength characters, preferring
// paragraph, line and word boundaries.
export function splitText(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) return [text];
  const target = maxLength - 96;
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    let cut = target;
    for (const sep of ["\n\n", "\n", " "]) {
      const idx = rest.lastIndexOf(sep, target);
      if (idx > target - 1000 && idx > 0) {
        cut = idx;
        break;
      }
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
    if (chunks.length > 20) break; // safety cap
  }
  if (rest) chunks.push(rest);
  return chunks;
}
