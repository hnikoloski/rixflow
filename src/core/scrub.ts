// A userinfo that is exactly `[redacted]` (no further `@` before the host ends) is what scrub()
// itself produces. Both URL rules skip it, so scrub output is never flagged by findSecrets
// (redaction is a fixed point of detection) and the pre-commit check accepts scrubbed notes.
const NOT_REDACTED = String.raw`(?!\[redacted\]@(?![^\s/]*@))`;

const PATTERNS: Array<[name: string, re: RegExp, replacement: string]> = [
  // Any scheme with a password: sftp://u:p@, mysql://u:p@, redis://:p@, postgres://u:p@ ...
  // Linear time: the scheme must start a word (the lookbehind stops retries inside long runs of
  // scheme characters) and the user part stops at the first ':' (no nested backtracking).
  ['url-credentials', new RegExp(String.raw`(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)${NOT_REDACTED}[^\s/:]*:[^\s/]*@`, 'gi'), '$1[redacted]@'],
  // http(s) with any userinfo, including a username alone.
  ['url-credentials', new RegExp(String.raw`(https?:\/\/)${NOT_REDACTED}[^\s/]+@`, 'gi'), '$1[redacted]@'],
  ['asana-pat', /\b\d\/\d+(?:\/\d+)?:[0-9a-f]{32}\b/g, '[redacted]'],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, '[redacted]'],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, 'Bearer [redacted]'],
];

export function scrub(text: string, extra: string[] = []): string {
  let out = text;
  for (const secret of extra) if (secret.length >= 6) out = out.split(secret).join('[redacted]');
  for (const [, re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function findSecrets(text: string): string[] {
  const found = PATTERNS.filter(([, re]) => new RegExp(re.source, re.flags.replace('g', '')).test(text)).map(([name]) => name);
  return [...new Set(found)];
}
