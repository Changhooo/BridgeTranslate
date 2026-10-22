import {DEFAULTS,validateConfig,makeRequest,parseResponse,protectInline} from './api.mjs';
export const hasHan=text=>/\p{Script=Han}/u.test(text);
export function configFrom(options){return validateConfig({...DEFAULTS,protocol:options.protocol||'chat',endpoint:options.endpoint||'',model:options.model||'',auth:options.auth||'auto',glossary:options.glossary||'',maxTokens:options.max_tokens??4096});}
// Segment only at Markdown block boundaries. An unfinished fence/math block stays local.
export function blocks(source,complete=false){
 const lines=source.match(/[^\n]*\n|[^\n]+$/g)||[],out=[];let buf='',fence=null,math=null;
 const add=kind=>{if(buf)out.push({kind,text:buf,closed:true});buf='';};
 for(const line of lines){
  if(fence){buf+=line;const m=line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);if(m&&m[1][0]===fence[0]&&m[1].length>=fence.length){add('keep');fence=null;}continue;}
  if(math){buf+=line;if(line.trim()===math){add('keep');math=null;}continue;}
  const f=line.match(/^ {0,3}(`{3,}|~{3,})/);
  if(f){add('text');fence=f[1];buf=line;continue;}
  if(['$$','\\['].includes(line.trim())){add('text');math=line.trim()==='$$'?'$$':'\\]';buf=line;continue;}
  if(/^ {4}\S|^\t\S|^\s*\[[^\]]+\]:\s*\S+/.test(line)){add('text');buf=line;add('keep');continue;}
  buf+=line;if(!line.trim())add('text');
 }
 if(buf)out.push({kind:fence||math?'keep':'text',text:buf,closed:complete});
 return out;
}
export function protect(text,nonce){
 const kept=[];const blockMasked=blocks(text,true).map(p=>{if(p.kind!=='keep')return p.text;const marker=`BT_KEEP_BLOCK_${nonce}_${kept.length}_END`;kept.push({marker,value:p.text});return marker;}).join('');const masked=blockMasked.replace(/!\[[^\]]*\]\([^\n]*?\)|!\[[^\]]*\]\[[^\]]*\]|<(?:img|video|audio)\b[^>]*>|<svg\b[\s\S]*?<\/svg>|<math\b[\s\S]*?<\/math>/gi,v=>{const marker=`BT_KEEP_IMAGE_${nonce}_${kept.length}_END`;kept.push({marker,value:v});return marker;});
 const inline=protectInline(masked,nonce);
 return {text:inline.text,restore(value){let s=inline.restore(value);for(const x of kept){if(s.split(x.marker).length!==2)throw new Error('翻译改动了保护内容。');s=s.replace(x.marker,()=>x.value);}return s;}};
}
export async function translate($,options,source,direction){
 if(!source.trim())return source;
 if(source.length>60000)throw new Error('单次文字超过 60000 字，请分次处理。');
 const config=configFrom(options),protectedText=protect(source,'CC');
 const req=makeRequest(config,options.api_key||'',protectedText.text,direction);
 // Only documented host HTTP fields are passed. The host controls its 30 s timeout/redirects.
 const res=await $.http.fetch(req.url,{method:req.options.method,headers:req.options.headers,body:req.options.body});
 if(!res.ok)throw new Error(`翻译 API 返回 ${res.status}，请检查配置或稍后手动重试。`);
 let payload;try{payload=JSON.parse(res.text);}catch{throw new Error('翻译 API 未返回 JSON。');}
 let result=protectedText.restore(parseResponse(config.protocol,payload));
 if(direction==='en'&&hasHan(result))throw new Error('译文仍有汉字，未提交。请检查原文中的名称或代码。');
 const suffix=source.match(/\s*$/)?.[0]||'';return result.trimEnd()+suffix;
}
export function renderBlocks(parts,cache,mode){return parts.map(p=>{
 const zh=cache.get(p.text)?.translation;if(p.kind!=='text'||!zh||mode==='original')return p.text;
 if(mode==='chinese')return zh;
 return p.text.trimEnd()+'\n\n'+zh.trimEnd()+'\n\n';
}).join('');}
export class Queue{
 constructor(limit=2){this.limit=limit;this.active=0;this.jobs=[];}
 run(fn,priority=false){return new Promise((resolve,reject)=>{const job={fn,resolve,reject};priority?this.jobs.unshift(job):this.jobs.push(job);this.pump();});}
 pump(){while(this.active<this.limit&&this.jobs.length){const j=this.jobs.shift();this.active++;Promise.resolve().then(j.fn).then(j.resolve,j.reject).finally(()=>{this.active--;this.pump();});}}
}
