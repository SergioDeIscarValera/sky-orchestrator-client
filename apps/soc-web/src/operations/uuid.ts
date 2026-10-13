/**
 * A version 4 UUID from the platform's random bytes. crypto.randomUUID is not available over plain
 * HTTP from a LAN address, which is no secure context (ADR-0015, NFR-PORT-04), so the console builds
 * the id itself. A request's client id is the key the database keeps its answer under, so each ask
 * takes a new one.
 */
export function uuidV4(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = fillRandom,
): string {
  const bytes = random(new Uint8Array(16))
  // RFC 9562: the version nibble is 4, and the variant's two bits are 10.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return [hex.slice(0, 4), hex.slice(4, 6), hex.slice(6, 8), hex.slice(8, 10), hex.slice(10, 16)]
    .map((group) => group.join(''))
    .join('-')
}

function fillRandom(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(bytes)
}
