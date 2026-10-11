const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function newMessageId(now: Date, rand: () => number = Math.random): string {
  const suffix = Array.from({ length: 4 }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join('');
  return `${isoDate(now)}-${suffix}`;
}
