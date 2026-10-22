// Runs the actual content script and worker against a simulated DOM and Chrome API.
// This checks state transitions; it does not replace native browser/editor testing.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import * as api from '../extension/api.mjs';
import {renderMarkdown} from '../extension/render.mjs';
import * as domText from '../extension/dom-text.mjs';
import * as paragraphs from '../extension/paragraphs.mjs';
import * as titles from '../extension/titles.mjs';
import {serializeMarkdown,tablePayload} from '../extension/clipboard.mjs';
const require=createRequire(import.meta.url);
let JSDOM;
try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=require(path.join(process.env.BRIDGE_TEST_NODE_MODULES||'', 'jsdom')));}
const root=new URL('../',import.meta.url);
const contentSource=(await readFile(new URL('extension/content.js',root),'utf8')).replace("await import(chrome.runtime.getURL('api.mjs'))",'globalThis.__bridgeAPI').replace("await import(chrome.runtime.getURL('dom-text.mjs'))",'globalThis.__bridgeText').replace("await import(chrome.runtime.getURL('paragraphs.mjs'))",'globalThis.__bridgeParagraphs').replace("await import(chrome.runtime.getURL('titles.mjs'))",'globalThis.__bridgeTitles');
const backgroundSource=(await readFile(new URL('extension/background.js',root),'utf8')).replace(/^import[^\n]+\n/,'const {DEFAULTS, validateConfig, permissionOrigin, makeRequest, parseResponse, publicError} = globalThis.__bridgeAPI;\n');
const fixture=await readFile(new URL('tests/claude-fixture.html',root),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
async function waitFor(check,attempts=200){for(let i=0;i<attempts;i++){try{if(check())return;}catch{}await new Promise(r=>setTimeout(r,5));}throw new Error('Condition did not become true');}
function area(initial={}){
  const data=structuredClone(initial);
  return {data,async get(keys){if(keys===null)return structuredClone(data);if(typeof keys==='string')keys=[keys];return Object.fromEntries(keys.filter(k=>k in data).map(k=>[k,structuredClone(data[k])]))},async set(values){Object.assign(data,structuredClone(values))},async remove(keys){for(const k of typeof keys==='string'?[keys]:keys)delete data[k]},async setAccessLevel(){}};
}
async function harness({empty=false,composerType='prosemirror',enterSend=false,nativeSend=false}={}){
  const config=api.validateConfig({...api.DEFAULTS,endpoint:'https://api.example.test/v1',model:'test-translator',enterTranslateSend:enterSend});
  const local=area(empty?{}:{config}),session=area(empty?{}:{sessionKey:'TEST_ONLY_KEY'});
  let listener,contentListener,delay=0,failStatus=0,settingsOpens=0,activeCalls=0,peakCalls=0,englishOverride=null;
  const records=[],activeTimers=new Set();
  const safeTimeout=(fn,ms)=>{const id=setTimeout(()=>{activeTimers.delete(id);fn()},ms);activeTimers.add(id);return id;};
  const bgChrome={storage:{local,session},sidePanel:{setPanelBehavior:async()=>{}},permissions:{contains:async()=>true},runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,openOptionsPage:async()=>{settingsOpens++},onMessage:{addListener:fn=>listener=fn}}};
  async function fakeFetch(url,options){
    activeCalls++;peakCalls=Math.max(peakCalls,activeCalls);
    try{
    const body=JSON.parse(options.body);records.push({url,options,body});
    const requestDelay=typeof delay==='function'?delay(records.length,body):delay;
    if(requestDelay)await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,requestDelay);
      options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'))},{once:true});
    });
    if(options.signal.aborted)throw new DOMException('Aborted','AbortError');
    if(failStatus)return new Response(JSON.stringify({error:{message:'DO_NOT_ECHO_KEY_OR_SOURCE'}}),{status:failStatus});
    const source=body.messages.at(-1).content,direction=body.messages[0].content;
    const text=direction.includes('input is a JSON object')?JSON.stringify({items:JSON.parse(source).items.map(item=>({id:item.id,text:'中文译文：'+item.text}))}):direction.includes('natural, fluent English')?(englishOverride??(source==='你好，我是xxx'?"Hello, I'm xxx.":'Explain microscopy autofocus.')):source==='Hello.'?'你好。':source.startsWith('#')?source.replace(/^(#+\s+)/,'$1中文译文：'):'中文译文：'+source;
    return new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}));
    }finally{activeCalls--;}
  }
  const bg=vm.createContext({chrome:bgChrome,__bridgeAPI:api,URL,fetch:fakeFetch,AbortController,setTimeout:safeTimeout,clearTimeout:id=>{clearTimeout(id);activeTimers.delete(id)}});
  vm.runInContext(backgroundSource,bg);
  const dom=new JSDOM(fixture,{url:'https://claude.ai/chat/first',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;w.__bridgeAPI=api;w.__bridgeRenderer={renderMarkdown};w.__bridgeText=domText;w.__bridgeParagraphs=paragraphs;w.__bridgeTitles=titles;
  const originalEditor=w.document.querySelector('.ProseMirror');
  let testEditor=originalEditor;
  if(composerType==='generic'||composerType==='plaintext'){
    originalEditor.className='new-composer';originalEditor.removeAttribute('role');originalEditor.removeAttribute('aria-label');
    originalEditor.setAttribute('contenteditable',composerType==='plaintext'?'plaintext-only':'true');
  }else if(composerType==='textarea'){
    testEditor=w.document.createElement('textarea');testEditor.className='new-composer';originalEditor.replaceWith(testEditor);
  }
  let virtualNow=Date.now();w.Date.now=()=>virtualNow;
  Object.defineProperty(w.HTMLElement.prototype,'offsetWidth',{get(){return this.hidden?0:100;}});
  w.HTMLElement.prototype.getBoundingClientRect=function(){return {left:800,right:1400,top:350,bottom:440,width:600,height:90,x:800,y:350};};
  // jsdom does not implement native editor actions. Simulate insertText only.
  w.document.execCommand=(command,_ui,text)=>{if(command!=='insertText')return false;w.document.activeElement.textContent=text;return true;};
  Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent},set(value){this.textContent=value;}});
  const clipboard=[];w.navigator.clipboard={writeText:async text=>{clipboard.push({text});}};
  const intervals=[];w.setInterval=fn=>{intervals.push(fn);return intervals.length;};
  const sender={id:'test-id',url:'https://claude.ai/chat/first',frameId:0,tab:{id:1}};
  const call=(message,from=sender)=>new Promise(resolve=>listener(message,from,resolve));
  w.chrome={runtime:{id:'test-id',getURL:bgChrome.runtime.getURL,sendMessage:call,onMessage:{addListener:fn=>contentListener=fn}}};
  await w.eval(contentSource);await tick();
  const shadowRoots=()=>[...w.document.querySelectorAll('[data-bridge-ui]')].map(h=>h.shadowRoot);
  const sent=[];
  const sendButton=w.document.getElementById('send');
  if(nativeSend){
    let composing=false;
    w.document.addEventListener('compositionstart',()=>composing=true);w.document.addEventListener('compositionend',()=>composing=false);
    sendButton.addEventListener('click',event=>{event.preventDefault();sent.push(testEditor.value??testEditor.textContent);if(testEditor.tagName==='TEXTAREA')testEditor.value='';else testEditor.textContent='';testEditor.dispatchEvent(new w.Event('input',{bubbles:true}));});
    w.document.addEventListener('keydown',event=>{if(event.target===testEditor&&event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.isComposing&&!composing){event.preventDefault();sendButton.click();}});
  }
  const key=(options={})=>{const event=new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options});testEditor.dispatchEvent(event);return event;};
  const enterCheckbox=()=>[...shadowRoots().find(root=>root.querySelector('.toolbar')).querySelectorAll('label')].find(label=>label.textContent==='回车译后发送').querySelector('input');
  function findButton(text){for(const s of shadowRoots()){const b=[...s.querySelectorAll('button')].find(b=>b.textContent===text&&!b.hidden);if(b)return b;}throw new Error('Button not found: '+text);}
  function status(){return shadowRoots().map(s=>s.querySelector('.status')?.textContent||'').join('');}
  async function scan(ms=1200){virtualNow+=ms;for(const fn of intervals)await fn();await tick();}
  async function close(){w.dispatchEvent(new w.Event('pagehide'));for(let i=0;i<500;i++){const busy=shadowRoots().some(root=>[...root.querySelectorAll('button')].some(button=>button.textContent==='取消'&&!button.hidden));if(!activeCalls&&!busy)break;await new Promise(resolve=>setTimeout(resolve,5));}await tick();await tick();for(const id of activeTimers)clearTimeout(id);dom.window.close();}
  return {dom,w,editor:testEditor,local,session,records,clipboard,call,findButton,status,scan,close,shadowRoots,key,sent,sendButton,enterCheckbox,get contentListener(){return contentListener;},set delay(v){delay=v},set failStatus(v){failStatus=v},set englishOverride(v){englishOverride=v},get settingsOpens(){return settingsOpens;},get activeCalls(){return activeCalls;},get peakCalls(){return peakCalls;}};
}
test('in-page request/reply translation state transitions and worker boundaries',async()=>{
  const h=await harness();const doc=h.w.document,editor=doc.querySelector('.ProseMirror');
  try{
    const privateResult=await h.call({type:'GET_CONFIG'});assert.equal(privateResult.ok,false,'content script must not get private config');
    const publicResult=await h.call({type:'GET_PUBLIC_CONFIG'});assert.equal(publicResult.configured,true);assert.equal(publicResult.key,undefined);
    assert.equal(h.local.data.savedKey,undefined);assert.equal(h.session.data.sessionKey,'TEST_ONLY_KEY');
    await h.scan(5000);await waitFor(()=>!h.findButton('复制中文全文').disabled);
    assert.equal(h.records.length,4,'each paragraph translates independently; code stays local');
    assert.ok(h.records.every(r=>!r.options.body.includes('def focus_step')));
    assert.ok(doc.querySelector('pre code').textContent.includes('def focus_step(image):'));
    assert.ok(h.shadowRoots().every(s=>!s.querySelector('.text')?.textContent.includes('def focus_step(image):')));
    assert.ok(!doc.documentElement.textContent.includes('TEST_ONLY_KEY'));
    h.findButton('中文').click();assert.equal(doc.querySelector('.font-claude-response').hidden,false);assert.ok(doc.querySelector('.font-claude-response').textContent.includes('中文译文：'));
    h.findButton('原文').click();assert.equal(doc.querySelector('.font-claude-response').hidden,false);
    h.findButton('双语').click();
    editor.textContent='请解释显微镜自动对焦。';h.findButton('中文 → 英文').click();
    await waitFor(()=>editor.textContent==='Explain microscopy autofocus.');
    await waitFor(()=>!h.findButton('还原中文').disabled);
    h.findButton('还原中文').click();await waitFor(()=>editor.textContent==='请解释显微镜自动对焦。');
    // Let native-edit verification finish before issuing the next operation.
    await new Promise(r=>setTimeout(r,140));
    h.delay=100;h.findButton('中文 → 英文').click();await tick();editor.textContent='新的草稿';
    await waitFor(()=>h.status().includes('翻译期间提问已修改'));assert.equal(editor.textContent,'新的草稿');
    h.findButton('关闭预览').click();
    h.findButton('中文 → 英文').click();await waitFor(()=>h.shadowRoots().some(s=>[...s.querySelectorAll('button')].some(b=>b.textContent==='取消'&&!b.hidden)));
    h.findButton('取消').click();await waitFor(()=>h.status().includes('取消')||h.status().includes('超时'));await new Promise(r=>setTimeout(r,150));assert.equal(editor.textContent,'新的草稿');
    h.delay=0;h.failStatus=429;h.findButton('中文 → 英文').click();await waitFor(()=>h.status().includes('429'));assert.equal(editor.textContent,'新的草稿');assert.ok(!h.status().includes('DO_NOT_ECHO'));
    h.failStatus=0;
    const before=h.records.length;
    const next=doc.createElement('div');next.className='font-claude-response';next.setAttribute('data-is-streaming','true');next.innerHTML='<p>A new complete answer.</p>';doc.querySelector('.assistant').append(next);
    await h.scan();await h.scan(5000);assert.equal(h.records.length,before);
    next.setAttribute('data-is-streaming','false');await h.scan();await waitFor(()=>h.records.length>before);
    await waitFor(()=>h.shadowRoots().some(s=>s.querySelector('.text')?.textContent.includes('A new complete answer.')));
    editor.textContent='切换之前的草稿';h.delay=100;h.findButton('中文 → 英文').click();await tick();h.w.history.pushState({},'','/chat/second');
    await new Promise(r=>setTimeout(r,180));assert.equal(editor.textContent,'切换之前的草稿');await h.scan();
    await waitFor(()=>h.shadowRoots().filter(s=>s.querySelector('.answer')).length===2);
    h.findButton('收起').click();h.findButton('展开').click();assert.equal(h.shadowRoots().find(s=>s.querySelector('.preview')).querySelector('.preview').hidden,true);
    h.findButton('设置').click();await tick();assert.equal(h.settingsOpens,1);
    const trusted={id:'test-id',url:'chrome-extension://test-id/sidepanel.html'};
    const cfg=await h.call({type:'GET_CONFIG'},trusted);assert.equal(cfg.hasKey,true);assert.equal(JSON.stringify(cfg).includes('TEST_ONLY_KEY'),false);
    const bad=await h.call({type:'SAVE_CONFIG',config:cfg.config,apiKey:'x'});assert.equal(bad.ok,false);
  }finally{await h.close();}
});
test('settings test uses the unsaved form and does not silently change saved configuration',async()=>{
  const h=await harness({empty:true});
  const html=await readFile(new URL('extension/sidepanel.html',root),'utf8');
  const pane=new JSDOM(html,{url:'chrome-extension://test-id/sidepanel.html#settings',runScripts:'outside-only'});
  const w=pane.window,doc=w.document;
  const trusted={id:'test-id',url:'chrome-extension://test-id/sidepanel.html'};
  const permissions=[];
  const run=message=>h.call(message,trusted);
  w.__bridgeAPI=api;
  w.chrome={
    runtime:{sendMessage:run},
    permissions:{request:async request=>{permissions.push(request);return true;}},
    tabs:{query:async()=>[],getCurrent:async()=>({id:2}),onActivated:{addListener(){}},onUpdated:{addListener(){}}},
    storage:{onChanged:{addListener(){}}}
  };
  w.navigator.clipboard={writeText:async()=>{}};
  const script=(await readFile(new URL('extension/sidepanel.js',root),'utf8')).replace(/^import[^\n]+\n/,'const {DEFAULTS, validateConfig, permissionOrigin, planTranslation, protectInline}=globalThis.__bridgeAPI;\n');
  try{
    await w.eval('(async()=>{'+script+'\n})()');
    doc.getElementById('endpoint').value='https://api.deepseek.com';
    doc.getElementById('model').value='deepseek-flash';
    doc.getElementById('apiKey').value='FORM_ONLY_TEST_KEY';
    doc.getElementById('apiKey').dispatchEvent(new w.Event('input'));
    doc.getElementById('rememberKey').checked=true;
    assert.equal(doc.getElementById('keyState').textContent,'已填写，尚未保存');
    doc.getElementById('testApi').click();
    await waitFor(()=>doc.getElementById('toast').textContent.includes('当前配置连接成功'));
    assert.equal(h.records.length,1);
    assert.equal(h.records[0].url,'https://api.deepseek.com/chat/completions');
    assert.equal(h.records[0].body.model,'deepseek-flash');
    assert.equal(h.records[0].options.headers.Authorization,'Bearer FORM_ONLY_TEST_KEY');
    assert.equal(h.records[0].body.thinking.type,'disabled');
    assert.equal(h.local.data.config,undefined);
    assert.equal(h.local.data.savedKey,undefined);
    assert.equal(h.session.data.sessionKey,undefined);
    assert.equal(permissions[0].origins[0],'https://api.deepseek.com/*');
    doc.getElementById('enterTranslateSend').checked=true;
    doc.getElementById('configForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
    await waitFor(()=>doc.getElementById('toast').textContent.startsWith('已保存。'));
    assert.equal(h.local.data.savedKey,'FORM_ONLY_TEST_KEY');
    assert.equal(h.local.data.config.enterTranslateSend,true);
    assert.equal(doc.getElementById('apiKey').value,'');
    doc.getElementById('model').value='changed-form-model';
    doc.getElementById('enterTranslateSend').checked=false;
    doc.getElementById('testApi').click();
    await waitFor(()=>h.records.length===2&&!doc.getElementById('testApi').disabled);
    assert.equal(h.records[1].body.model,'changed-form-model');
    assert.equal(h.local.data.config.model,'deepseek-flash');
    assert.equal(h.local.data.config.enterTranslateSend,true,'testing a form must not change its optional preference');
    assert.equal(h.records[1].options.headers.Authorization,'Bearer FORM_ONLY_TEST_KEY');
    doc.getElementById('endpoint').value='https://other.example.test/v1';
    doc.getElementById('testApi').click();
    await waitFor(()=>doc.getElementById('toast').textContent.includes('请填写 API Key'));
    assert.equal(h.records.length,2,'must not send saved key to another domain');
    const denied=await h.call({type:'TEST_CONNECTION',config:h.local.data.config,apiKey:'x',requestId:'denied-test'});
    assert.equal(denied.ok,false,'web content cannot supply temporary test keys');
  }finally{pane.window.close();await h.close();}
});
test('reply extraction excludes accessibility labels, hidden text and timestamps',async()=>{
  const h=await harness();
  try{
    const doc=h.w.document,reply=doc.querySelector('.font-claude-response');
    const label=doc.createElement('h2');label.className='sr-only';label.textContent='Claude response: Hello!';reply.prepend(label);
    const time=doc.createElement('time');time.textContent='Just now';reply.append(time);
    const hidden=doc.createElement('span');hidden.hidden=true;hidden.textContent='Internal hidden label';reply.append(hidden);
    await h.scan();await h.scan(5000);await waitFor(()=>h.records.length>=1);
    const sent=h.records.map(r=>r.body.messages.at(-1).content).join('\n');
    assert.ok(!sent.includes('Claude response:'));assert.ok(!sent.includes('Just now'));assert.ok(!sent.includes('Internal hidden label'));
    await waitFor(()=>h.shadowRoots().some(s=>s.querySelector('.text h2')));
    const root=h.shadowRoots().find(s=>s.querySelector('.text h2'));
    assert.ok(root.querySelector('.text h2').textContent.includes('From a blurred image'));
    assert.equal(root.querySelector('.text pre code'),null);assert.ok(doc.querySelector('pre code').textContent.includes('def focus_step'));
    h.findButton('中文').click();await h.scan(5000);
    assert.equal(reply.hidden,false,'media and code remain visible in Chinese-only mode');assert.ok(reply.textContent.includes('中文译文：'));
  }finally{await h.close();}
});
test('Markdown rendering formats text and leaves HTML or script payloads inert',()=>{
  const dom=new JSDOM('<div id="output"></div>'),doc=dom.window.document,out=doc.getElementById('output');
  try{
    renderMarkdown(out,'## 标题\n\n**粗体**和 `a < b`\n\n- 项目一\n- 项目二\n\n```js\nconst x = "<script>bad()</script>";\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[官网](https://example.com)\n\n<img src=x onerror="bad()"> [坏链接](javascript:bad())');
    assert.equal(out.querySelector('h2').textContent,'标题');assert.equal(out.querySelector('strong').textContent,'粗体');
    assert.equal(out.querySelectorAll('li').length,2);assert.equal(out.querySelectorAll('td').length,2);
    assert.ok(out.querySelector('pre code').textContent.includes('<script>bad()</script>'));
    assert.equal(out.querySelectorAll('img,script').length,0);assert.equal(out.querySelectorAll('a').length,1);
    assert.equal(out.querySelector('a').protocol,'https:');assert.equal(out.querySelector('a').rel,'noopener noreferrer');
  }finally{dom.window.close();}
});
for(const composerType of ['generic','plaintext','textarea'])test(`homepage ${composerType} composer offers one-click translation next to the Chinese draft`,async()=>{
  const h=await harness({composerType});
  try{
    const editor=h.editor;
    if(editor.tagName==='TEXTAREA')editor.value='你好，我是xxx';else editor.textContent='你好，我是xxx';
    editor.focus();editor.dispatchEvent(new h.w.InputEvent('input',{bubbles:true,inputType:'insertText',data:'你好，我是xxx'}));
    assert.equal(h.records.length,0,'typing alone must not call a paid translation API');
    assert.ok(h.status().includes('检测到中文提问'));
    const contextual=h.findButton('翻译成英文');assert.equal(contextual.getRootNode().host.hidden,false);
    contextual.click();
    await waitFor(()=>(editor.value??editor.textContent)==="Hello, I'm xxx.");
    await waitFor(()=>h.status().includes('已替换为英文'));
    assert.equal(h.records[0].body.messages.at(-1).content,'你好，我是xxx');
    assert.equal(contextual.getRootNode().host.hidden,true);
  }finally{await h.close();}
});
test('input focus selects the visible composer and ignores a hidden legacy editor',async()=>{
  const h=await harness({composerType:'generic'});
  try{
    const box=h.w.document.createElement('aside');box.hidden=true;
    box.innerHTML='<div class="ProseMirror" contenteditable="true">错误的旧草稿</div>';h.w.document.body.prepend(box);
    h.editor.textContent='你好，我是xxx';h.editor.focus();h.editor.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    h.findButton('翻译成英文').click();await waitFor(()=>h.status().includes('已替换为英文'));
    assert.equal(h.editor.textContent,"Hello, I'm xxx.");assert.equal(box.textContent,'错误的旧草稿');
    assert.equal(h.records[0].body.messages.at(-1).content,'你好，我是xxx');
  }finally{await h.close();}
});
test('native editor rejection leaves the Chinese draft and displays the translated preview',async()=>{
  const h=await harness({composerType:'generic'});
  try{
    h.w.document.execCommand=()=>false;
    h.editor.textContent='你好，我是xxx';h.editor.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    h.findButton('翻译成英文').click();await waitFor(()=>h.status().includes('未接受填入'));
    assert.equal(h.editor.textContent,'你好，我是xxx');
    const preview=h.shadowRoots().find(root=>root.querySelector('.preview')).querySelector('.preview');
    assert.equal(preview.hidden,false);assert.equal(preview.querySelector('textarea').value,"Hello, I'm xxx.");
  }finally{await h.close();}
});
test('editor-owned plain-text paste is used when insertText is unsupported',async()=>{
  const h=await harness({composerType:'generic'});
  try{
    h.w.document.execCommand=()=>false;
    h.w.DataTransfer=class {setData(type,value){this[type]=value}getData(type){return this[type]||''}};
    h.w.ClipboardEvent=class extends h.w.Event {constructor(type,options){super(type,options);this.clipboardData=options.clipboardData;}};
    let pasteCount=0;
    h.editor.addEventListener('paste',event=>{pasteCount++;event.preventDefault();h.editor.textContent=event.clipboardData.getData('text/plain');});
    h.editor.textContent='你好，我是xxx';h.editor.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    h.findButton('翻译成英文').click();await waitFor(()=>h.status().includes('已替换为英文'));
    assert.equal(pasteCount,1);assert.equal(h.editor.textContent,"Hello, I'm xxx.");
  }finally{await h.close();}
});
test('Chinese IME composition must be committed before translating',async()=>{
  const h=await harness({composerType:'generic'});
  try{
    h.editor.textContent='你好，我是xxx';h.editor.dispatchEvent(new h.w.CompositionEvent('compositionstart',{bubbles:true}));
    assert.equal(h.findButton('请先确认输入').disabled,true);
    h.findButton('中文 → 英文').click();await waitFor(()=>h.status().includes('请先确认中文输入候选'));assert.equal(h.records.length,0);
    h.editor.dispatchEvent(new h.w.CompositionEvent('compositionend',{bubbles:true,data:'你好，我是xxx'}));
    assert.equal(h.findButton('翻译成英文').disabled,false);h.findButton('翻译成英文').click();await waitFor(()=>h.status().includes('已替换为英文'));
    assert.equal(h.editor.textContent,"Hello, I'm xxx.");
  }finally{await h.close();}
});
test('text-only plans retain native small fonts and keep formulas, images and canvas identities',()=>{
  const dom=new JSDOM('<article id="r" style="font-size:18px;line-height:27px"><div style="font-size:12px;line-height:16px;color:rgb(120,120,120)">Suggesting other affordable clothing stores like H&amp;M.</div><h2 style="font-size:21px">Recommendations</h2><p>Use \\(x^2+y^2\\) and $z_1$ here.</p><span class="katex">FORMULA_PRIVATE<math><mi>x</mi></math></span><img src="https://example.com/p.png" alt="IMAGE_ALT_PRIVATE"><canvas>CANVAS_PRIVATE</canvas><pre><code>CODE_PRIVATE</code></pre></article>',{pretendToBeVisual:true});
  const doc=dom.window.document,root=doc.getElementById('r'),original=root.innerHTML;
  const protectedNodes=[root.querySelector('.katex'),root.querySelector('img'),root.querySelector('canvas'),root.querySelector('pre')];
  try{
    const plan=domText.createTextPlan(root),payload=plan.batches.map(batch=>plan.payload(batch)).join('');
    for(const marker of ['FORMULA_PRIVATE','IMAGE_ALT_PRIVATE','CANVAS_PRIVATE','CODE_PRIVATE','x^2+y^2','z_1'])assert.ok(!payload.includes(marker));
    for(const batch of plan.batches)plan.applyBatch(batch,JSON.stringify({items:batch.map(unit=>({id:unit.id,text:'中文：'+unit.text}))}));
    const small=plan.items.find(item=>item.source.startsWith('Suggesting'));
    assert.equal(small.mirror.parentElement.style.fontSize,'12px');assert.equal(small.mirror.parentElement.style.lineHeight,'16px');
    assert.equal(plan.items.find(item=>item.source==='Recommendations').mirror.parentElement.style.fontSize,'21px');
    assert.equal(plan.view.querySelector('img,canvas,math,code'),null,'non-text objects are not copied into the translation card');
    plan.setMode('chinese');assert.equal(root.hidden,false);assert.ok(root.textContent.includes('中文：'));assert.ok(root.textContent.includes('\\(x^2+y^2\\)'));assert.ok(root.textContent.includes('$z_1$'));
    assert.equal(plan.isCurrent(),true);
    for(const node of protectedNodes)assert.ok(node.isConnected&&root.contains(node));
    assert.equal(root.querySelector('.katex'),protectedNodes[0]);assert.equal(root.querySelector('img'),protectedNodes[1]);assert.equal(root.querySelector('canvas'),protectedNodes[2]);
    plan.setMode('original');assert.equal(root.innerHTML,original);
  }finally{dom.window.close();}
});
test('node mapping rejects missing or duplicate IDs and never executes model HTML',()=>{
  const dom=new JSDOM('<p id="r">Hello <strong>world</strong></p>'),root=dom.window.document.getElementById('r');
  try{
    const plan=domText.createTextPlan(root),batch=plan.batches[0];
    assert.throws(()=>plan.applyBatch(batch,JSON.stringify({items:[]})),/不完整/);
    assert.throws(()=>plan.applyBatch(batch,JSON.stringify({items:batch.map(()=>({id:batch[0].id,text:'x'}))})),/无效/);
    for(const item of plan.items)assert.equal(item.mirror.nodeValue,item.source);
    plan.applyBatch(batch,JSON.stringify({items:batch.map(unit=>({id:unit.id,text:'<img src=x onerror="bad()">'}))}));
    plan.setMode('chinese');assert.equal(root.querySelector('img'),null);assert.equal(plan.view.querySelector('img'),null);
    plan.setMode('original');assert.equal(root.textContent,'Hello world');
  }finally{dom.window.close();}
});
test('restoring original text does not overwrite a later site update',()=>{
  const dom=new JSDOM('<p id="r">Original</p>'),root=dom.window.document.getElementById('r');
  try{
    const plan=domText.createTextPlan(root),batch=plan.batches[0];plan.applyBatch(batch,JSON.stringify({items:[{id:batch[0].id,text:'译文'}]}));
    plan.setMode('chinese');root.firstChild.nodeValue='Updated by site';assert.equal(plan.isCurrent(),false);
    plan.dispose();assert.equal(root.textContent,'Updated by site');
  }finally{dom.window.close();}
});
test('confirmed completion starts translation without the old four-second wait',async()=>{
  const h=await harness();
  try{
    await h.scan(200);assert.equal(h.records.length,0);
    await h.scan(100);await waitFor(()=>h.records.length>0);
    assert.ok(h.shadowRoots().some(root=>root.querySelector('.label')?.textContent.includes('段')||root.querySelector('.label')?.textContent.includes('秒')));
  }finally{await h.close();}
});
test('long replies run at most two batches and show completed text before the entire reply is ready',async()=>{
  const h=await harness();
  try{
    const reply=h.w.document.querySelector('.font-claude-response');reply.replaceChildren();
    for(let i=0;i<5;i++){const p=h.w.document.createElement('p');p.textContent=('Paragraph '+i+' words ').repeat(85);reply.append(p);}
    h.delay=index=>index===1?20:350;
    await h.scan(1);await h.scan(300);await waitFor(()=>h.records.length>=2);
    await waitFor(()=>h.shadowRoots().some(root=>root.querySelector('.text')?.textContent.includes('中文译文：')));
    assert.equal(h.activeCalls>0,true);assert.equal(h.peakCalls,2);
    assert.ok(h.shadowRoots().some(root=>root.querySelector('.caption')?.textContent.includes('正在翻译此段')));
    h.findButton('取消').click();await waitFor(()=>h.activeCalls===0);
    assert.ok(reply.textContent.startsWith('Paragraph 0'));
    assert.ok(h.shadowRoots().some(root=>root.querySelector('.label')?.textContent.includes('已暂停')));
  }finally{await h.close();}
});
test('Markdown export keeps headings, emphasis, links, nested lists, tables, formulas and exact code',()=>{
  const dom=new JSDOM('<article id="r"><h2>Title</h2><p><strong>Bold</strong> and <em>emphasis</em> <a href="https://example.com">Link</a></p><ol start="3"><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol><blockquote><p>Quote</p></blockquote><table><tr><th>Name</th><th>Value</th></tr><tr><td>A|B</td><td>1</td></tr></table><p>Use \\(x^2\\) and $z_1$.</p><span class="katex"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x_1</annotation></semantics></math></span><pre><code class="language-python">a = 1\n\n\nprint(a)\n</code></pre><button>DO_NOT_COPY</button><span data-bridge-ui>PLUGIN_UI</span></article>');
  try {
    const text=serializeMarkdown(dom.window.document.getElementById('r'));
    for(const expected of ['## Title','**Bold**','*emphasis*','[Link](https://example.com)','3. First','   - Nested','4. Second','> Quote','| Name | Value |','| --- | --- |','| A\\|B | 1 |','\\(x^2\\)','$z_1$','$x_1$','```python\na = 1\n\n\nprint(a)\n```'])assert.ok(text.includes(expected),expected);
    assert.ok(!text.includes('DO_NOT_COPY'));assert.ok(!text.includes('PLUGIN_UI'));
  }finally{dom.window.close();}
});
test('table clipboard preserves cells with quotes and line breaks and emits safe HTML',()=>{
  const dom=new JSDOM('<table><tr><th>Header</th><th>Other</th></tr><tr><td>A<br>B</td><td>&lt;script&gt;bad&lt;/script&gt;</td></tr></table>');
  try {
    const payload=tablePayload(dom.window.document.querySelector('table'));
    assert.equal(payload.text,'Header\tOther\n"A\nB"\t<script>bad</script>');
    assert.ok(payload.html.includes('&lt;script&gt;'));assert.ok(!payload.html.includes('<script>'));
    assert.ok(payload.markdown.includes('A<br>B'));
  }finally{dom.window.close();}
});
test('Chinese view keeps native code copy and copies translated tables and full Markdown',async()=>{
  const h=await harness();
  try {
    const reply=h.w.document.querySelector('.font-claude-response');
    const table=h.w.document.createElement('table');table.innerHTML='<tr><th>Store</th><th>Price</th></tr><tr><td>Brand A</td><td>Low</td></tr>';reply.append(table);
    const heading=reply.querySelector('h2'),code=reply.querySelector('pre'),codeValue=code.querySelector('code').textContent;
    h.delay=100;await h.scan(1);await h.scan(300);
    await waitFor(()=>h.records.length>0);
    await waitFor(()=>h.shadowRoots().some(root=>[...root.querySelectorAll('button')].some(button=>button.textContent==='复制中文表格')));
    assert.equal(h.findButton('复制中文表格').disabled,true,'incomplete tables must not be copied as finished translations');
    await waitFor(()=>!h.findButton('复制中文全文').disabled);
    h.findButton('中文').click();assert.equal(reply.querySelector('h2'),heading);assert.equal(reply.querySelector('table'),table);assert.equal(reply.querySelector('pre'),code);
    assert.ok(heading.textContent.startsWith('中文译文：'));assert.ok(table.textContent.includes('中文译文：Store'));
    assert.ok(h.shadowRoots().every(root=>![...root.querySelectorAll('button')].some(button=>button.textContent==='复制代码')),'extension no longer adds code-copy controls');
    assert.equal(code.querySelector('code').textContent,codeValue);
    h.findButton('复制中文表格').click();await waitFor(()=>h.clipboard.length===1);assert.equal(h.clipboard[0].text,'中文译文：Store\t中文译文：Price\n中文译文：Brand A\t中文译文：Low');
    h.findButton('复制 Markdown').click();await waitFor(()=>h.clipboard.length===2);assert.ok(h.clipboard[1].text.includes('| 中文译文：Store | 中文译文：Price |'));
    h.findButton('原文').click();assert.equal(table.rows[0].cells[0].textContent,'Store');
    h.findButton('复制中文全文').click();await waitFor(()=>h.clipboard.length===3);
    const full=h.clipboard[2].text;assert.ok(full.includes('## 中文译文：'));assert.ok(full.includes('```python\n'+codeValue.trimEnd()+'\n```'));assert.ok(full.includes('| 中文译文：Store | 中文译文：Price |'));assert.ok(!full.includes('复制中文表格'));
    h.findButton('双语').click();assert.ok(h.shadowRoots().some(root=>root.querySelector('.text table')));
    assert.ok(h.records.every(record=>!record.options.body.includes('def focus_step')));
  }finally{await h.close();}
});
test('table copy uses rich clipboard when available and falls back to plain TSV if rejected',async()=>{
  const h=await harness();
  try {
    const reply=h.w.document.querySelector('.font-claude-response');const table=h.w.document.createElement('table');table.innerHTML='<tr><td>A</td><td>B</td></tr>';reply.append(table);
    await h.scan(1);await h.scan(300);await waitFor(()=>!h.findButton('复制中文全文').disabled);
    const rich=[];h.w.Blob=Blob;h.w.ClipboardItem=class{constructor(values){this.values=values;}};h.w.navigator.clipboard.write=async items=>{rich.push(items[0]);};
    h.findButton('复制中文表格').click();await waitFor(()=>rich.length===1);
    assert.equal(await rich[0].values['text/plain'].text(),'中文译文：A\t中文译文：B');
    assert.ok((await rich[0].values['text/html'].text()).includes('<td>中文译文：A</td>'));
    h.w.navigator.clipboard.write=async()=>{throw new Error('Denied');};h.findButton('复制中文表格').click();await waitFor(()=>h.clipboard.length===1);assert.equal(h.clipboard[0].text,'中文译文：A\t中文译文：B');
  }finally{await h.close();}
});
test('finished paragraphs translate during streaming and appear directly below their English source',async()=>{
  const h=await harness();
  try{
    const doc=h.w.document,reply=doc.querySelector('.font-claude-response');reply.setAttribute('data-is-streaming','true');
    reply.innerHTML='<p id="first">Use <code>turn()</code> to change direction.</p><pre><code>CODE_MUST_REMAIN_LOCAL</code><button>Native copy</button></pre><p id="tail">The last paragraph is growing</p>';
    const first=doc.getElementById('first'),tail=doc.getElementById('tail'),pre=reply.querySelector('pre');let nativeCopies=0;
    pre.querySelector('button').addEventListener('click',()=>nativeCopies++);
    await h.scan(1);await h.scan(300);
    await waitFor(()=>first.nextElementSibling?.shadowRoot?.querySelector('.text')?.textContent.includes('中文译文：Use'));
    assert.equal(reply.getAttribute('data-is-streaming'),'true','translation must be visible before generation ends');
    assert.equal(first.textContent,'Use turn() to change direction.');
    assert.equal(first.nextElementSibling.shadowRoot.querySelector('code').textContent,'turn()','inline code is retained in Chinese context');
    assert.equal(h.records.length,1);assert.ok(!h.records[0].options.body.includes('turn()'));assert.ok(!h.records[0].options.body.includes('CODE_MUST_REMAIN_LOCAL'));
    const firstHost=first.nextElementSibling;
    const third=doc.createElement('p');third.textContent='Still generating the third paragraph';reply.append(third);
    await h.scan(1);await h.scan(300);
    await waitFor(()=>tail.nextElementSibling?.shadowRoot?.querySelector('.text')?.textContent.includes('中文译文：The last'));
    assert.equal(first.nextElementSibling,firstHost,'earlier translation must not be rebuilt for an appended paragraph');
    assert.equal(h.records.length,2);assert.equal(h.findButton('复制中文全文').disabled,true);
    await h.scan(5000);assert.equal(h.records.length,2,'stable unfinished tail must not repeatedly call the model');
    reply.setAttribute('data-is-streaming','false');await h.scan(300);await waitFor(()=>!h.findButton('复制中文全文').disabled);
    assert.equal(h.records.length,3);assert.equal(reply.querySelector('pre'),pre);assert.equal(doc.querySelectorAll('pre').length,1);
    pre.querySelector('button').click();assert.equal(nativeCopies,1,'native code button stays functional');
    h.findButton('中文').click();assert.equal(first.querySelector('code').textContent,'turn()');assert.ok(first.textContent.includes('中文译文：'));
    h.findButton('原文').click();assert.equal(first.textContent,'Use turn() to change direction.');
    h.findButton('双语').click();await h.scan(5000);assert.equal(h.records.length,3,'own translation and mode changes never retrigger paid requests');
  }finally{await h.close();}
});
test('growing single-paragraph tail waits for a boundary or actual completion',async()=>{
  const h=await harness();
  try{
    const reply=h.w.document.querySelector('.font-claude-response');reply.setAttribute('data-is-streaming','true');reply.innerHTML='<p>One incomplete paragraph</p>';
    await h.scan(1);await h.scan(8000);assert.equal(h.records.length,0);
    reply.firstChild.append(' continues to grow');await h.scan(1);await h.scan(8000);assert.equal(h.records.length,0);
    reply.setAttribute('data-is-streaming','false');await h.scan(300);await waitFor(()=>!h.findButton('复制中文全文').disabled);
    assert.equal(h.records.length,1);assert.ok(h.records[0].options.body.includes('continues to grow'));
  }finally{await h.close();}
});
test('editing an in-flight paragraph discards only its old result and preserves completed paragraphs',async()=>{
  const h=await harness();
  try{
    const reply=h.w.document.querySelector('.font-claude-response');reply.setAttribute('data-is-streaming','true');reply.innerHTML='<p id="done">A finished paragraph.</p><p id="edit">Old text pending translation.</p><p>Growing tail.</p>';
    h.delay=index=>index===1?5:180;await h.scan(1);await h.scan(300);
    const done=reply.querySelector('#done'),edit=reply.querySelector('#edit');
    await waitFor(()=>done.nextElementSibling?.shadowRoot?.querySelector('.text')?.textContent.includes('中文译文：'));
    const host=done.nextElementSibling;edit.textContent='Corrected text for this paragraph.';await h.scan(1);await h.scan(300);
    await waitFor(()=>edit.nextElementSibling?.shadowRoot?.querySelector('.text')?.textContent.includes('中文译文：Corrected'));
    assert.equal(done.nextElementSibling,host);assert.ok(!edit.nextElementSibling.shadowRoot.querySelector('.text').textContent.includes('Old text'));
    assert.ok(h.shadowRoots().every(root=>!root.querySelector('.label')?.textContent.includes('已暂停')));
    assert.equal(h.records.filter(record=>record.options.body.includes('A finished paragraph.')).length,1);
  }finally{await h.close();}
});
test('paragraph targets keep list translations inside list items and skip code-language chrome',()=>{
  const dom=new JSDOM('<article id="r"><div><div>javascript<button>Copy</button></div><pre><code>const a=1;</code></pre></div><ul><li id="outer">One <code>a()</code><ul><li id="inner">Two</li></ul></li></ul><table><tr><td>A</td></tr></table><p>Last</p></article>',{pretendToBeVisual:true});
  try{
    const doc=dom.window.document,root=doc.getElementById('r'),targets=paragraphs.paragraphTargets(root);
    assert.equal(targets.length,4);assert.equal(targets[0].node.id,'outer');assert.equal(targets[1].node.id,'inner');assert.equal(targets[1].inside,true);assert.equal(targets[2].node.tagName,'TABLE');
    let now=0;const tracker=paragraphs.createParagraphTracker(root,{now:()=>now,createHost:()=>{const host=doc.createElement('span');host.setAttribute('data-bridge-ui','');const output=doc.createElement('div'),caption=doc.createElement('small');host.append(output,caption);return {host,output,caption};}});
    tracker.update();now=300;
    for(const record of tracker.ready(false)){if(tracker.prepare(record)){for(const batch of record.plan.batches)record.plan.applyBatch(batch,JSON.stringify({items:batch.map(unit=>({id:unit.id,text:'译文'+unit.text}))}));tracker.finish(record);}}
    const inner=doc.getElementById('inner');assert.equal(inner.querySelector('[data-bridge-ui]')?.parentElement,inner);assert.equal(root.querySelector('ul > [data-bridge-ui]'),null);
    tracker.dispose();assert.equal(root.querySelector('[data-bridge-ui]'),null);
  }finally{dom.window.close();}
});
test('failed live paragraphs pause without looping and manual retry replaces failed UI once',async()=>{
  const h=await harness();
  try{
    const reply=h.w.document.querySelector('.font-claude-response');reply.setAttribute('data-is-streaming','true');reply.innerHTML='<p>Translate this paragraph.</p><p>Growing tail.</p>';
    h.failStatus=429;await h.scan(1);await h.scan(300);await waitFor(()=>h.status().includes('429'));
    const failedCount=h.records.length;await h.scan(5000);assert.equal(h.records.length,failedCount);
    h.failStatus=0;h.findButton('翻译／重试').click();
    await waitFor(()=>reply.querySelector('[data-bridge-paragraph]')?.shadowRoot?.querySelector('.text')?.textContent.includes('中文译文：'));
    assert.equal(reply.querySelectorAll('[data-bridge-paragraph]').length,1,'retry must not reattach an orphaned failure placeholder');
    assert.ok(h.shadowRoots().every(root=>!root.querySelector('.caption')?.textContent.includes('翻译失败')));
  }finally{await h.close();}
});
test('without an explicit end marker earlier paragraphs translate while the tail uses a quiet fallback',async()=>{
  const h=await harness();
  try{
    const reply=h.w.document.querySelector('.font-claude-response');reply.removeAttribute('data-is-streaming');reply.innerHTML='<p>Closed paragraph.</p><p>Unconfirmed tail.</p>';
    await h.scan(1);await h.scan(300);await waitFor(()=>h.records.length===1);
    assert.ok(h.records[0].options.body.includes('Closed paragraph.'));assert.equal(h.findButton('复制中文全文').disabled,true);
    await h.scan(1200);await waitFor(()=>!h.findButton('复制中文全文').disabled);assert.equal(h.records.length,2);
  }finally{await h.close();}
});
test('Enter translation is optional and defaults off without intercepting native Enter',async()=>{
  const h=await harness({nativeSend:true});
  try{
    assert.equal(api.DEFAULTS.enterTranslateSend,false);assert.equal(h.enterCheckbox().checked,false);
    assert.equal((await h.call({type:'GET_PUBLIC_CONFIG'})).enterTranslateSend,false);
    h.editor.textContent='未开启时沿用网页发送行为';h.key();await tick();
    assert.deepEqual(h.sent,['未开启时沿用网页发送行为']);assert.equal(h.records.length,0);
    h.enterCheckbox().checked=true;h.enterCheckbox().dispatchEvent(new h.w.Event('change',{bubbles:true}));
    await waitFor(()=>h.local.data.config.enterTranslateSend===true);
    assert.equal((await h.call({type:'GET_PUBLIC_CONFIG'})).enterTranslateSend,true);
  }finally{await h.close();}
});
for(const composerType of ['prosemirror','generic','plaintext','textarea'])test(`opt-in Enter translates and submits exactly once for ${composerType}`,async()=>{
  const h=await harness({composerType,enterSend:true,nativeSend:true});
  try{
    const decoy=h.w.document.createElement('button');decoy.setAttribute('aria-label','Send message');decoy.textContent='Unrelated send';let wrongClicks=0;decoy.addEventListener('click',()=>wrongClicks++);h.w.document.querySelector('.sidebar').append(decoy);
    if(h.editor.tagName==='TEXTAREA')h.editor.value='你好，我是xxx';else h.editor.textContent='你好，我是xxx';
    const event=h.key();assert.equal(event.defaultPrevented,true);assert.equal(h.sent.length,0);
    await waitFor(()=>h.sent.length===1);assert.deepEqual(h.sent,["Hello, I'm xxx."]);assert.equal(h.records.length,1);assert.equal(wrongClicks,0);
    await waitFor(()=>h.status().includes('已翻译成英文并发送'));assert.ok(h.shadowRoots().every(root=>![...root.querySelectorAll('button')].some(button=>button.textContent==='还原中文'&&!button.hidden)));
  }finally{await h.close();}
});
test('Shift+Enter, modifiers, IME selection and ordinary English keep native behavior',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.editor.textContent='输入中文';
    for(const modifier of ['shiftKey','ctrlKey','metaKey','altKey'])assert.equal(h.key({[modifier]:true}).defaultPrevented,false);
    h.editor.dispatchEvent(new h.w.CompositionEvent('compositionstart',{bubbles:true}));assert.equal(h.key({isComposing:true}).defaultPrevented,false);
    h.editor.dispatchEvent(new h.w.CompositionEvent('compositionend',{bubbles:true}));
    assert.equal(h.records.length,0);assert.equal(h.sent.length,0);
    h.editor.textContent='An ordinary English question.';h.key();assert.deepEqual(h.sent,['An ordinary English question.']);assert.equal(h.records.length,0);
  }finally{await h.close();}
});
test('repeat Enter and clicking Send during translation cannot submit Chinese or duplicate English',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.delay=120;h.editor.textContent='你好，我是xxx';h.key();h.key();h.key({repeat:true});
    await waitFor(()=>h.records.length===1);h.sendButton.click();assert.equal(h.sent.length,0);
    assert.equal(h.key({ctrlKey:true}).defaultPrevented,true);assert.equal(h.key({metaKey:true}).defaultPrevented,true);
    await waitFor(()=>h.editor.textContent==="Hello, I'm xxx.");h.key();h.sendButton.click();assert.equal(h.sent.length,0);
    await waitFor(()=>h.sent.length===1);assert.deepEqual(h.sent,["Hello, I'm xxx."]);assert.equal(h.records.length,1);
  }finally{await h.close();}
});
test('changing a draft while translating preserves the edit and never sends the old translation',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.delay=120;h.editor.textContent='中文旧问题';h.key();await waitFor(()=>h.records.length===1);
    h.editor.textContent='翻译时编辑的新问题';h.editor.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    await waitFor(()=>h.status().includes('翻译期间提问已修改'));
    assert.equal(h.editor.textContent,'翻译时编辑的新问题');assert.equal(h.sent.length,0);
    assert.equal(h.shadowRoots().find(root=>root.querySelector('.preview')).querySelector('.preview').hidden,false);
  }finally{await h.close();}
});
test('turning the optional feature off during a pending request cancels automatic submission',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.delay=120;h.editor.textContent='不要在关闭功能后发送';h.key();await waitFor(()=>h.records.length===1);
    h.enterCheckbox().checked=false;h.enterCheckbox().dispatchEvent(new h.w.Event('change',{bubbles:true}));
    await waitFor(()=>h.status().includes('取消'));assert.equal(h.sent.length,0);assert.equal(h.editor.textContent,'不要在关闭功能后发送');assert.equal(h.local.data.config.enterTranslateSend,false);
  }finally{await h.close();}
});
for(const failure of ['api','remaining-han','editor-rejection'])test(`auto-send stops for ${failure} without submitting the Chinese draft`,async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    if(failure==='api')h.failStatus=429;
    if(failure==='remaining-han')h.englishOverride='English with 中文 still present.';
    if(failure==='editor-rejection')h.w.document.execCommand=()=>false;
    h.editor.textContent='原来的中文问题';h.key();
    await waitFor(()=>h.status().includes(failure==='api'?'429':failure==='remaining-han'?'仍含汉字':'未接受填入'));
    assert.equal(h.sent.length,0);assert.equal(h.editor.textContent,'原来的中文问题');
  }finally{await h.close();}
});
test('cancel during native editor verification prevents sending even after English is inserted',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.editor.textContent='你好，我是xxx';h.key();await waitFor(()=>h.editor.textContent==="Hello, I'm xxx.");
    h.findButton('取消').click();await waitFor(()=>h.status().includes('取消'));await waitFor(()=>!h.findButton('中文 → 英文').disabled);
    assert.equal(h.sent.length,0);
  }finally{await h.close();}
});
test('missing or disabled native Send keeps English ready for manual submission',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.sendButton.disabled=true;h.editor.textContent='你好，我是xxx';h.key();
    await waitFor(()=>h.status().includes('没有找到可用的发送按钮'),600);
    assert.equal(h.sent.length,0);assert.equal(h.editor.textContent,"Hello, I'm xxx.");
  }finally{await h.close();}
});
test('navigation during Enter translation cannot submit to a different conversation',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.delay=100;h.editor.textContent='切换会话前的提问';h.key();await waitFor(()=>h.records.length===1);h.w.history.pushState({},'','/chat/other');
    await waitFor(()=>!h.findButton('中文 → 英文').disabled);assert.equal(h.sent.length,0);assert.equal(h.editor.textContent,'切换会话前的提问');
  }finally{await h.close();}
});
test('manual Translate remains preview-only when Enter automation is enabled',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.editor.textContent='你好，我是xxx';h.findButton('中文 → 英文').click();await waitFor(()=>h.status().includes('已替换为英文'));
    assert.equal(h.editor.textContent,"Hello, I'm xxx.");assert.equal(h.sent.length,0);
  }finally{await h.close();}
});
test('optional Enter preference and automatic-answer preference cannot overwrite each other',async()=>{
  const h=await harness();
  try{
    const values=await Promise.all([h.call({type:'SET_ENTER_SEND',enabled:true}),h.call({type:'SET_AUTO',enabled:false}),h.call({type:'GET_PUBLIC_CONFIG'})]);
    assert.ok(values.every(value=>value.ok));assert.equal(values[2].enterTranslateSend,true);assert.equal(values[2].autoTranslate,false);
    assert.equal(h.local.data.config.enterTranslateSend,true);assert.equal(h.local.data.config.autoTranslate,false);
  }finally{await h.close();}
});
test('Enter submission waits for active answer batches without discarding their completed translations',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.delay=130;await h.scan(300);await waitFor(()=>h.activeCalls===2);
    h.editor.textContent='你好，我是xxx';h.key();assert.equal(h.sent.length,0);
    await waitFor(()=>h.sent.length===1,400);assert.deepEqual(h.sent,["Hello, I'm xxx."]);
    assert.ok(h.peakCalls<=2);assert.ok(h.shadowRoots().some(root=>root.querySelector('.text')?.textContent.includes('中文译文：')));
    assert.equal(h.records.filter(record=>record.body.messages[0].content.includes('natural, fluent English')).length,1);
  }finally{await h.close();}
});
test('a scoped form submit button is used when an editor has no labelled send control',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    const form=h.w.document.createElement('form');h.editor.parentElement.append(form);form.append(h.editor,h.sendButton);h.sendButton.removeAttribute('aria-label');h.sendButton.type='submit';
    h.delay=60;h.editor.textContent='你好，我是xxx';h.key();await waitFor(()=>h.activeCalls>0);
    const submit=new h.w.Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(submit);assert.equal(submit.defaultPrevented,true);assert.equal(h.sent.length,0);
    await waitFor(()=>h.sent.length===1);assert.deepEqual(h.sent,["Hello, I'm xxx."]);
  }finally{await h.close();}
});
test('an unconfirmed send is clicked only once and reports uncertainty instead of retrying',async()=>{
  const h=await harness({enterSend:true});
  try{
    let clicks=0;h.sendButton.addEventListener('click',()=>clicks++);h.editor.textContent='你好，我是xxx';h.key();
    await waitFor(()=>clicks===1);h.key();h.sendButton.click();
    await waitFor(()=>h.status().includes('尚未确认是否成功'),600);assert.equal(clicks,1);assert.equal(h.records.length,1);
  }finally{await h.close();}
});
test('leaving the page cancels pending automatic submission and prevents background paragraph restart',async()=>{
  const h=await harness({enterSend:true,nativeSend:true});
  try{
    h.delay=130;h.editor.textContent='离开页面前的提问';h.key();await waitFor(()=>h.records.length===1);
    h.w.dispatchEvent(new h.w.Event('pagehide'));await waitFor(()=>h.activeCalls===0);await waitFor(()=>!h.findButton('中文 → 英文').disabled);
    assert.equal(h.sent.length,0);const count=h.records.length;await h.scan(5000);assert.equal(h.records.length,count);
  }finally{await h.close();}
});

