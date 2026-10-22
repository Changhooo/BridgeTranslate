import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {register} from '../desktop/bridge-translate-cc/hooks/register.js';
import {blocks,protect,translate,Queue} from '../desktop/bridge-translate-cc/lib/translate.mjs';
const OPTIONS={protocol:'chat',endpoint:'https://api.example.test/v1',model:'translator',api_key:'TEST_SECRET_ONLY'};
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await tick();}throw new Error('condition not reached');}
async function harness(options={}){
 const handlers=[],store=new Map(),http=[],submitted=[],filled=[],copied=[];let draft='',delay=null,error=false;
 const atom=type=>function(props){assert.equal(arguments.length,1,'native element constructors accept one props object');const children=Array.isArray(props.children)?props.children:[props.children];return {type,props,children};};
 const $={store:{get:async k=>store.get(k),set:async(k,v)=>store.set(k,v)},command:{register:async()=>{}},
  prompt:{read:async()=>({text:draft}),fill:async({text})=>{draft=text;filled.push(text);return {isFilled:true,text};}},
  ui:{invalidate:()=>{},open:async()=>{},copy:async s=>copied.push(s),resolve:()=>({Box:atom('Box'),Text:atom('Text'),Button:atom('Button')})},
  http:{fetch:async(url,init)=>{const body=JSON.parse(init.body);http.push({url,body,headers:init.headers});if(delay)await delay;if(error)throw Error('TEST_SECRET_ONLY SOURCE');const source=body.messages.at(-1).content;const en=body.messages[0].content.includes('natural, fluent English');return {ok:true,status:200,text:JSON.stringify({choices:[{message:{content:en?'Please explain autofocus.':'中文：'+source},finish_reason:'stop'}]})};}}};
 const on=(name,matcher,fn)=>{if(typeof matcher==='function'){fn=matcher;matcher=null;}const h={name,matcher,fn};handlers.push(h);return {catch:fn=>{h.error=fn;}};};
 register(on,{...OPTIONS,...options});
 async function fire(name,e,base){const selected=handlers.filter(h=>h.name===name&&(!h.matcher||Object.entries(h.matcher).every(([k,v])=>e[k]===v)));
  async function run(i,x){const h=selected[i];if(!h)return base?base(x):{};return h.fn($,x,y=>run(i+1,y));}return run(0,e);}
 const draw=()=>fire('ui.render',{component:'AbovePrompt',props:{},requestId:'band'},()=>null);
 function find(node,key){if(!node||typeof node!=='object')return;if(node.props?.key===key)return node;for(const c of node.children??[]){const v=find(c,key);if(v)return v;}}
 async function click(key){const n=find(await draw(),key);assert.ok(n,'missing '+key);n.props.onPress();await tick();}
 const submit=text=>fire('prompt.submit',{text,origin:{kind:'composer'},wait:false},e=>{submitted.push(e);return {text:e.text};});
 const render=(text,id='reply')=>fire('ui.render',{component:'AssistantMessage',props:{text,isFirstOfReply:true},requestId:id},e=>e.props.text);
 await fire('session.start',{});
 return {$,fire,click,draw,submit,render,http,submitted,filled,copied,store,set draft(s){draft=s;},get draft(){return draft;},set delay(p){delay=p;},set error(v){error=v;}};
}
test('desktop Markdown segments protect code, math, images and inline code',()=>{
 const input='A paragraph.\n\n```js\nsecret();\n```\n\n$$\nx^2=1\n$$\n\nUse `fn()` and $y=2$. ![test](https://private.test/a.png)';
 const p=blocks(input,false);assert.equal(p.at(-1).closed,false);assert.equal(p.map(x=>x.text).join(''),input);
 const v=protect(input,'T');for(const s of ['secret()','fn()','x^2','private.test'])assert.ok(!v.text.includes(s));assert.equal(v.restore(v.text),input);
 assert.throws(()=>v.restore(v.text.replace(/BT_KEEP_\S+_END/,'')));assert.equal(blocks('```js\nunfinished',false)[0].kind,'keep');
});
test('desktop transport sends protected prose and reports status without provider content',async()=>{
 const h=await harness();const s='Read `fn()` and $x=2$. ![private](https://img.test/z.png)';const translated=await translate(h.$,OPTIONS,s,'zh');assert.ok(translated.includes('fn()'));assert.ok(translated.includes('img.test'));
 const wire=JSON.stringify(h.http[0].body);for(const s of ['fn()','img.test','x=2'])assert.ok(!wire.includes(s));assert.equal(h.http[0].headers.Authorization,'Bearer TEST_SECRET_ONLY');
 await assert.rejects(()=>translate({http:{fetch:async()=>({ok:false,status:401,text:'KEY_AND_SOURCE'})}},OPTIONS,'text','zh'),/401/);
});
test('automatic submit defaults off, preserves English and adds no model context',async()=>{
 const h=await harness();await h.submit('中文');assert.equal(h.submitted[0].text,'中文');assert.equal(h.http.length,0);
 await h.click('enter');await h.submit('解释自动对焦');assert.equal(h.submitted[1].text,'Please explain autofocus.');assert.equal(h.submitted[1].context,undefined);
 await h.submit('English only');assert.equal(h.http.length,1);assert.equal(h.submitted[2].text,'English only');assert.equal(h.store.get('preferences').enter,true);assert.ok(!JSON.stringify(await h.draw()).includes('TEST_SECRET_ONLY'));
});
test('automatic translation failure drops prompt without forwarding Chinese',async()=>{
 const h=await harness({enter_translate_send:true});h.error=true;assert.ok((await h.submit('不要发送原文')).drop);assert.equal(h.submitted.length,0);
});
test('manual translation fills without sending; changed drafts stay untouched',async()=>{
 const h=await harness();h.draft='请解释自动对焦';await h.click('translate');await until(()=>h.filled.length===1);assert.equal(h.draft,'Please explain autofocus.');assert.equal(h.submitted.length,0);
 let done;h.delay=new Promise(r=>done=r);h.draft='旧稿';await h.click('translate');h.draft='新稿';done();await tick();await tick();assert.equal(h.draft,'新稿');assert.equal(h.filled.length,1);
});
test('toggle off and session end stop an outstanding automatic submit',async()=>{
 for(const cancel of ['toggle','end']){const h=await harness({enter_translate_send:true});let done;h.delay=new Promise(r=>done=r);const pending=h.submit('请翻译');await until(()=>h.http.length===1);if(cancel==='toggle')await h.click('enter');else await h.fire('session.end',{reason:'clear'});done();assert.ok((await pending).drop);assert.equal(h.submitted.length,0);}
});
test('duplicate submit is dropped while translation is pending',async()=>{
 const h=await harness({enter_translate_send:true});let done;h.delay=new Promise(r=>done=r);const first=h.submit('问题一');await until(()=>h.http.length===1);assert.ok((await h.submit('问题一')).drop);done();await first;assert.equal(h.submitted.length,1);
});
test('streaming translates closed paragraphs and reuses earlier results',async()=>{
 const h=await harness();await h.fire('turn.start',{});assert.equal(await h.render('First paragraph.\n\nGrowing'),'First paragraph.\n\nGrowing');await until(()=>h.http.length===1);await tick();await tick();
 const shown=await h.render('First paragraph.\n\nGrowing');assert.ok(shown.includes('中文：First paragraph.'));assert.ok(!shown.includes('中文：Growing'));await h.render('First paragraph.\n\nGrowing tail.');assert.equal(h.http.length,1);
 await h.fire('turn.complete',{});await until(()=>h.http.length===2);await tick();await tick();assert.ok((await h.render('First paragraph.\n\nGrowing tail.')).includes('中文：Growing tail.'));await h.click('copy');assert.ok(h.copied[0].includes('中文：Growing tail.'));
});
test('native display rewrite keeps code and math; original mode restores source',async()=>{
 const h=await harness();const src='First.\n\n```py\nunchanged()\n```\n\n$$\nx=2\n$$\n';await h.fire('turn.start',{});await h.render(src);await until(()=>h.http.length===1);await tick();await tick();const out=await h.render(src);assert.ok(out.includes('```py\nunchanged()\n```'));assert.ok(out.includes('$$\nx=2\n$$'));assert.ok(!JSON.stringify(h.http).includes('unchanged()'));await h.click('mode');await h.click('mode');assert.equal(await h.render(src),src);
});
test('failed paragraphs do not retry endlessly and cancellation pauses new work',async()=>{
 const h=await harness();h.error=true;await h.fire('turn.start',{});await h.render('Bad paragraph.\n\nTail');await until(()=>h.http.length===1);await tick();await tick();for(let i=0;i<5;i++)await h.render('Bad paragraph.\n\nTail');assert.equal(h.http.length,1);await h.click('cancel');await h.render('New paragraph.\n\nLater');assert.equal(h.http.length,1);assert.equal(h.store.get('preferences').auto,false);
});
test('queue limits concurrency and prioritizes a queued prompt',async()=>{
 const q=new Queue(2);let release;const gate=new Promise(r=>release=r),started=[];const a=q.run(async()=>{started.push('a');await gate});const b=q.run(async()=>{started.push('b');await gate});const c=q.run(async()=>started.push('c'));const p=q.run(async()=>started.push('prompt'),true);await tick();assert.deepEqual(started,['a','b']);release();await Promise.all([a,b,c,p]);assert.deepEqual(started,['a','b','prompt','c']);
});
test('manifest marks Key sensitive and submit optional, without model-facing skills/tools',async()=>{
 const m=JSON.parse(await readFile(new URL('../desktop/bridge-translate-cc/.claude-plugin/plugin.json',import.meta.url),'utf8'));assert.equal(m.userConfig.api_key.sensitive,true);assert.equal(m.userConfig.enter_translate_send,undefined);assert.equal(m.skills,undefined);assert.equal(m.mcpServers,undefined);
});
