import YAML from 'yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseDoc(text: string): { data: Record<string, unknown>; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text };
  const data = (YAML.parse(match[1]) ?? {}) as Record<string, unknown>;
  return { data, body: text.slice(match[0].length) };
}

export function stringifyDoc(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const text = body.endsWith('\n') ? body : `${body}\n`;
  return `---\n${YAML.stringify(clean).trimEnd()}\n---\n${text}`;
}
