// Minimal Markdown → plain data (no HTML strings), so rendering can only ever create text nodes.
// Blocks: # / ## / ### headings, "- " lists, paragraphs. Inline: **bold**, *italic*, [[id|Title]] links.
(function (root) {
  const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|\[\[[^\]|]+\|[^\]]+\]\])/;
  function inline(s) {
    return s.split(INLINE).filter(Boolean).map((t) => {
      if (t.startsWith('**') && t.endsWith('**') && t.length > 4) return { b: inline(t.slice(2, -2)) };
      if (t.startsWith('[[')) { const [id, title] = t.slice(2, -2).split('|'); return { link: id, text: title }; }
      if (t.startsWith('*') && t.endsWith('*') && t.length > 2) return { i: inline(t.slice(1, -1)) };
      return t;
    });
  }
  function parseMarkdown(md) {
    const blocks = [];
    for (const line of String(md).split(/\r?\n/)) {
      const last = blocks[blocks.length - 1];
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (!line.trim()) blocks.push(null);
      else if (h) blocks.push({ tag: 'h' + (h[1].length + 2), inline: inline(h[2]) });
      else if (/^[-*]\s+/.test(line)) {
        const item = inline(line.replace(/^[-*]\s+/, ''));
        if (last && last.tag === 'ul') last.items.push(item); else blocks.push({ tag: 'ul', items: [item] });
      } else if (last && last.tag === 'p') last.inline.push('\n', ...inline(line));
      else blocks.push({ tag: 'p', inline: inline(line) });
    }
    return blocks.filter(Boolean);
  }
  root.parseMarkdown = parseMarkdown;
})(typeof module !== 'undefined' ? module.exports : window);
