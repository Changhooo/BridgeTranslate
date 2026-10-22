// Export the existing document structure. Model output is never interpreted as HTML.
const ignored = '[data-bridge-ui],button,input,textarea,select,script,style,noscript,.sr-only,.visually-hidden,.screen-reader-only,.screen-reader-text,[data-testid="message-timestamp"],[data-testid="timestamp"],[data-testid="message-actions"]';
function hidden(node) { return node.matches(ignored) || node.hidden || node.getAttribute('aria-hidden')==='true' || node.style.display==='none' || node.style.visibility==='hidden'; }
function mathText(node) {
  const latex=node.getAttribute('data-latex')||node.getAttribute('data-tex')||node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
  return latex ? '$'+latex+'$' : node.textContent||'';
}
function plain(node,readText) {
  if(node.nodeType===3)return readText(node)||'';
  if(node.nodeType!==1||hidden(node))return '';
  if(node.matches('math,mjx-container,.katex,.MathJax,[role="math"],[data-latex],[data-tex]'))return mathText(node);
  if(node.tagName==='BR')return '\n';
  return [...node.childNodes].map(child=>plain(child,readText)).join('');
}
export function codeText(pre) { return (pre.querySelector('code')||pre).textContent||''; }
export function tablePayload(table,readText=node=>node.nodeValue) {
  const doc=table.ownerDocument,copy=doc.createElement('table');
  const rows=[...table.rows].map(row=>{
    const tr=doc.createElement('tr');copy.append(tr);
    return [...row.cells].map(cell=>{
      const value=plain(cell,readText).trim(),td=doc.createElement(cell.tagName.toLowerCase());td.textContent=value;
      if(cell.colSpan>1)td.colSpan=cell.colSpan;if(cell.rowSpan>1)td.rowSpan=cell.rowSpan;tr.append(td);
      return value;
    });
  });
  const escape=value=>value.replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>');
  const width=Math.max(0,...rows.map(row=>row.length));
  const md=rows.map(row=>'| '+Array.from({length:width},(_,i)=>escape(row[i]||'')).join(' | ')+' |');
  if(md.length)md.splice(1,0,'| '+Array(width).fill('---').join(' | ')+' |');
  // Quoted TSV retains newlines/tabs inside a cell when pasted into spreadsheets.
  const tsv=value=>/[\t\r\n"]/u.test(value)?'"'+value.replace(/"/g,'""')+'"':value;
  return {text:rows.map(row=>row.map(tsv).join('\t')).join('\n'),html:copy.outerHTML,markdown:md.join('\n')};
}
export function serializeMarkdown(root,readText=node=>node.nodeValue) {
  const escape=text=>text.split(/(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\$(?!\s)[^$\n]+?\$)/g).map((part,index)=>index%2?part:part.replace(/([\\`*_[\]<>])/g,'\\$1')).join('');
  function walk(node,depth=0) {
    if(node.nodeType===3)return escape(readText(node)||'');
    if(node.nodeType!==1||hidden(node))return '';
    const tag=node.tagName;
    if(tag==='PRE') {
      const value=codeText(node),lang=(node.querySelector('code')?.className||'').match(/language-([\w+-]+)/)?.[1]||'';
      const fence='`'.repeat(Math.max(3,...[...value.matchAll(/`+/g)].map(m=>m[0].length+1)));
      return '\n\n'+fence+lang+'\n'+value.replace(/\n$/,'')+'\n'+fence+'\n\n';
    }
    if(tag==='CODE') { const value=node.textContent||'',fence='`'.repeat(Math.max(1,...[...value.matchAll(/`+/g)].map(m=>m[0].length+1)));return fence+' '+value+' '+fence; }
    if(node.matches('math,mjx-container,.katex,.MathJax,[role="math"],[data-latex],[data-tex]'))return mathText(node);
    if(tag==='IMG'){const src=node.getAttribute('src')||'';return /^https?:\/\//i.test(src)?'!['+escape(node.getAttribute('alt')||'')+']('+src.replace(/\)/g,'%29')+')':'';}
    if(node.matches('svg,canvas,picture,video,audio,iframe,object,embed'))return '';
    if(tag==='TABLE')return '\n\n'+tablePayload(node,readText).markdown+'\n\n';
    if(tag==='BR')return '\n';if(tag==='HR')return '\n\n---\n\n';
    if(tag==='UL'||tag==='OL') {
      let index=Number(node.getAttribute('start'))||1;
      const rows=[...node.children].filter(child=>child.tagName==='LI').map(li=>{
        const prefix=tag==='OL'?(index++)+'. ':'- ';
        const text=[...li.childNodes].map(child=>walk(child,depth+1)).join('').trim();
        return prefix+text.replace(/\n/g,'\n'+' '.repeat(prefix.length));
      });
      return '\n'+rows.join('\n')+'\n';
    }
    const children=[...node.childNodes].map(child=>walk(child,depth)).join('');
    if(/^H[1-6]$/.test(tag))return '\n\n'+'#'.repeat(Number(tag[1]))+' '+children.trim()+'\n\n';
    if(tag==='STRONG'||tag==='B')return '**'+children+'**';
    if(tag==='EM'||tag==='I')return '*'+children+'*';
    if(tag==='S'||tag==='DEL')return '~~'+children+'~~';
    if(tag==='A'){const href=node.getAttribute('href')||'';return /^https?:\/\//i.test(href)?'['+children+']('+href.replace(/\)/g,'%29')+')':children;}
    if(tag==='BLOCKQUOTE')return '\n\n'+children.trim().split('\n').map(line=>'> '+line).join('\n')+'\n\n';
    if(['P','DIV','SECTION','ARTICLE','DETAILS','SUMMARY'].includes(tag))return '\n'+children+'\n';
    return children;
  }
  return walk(root).trim();
}
