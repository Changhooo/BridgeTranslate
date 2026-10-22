import {createTextPlan,originalText,isProtectedElement} from './dom-text.mjs';
import {serializeMarkdown} from './clipboard.mjs';

const containers=new Set(['DIV','SECTION','ARTICLE','HEADER','FOOTER','MAIN','UL','OL','LI','BLOCKQUOTE','DETAILS','SUMMARY','P','H1','H2','H3','H4','H5','H6','TABLE']);
const leaves=new Set(['P','H1','H2','H3','H4','H5','H6','TABLE','SUMMARY']);
function invisible(node) { if(node.nodeType!==1)return false;const s=node.ownerDocument.defaultView.getComputedStyle(node);return node.hidden||node.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'; }
// Include protected objects in the revision signature, but never in translation input.
function signature(node) {
  if(node.nodeType===3)return originalText(node)||'';
  if(node.nodeType!==1||node.matches('[data-bridge-ui],button,script,style,time,.sr-only,.visually-hidden,.screen-reader-only,.screen-reader-text,[data-testid="message-actions"],[data-testid="timestamp"],[data-testid="message-timestamp"]')||invisible(node))return '';
  return '<'+node.tagName+' '+(node.getAttribute('src')||'')+' '+(node.getAttribute('href')||'')+'>'+[...node.childNodes].map(signature).join('')+'</'+node.tagName+'>';
}
function codeChrome(node,root) {
  let parent=node.parentElement;
  for(let depth=0;parent&&parent!==root&&depth<2;depth++,parent=parent.parentElement){
    if(parent.querySelector('pre')&&!node.querySelector?.('pre')&&!parent.querySelector('p,h1,h2,h3,h4,h5,h6,ul,ol,table'))return true;
  }
  return false;
}
export function paragraphTargets(root) {
  const ordered=[];
  function walk(node) {
    if(node.nodeType!==1||node.matches('[data-bridge-ui]')||invisible(node))return;
    if(isProtectedElement(node)){if(node.matches('pre,img,picture,svg,canvas,math,mjx-container,.katex,.MathJax,video,iframe'))ordered.push(null);return;}
    if(codeChrome(node,root))return;
    if(leaves.has(node.tagName)) {ordered.push({key:node,node,nodes:null,anchor:node,inside:node===root});return;}
    let group=[];
    function flush(){
      if(!group.length)return;
      const nodes=group;group=[];
      if(!nodes.some(child=>child.nodeType===3?(originalText(child)||'').trim():!isProtectedElement(child)&&signature(child).replace(/<[^>]+>/g,'').trim()))return;
      const whole=nodes.length===[...node.childNodes].filter(child=>!child.matches?.('[data-bridge-ui]')).length;
      ordered.push({key:whole?node:nodes[0],node,nodes,anchor:whole?node:nodes.at(-1),inside:whole&&(node===root||node.tagName==='LI')});
    }
    for(const child of node.childNodes){
      if(child.matches?.('[data-bridge-ui]'))continue;
      if(child.nodeType===1&&(containers.has(child.tagName)||child.matches('pre,img,picture,svg,canvas,math,mjx-container,.katex,.MathJax,video,iframe'))){flush();walk(child);}
      else if(child.nodeType===3||child.nodeType===1)group.push(child);
    }
    flush();
  }
  walk(root);
  return ordered.map((target,index)=>target&&({...target,closed:index<ordered.length-1})).filter(Boolean);
}
export function createParagraphTracker(root,{createHost,now=()=>Date.now(),onInvalidate=()=>{}}={}) {
  const records=new Map(),owners=new WeakMap();let mode='bilingual',disposed=false;
  function current(record){return !disposed&&records.get(record.target.key)===record&&record.plan?.isCurrent()&&record.signature===record.targetSignature();}
  function discard(record){onInvalidate(record);record.plan?.dispose();record.host?.remove();}
  function place(record){
    const {anchor,inside}=record.target;if(!record.host)return;
    if(inside){if(record.host.parentNode!==anchor)anchor.append(record.host);}
    else if(record.host.previousSibling!==anchor)anchor.parentNode?.insertBefore(record.host,anchor.nextSibling);
  }
  function display(record){
    if(!record.host)return;
    if(record.status==='done'&&current(record))record.plan.setMode(mode);
    else record.plan?.setMode('original');
    record.output.hidden=record.status!=='done'||mode!=='bilingual';
    record.caption.hidden=record.status==='done';
    record.caption.textContent=record.status==='running'?'正在翻译此段…':record.status==='error'?'此段翻译失败，原文保留；可点击下方“翻译／重试”。':record.status==='cancelled'?'此段翻译已取消。':'';
    record.host.hidden=mode==='original'||(mode==='chinese'&&record.status==='done'&&!record.tableTools);
    if(record.tableTools){record.tableTools.hidden=record.status!=='done';for(const button of record.tableTools.querySelectorAll('button'))button.disabled=record.status!=='done';}
    place(record);
  }
  return {
    records,
    update(){
      if(disposed)return [];
      const targets=paragraphTargets(root),seen=new Set();
      for(const target of targets){
        const targetSignature=()=>target.nodes?target.nodes.map(signature).join(''):signature(target.node),value=targetSignature();
        seen.add(target.key);let record=records.get(target.key);
        if(record&&(record.signature!==value||(record.plan&&!record.plan.isCurrent()))){discard(record);records.delete(target.key);record=null;}
        if(!record){record={target,signature:value,targetSignature,changedAt:now(),status:'waiting',plan:null,requestIds:new Set()};records.set(target.key,record);}
        record.target=target;record.targetSignature=targetSignature;record.closed=target.closed;place(record);
      }
      for(const [key,record]of records)if(!seen.has(key)){discard(record);records.delete(key);}
      return [...records.values()];
    },
    ready(isStreaming,tailDelay=250){return [...records.values()].filter(record=>record.status==='waiting'&&(!isStreaming||record.closed)&&now()-record.changedAt>=(record.closed?250:tailDelay));},
    prepare(record){
      record.plan=createTextPlan(record.target.node,{nodes:record.target.nodes,inlineCode:true});
      for(const item of record.plan.items)owners.set(item.node,record);
      if(!record.plan.batches.length){record.status='done';return false;}
      const ui=createHost(record);Object.assign(record,ui);record.output.replaceChildren(record.plan.view);record.status='running';display(record);return true;
    },
    isCurrent:current,
    finish(record){if(!current(record))return false;record.status='done';display(record);return true;},
    fail(record,cancelled=false){if(records.get(record.target.key)!==record)return;record.status=cancelled?'cancelled':'error';record.plan?.setMode('original');display(record);},
    retry(){for(const record of records.values())if(record.status==='error'||record.status==='cancelled'){record.host?.remove();record.plan?.dispose();record.plan=null;record.host=null;record.output=null;record.caption=null;record.tableTools=null;record.status='waiting';}},
    setMode(value){mode=value;for(const record of records.values())display(record);},
    complete(){return [...records.values()].every(record=>record.status==='done');},
    markdown(){return serializeMarkdown(root,node=>{const record=owners.get(node);return record?.status==='done'&&current(record)?record.plan.readText(node):originalText(node);});},
    dispose(){disposed=true;for(const record of records.values())discard(record);records.clear();}
  };
}
