import {blocks,translate,hasHan,renderBlocks,Queue,configFrom} from '../lib/translate.mjs';

export function register(on,options={}){
 const queue=new Queue(2),records=new Map();let epoch=0,activeTurn=false,latest=null,task=null;
 let prefs={enter:options.enter_translate_send===true,auto:options.auto_reply!==false,mode:'bilingual'};
 let savePrefs=Promise.resolve();
 let status='桥译就绪 · 首次使用请配置翻译模型',undo=null;
 const redraw=$=>$.ui.invalidate('ui.render');
 const message=async($,text)=>{status=text;await redraw($);};
 function configured(){try{configFrom(options);return options.auth==='none'||!!options.api_key;}catch{return false;}}
 async function setPref($,key,value){prefs[key]=value;if(key==='enter'&&!value&&task?.auto)task.cancelled=true;const snapshot={...prefs};savePrefs=savePrefs.catch(()=>{}).then(()=>$.store.set('preferences',snapshot));await savePrefs;await redraw($);}
 async function manual($){
  if(task)return message($,'提问正在处理中，请勿重复操作。');
  const token={epoch,cancelled:false,auto:false};task=token;
  try{
   const draft=await $.prompt.read();if(!draft.text?.trim())return message($,'请先在 CC 原输入框输入中文。');
   await message($,'正在翻译提问…');const en=await queue.run(()=>translate($,options,draft.text,'en'),true);
   const now=await $.prompt.read();
   if(token.cancelled||epoch!==token.epoch||now.text!==draft.text)return message($,'草稿已改变或操作已取消，未覆盖当前输入。');
   const filled=await $.prompt.fill({text:en});
   if(!filled.isFilled)return message($,'输入框未接受英文，请稍后重试。');
   undo={before:draft.text,after:en};await message($,'英文已填入，请检查后自行发送。');
  }catch{await message($,'翻译失败，草稿保留；请检查 API 配置并手动重试。');}
  finally{if(task===token)task=null;await redraw($);}
 }
 function update($,rec,complete=false,force=false){
  const parts=blocks(rec.source,complete);rec.parts=parts;rec.complete=complete;
  if((!prefs.auto&&!force)||!configured()||!rec.eligible)return;
  for(const p of parts){
   if(p.kind!=='text'||!p.closed||!/[A-Za-z]/.test(p.text)||!p.text.trim())continue;
   if(rec.cache.has(p.text))continue;
   const job={state:'pending'},version=rec.generation,currentEpoch=epoch;rec.cache.set(p.text,job);
   void queue.run(async()=>{
    if(epoch!==currentEpoch||rec.generation!==version||!records.has(rec.id))return;
    if(!prefs.auto&&!force){rec.cache.delete(p.text);return;}
    // Cancellation stops writes and pending jobs; a host HTTP request already started may finish.
    const zh=await translate($,options,p.text,'zh');
    if(epoch===currentEpoch&&rec.generation===version&&rec.cache.get(p.text)===job){job.translation=zh;job.state='done';}
   }).catch(()=>{if(rec.cache.get(p.text)===job){job.state='failed';status='部分段落翻译失败，保留英文；点击“翻译／重试”。';}}).finally(()=>redraw($));
  }
 }
 on('session.start',async($,e,next)=>{
  const stored=await $.store.get('preferences');if(stored&&typeof stored==='object'){prefs={enter:typeof stored.enter==='boolean'?stored.enter:prefs.enter,auto:typeof stored.auto==='boolean'?stored.auto:prefs.auto,mode:['original','bilingual','chinese'].includes(stored.mode)?stored.mode:'bilingual'};}
  await $.command.register({name:'bridge',description:'打开桥译 CC 桌面版控制面板',immediate:true});
  status=configured()?`模型已配置 · 自动译后提交${prefs.enter?'已开启':'已关闭'}`:'尚未配置模型：在 /plugin 中配置桥译的 API URL、模型与 Key';return next(e);
 });
 on('command.run',{command:'bridge'},async $=>{await $.ui.open({id:'bridge-panel',title:'桥译 · CC 桌面版',focus:true});return {};});
 on('prompt.submit',async($,e,next)=>{
  if(e.origin?.kind!=='composer'||!prefs.enter||!hasHan(e.text)||e.text.trimStart().startsWith('/'))return next(e);
  if(task)return {drop:'桥译正在处理提问，请等待当前操作完成。'};
  const token={epoch,cancelled:false,auto:true};task=token;
  try{
   await message($,'正在翻译，完成并校验后提交英文…');
   const en=await queue.run(()=>translate($,options,e.text,'en'),true);
   if(token.cancelled||epoch!==token.epoch||!prefs.enter)return {drop:'桥译已取消本次提交。'};
   status='英文已交给 CC 提交流程。';
   return await next({...e,text:en});
  }catch{return {drop:'桥译未完成英文翻译，本次提问未提交。请检查 API 配置后重试。'};}
  finally{if(task===token)task=null;await redraw($);}
 }).catch(($,e,next)=>next.called?next(e):{drop:'桥译处理异常，已停止本次提交。'});
 on('turn.start',async($,e,next)=>{activeTurn=true;return next(e);});
 on('turn.complete',async($,e,next)=>{
  if(e.agentId)return next(e);
  activeTurn=false;for(const rec of records.values())if(rec.eligible&&!rec.complete)update($,rec,true);
  return next(e);
 });
 on('session.end',async($,e,next)=>{epoch++;activeTurn=false;if(task)task.cancelled=true;records.clear();latest=null;undo=null;return next(e);});
 on('ui.render',{component:'AssistantMessage'},async($,e,next)=>{
  const source=e.props.text;if(typeof source!=='string'||source.length>60000)return next(e);
  let rec=records.get(e.requestId);
  if(!rec){
   rec={id:e.requestId,source,parts:[],cache:new Map(),complete:!activeTurn,eligible:activeTurn,generation:0};records.set(rec.id,rec);
   if(records.size>20){const old=records.keys().next().value;records.get(old).generation++;records.delete(old);}
  }else if(rec.source!==source){
   const append=source.startsWith(rec.source);rec.source=source;
   if(!append){rec.generation++;rec.cache.clear();}
   rec.eligible=rec.eligible||activeTurn;
  }
  latest=rec;update($,rec,rec.complete||!activeTurn);
  const text=renderBlocks(rec.parts,rec.cache,prefs.mode);
  return text===source?next(e):next({...e,props:{...e.props,text}});
 });
 async function retry($){if(!latest)return message($,'当前没有可翻译的回答。');latest.eligible=true;for(const [key,j]of latest.cache)if(j.state==='failed')latest.cache.delete(key);update($,latest,!activeTurn,true);await message($,'已加入翻译队列。');}
 async function copy($){
  if(!latest)return message($,'当前没有可复制的回答。');
  if(!latest.complete||latest.parts.some(p=>p.kind==='text'&&/[A-Za-z]/.test(p.text)&&!latest.cache.get(p.text)?.translation))return message($,'请等待回答和全部译文完成。');
  if(typeof $.ui.copy!=='function')return message($,'当前 CC 版本不支持插件剪贴板，请切到中文后使用原生选中复制。');
  await $.ui.copy(renderBlocks(latest.parts,latest.cache,'chinese'));await message($,'中文 Markdown 已复制，代码与公式保持原样。');
 }
 async function test($){try{await message($,'正在测试翻译接口…');await queue.run(()=>translate($,options,'Hello.','zh'),true);await message($,'翻译接口连接成功。');}catch{await message($,'连接失败，请检查协议、URL、模型和 Key。');}}
 on('ui.render',async($,e,next)=>{
  if(e.component!=='AbovePrompt'&&!(e.component==='Pane'&&e.requestId==='bridge-panel'))return next(e);
  const {Box,Text,Button}= $.ui.resolve(e);const base=await next(e);
  const B=(key,label,fn)=>Button({key,label,onPress:()=>{void fn().catch(()=>message($,'操作未完成，请重试。'));}});
  const controls=[
   B('translate','中文 → 英文',()=>manual($)),
   B('enter',`自动译后提交：${prefs.enter?'开':'关'}`,()=>setPref($,'enter',!prefs.enter)),
   B('auto',`自动译回答：${prefs.auto?'开':'关'}`,()=>setPref($,'auto',!prefs.auto)),
   B('mode',`显示：${{original:'原文',bilingual:'双语',chinese:'中文'}[prefs.mode]}`,()=>setPref($,'mode',prefs.mode==='original'?'bilingual':prefs.mode==='bilingual'?'chinese':'original')),
   B('retry','翻译／重试',()=>retry($)),B('copy','复制中文 Markdown',()=>copy($)),
   B('cancel','取消',async()=>{if(task)task.cancelled=true;for(const rec of records.values()){rec.generation++;for(const [k,j]of rec.cache)if(j.state==='pending')rec.cache.delete(k);}await setPref($,'auto',false);await message($,'已暂停后续翻译，正在进行的 API 请求可能仍会计费。');})];
  if(e.component==='Pane')controls.push(B('test','测试连接',()=>test($)),B('undo','还原中文草稿',async()=>{if(!undo)return;const now=await $.prompt.read();if(now.text!==undo.after)return message($,'草稿已修改，未覆盖。');await $.prompt.fill({text:undo.before});undo=null;await message($,'中文草稿已还原。');}));
  return Box({flexDirection:'column',gap:1,children:[base,Text({color:'green',children:'桥译 · CC 桌面版'}),Box({flexDirection:'row',flexWrap:'wrap',gap:1,children:controls}),Text({dimColor:true,children:status}),...(e.component==='Pane'?[Text({children:'配置：/plugin → Installed → 桥译 → Configure。自动译后提交默认关闭；开启时发送按钮也会先译后提交。'})]:[])]});
 });
}
