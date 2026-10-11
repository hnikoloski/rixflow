// Atlassian Document Format (Jira Cloud rich text) to plain text. Unknown nodes fall back to their text.
interface AdfNode {
  type?: string;
  text?: string;
  attrs?: unknown;
  content?: unknown;
}

const kids = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const isNode = (v: unknown): v is AdfNode => typeof v === 'object' && v !== null && !Array.isArray(v);

function inline(node: unknown): string {
  if (!isNode(node)) return '';
  if (node.type === 'text') return text(node.text);
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return '@' + text(obj(node.attrs).text).replace(/^@/, '');
  if (node.type === 'emoji') return text(obj(node.attrs).shortName);
  if (node.type === 'inlineCard') return text(obj(node.attrs).url);
  if (typeof node.text === 'string') return node.text;
  return kids(node.content).map(inline).join('');
}

function blocks(nodes: unknown[], indent: string): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (!isNode(n)) continue;
    const sub = kids(n.content);
    if (n.type === 'bulletList' || n.type === 'orderedList') {
      sub.forEach((item, i) => {
        const marker = n.type === 'orderedList' ? `${i + 1}. ` : '- ';
        const lines = blocks(isNode(item) ? kids(item.content) : [], indent + '  ');
        if (lines.length === 0) return;
        out.push(indent + marker + lines[0].trimStart(), ...lines.slice(1));
      });
    } else if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'codeBlock') {
      out.push(...inline(n).split('\n').map((l) => indent + l));
    } else if (sub.length > 0 && sub.some((k) => isNode(k) && k.type !== 'text' && k.type !== 'mention')) {
      out.push(...blocks(sub, indent));
    } else {
      const t = inline(n);
      if (t) out.push(indent + t);
    }
  }
  return out;
}

export function adfToText(doc: unknown): string {
  if (typeof doc === 'string') return doc;
  if (!isNode(doc)) return '';
  return blocks(doc.type === 'doc' ? (kids(doc.content)) : [doc], '').join('\n').trim();
}
