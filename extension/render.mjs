// Small DOM-only Markdown renderer. Model output is never assigned to innerHTML.
export function renderMarkdown(container, source) {
  const doc = container.ownerDocument;
  container.replaceChildren();
  function inline(parent, text) {
    const pattern = /(`+)([^`\n]+?)\1|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(doc.createTextNode(text.slice(last, match.index)));
      let child;
      if (match[1]) { child = doc.createElement('code'); child.textContent = match[2]; }
      else if (match[3]) {
        child = doc.createElement('a'); child.textContent = match[3]; child.href = match[4];
        child.target = '_blank'; child.rel = 'noopener noreferrer';
      } else if (match[5] || match[6]) { child = doc.createElement('strong'); child.textContent = match[5] || match[6]; }
      else { child = doc.createElement('em'); child.textContent = match[7]; }
      parent.append(child); last = match.index + match[0].length;
    }
    parent.append(doc.createTextNode(text.slice(last)));
  }
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  function blockStart(index) {
    const line = lines[index] || '';
    return !line.trim() || /^ {0,3}(`{3,}|~{3,})|^#{1,6}\s|^\s*(?:[-+*]|\d+[.)])\s|^\s*>|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) || (index+1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index+1]));
  }
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^\s]*)\s*$/);
    if (fence) {
      const content = []; i++;
      while (i < lines.length) {
        const close = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length) { i++; break; }
        content.push(lines[i++]);
      }
      const pre = doc.createElement('pre'), code = doc.createElement('code');
      if (/^[\w+-]+$/.test(fence[2])) code.className = 'language-' + fence[2];
      code.textContent = content.join('\n'); pre.append(code); container.append(pre); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) { const el = doc.createElement('h' + Math.min(heading[1].length, 4)); inline(el, heading[2]); container.append(el); i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { container.append(doc.createElement('hr')); i++; continue; }
    if (i+1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])) {
      const wrap = doc.createElement('div'); wrap.className = 'table-wrap';
      const table = doc.createElement('table'), head = doc.createElement('thead'), tr = doc.createElement('tr');
      for (const cell of tableCells(line)) { const th=doc.createElement('th'); inline(th,cell); tr.append(th); }
      head.append(tr); table.append(head); i+=2;
      const body = doc.createElement('tbody');
      while(i<lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row=doc.createElement('tr'); for(const cell of tableCells(lines[i++])) {const td=doc.createElement('td'); inline(td,cell); row.append(td);} body.append(row);
      }
      table.append(body); wrap.append(table); container.append(wrap); continue;
    }
    const list = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
    if (list) {
      const ordered=!!list[2],el=doc.createElement(ordered?'ol':'ul'); if(ordered&&Number(list[2])!==1)el.start=Number(list[2]);
      while(i<lines.length) {
        const item=lines[i].match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/); if(!item||!!item[2]!==ordered)break;
        const li=doc.createElement('li'); inline(li,item[3]); el.append(li); i++;
      }
      container.append(el); continue;
    }
    if (/^\s*>/.test(line)) {
      const quote=[];while(i<lines.length&&/^\s*>/.test(lines[i]))quote.push(lines[i++].replace(/^\s*>\s?/,''));
      const el=doc.createElement('blockquote'); inline(el,quote.join('\n')); container.append(el); continue;
    }
    const paragraph=[line];i++;
    while(i<lines.length&&!blockStart(i))paragraph.push(lines[i++]);
    const p=doc.createElement('p');inline(p,paragraph.join('\n'));container.append(p);
  }
}
