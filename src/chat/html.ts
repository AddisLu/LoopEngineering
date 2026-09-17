/**
 * HTML → readable text for the chat page's fetch_url tool. Hand-rolled on purpose: the repo
 * carries no HTML parser, and the model only needs the prose — headings, paragraphs, lists,
 * table cells — with scripts, styles and site chrome gone. Not a sanitizer: the output is
 * fed to the model as untrusted data, never rendered.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

const DROP_BLOCKS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'nav', 'footer', 'header', 'aside', 'form'];
const NEWLINE_TAGS = ['p', 'div', 'br', 'tr', 'section', 'article', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dt', 'dd', 'hr', 'table', 'ul', 'ol'];

export function htmlToText(html: string): { title: string; text: string } {
  let s = html;
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP_BLOCKS) s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  // headings and list items get a marker so structure survives the flattening
  s = s.replace(/<(h[1-6])\b[^>]*>/gi, '\n\n# ').replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/li\s*>/gi, '');
  s = s.replace(/<t[dh]\b[^>]*>/gi, ' | ');
  for (const tag of NEWLINE_TAGS) s = s.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s
    .replace(/\r/g, '')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: s };
}
