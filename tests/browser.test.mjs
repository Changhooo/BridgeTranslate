import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,cp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let chromium;
try { ({chromium}=require('playwright')); } catch { ({chromium}=require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||'', 'playwright'))); }
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(path.join(tmpdir(),'bridge-test-'));
const records=[];let delay=0,failStatus=0;
const phrases=new Map([
  ['Autofocus estimates the distance between the current imaging plane and the best-focus plane.','自动对焦估计当前成像平面与最佳焦平面之间的距离。'],
  ['A signed defocus model predicts both the direction and the distance of the required movement.','带符号离焦模型同时预测需要移动的方向和距离。'],
  ['Use a small correction step near focus, then verify the result with a new image.','靠近焦点时采用较小的修正步长，再采集一张图像验证结果。'],
  ['From a blurred image to a focus estimate','从模糊图像到离焦估计'],
  ['A new complete answer.','这是一条新的完整回答。']
]);
const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const data=JSON.parse(Buffer.concat(chunks).toString());records.push({data,headers:req.headers});
  const wait=delay,status=failStatus;if(wait)await new Promise(r=>setTimeout(r,wait));
  if(status){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'secret-key-and-source-should-never-be-echoed'}}));return;}
  const system=data.messages?.[0]?.content||'',source=data.messages?.at(-1)?.content||'';
  let text=source;
  if(system.includes('natural, fluent English'))text='Explain how microscopy autofocus works.';
  else if(system.includes('input is a JSON object'))text=JSON.stringify({items:JSON.parse(source).items.map(item=>{let translated=item.text;for(const [en,zh]of phrases)translated=translated.replaceAll(en,zh);return {id:item.id,text:translated};})});
  else if(source==='Hello.')text='你好。';
  else for(const [en,zh]of phrases)text=text.replaceAll(en,zh);
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
let context;
try{
  const ext=path.join(temp,'extension');await cp(path.join(project,'extension'),ext,{recursive:true});
  const manifest=JSON.parse(await readFile(path.join(ext,'manifest.json'),'utf8'));
  // Test-only host grant avoids a native optional-permission dialog in headless Chromium.
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(path.join(ext,'manifest.json'),JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
    headless:true,...(process.env.BRIDGE_CHROMIUM ? {executablePath:process.env.BRIDGE_CHROMIUM} : {channel:'chromium'}),viewport:{width:1440,height:1050},
    args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--no-sandbox']
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
  const id=new URL(worker.url()).host;
  const fixture=await readFile(path.join(project,'tests/claude-fixture.html'),'utf8');
  await context.route('https://claude.ai/**',route=>route.fulfill({contentType:'text/html',body:fixture}));
  const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('https://claude.ai/chat/local-test');
  await page.getByRole('button',{name:'中文 → 英文',exact:true}).waitFor();
  const options=await context.newPage();await options.goto(`chrome-extension://${id}/sidepanel.html#settings`);
  await options.locator('#endpoint').fill(endpoint);await options.locator('#model').fill('mock-translator');await options.locator('#apiKey').fill('test-only-secret');
  await options.locator('#saveConfig').click();
  await options.getByText('已保存。网页将在几秒内使用新配置。',{exact:true}).waitFor();
  const saved=await worker.evaluate(()=>Promise.all([chrome.storage.local.get(null),chrome.storage.session.get(null)]));
  assert.equal(saved[0].savedKey,undefined);assert.equal(saved[1].sessionKey,'test-only-secret');
  await options.locator('#testApi').click();await options.getByText(/当前配置连接成功：你好。/).waitFor();
  await page.bringToFront();
  const out=page.locator('[data-bridge-paragraph] .text').filter({hasText:'自动对焦估计'}).first();
  await out.getByText('自动对焦估计当前成像平面与最佳焦平面之间的距离。',{exact:false}).waitFor({timeout:20000});
  assert.ok(!(await out.textContent()).includes('def focus_step(image):'));
  assert.ok((await page.locator('.font-claude-response pre code').textContent()).includes('def focus_step(image):'));
  assert.ok(!records.some(r=>JSON.stringify(r.data).includes('def focus_step')),'fenced code must stay local');
  assert.ok(!await page.locator('body').textContent().then(t=>t.includes('test-only-secret')));
  assert.ok(records.every(r=>r.headers.authorization==='Bearer test-only-secret'));
  await page.getByRole('button',{name:'中文',exact:true}).first().click();assert.equal(await page.locator('.font-claude-response').isVisible(),true);assert.ok((await page.locator('.font-claude-response').textContent()).includes('自动对焦估计'));
  await page.getByRole('button',{name:'原文',exact:true}).first().click();assert.equal(await page.locator('.font-claude-response').isVisible(),true);assert.equal(await out.isHidden(),true);
  await page.getByRole('button',{name:'双语',exact:true}).first().click();assert.equal(await out.isVisible(),true);
  console.log('PASS: real extension load, settings, session-only key, test API, automatic inline translation, code preservation, display modes');
  const editor=page.locator('.ProseMirror'),prompt=page.getByRole('button',{name:'中文 → 英文',exact:true});
  await editor.fill('请解释显微镜自动对焦的原理。');await prompt.click();
  await page.waitForFunction(()=>document.querySelector('.ProseMirror').innerText==='Explain how microscopy autofocus works.');
  await page.getByRole('button',{name:'还原中文',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ProseMirror').innerText==='请解释显微镜自动对焦的原理。');
  delay=600;await prompt.click();const pendingCount=records.length;
  await new Promise(r=>setTimeout(r,150));await editor.fill('翻译期间改写的新问题');
  await page.getByText('翻译期间提问已修改，未覆盖当前内容，也未自动发送。当前草稿保留。',{exact:true}).waitFor();
  assert.equal(await editor.innerText(),'翻译期间改写的新问题');
  assert.ok(records.length>=pendingCount);
  await page.getByRole('button',{name:'关闭预览',exact:true}).click();
  await prompt.click();await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByText(/翻译已取消|请求超时/).first().waitFor();await new Promise(r=>setTimeout(r,700));
  assert.equal(await editor.innerText(),'翻译期间改写的新问题');
  console.log('PASS: one-click prompt replacement, undo, protection against overwriting edited drafts, cancellation');
  delay=0;failStatus=429;await prompt.click();await page.getByText(/API 返回 429/).waitFor();
  assert.equal(await editor.innerText(),'翻译期间改写的新问题');
  assert.ok(!(await page.locator('[data-bridge-ui]').allTextContents()).join('').includes('secret-key-and-source'));
  failStatus=0;
  console.log('PASS: provider failures preserve drafts and do not expose raw provider error bodies');
  const enterOption=page.getByRole('checkbox',{name:'回车译后发送',exact:true});assert.equal(await enterOption.isChecked(),false);
  await page.evaluate(()=>{window.__bridgeTestSent=[];document.getElementById('send').addEventListener('click',event=>{event.preventDefault();const editor=document.querySelector('.ProseMirror');window.__bridgeTestSent.push(editor.innerText);editor.textContent='';editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));});});
  await enterOption.check();await editor.fill('你好，帮我解释显微镜自动对焦。');await editor.press('Enter');
  await page.waitForFunction(()=>window.__bridgeTestSent.length===1);assert.deepEqual(await page.evaluate(()=>window.__bridgeTestSent),['Explain how microscopy autofocus works.']);
  await enterOption.uncheck();await options.waitForFunction(async()=>!(await chrome.storage.local.get('config')).config.enterTranslateSend);
  assert.equal((await worker.evaluate(()=>chrome.storage.local.get('config'))).config.enterTranslateSend,false);
  console.log('PASS: opt-in Enter translates before one native Send click; disabled by default and preference persists');
  const before=records.length;
  await page.evaluate(()=>{const n=document.createElement('div');n.className='font-claude-response';n.setAttribute('data-is-streaming','true');n.innerHTML='<p>A new complete answer.</p><p>Growing tail.</p>';document.querySelector('.assistant').append(n);});
  await page.getByText('这是一条新的完整回答。',{exact:true}).waitFor({timeout:12000});
  assert.equal(await page.locator('.font-claude-response').last().getAttribute('data-is-streaming'),'true','finished paragraph translates while generation continues');
  assert.ok(records.length>before);assert.ok(!records.slice(before).some(record=>JSON.stringify(record.data).includes('Growing tail.')));
  await page.locator('.font-claude-response').last().evaluate(n=>n.setAttribute('data-is-streaming','false'));
  await page.getByRole('button',{name:'复制中文全文',exact:true}).last().waitFor();
  await page.waitForFunction(()=>{const hosts=[...document.querySelectorAll('[data-bridge-ui]')];return hosts.some(host=>host.shadowRoot?.querySelector('.label')?.textContent.includes('已译 2/2 段'));});
  console.log('PASS: live paragraph translation before completion and final-tail translation after completion');
  await editor.fill('请解释显微镜自动对焦的原理。');await prompt.click();await page.waitForFunction(()=>document.querySelector('.ProseMirror').innerText==='Explain how microscopy autofocus works.');
  await page.evaluate(()=>document.querySelectorAll('.font-claude-response')[1].closest('[data-is-streaming]')?.remove());
  await mkdir(path.join(project,'docs'),{recursive:true});
  await page.screenshot({path:path.join(project,'docs/inline-preview.png'),fullPage:true});
  await options.bringToFront();await options.screenshot({path:path.join(project,'docs/settings-preview.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  await worker.evaluate(()=>chrome.runtime.openOptionsPage());
  console.log('PASS: options-page manifest and browser screenshots; no page JavaScript errors');
  console.log(`Browser checks complete. Mock translation API requests: ${records.length}. No real Claude or paid model requests were made.`);
}finally{
  await context?.close();await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});
}
