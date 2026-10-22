import {planTranslation, protectInline} from './api.mjs';
import {serializeMarkdown,tablePayload,codeText} from './clipboard.mjs';

// Original media/math nodes remain in the site's DOM. Only ordinary text nodes
// participate in requests or the Chinese/original view switch.
const applied = new WeakMap();
const excluded = 'pre,code,math,mjx-container,.katex,.katex-display,.MathJax,.MathJax_Display,.math,.math-inline,.math-display,[role="math"],[data-math],[data-latex],[data-mathml],[data-tex],[data-formula],img,picture,svg,canvas,video,audio,iframe,object,embed,button,input,textarea,select,script,style,noscript,time,[data-bridge-ui],.sr-only,.visually-hidden,.screen-reader-only,.screen-reader-text,[data-testid="message-timestamp"],[data-testid="timestamp"],[data-testid="message-actions"]';
const tags = new Set(['DIV','P','SPAN','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','STRONG','B','EM','I','U','S','DEL','A','TABLE','CAPTION','THEAD','TBODY','TFOOT','TR','TH','TD','BR','HR']);
const fontProperties = ['font-family','font-size','font-weight','font-style','line-height','letter-spacing','color','text-align','text-decoration','white-space'];

export function originalText(node) {
  const record = applied.get(node);
  return record && node.nodeValue === record.value ? record.original : node.nodeValue;
}
export function isProtectedElement(node) { return node.nodeType === 1 && node.matches(excluded); }

export function createTextPlan(root,{nodes=null,inlineCode=false}={}) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const view = doc.createElement('div'); view.className = 'native-text-layout';
  const items = [], units = [],mirrors=new WeakMap(),index=new WeakMap();
  function clone(node,parent) {
    if(node.nodeType === 3) {
      const source = originalText(node) || '';
      if(!source.trim()) { parent.append(doc.createTextNode(source)); return; }
      const mirror = doc.createTextNode(source); parent.append(mirror);
      const item = {node,source,mirror,parts:[],translation:null}; items.push(item);index.set(node,item);
      for(const part of planTranslation(source,2200)) {
        if(part.kind === 'code' || !part.text.trim()) { item.parts.push({value:part.text}); continue; }
        const id = 't'+units.length;
        const protection = protectInline(part.text.trim(),win.crypto.randomUUID().replace(/-/g,'').slice(0,12));
        const unit = {id,text:protection.text,restore:protection.restore,leading:part.text.match(/^\s*/)[0],trailing:part.text.match(/\s*$/)[0],value:null,item};
        item.parts.push(unit);units.push(unit);
      }
      if(item.parts.every(p=>p.value!==null)) item.translation=item.parts.map(p=>p.value).join('');
      return;
    }
    if(node.nodeType !== 1 || node.hidden || node.getAttribute('aria-hidden') === 'true') return;
    if(inlineCode && node.tagName==='CODE'&&!node.closest('pre')) {
      const code=doc.createElement('code');code.textContent=node.textContent;
      const style=win.getComputedStyle(node);
      for(const property of [...fontProperties,'background-color','border-radius','padding']){const value=style.getPropertyValue(property);if(value)code.style.setProperty(property,value);}
      parent.append(code);return;
    }
    if(isProtectedElement(node))return;
    const style=win.getComputedStyle(node);
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse') return;
    const el=doc.createElement(tags.has(node.tagName)?node.tagName.toLowerCase():'span');
    mirrors.set(node,el);
    for(const property of fontProperties) { const value=style.getPropertyValue(property);if(value)el.style.setProperty(property,value); }
    if(node.tagName==='A') {
      const href=node.getAttribute('href')||'';
      if(/^https?:\/\//i.test(href)){el.href=href;el.target='_blank';el.rel='noopener noreferrer';}
    }
    if(node.tagName==='OL' && node.hasAttribute('start')) el.start=Number(node.getAttribute('start'))||1;
    for(const child of node.childNodes) {
      if(node.tagName==='DETAILS'&&!node.open&&child.nodeType===1&&child.tagName!=='SUMMARY')continue;
      clone(child,el);
    }
    if(el.childNodes.length || el.tagName==='BR'||el.tagName==='HR')parent.append(el);
  }
  // A source container hidden by an older view is first restored by the caller.
  if(nodes){const wrapper=doc.createElement('div'),style=win.getComputedStyle(root);for(const property of fontProperties){const value=style.getPropertyValue(property);if(value)wrapper.style.setProperty(property,value);}for(const node of nodes)clone(node,wrapper);view.append(wrapper);}
  else clone(root,view);
  const batches=[];let batch=[],length=0;
  for(const unit of units) {
    if(batch.length && (length+unit.text.length>2600 || batch.length>=32)){batches.push(batch);batch=[];length=0;}
    batch.push(unit);length+=unit.text.length;
  }
  if(batch.length)batches.push(batch);
  function isCurrent() { return root.isConnected && items.every(item=>item.node.isConnected&&root.contains(item.node)&&originalText(item.node)===item.source); }
  function restore() {
    for(const item of items) {
      const record=applied.get(item.node);
      if(record && item.node.nodeValue===record.value)item.node.nodeValue=record.original;
      applied.delete(item.node);
    }
  }
  const readTranslation=node=>index.get(node)?.translation??originalText(node);
  return {
    view,items,batches,isCurrent,
    blocks:[...root.querySelectorAll('pre,table')].filter(node=>!node.closest('[data-bridge-ui]')).map(node=>({node,mirror:mirrors.get(node),kind:node.tagName==='PRE'?'code':'table'})),
    markdown(){return serializeMarkdown(root,readTranslation);},
    readText:readTranslation,
    copyBlock(block){return block.kind==='code'?{text:codeText(block.node)}:tablePayload(block.node,readTranslation);},
    payload(batch){return JSON.stringify({items:batch.map(unit=>({id:unit.id,text:unit.text}))});},
    applyBatch(batch,text) {
      if(!isCurrent())throw new Error('原文已更新，停止使用旧译文。');
      let data;
      try{data=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw new Error('翻译模型没有返回可用的文字映射，请重试或更换模型。');}
      if(!Array.isArray(data.items)||data.items.length!==batch.length)throw new Error('译文段落不完整，原文保留。');
      const expected=new Map(batch.map(unit=>[unit.id,unit])),values=new Map();
      for(const item of data.items) {
        if(!item || !expected.has(item.id)||values.has(item.id)||typeof item.text!=='string'||!item.text.trim()||item.text.length>30000)throw new Error('译文段落编号或文字无效，原文保留。');
        const unit=expected.get(item.id);values.set(item.id,unit.leading+unit.restore(item.text.trim())+unit.trailing);
      }
      // Validate the complete batch before changing any displayed text.
      for(const unit of batch)unit.value=values.get(unit.id);
      for(const item of items)if(item.parts.every(part=>part.value!==null)) {
        item.translation=item.parts.map(part=>part.value).join('');item.mirror.nodeValue=item.translation;
      }
    },
    text(){return items.map(item=>item.translation??item.source).join('\n');},
    setMode(mode) {
      if(mode!=='chinese'){restore();return;}
      if(!isCurrent())throw new Error('原文已更新，请重新翻译后切换中文。');
      for(const item of items)if(item.translation!==null) {
        const record={original:item.source,value:item.translation};applied.set(item.node,record);item.node.nodeValue=record.value;
      }
    },
    dispose:restore
  };
}
