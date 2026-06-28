/**
 * Generate a unique id that works in non-secure contexts.
 *
 * `crypto.randomUUID()` only exists in secure contexts (HTTPS or localhost), so
 * it is undefined when the web client is served over plain HTTP on a LAN/VPN IP.
 * Fall back to `getRandomValues` (RFC-4122 v4), then to a timestamp+random id.
 * These ids are only used for client-local tab/connection keys, not security.
 */
export function genId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h
      .slice(8, 10)
      .join("")}-${h.slice(10, 16).join("")}`;
  }
  return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