test('sidebar title toggle persists independently and restores original display without rename',async()=>{
 const h=await harness();try{await h.scan(5000);await waitFor(()=>!h.findButton('复制中文全文').disabled);const nav=h.w.document.createElement('nav');nav.innerHTML='<a href="/chat/title-example"><span>Greeting</span><button>More</button></a>';h.w.document.body.prepend(nav);await h.scan();await waitFor(()=>nav.querySelector('span').textContent==='中文译文：Greeting');assert.equal(nav.querySelector('a').getAttribute('href'),'/chat/title-example');assert.equal(nav.querySelector('a').title,'Greeting');assert.equal(nav.querySelector('button').textContent,'More');const toggle=[...h.shadowRoots().find(r=>r.querySelector('.toolbar')).querySelectorAll('label')].find(l=>l.textContent==='对话标题').querySelector('input');toggle.checked=false;toggle.dispatchEvent(new h.w.Event('change'));await waitFor(()=>h.local.data.config.translateTitles===false);assert.equal(nav.querySelector('span').textContent,'Greeting');const p=await h.call({type:'GET_PUBLIC_CONFIG'});assert.equal(p.translateTitles,false);assert.equal(p.autoTranslate,true);assert.equal(p.enterTranslateSend,false);const before=h.records.length;await h.scan();await tick();assert.equal(h.records.length,before);}finally{await h.close();}
});
test('Enter translation preempts an in-flight title batch within the two-request limit',async()=>{
 const h=await harness({enterSend:true,nativeSend:true});try{await h.scan(5000);await waitFor(()=>!h.findButton('复制中文全文').disabled);h.delay=180;const nav=h.w.document.createElement('aside');nav.innerHTML='<a href="/chat/priority-title">Greeting</a>';h.w.document.body.prepend(nav);const before=h.records.length;await h.scan();await waitFor(()=>h.records.length>before);h.editor.textContent='解释显微镜自动对焦';h.key();await waitFor(()=>h.sent.length===1);assert.deepEqual(h.sent,['Explain microscopy autofocus.']);assert.ok(h.peakCalls<=2);assert.equal(nav.querySelector('a').textContent,'Greeting');}finally{await h.close();}
});
