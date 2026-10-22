'use strict';
const root=document.getElementById('content');
const send=(type,other={})=>window.chrome.webview.postMessage({type,...other});
function button(label,action){const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',action);return b;}
function safeURL(s){try{const u=new URL(s);return u.protocol==='https:'?u.href:null;}catch{return null;}}
function tableText(table){return [...table.rows].map(r=>[...r.cells].map(c=>c.innerText.replace(/\t|\r?\n/g,' ')).join('\t')).join('\r\n');}
function tableMarkdown(t){const rows=[...t.rows].map(r=>[...r.cells].map(c=>c.textContent.replace(/\|/g,'\\|').replace(/\r?\n/g,' ')));if(!rows.length)return '';const size=Math.max(...rows.map(r=>r.length));const line=r=>'| '+Array.from({length:size},(_,i)=>r[i]||'').join(' | ')+' |';return [line(rows[0]),line(Array(size).fill('---')),...rows.slice(1).map(line)].join('\n');}
window.chrome.webview.addEventListener('message',event=>{
 if(event.data.type!=='render'||typeof event.data.html!=='string')return;
 const atEnd=window.scrollY+innerHeight>=document.body.scrollHeight-80,scroll=window.scrollY;
 const template=document.createElement('template');template.innerHTML=event.data.html;
 for(const el of template.content.querySelectorAll('*')){
  if(['SCRIPT','IFRAME','OBJECT','EMBED','FORM','STYLE','LINK','META'].includes(el.tagName)){el.remove();continue;}
  for(const a of [...el.attributes])if(a.name.startsWith('on')||['srcdoc','style'].includes(a.name))el.removeAttribute(a.name);
  if(el.hasAttribute('href')){const url=safeURL(el.getAttribute('href'));if(url)el.setAttribute('href',url);else el.removeAttribute('href');}
  if(el.tagName==='IMG'){
   const url=safeURL(el.getAttribute('data-source'));el.removeAttribute('src');el.removeAttribute('srcset');
   const replacement=url?button('加载图片：'+(el.alt||'原图'),()=>{el.src=url;replacement.replaceWith(el);}):document.createTextNode(el.alt||'图片链接不可用');replacement.className='image-link';el.replaceWith(replacement);
  }
 }
 root.replaceChildren(template.content);
 root.querySelectorAll('pre').forEach(pre=>{const code=pre.querySelector('code');if(code)pre.prepend(button('复制代码',()=>send('copy',{text:code.textContent})));});
 root.querySelectorAll('table').forEach(table=>{const tools=document.createElement('div');tools.className='table-tools';tools.append(button('复制表格 TSV',()=>send('copy',{text:tableText(table)})),button('复制表格 Markdown',()=>send('copy',{text:tableMarkdown(table)})));table.before(tools);const wrap=document.createElement('div');wrap.className='table-wrap';table.before(wrap);wrap.append(table);});
 root.querySelectorAll('[data-tex]').forEach(el=>{if(typeof katex!=='undefined')katex.render(el.dataset.tex,el,{displayMode:el.dataset.display==='true',throwOnError:false,trust:false});});
 if(typeof renderMathInElement==='function')renderMathInElement(root,{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'\\(',right:'\\)',display:false},{left:'$',right:'$',display:false}],throwOnError:false,trust:false});
 requestAnimationFrame(()=>window.scrollTo(0,atEnd?document.body.scrollHeight:scroll));
});
root.addEventListener('click',event=>{const a=event.target.closest('a');if(a){event.preventDefault();const url=safeURL(a.href);if(url)send('open',{url});}});
send('ready');
