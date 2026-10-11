// Atlassian Document Format (Jira Cloud rich text) to plain text. Unknown nodes fall back to their text.
interface AdfNode {
  type?: string;
  text?: string;
  attrs?: { text?: string; shortName?: string; url?: string };
  content?: unknown[];
}

const isNode = (v: unknown): v is AdfNode => typeof v === 'object' && v !== null && !Array.isArray(v);

function inline(node: unknown): string {
  if (!isNode(node)) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return '@' + (node.attrs?.text ?? '').replace(/^@/, '');
  if (node.type === 'emoji') return node.attrs?.shortName ?? '';
  if (node.type === 'inlineCard') return node.attrs?.url ?? '';
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(inline).join('');
}

function blocks(nodes: unknown[], indent: string): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (!isNode(n)) continue;
    const kids = n.content ?? [];
    if (n.type === 'bulletList' || n.type === 'orderedList') {
      kids.forEach((item, i) => {
        const marker = n.type === 'orderedList' ? `${i + 1}. ` : '- ';
        const lines = blocks(isNode(item) ? (item.content ?? []) : [], indent + '  ');
        if (lines.length === 0) return;
        out.push(indent + marker + lines[0].trimStart(), ...lines.slice(1));
      });
    } else if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'codeBlock') {
      out.push(...inline(n).split('\n').map((l) => indent + l));
    } else if (kids.length > 0 && kids.some((k) => isNode(k) && k.type !== 'text' && k.type !== 'mention')) {
      out.push(...blocks(kids, indent));
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
  return blocks(doc.type === 'doc' ? (doc.content ?? []) : [doc], '').join('\n').trim();
}
