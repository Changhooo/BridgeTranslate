import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);let JSDOM;try{({JSDOM}=require('jsdom'));}catch{({JSDOM}=require(path.join(process.env.BRIDGE_TEST_NODE_MODULES||'', 'jsdom')));}
const root=new URL('../windows/BridgeTranslate.App/Assets/',import.meta.url);
const script=await readFile(new URL('reader.js',root),'utf8');
function setup(){const dom=new JSDOM('<!doctype html><body><main id="content"></main></body>',{url:'https://bridge.local/index.html',runScripts:'outside-only'});const w=dom.window,sent=[];let handler;w.chrome={webview:{postMessage:m=>sent.push(m),addEventListener:(_,fn)=>handler=fn}};w.requestAnimationFrame=()=>{};w.scrollTo=()=>{};w.eval(script);return {dom,w,sent,render:html=>handler({data:{type:'render',html}})};}
test('standalone reader removes executable content, unsafe links and automatic remote image loading',()=>{const h=setup();try{
 h.render('<script>window.INJECTED=1</script><p onclick="bad()" style="color:red"><a href="javascript:alert(1)">bad</a></p><iframe src="https://x.test"></iframe><img src="https://automatic.test/a.png" data-source="https://img.test/a.png" alt="demo">');
 const d=h.w.document;assert.equal(d.querySelector('script'),null);assert.equal(d.querySelector('iframe'),null);assert.equal(d.querySelector('[onclick]'),null);assert.equal(d.querySelector('[style]'),null);assert.equal(d.querySelector('a').hasAttribute('href'),false);assert.equal(d.querySelector('img'),null);
 d.querySelector('.image-link').click();assert.equal(d.querySelector('img').getAttribute('src'),'https://img.test/a.png');
}finally{h.dom.window.close();}});
test('code and table copy send only selected plain content, preserving line breaks and Markdown pipes',()=>{const h=setup();try{
 h.render('<pre><code>def test():\n    return 1\n</code></pre><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>x|y</td><td>中文</td></tr></tbody></table>');
 h.w.document.querySelector('pre button').click();assert.equal(h.sent.at(-1).text,'def test():\n    return 1\n');
 h.w.document.querySelectorAll('.table-tools button')[1].click();assert.ok(h.sent.at(-1).text.includes('x\\|y'));assert.ok(h.sent.at(-1).text.includes('| --- | --- |'));
}finally{h.dom.window.close();}});
test('safe link clicks open only HTTPS URLs through the narrow host bridge',()=>{const h=setup();try{h.render('<a href="https://example.test/a">open</a>');h.w.document.querySelector('a').click();assert.deepEqual(JSON.parse(JSON.stringify(h.sent.at(-1))),{type:'open',url:'https://example.test/a'});}finally{h.dom.window.close();}});
test('KaTeX uses untrusted rendering with original TeX retained in a data field',()=>{const h=setup();try{let called;h.w.katex={render:(text,el,options)=>called={text,options}};h.render('<span data-tex="x^2" data-display="true"></span>');assert.equal(called.text,'x^2');assert.equal(called.options.trust,false);assert.equal(called.options.displayMode,true);}finally{h.dom.window.close();}});
