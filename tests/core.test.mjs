import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,endpointFor,validateConfig,permissionOrigin,makeRequest,parseResponse,planTranslation,protectInline} from '../extension/api.mjs';
const base={...DEFAULTS,endpoint:'https://api.example.com/v1',model:'translator'};
test('normalizes known bases and preserves exact gateway endpoints and api-version',()=>{
  assert.equal(endpointFor(base.endpoint,'chat'),'https://api.example.com/v1/chat/completions');
  assert.equal(endpointFor('https://api.example.com','responses'),'https://api.example.com/v1/responses');
  assert.equal(endpointFor('https://api.example.com/gateway/custom?api-version=2024','chat'),'https://api.example.com/gateway/custom?api-version=2024');
  assert.equal(endpointFor('https://api.example.com/v1','anthropic'),'https://api.example.com/v1/messages');
  assert.equal(endpointFor('https://api.example.com/v1beta','gemini','test-model'),'https://api.example.com/v1beta/models/test-model:generateContent');
  assert.equal(permissionOrigin('https://api.example.com/v1/chat/completions'),'https://api.example.com/*');
});
test('rejects unsafe URLs and embedded credentials; allows local services',()=>{
  for(const url of ['http://remote.example.com/v1','https://user:pass@api.example.com/v1','https://api.example.com/v1?key=secret','https://claude.ai/api'])assert.throws(()=>endpointFor(url,'chat'));
  assert.equal(endpointFor('http://127.0.0.1:1234/v1','chat'),'http://127.0.0.1:1234/v1/chat/completions');
});
test('validates configuration and strips unknown fields rather than saving keys in config',()=>{
  const result=validateConfig({...base,apiKey:'secret',unexpected:'no'});
  assert.equal(result.apiKey,undefined);assert.equal(result.unexpected,undefined);
  for(const delta of [{model:''},{maxTokens:0},{maxTokens:2.5},{protocol:'made-up'},{auth:'Cookie'}])assert.throws(()=>validateConfig({...base,...delta}));
});
test('all four adapters send single-turn translation requests with explicit auth, no cookies or redirects',()=>{
  for(const protocol of ['chat','responses','anthropic','gemini']){
    const req=makeRequest({...base,protocol,endpoint:'https://api.example.com',model:'test-model'},'secret','source','zh');
    const body=JSON.parse(req.options.body);
    assert.equal(req.options.credentials,'omit');assert.equal(req.options.redirect,'error');assert.equal(req.options.referrerPolicy,'no-referrer');
    if(protocol==='chat'){assert.equal(body.messages.length,2);assert.equal(body.messages[1].content,'source');assert.equal(req.options.headers.Authorization,'Bearer secret');}
    if(protocol==='responses'){assert.equal(body.store,false);assert.equal(body.input,'source');}
    if(protocol==='anthropic'){assert.equal(body.messages.length,1);assert.equal(req.options.headers['x-api-key'],'secret');assert.ok(body.system);}
    if(protocol==='gemini'){assert.equal(body.contents.length,1);assert.equal(req.options.headers['x-goog-api-key'],'secret');}
  }
});
test('local no-auth and alternate token fields are supported',()=>{
  const req=makeRequest({...base,auth:'none',tokenField:'max_completion_tokens'},'','hi','en');
  assert.equal(req.options.headers.Authorization,undefined);assert.equal(JSON.parse(req.options.body).max_completion_tokens,4096);
  assert.equal(JSON.parse(makeRequest({...base,tokenField:'omit'},'key','hi','zh').options.body).max_tokens,undefined);
});
test('DeepSeek uses its documented root endpoint and non-thinking translation requests',()=>{
  const req=makeRequest({...base,endpoint:'https://api.deepseek.com',model:'deepseek-flash'},'key','Hello.','zh');
  assert.equal(req.url,'https://api.deepseek.com/chat/completions');
  assert.equal(JSON.parse(req.options.body).thinking.type,'disabled');
  assert.equal(JSON.parse(makeRequest(base,'key','Hello.','zh').options.body).thinking,undefined);
});
test('parses text-only outputs and excludes reasoning for each protocol',()=>{
  assert.equal(parseResponse('chat',{choices:[{message:{content:'你好'},finish_reason:'stop'}]}),'你好');
  assert.equal(parseResponse('responses',{output:[{type:'reasoning',content:[{type:'output_text',text:'private'}]},{type:'message',content:[{type:'output_text',text:'你好'}]}]}),'你好');
  assert.equal(parseResponse('anthropic',{content:[{type:'thinking',thinking:'private'},{type:'text',text:'你好'}]}),'你好');
  assert.equal(parseResponse('gemini',{candidates:[{content:{parts:[{thought:true,text:'private'},{text:'你好'}]}}]}),'你好');
});
test('rejects truncated results for every protocol and empty output',()=>{
  for(const [protocol,data] of [['chat',{choices:[{message:{content:'partial'},finish_reason:'length'}]}],['responses',{output_text:'partial',status:'incomplete'}],['anthropic',{content:[{type:'text',text:'partial'}],stop_reason:'max_tokens'}],['gemini',{candidates:[{content:{parts:[{text:'partial'}]},finishReason:'MAX_TOKENS'}]}]])assert.throws(()=>parseResponse(protocol,data),/上限/);
  assert.throws(()=>parseResponse('chat',{}),/没有返回/);
});
test('chunk planning reconstructs original bytes and keeps fenced code local',()=>{
  const text='Intro\n\n'+'paragraph '.repeat(800)+'\n```python\nprint("中文")\n```\n\nAfter\n~~~js\nconst x = `a`;\n~~~\n';
  const units=planTranslation(text);
  assert.equal(units.map(u=>u.text).join(''),text);assert.equal(units.filter(u=>u.kind==='code').length,2);
  assert.ok(units.filter(u=>u.kind==='text').every(u=>u.text.length<=2600));
  assert.ok(!units.filter(u=>u.kind==='text').map(u=>u.text).join('').includes('print('));
});
test('unclosed and nested code fences remain intact; surrogate pairs do not split',()=>{
  for(const text of ['x\n````js\n```\n````\ny','before\n```\nunclosed','🙂'.repeat(4000)]){
    const units=planTranslation(text);assert.equal(units.map(u=>u.text).join(''),text);
    for(const u of units)assert.ok(!/[\uD800-\uDBFF]$/.test(u.text));
  }
});
test('inline code and URLs restore exactly; damaged or duplicated placeholders fail',()=>{
  const part=protectInline('Use `x = 1` and https://example.com/path?q=3','test');
  assert.ok(!part.text.includes('x = 1'));assert.equal(part.restore(part.text),'Use `x = 1` and https://example.com/path?q=3');
  assert.throws(()=>part.restore('missing'),/占位符/);assert.throws(()=>part.restore(part.text+part.text),/占位符/);
});
