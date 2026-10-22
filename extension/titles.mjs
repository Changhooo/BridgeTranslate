// Local display only; never changes conversation names on the server.
const SIDEBAR='nav,aside,[role="navigation"],[data-testid*="sidebar" i],[id*="sidebar" i],[class*="sidebar" i]';
const EXCLUDE='button,svg,input,textarea,[contenteditable],script,style,[data-bridge-ui],.sr-only,.visually-hidden,[aria-hidden="true"]';
export function createTitleTracker(document,{visible=()=>true}={}) {
 const records=new Map(),cache=new Map(),failed=new Set();
 function nodesOf(anchor){const walker=document.createTreeWalker(anchor,4),nodes=[];let n;while((n=walker.nextNode()))if(n.nodeValue.trim()&&!n.parentElement.closest(EXCLUDE))nodes.push(n);return nodes;}
 function current(r){return r.anchor.isConnected&&r.anchor.getAttribute('href')===r.href&&r.nodes.every((n,i)=>n.isConnected&&r.anchor.contains(n)&&n.nodeValue===r.values[i]);}
 function restore(r){if(current(r))r.nodes.forEach((n,i)=>n.nodeValue=r.original[i]);if(r.anchor.getAttribute('title')===r.tooltip){if(r.oldTooltip===null)r.anchor.removeAttribute('title');else r.anchor.setAttribute('title',r.oldTooltip);}}
 function apply(r,value){if(!current(r))return;r.values=r.nodes.map((_,i)=>i===0?value:'');r.nodes.forEach((n,i)=>n.nodeValue=r.values[i]);r.tooltip=r.source;r.anchor.setAttribute('title',r.tooltip);r.done=true;}
 function reset({clearCache=false}={}){for(const r of records.values())restore(r);records.clear();failed.clear();if(clearCache)cache.clear();}
 function scan(){
  for(const [a,r] of records)if(!current(r)){restore(r);records.delete(a);}
  for(const a of document.querySelectorAll('a[href*="/chat/"]')){
   if(!a.closest(SIDEBAR)||!visible(a)||a.closest(EXCLUDE))continue;
   let url;try{url=new URL(a.href);}catch{continue;}
   if(url.origin!==document.location.origin||!/^\/chat\/[^/]+\/?$/.test(url.pathname)||records.has(a))continue;
   const nodes=nodesOf(a),original=nodes.map(n=>n.nodeValue),source=original.join('').trim();
   if(!/[a-zA-Z]{2}/.test(source)||source.length>256||/[\u3400-\u9fff]/.test(source))continue;
   const r={anchor:a,nodes,original,source,href:a.getAttribute('href'),values:[...original],oldTooltip:a.getAttribute('title'),done:false};records.set(a,r);if(cache.has(source))apply(r,cache.get(source));
  }
  const batch=[],sources=new Set();let length=0;
  for(const r of records.values())if(!r.done&&!failed.has(r.source)&&current(r)&&visible(r.anchor)&&!sources.has(r.source)){
   if(batch.length>=20||length+r.source.length>2200)break;sources.add(r.source);length+=r.source.length;batch.push({id:'title'+batch.length,text:r.source});
  }
  return batch;
 }
 return {scan,reset,payload:batch=>JSON.stringify({items:batch}),fail(batch){for(const i of batch)failed.add(i.text);},apply(batch,text){
  let data;try{data=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{throw new Error('标题译文格式无效，已保留原文。');}
  if(!Array.isArray(data.items)||data.items.length!==batch.length)throw new Error('标题译文不完整，已保留原文。');
  const expected=new Map(batch.map(i=>[i.id,i.text])),values=new Map();
  for(const i of data.items){if(!i||!expected.has(i.id)||values.has(i.id)||typeof i.text!=='string'||!i.text.trim()||i.text.length>512)throw new Error('标题译文编号或文字无效，已保留原文。');values.set(i.id,i.text.trim());}
  for(const i of batch){cache.set(i.text,values.get(i.id));for(const r of records.values())if(r.source===i.text)apply(r,values.get(i.id));}
  while(cache.size>300)cache.delete(cache.keys().next().value);
 }};
}
