// Page UI uses a shadow root only to avoid style collisions, not as a secrecy boundary.
// Keys stay in the background worker; translations intentionally appear in Claude's DOM.
(async () => {
  'use strict';
  if (globalThis.__bridgeTranslateAdapter) return;
  globalThis.__bridgeTranslateAdapter = true;
  const {planTranslation, protectInline} = await import(chrome.runtime.getURL('api.mjs'));
  const {originalText, isProtectedElement} = await import(chrome.runtime.getURL('dom-text.mjs'));
  const {createParagraphTracker} = await import(chrome.runtime.getURL('paragraphs.mjs'));
  const {createTitleTracker} = await import(chrome.runtime.getURL('titles.mjs'));
  const MAX_TEXT = 60000;
  const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{323AF}]/u;
  const editorSelectors = ['.ProseMirror[contenteditable="true"]', '[data-testid="chat-input"][contenteditable="true"]', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"][data-placeholder]', '[contenteditable="plaintext-only"]', 'textarea', '[contenteditable="true"]'];
  const editorSelector = editorSelectors.join(',');
  const composingEditors = new WeakSet();
  const consumedEnter=new WeakSet();
  let lastEditor = null, writingComposer = false, observedEditor = null, observedText = null;
  let settings = {configured: false, autoTranslate: true, enterTranslateSend:false, translateTitles:true}, currentJob = null, undo = null, promptAction=null;
  let path = location.href, lastConfigCheck = 0, scanBusy = false,pageActive=true;
  let scanTimer = null, scanDue = Infinity;
  const states = new Map();
  function shown(el) { return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  function usableEditor(el) {
    if (!el?.isConnected || !el.matches?.(editorSelector) || !shown(el) || el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('[data-bridge-ui], [role="search"], [role="dialog"]')) return false;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  }
  function editorFrom(node) { return node?.closest?.(editorSelector) || null; }
  function editor() {
    const focused = editorFrom(document.activeElement);
    if (usableEditor(focused)) return lastEditor = focused;
    if (usableEditor(lastEditor)) return lastEditor;
    const candidates = [...document.querySelectorAll(editorSelector)].filter(usableEditor);
    const score = el => (el.matches('.ProseMirror, [data-testid="chat-input"]') ? 80 : 0) +
      (el.getAttribute('role') === 'textbox' ? 30 : 0) + (el.closest('main, form, [data-testid="chat-input-container"]') ? 20 : 0) +
      (/message|prompt|chat|消息|提问/i.test((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('data-placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')) ? 40 : 0);
    candidates.sort((a,b) => score(b)-score(a));
    return lastEditor = candidates[0] || null;
  }
  function editorText(el = editor()) { return el ? (el.value ?? el.innerText ?? '').replace(/\r\n/g, '\n').trim() : ''; }
  async function rpc(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || '插件连接已断开，请刷新网页。');
    return result;
  }
  function streaming() {
    if (document.querySelector('[data-is-streaming="true"], [data-testid="stop-button"], [data-testid="stop-generation-button"]')) return true;
    return [...document.querySelectorAll('button[aria-label], button[title]')].some(b => shown(b) && /stop (generating|response)|stop generation|停止生成|停止回答/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')));
  }
  function markdown(node, root = node) {
    if (node.nodeType === Node.TEXT_NODE) return originalText(node);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName;
    if (isProtectedElement(node) || node.getAttribute('aria-hidden') === 'true') return '';
    if (node.matches('.sr-only, .visually-hidden, .screen-reader-only, .screen-reader-text, .hidden, [data-testid="message-timestamp"], [data-testid="timestamp"], [data-testid="message-actions"]')) return '';
    if (node !== root && (node.hidden || node.style.display === 'none' || node.style.visibility === 'hidden')) return '';
    if (tag === 'PRE') {
      const code = node.querySelector('code');
      const value = (code || node).textContent;
      const lang = (code?.className || '').match(/language-([\w+-]+)/)?.[1] || '';
      const fence = '`'.repeat(Math.max(3, ...[...value.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return '\n\n' + fence + lang + '\n' + value.replace(/\n$/, '') + '\n' + fence + '\n\n';
    }
    if (tag === 'CODE') {
      const value = node.textContent;
      const fence = '`'.repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return fence + value + fence;
    }
    if (tag === 'BR') return '\n';
    const children = [...node.childNodes].map(child => markdown(child, root)).join('');
    if (/^H[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + children.trim() + '\n\n';
    if (tag === 'LI') return '\n- ' + children.trim() + '\n';
    if (tag === 'STRONG' || tag === 'B') return '**' + children + '**';
    if (tag === 'EM' || tag === 'I') return '*' + children + '*';
    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      return /^https?:\/\//i.test(href) ? '[' + children + '](' + href + ')' : children;
    }
    if (tag === 'TR') return children + '\n';
    if (tag === 'TD' || tag === 'TH') return children.trim() + ' | ';
    if (['P', 'DIV', 'SECTION', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE'].includes(tag)) return '\n' + children + '\n';
    return children;
  }
  function responseNodes() {
    let nodes = [...document.querySelectorAll('.font-claude-response, .font-claude-response-body')];
    if (!nodes.length) nodes = [...document.querySelectorAll('[data-testid="assistant-message"], [data-message-author-role="assistant"], [data-is-streaming]')];
    nodes = [...new Set(nodes.map(node => node.closest('[data-testid="assistant-message"], [data-message-author-role="assistant"], [data-is-streaming]') || node))];
    return nodes.filter(n => !nodes.some(other => other !== n && other.contains(n)));
  }
  function latest() {
    const nodes = responseNodes(), node = nodes.at(-1);
    if (!node) return null;
    const text = markdown(node).trim();
    return text ? {text: text.length <= MAX_TEXT ? text : '', tooLong: text.length > MAX_TEXT, length: text.length, index: nodes.length - 1} : null;
  }
  async function replaceComposer(text, expectedText, preferred = null) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('提问文本为空或超过 60000 字。');
    if (streaming()) throw new Error('请等待 Claude 完成当前回答。');
    const el = usableEditor(preferred) ? preferred : editor();
    if (!el) throw new Error('没有找到提问框，请刷新 Claude 网页后重试。');
    if (editorText(el) !== expectedText) throw new Error('翻译期间提问已修改，未覆盖当前内容。英文已放在预览中，可复制使用。');
    writingComposer = true;
    try {
      el.focus(); lastEditor = el;
      const selectAll = () => {
        const selection = window.getSelection(), range = document.createRange();
        range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range);
      };
      if (el.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
        el.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
      } else {
        selectAll();
        try { document.execCommand('insertText', false, text); } catch {}
        await new Promise(resolve => setTimeout(resolve, 120));
        // If native editing was ignored, let the site's editor handle a plain-text paste.
        // Never replace DOM content directly: that may leave the editor's internal state stale.
        if (el.isConnected && editorText(el) === expectedText && typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function') {
          selectAll(); const data = new DataTransfer(); data.setData('text/plain', text);
          el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
        }
      }
      await new Promise(resolve => setTimeout(resolve, 120));
      const actual = el.isConnected ? el : editor();
      if (!actual || editorText(actual) !== text.replace(/\r\n/g, '\n').trim()) throw new Error('英文已生成，但网页输入框未接受填入。原稿保留，请复制预览中的英文。');
      return actual;
    } finally { writingComposer = false; syncComposer(false); }
  }
  const STYLE = `:host{all:initial;font:13px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#24443a;color-scheme:light}*{box-sizing:border-box}button,textarea{font:inherit}button{cursor:pointer;border:1px solid #d9e4dd;background:white;color:#3e6656;border-radius:7px;padding:5px 10px;line-height:1.5;font-size:12px}button:hover{background:#eef6f0}button:disabled{opacity:.5;cursor:wait}button:focus-visible{outline:3px solid #9ec8b2;outline-offset:2px}[hidden]{display:none!important}.primary{background:#237663;color:white;border-color:#237663}.primary:hover{background:#195c4c}.toolbar{background:#f8fcf8;border:1px solid #d5e4d9;border-radius:12px;box-shadow:0 5px 26px #193f2d1a;padding:9px 10px;max-width:min(420px,calc(100vw - 24px))}.top{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.brand{font-size:12px;font-weight:700;color:#237663;margin:0 4px}.small{font-size:11px;color:#7b9185}.status{font-size:11px;margin:7px 2px 0;color:#637e6e;max-width:370px;overflow-wrap:anywhere}.error{color:#a05b3a}.check{font-size:11px;display:flex;align-items:center;gap:3px;color:#58715f}.check input{accent-color:#237663}.preview{margin-top:8px}textarea{display:block;width:100%;min-height:100px;max-height:240px;border:1px solid #cfdfd3;border-radius:7px;padding:9px;resize:vertical;background:white;color:#24443a;font-size:12px}.preview-actions{display:flex;gap:7px;margin-top:7px}.paragraph-output{margin:4px 0 12px;padding:3px 0 3px 12px;border-left:2px solid #d5e4d9}.paragraph-output .text{margin-top:0}.paragraph-output .text>*{margin-top:0;margin-bottom:0}.paragraph-output .caption{margin:2px 0}.answer{margin:12px 0 16px;background:#f3f8f2;border:1px solid #dce7d8;border-radius:10px;padding:12px 15px}.answer-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.label{font-size:11px;font-weight:650;letter-spacing:.4px;color:#547650}.tools{display:flex;gap:5px;flex-wrap:wrap}.tools button{font-size:10px;padding:3px 7px}.text{overflow-wrap:anywhere;line-height:1.9;font-size:14px;margin-top:12px;color:#243f2a}.text p{white-space:pre-wrap;margin:9px 0}.text h1,.text h2,.text h3,.text h4{font-weight:650;line-height:1.5;margin:16px 0 9px;font-size:16px}.text h1{font-size:19px}.text h2{font-size:17px}.text pre{white-space:pre;overflow:auto;background:#e8f0e6;border:1px solid #d7e3d2;border-radius:7px;padding:12px;font:12px/1.7 Consolas,monospace}.text code{font:12px/1.7 Consolas,monospace;background:#e8f0e6;border-radius:3px;padding:1px 4px}.text pre code{padding:0;background:none}.text ul,.text ol{padding-left:24px;margin:9px 0}.text li{margin:4px 0}.text a{color:#20725d;text-decoration:underline}.text blockquote{border-left:3px solid #abc9a4;margin:12px 0;padding:0 12px;color:#5e7659;white-space:pre-wrap}.text hr{border:0;border-top:1px solid #d7e3d2;margin:16px 0}.table-wrap{overflow:auto}.text table{border-collapse:collapse;width:100%;font-size:12px}.text th,.text td{padding:6px 9px;border:1px solid #d4e0cf;text-align:left}.text th{background:#e7f0e1}.text>:first-child{margin-top:0}.caption{font-size:10px;color:#8c9f8b;margin-top:9px}`;
  function shadowHost() {
    const host = document.createElement('div'); host.setAttribute('data-bridge-ui', '');
    const root = host.attachShadow({mode: 'open'}), style = document.createElement('style'); style.textContent = STYLE; root.append(style);
    return {host, root};
  }
  function button(text, click, cls = '') { const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.className = cls; el.addEventListener('click', click); return el; }
  const {host: toolbarHost, root: toolbarRoot} = shadowHost();
  toolbarHost.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;';
  const toolbar = document.createElement('div'); toolbar.className = 'toolbar';
  const top = document.createElement('div'); top.className = 'top';
  const brand = document.createElement('span'); brand.className = 'brand'; brand.textContent = '桥译';
  brand.title = '桥译 · 正式版'; toolbarHost.setAttribute('data-bridge-version', '1.0.0');
  const promptBtn = button('中文 → 英文', () => translatePrompt(), 'primary');
  const autoLabel = document.createElement('label'); autoLabel.className = 'check';
  const autoInput = document.createElement('input'); autoInput.type = 'checkbox'; autoInput.checked = true;
  autoLabel.append(autoInput, '自动译回答');
  autoLabel.title = '此开关只控制回答；提问可手动翻译，或单独开启“回车译后发送”。';
  autoInput.addEventListener('change', async () => { try { await rpc({type: 'SET_AUTO', enabled: autoInput.checked}); settings.autoTranslate = autoInput.checked; } catch(e) { notify(e.message, true); } });
  const enterLabel=document.createElement('label');enterLabel.className='check';
  const enterInput=document.createElement('input');enterInput.type='checkbox';enterInput.checked=false;
  enterLabel.append(enterInput,'回车译后发送');enterLabel.title='中文提问按 Enter 自动翻译成英文并发送；Shift+Enter 换行。';
  enterInput.addEventListener('change',async()=>{
    settings.enterTranslateSend=enterInput.checked;
    if(!enterInput.checked&&promptAction?.send)promptAction.cancelled=true;
    try{await rpc({type:'SET_ENTER_SEND',enabled:enterInput.checked});syncComposer(false);}
    catch(error){notify(error.message,true);}
  });
  const titleLabel=document.createElement('label');titleLabel.className='check';
  const titleInput=document.createElement('input');titleInput.type='checkbox';titleInput.checked=true;titleLabel.append(titleInput,'对话标题');
  titleLabel.title='翻译侧栏可见对话标题；悬停看英文原名。仅本页显示，不重命名云端会话。';
  titleInput.addEventListener('change',async()=>{settings.translateTitles=titleInput.checked;cancelTitleJob();titleTracker.reset();try{await rpc({type:'SET_TITLES',enabled:titleInput.checked});scheduleScan(0);}catch(error){notify(error.message,true);}});
  const cancelBtn = button('取消', () => cancelCurrent()); cancelBtn.hidden = true;
  const undoBtn = button('还原中文', async () => {
    if (!undo || undo.url !== location.href) return;
    try { await replaceComposer(undo.original, undo.translated); undo = null; undoBtn.hidden = true; notify('已还原中文草稿。'); } catch (e) { notify(e.message, true); }
  }); undoBtn.hidden = true;
  const optionsBtn = button('设置', () => rpc({type: 'OPEN_SETTINGS'}).catch(e => notify(e.message, true)));
  let folded = false, previewBeforeFold = false;
  const compactBtn = button('收起', () => {
    folded = !folded;
    if (folded) previewBeforeFold = !preview.hidden;
    for (const el of [promptBtn, autoLabel, enterLabel, optionsBtn, status]) el.hidden = folded;
    preview.hidden = folded || !previewBeforeFold;
    compactBtn.textContent = folded ? '展开' : '收起';
  });
  const status = document.createElement('div'); status.className = 'status'; status.textContent = '正在读取模型设置…'; status.setAttribute('role', 'status');
  const preview = document.createElement('div'); preview.className = 'preview'; preview.hidden = true;
  const previewText = document.createElement('textarea'); previewText.setAttribute('aria-label', '英文翻译预览');
  const previewActions = document.createElement('div'); previewActions.className = 'preview-actions';
  previewActions.append(button('复制英文', () => navigator.clipboard.writeText(previewText.value).then(() => notify('英文已复制。')).catch(() => notify('复制失败，请选中预览文字手动复制。', true))), button('关闭预览', () => preview.hidden = true));
  preview.append(previewText, previewActions);
  top.append(brand, promptBtn, autoLabel, enterLabel, titleLabel, undoBtn, cancelBtn, optionsBtn, compactBtn); toolbar.append(top, status, preview); toolbarRoot.append(toolbar); document.documentElement.append(toolbarHost);
  const {host: composerHost, root: composerRoot} = shadowHost();
  composerHost.style.cssText = 'position:fixed;z-index:2147483645;'; composerHost.hidden = true;
  const composerButton = button('翻译成英文', () => translatePrompt(), 'primary');
  composerButton.title = '将当前中文提问翻译并填回输入框；不会自动发送。';
  composerButton.addEventListener('mousedown', event => event.preventDefault());
  promptBtn.addEventListener('mousedown', event => event.preventDefault());
  composerRoot.append(composerButton); document.documentElement.append(composerHost);
  function syncComposer(showNotice = true) {
    const el = editor(), text = editorText(el), chinese = HAN.test(text);
    const changed = el !== observedEditor || text !== observedText;
    observedEditor = el; observedText = text;
    const busy = !!currentJob||!!promptAction, composing = !!el && composingEditors.has(el);
    promptBtn.disabled=busy;cancelBtn.hidden=!busy;
    composerButton.disabled = busy || composing;
    composerButton.textContent = busy ? '正在翻译…' : composing ? '请先确认输入' : '翻译成英文';
    composerHost.hidden = !el || !chinese;
    if (el && chinese) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.bottom < 0 || rect.top > innerHeight) composerHost.hidden = true;
      else {
        composerHost.style.left = Math.max(8, Math.min(innerWidth-132, rect.right-124)) + 'px';
        composerHost.style.top = Math.max(8, rect.top-38) + 'px';
      }
    }
    if (showNotice && changed && !busy && !writingComposer) {
      if (chinese) notify(composing ? '请先确认中文输入候选，再翻译提问。' : settings.enterTranslateSend?'检测到中文提问，Enter 译后发送；Shift+Enter 换行，也可点按钮只翻译。':'检测到中文提问，点击输入框旁“翻译成英文”。');
      else if (!text) notify(settings.enterTranslateSend?'中文提问可按 Enter 译后发送；Shift+Enter 换行。':'提问需点击翻译按钮；“自动译回答”只控制回答。');
    }
  }
  function onComposerEvent(event) {
    const el = editorFrom(event.target);
    if (!usableEditor(el)) return;
    lastEditor = el; syncComposer();
  }
  document.addEventListener('focusin', onComposerEvent, true);
  document.addEventListener('input', onComposerEvent, true);
  document.addEventListener('compositionstart', event => { const el=editorFrom(event.target); if(el){composingEditors.add(el);onComposerEvent(event);} }, true);
  document.addEventListener('compositionend', event => { const el=editorFrom(event.target); if(el){composingEditors.delete(el);observedText=null;onComposerEvent(event);} }, true);
  window.addEventListener('keydown',event=>{
    if(event.key!=='Enter'||event.shiftKey)return;
    const target=editorFrom(event.target);if(!usableEditor(target))return;
    if(event.isComposing||event.keyCode===229||composingEditors.has(target))return;
    const pending=!!promptAction&&(promptAction.target===target||promptAction.actual===target);
    if((event.ctrlKey||event.altKey||event.metaKey)&&!pending)return;
    if(!pending&&(!settings.enterTranslateSend||!HAN.test(editorText(target))))return;
    event.preventDefault();event.stopImmediatePropagation();consumedEnter.add(target);
    if(event.repeat||promptAction)return;
    lastEditor=target;translatePrompt({send:true,target});
  },true);
  window.addEventListener('keyup',event=>{const target=editorFrom(event.target);if(event.key==='Enter'&&target&&consumedEnter.has(target)){event.preventDefault();event.stopImmediatePropagation();consumedEnter.delete(target);}},true);
  window.addEventListener('click',event=>{
    const action=promptAction;if(!action||action.allowSendClick)return;
    const control=event.target.closest?.('button');if(!control)return;
    if(control===sendControl(action.actual||action.target)){
      event.preventDefault();event.stopImmediatePropagation();notify(action.clicked?'正在确认发送结果，请勿重复发送。':'提问正在翻译或填入，请稍候；不会发送中文原稿。');
    }
  },true);
  window.addEventListener('submit',event=>{const action=promptAction;if(action&&!action.allowSendClick&&event.target.contains?.(action.actual||action.target)){event.preventDefault();event.stopImmediatePropagation();}},true);
  window.addEventListener('resize', () => syncComposer(false));
  document.addEventListener('scroll', () => syncComposer(false), {capture:true,passive:true});
  function notify(text, error = false) { status.textContent = text; status.className = 'status' + (error ? ' error' : ''); }
  function abortRequests(job) {
    for (const requestId of job.requestIds) rpc({type:'CANCEL', requestId}).catch(() => {});
  }
  function cancelCurrent() { if(!currentJob&&!promptAction)return;if(promptAction)promptAction.cancelled=true;if(currentJob){currentJob.cancelled=true;if(currentJob.state)currentJob.state.paused=true;abortRequests(currentJob);}notify('已取消；当前草稿和已完成译文保留。'); }
  async function translate(text, direction, onProgress, onPartial) {
    if (currentJob) throw new Error('已有翻译正在进行，可先点击“取消”。');
    if (!text.trim() || text.length > MAX_TEXT) throw new Error('单次翻译支持 1～60000 字。');
    const previousTitle=cancelTitleJob();
    const job = {cancelled: false, requestIds: new Set(), url: location.href}; currentJob = job; cancelBtn.hidden = false; promptBtn.disabled = true; syncComposer(false);
    try {
      await previousTitle;
      const units = planTranslation(text), total = units.filter(u => u.kind === 'text' && u.text.trim()).length;
      const parts = new Array(units.length);
      let next = 0, done = 0, published = 0, failure = null;
      function validateJob() { if (job.cancelled || job.url !== location.href) throw new Error('翻译已取消或会话已切换。'); }
      function publish() {
        let prefix = 0;
        while(prefix < parts.length && parts[prefix] !== undefined) prefix++;
        if (prefix > published) { published = prefix; onPartial?.(parts.slice(0,prefix).join('').trim(), done, total); }
      }
      async function worker() {
        try {
          while(next < units.length && !failure) {
            validateJob(); const index = next++, unit = units[index];
            if (unit.kind === 'code' || !unit.text.trim()) { parts[index] = unit.text; publish(); continue; }
            onProgress?.(done,total);
            const protectedPart = protectInline(unit.text.trim(), crypto.randomUUID().replace(/-/g, ''));
            const requestId = crypto.randomUUID(); job.requestIds.add(requestId);
            let result;
            try { result = await rpc({type:'TRANSLATE_CHUNK',requestId,text:protectedPart.text,direction}); }
            finally { job.requestIds.delete(requestId); }
            validateJob(); if(failure) return;
            parts[index] = unit.text.match(/^\s*/)[0] + protectedPart.restore(result.text) + unit.text.match(/\s*$/)[0];
            done++; onProgress?.(done,total); publish();
          }
        } catch(error) {
          if(!failure) failure = error;
          job.cancelled = true; abortRequests(job);
        }
      }
      // At most two independent response segments run together. Input translation stays sequential.
      await Promise.all(Array.from({length: direction === 'zh' ? Math.min(2,units.length) : 1}, () => worker()));
      if(failure) throw failure;
      validateJob(); return parts.join('').trim();
    } finally { currentJob = null; cancelBtn.hidden = true; promptBtn.disabled = false; syncComposer(false); }
  }
  function sendControl(target){
    if(!usableEditor(target))return null;
    const explicit='button[data-testid="send-button"],button[data-testid="send-message-button"],button[data-testid="chat-send-button"],button[aria-label="Send message" i],button[aria-label="Send" i],button[aria-label="发送消息"],button[aria-label="发送"],button[title="Send message" i]';
    const form=target.closest('form');
    for(let scope=target.parentElement;scope;scope=scope.parentElement){
      if(form&&!form.contains(scope)&&scope!==form)break;
      const nodes=[...scope.querySelectorAll(explicit+(scope===form?',button[type="submit"]':''))].filter(control=>{
        if(control.closest('[data-bridge-ui], [role="dialog"]')||!shown(control))return false;
        for(let n=control;n;n=n.parentElement){if(n.hidden||n.getAttribute('aria-hidden')==='true')return false;const style=getComputedStyle(n);if(style.display==='none'||style.visibility==='hidden')return false;}
        const own=control.closest('form');return !own||own.contains(target);
      });
      if(nodes.length===1)return nodes[0];if(nodes.length>1)return null;
      if(scope===form)break;
    }
    return null;
  }
  function checkPromptAction(action,expected,el=action.target){
    if(action.cancelled)throw new Error('提问操作已取消，未自动发送。');
    if(action.url!==location.href)throw new Error('会话已切换，未自动发送。');
    if(!usableEditor(el)||editorText(el)!==expected)throw new Error('翻译期间提问已修改，未覆盖当前内容，也未自动发送。当前草稿保留。');
    if(action.send&&(!settings.enterTranslateSend||!enterInput.checked))throw new Error('回车译后发送已关闭，未自动发送。');
    if(streaming())throw new Error('请等待当前回答完成后再发送提问。');
  }
  async function sendTranslatedPrompt(action,translated){
    const target=action.actual;let control=null;
    for(let i=0;i<20;i++){
      checkPromptAction(action,translated,target);control=sendControl(target);
      if(control&&!control.disabled&&control.getAttribute('aria-disabled')!=='true')break;
      control=null;await new Promise(resolve=>setTimeout(resolve,80));
    }
    checkPromptAction(action,translated,target);
    if(!control)throw new Error('英文已填入，但没有找到可用的发送按钮。请检查后手动发送。');
    action.clicked=true;undo=null;undoBtn.hidden=true;action.allowSendClick=true;
    try{control.click();}finally{action.allowSendClick=false;}
    for(let i=0;i<20;i++){
      if(action.url!==location.href||streaming()||!target.isConnected||!editorText(target))return true;
      await new Promise(resolve=>setTimeout(resolve,80));
    }
    return false;
  }
  async function translatePrompt({send=false,target=editor()}={}) {
    if(promptAction){notify('提问正在处理中，请稍候。');return;}
    const action={target,url:location.href,send,cancelled:false,clicked:false,actual:null};promptAction=action;syncComposer(false);
    try {
      const original=editorText(target),url=action.url;
      if (!target) throw new Error('未识别到网页提问框。请先点击提问框，再重试翻译。');
      if (composingEditors.has(target)) throw new Error('请先确认中文输入候选，再翻译提问。');
      if (!original) throw new Error('先在 Claude 提问框输入中文。');
      await refreshConfig();
      if (!settings.configured) { notify('先点击“设置”填写 API URL、模型名和 Key。', true); return; }
      if (streaming()) throw new Error('请等待当前回答完成后再翻译提问。');
      if(currentJob?.kind==='paragraphs'){
        notify('等待当前回答翻译请求结束，然后处理提问…');
        for(let i=0;i<260&&currentJob;i++){checkPromptAction(action,original);await new Promise(resolve=>setTimeout(resolve,100));}
      }
      checkPromptAction(action,original);
      const translated = await translate(original, 'en', (n, total) => notify(`提问翻译中 ${n}/${total}…`));
      action.translation=translated;
      previewText.value = translated;
      if (HAN.test(translated)) { preview.hidden = false; throw new Error('译文仍含汉字，未替换提问框。请检查预览中的人名、引文或代码。'); }
      if (url !== location.href) throw new Error('会话已切换，未填入译文。');
      checkPromptAction(action,original);
      try { action.actual=await replaceComposer(translated, original, target); } catch(e) { preview.hidden = false; throw e; }
      undo = {original, translated, url}; undoBtn.hidden = false;
      if(send){
        const confirmed=await sendTranslatedPrompt(action,translated);
        notify(confirmed?'已翻译成英文并发送。':'已点击网页发送按钮，尚未确认是否成功，请查看页面；不会自动重复发送。',!confirmed);
      }else notify('已替换为英文。检查后按网页发送按钮；可点击“还原中文”。');
    } catch(e) { if(action.translation&&!action.clicked&&!action.cancelled){previewText.value=action.translation;preview.hidden=false;}notify(e.message, true); }
    finally{if(promptAction===action)promptAction=null;syncComposer(false);scheduleScan(0);}
  }
  function addAnswer(node) {
    const {host,root}=shadowHost();
    const box=document.createElement('div');box.className='answer';
    const head=document.createElement('div');head.className='answer-head';
    const label=document.createElement('span');label.className='label';label.textContent='桥译 · 逐段翻译';
    const tools=document.createElement('div');tools.className='tools';
    const state={node,host,label,mode:'bilingual',paused:false,manual:false,loading:false,source:'',tracker:null};
    state.tracker=createParagraphTracker(node,{
      now:()=>Date.now(),
      onInvalidate:record=>{for(const requestId of record.requestIds)rpc({type:'CANCEL',requestId}).catch(()=>{});},
      createHost:record=>{
        const {host,root}=shadowHost();host.setAttribute('data-bridge-paragraph','');host.style.display='block';
        const wrap=document.createElement('div');wrap.className='paragraph-output';
        const output=document.createElement('div');output.className='text';
        const caption=document.createElement('div');caption.className='caption';
        wrap.append(output,caption);let tableTools=null;
        if(record.target.node.tagName==='TABLE'){
          tableTools=document.createElement('div');tableTools.className='tools';
          const payload=()=>record.plan.copyBlock({kind:'table',node:record.target.node});
          const valid=()=>record.status==='done'&&state.tracker.isCurrent(record);
          tableTools.append(button('复制中文表格',()=>{if(valid())copyPayload(payload(),'中文表格已复制，可粘贴到表格软件。');}),button('复制 Markdown',()=>{if(valid())copyPayload({text:payload().markdown},'中文表格 Markdown 已复制。');}));
          wrap.append(tableTools);
        }
        root.append(wrap);return {host,output,caption,tableTools};
      }
    });
    const copyBtn=button('复制中文全文',()=>{
      state.tracker.update();
      if(streaming()||!state.tracker.complete()){notify('回答或译文尚未完成，请完成后再复制全文。',true);return;}
      copyPayload({text:state.tracker.markdown()},'中文全文已复制，包含 Markdown 排版、代码和表格。');
    });copyBtn.disabled=true;state.copyBtn=copyBtn;
    tools.append(button('翻译／重试',()=>translateAnswer(state)),button('原文',()=>setAnswerMode(state,'original')),button('双语',()=>setAnswerMode(state,'bilingual')),button('中文',()=>setAnswerMode(state,'chinese')),copyBtn);
    head.append(label,tools);box.append(head);root.append(box);
    node.insertAdjacentElement('afterend',host);states.set(node,state);return state;
  }
  async function copyPayload(payload,message) {
    try {
      if(payload.html && typeof ClipboardItem==='function' && navigator.clipboard.write) {
        try { await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([payload.text],{type:'text/plain'}),'text/html':new Blob([payload.html],{type:'text/html'})})]); }
        catch { await navigator.clipboard.writeText(payload.text); }
      }else await navigator.clipboard.writeText(payload.text);
      notify(message);
    }catch {notify('复制失败，请选中文字手动复制。',true);}
  }
  function setAnswerMode(state,mode) {
    try{state.tracker.setMode(mode);state.mode=mode;state.node.hidden=false;}
    catch(error){notify(error.message,true);}
  }
  function refreshAnswer(state,busy) {
    const records=[...state.tracker.records.values()],done=records.filter(record=>record.status==='done').length;
    state.copyBtn.disabled=busy||!state.tracker.complete();
    const suffix=state.paused?' · 已暂停，可翻译／重试':busy?' · Claude 正在生成':state.tracker.complete()?' · 已完成':'';
    state.label.textContent=`桥译 · 已译 ${done}/${records.length} 段${suffix}`;
    if(!records.length)state.label.textContent='桥译 · 暂无可翻译的普通文字';
  }
  function tailDelay(state){return state.node.closest('[data-is-streaming]')?.getAttribute('data-is-streaming')==='false'?250:1400;}
  async function pumpAnswer(state) {
    if(!pageActive||state.loading||state.paused||document.hidden||!state.node.isConnected||currentJob||promptAction)return;
    if(!state.tracker.ready(streaming(),tailDelay(state)).length)return;
    if(state.source.length>MAX_TEXT){state.paused=true;notify('单条回答的普通文字超过 60000 字，已停止自动翻译。',true);return;}
    const previousTitle=cancelTitleJob();
    const job={kind:'paragraphs',state,cancelled:false,requestIds:new Set(),url:location.href};
    currentJob=job;state.loading=true;cancelBtn.hidden=false;promptBtn.disabled=true;syncComposer(false);
    async function worker(){
      while(!job.cancelled&&!promptAction&&job.url===location.href&&state.node.isConnected){
        const record=state.tracker.ready(streaming(),tailDelay(state))[0];if(!record)return;
        try{
          if(!state.tracker.prepare(record))continue;
          for(const batch of record.plan.batches){
            if(job.cancelled||job.url!==location.href)throw new Error('翻译已取消或会话已切换。');
            if(!state.tracker.isCurrent(record))break;
            const requestId=crypto.randomUUID();job.requestIds.add(requestId);record.requestIds.add(requestId);
            let result;
            try{result=await rpc({type:'TRANSLATE_NODES',requestId,text:record.plan.payload(batch),direction:'zh'});}
            finally{job.requestIds.delete(requestId);record.requestIds.delete(requestId);}
            if(job.cancelled||job.url!==location.href)throw new Error('翻译已取消或会话已切换。');
            if(!state.tracker.isCurrent(record))break;
            record.plan.applyBatch(batch,result.text);
          }
          if(state.tracker.isCurrent(record))state.tracker.finish(record);
          else state.tracker.update();
        }catch(error){
          if(!state.tracker.isCurrent(record)){state.tracker.update();continue;}
          state.tracker.fail(record,job.cancelled);state.paused=true;job.cancelled=true;abortRequests(job);notify(error.message,true);
        }
        refreshAnswer(state,streaming());
      }
    }
    try{await previousTitle;await Promise.all([worker(),worker()]);}
    finally{
      if(job.url!==location.href||!state.node.isConnected){state.tracker.dispose();state.host.remove();if(states.get(state.node)===state)states.delete(state.node);}
      state.loading=false;if(currentJob===job)currentJob=null;
      cancelBtn.hidden=true;promptBtn.disabled=false;syncComposer(false);
      refreshAnswer(state,streaming());scheduleScan(0);
    }
  }
  async function translateAnswer(state) {
    try{
      await refreshConfig();if(!settings.configured)throw new Error('请先点击右下角“设置”配置翻译模型。');
      if(currentJob&&currentJob.state!==state)throw new Error('已有翻译正在进行，可先点击右下角“取消”。');
      state.paused=false;state.manual=true;state.tracker.retry();state.tracker.update();state.source=markdown(state.node).trim();
      await pumpAnswer(state);scheduleScan(270);
    }catch(error){notify(error.message,true);}
  }
  const titleTracker=createTitleTracker(document,{visible:node=>{
    if(!shown(node))return false;
    for(let p=node;p;p=p.parentElement){const style=getComputedStyle(p);if(p.hidden||p.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden')return false;}
    const rect=node.getBoundingClientRect();if(rect.bottom<=0||rect.top>=innerHeight||rect.right<=0||rect.left>=innerWidth)return false;
    for(let p=node.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(/auto|scroll|hidden|clip/.test(s.overflowY)){const r=p.getBoundingClientRect();if(r.height&&((rect.bottom<=r.top)||(rect.top>=r.bottom)))return false;}}
    return true;
  }});
  let titleJob=null;
  function cancelTitleJob(){if(!titleJob)return Promise.resolve();titleJob.cancelled=true;rpc({type:'CANCEL',requestId:titleJob.requestId}).catch(()=>{});return titleJob.finished;}
  async function pumpTitles(){
    if(!settings.translateTitles||!settings.configured||document.hidden||!pageActive||currentJob||promptAction||streaming()||titleJob)return;
    const batch=titleTracker.scan();if(!batch.length)return;
    const job={requestId:crypto.randomUUID(),cancelled:false};job.finished=new Promise(resolve=>job.finish=resolve);titleJob=job;
    try{const result=await rpc({type:'TRANSLATE_NODES',requestId:job.requestId,text:titleTracker.payload(batch),direction:'zh'});
      if(!job.cancelled&&pageActive&&settings.translateTitles)titleTracker.apply(batch,result.text);
    }catch(error){if(!job.cancelled){titleTracker.fail(batch);notify('对话标题翻译失败：'+error.message+' 可关闭再开启“对话标题”重试。',true);}}
    finally{if(titleJob===job)titleJob=null;job.finish();scheduleScan(300);}
  }
  async function refreshConfig() {
    const config = await rpc({type: 'GET_PUBLIC_CONFIG'});
    if(settings.translateTitles!==config.translateTitles||settings.model!==config.model){cancelTitleJob();titleTracker.reset({clearCache:settings.model!==config.model});}
    settings = config; titleInput.checked=config.translateTitles; autoInput.checked = config.autoTranslate;enterInput.checked=config.enterTranslateSend;lastConfigCheck = Date.now();
  }
  function scheduleScan(delay = 100) {
    if(!pageActive)return;
    const due = Date.now()+delay;
    if(scanTimer !== null && due >= scanDue) return;
    if(scanTimer !== null) clearTimeout(scanTimer);
    scanDue = due;
    scanTimer = setTimeout(() => { scanTimer=null;scanDue=Infinity;scan(); },delay);
  }
  async function scan() {
    if(!pageActive||scanBusy)return;scanBusy=true;
    try{
      if(Date.now()-lastConfigCheck>5000)await refreshConfig();
      if(path!==location.href){
        cancelCurrent();undo=null;undoBtn.hidden=true;preview.hidden=true;path=location.href;
        lastEditor=null;observedEditor=null;observedText=null;
        for(const state of states.values()){state.tracker.dispose();state.host.remove();}states.clear();
        notify('已切换页面。输入中文后点击提问框旁的翻译按钮。');
      }
      if(!toolbarHost.isConnected)document.documentElement.append(toolbarHost);
      if(!composerHost.isConnected)document.documentElement.append(composerHost);syncComposer();
      for(const [node,state]of states)if(!node.isConnected){state.tracker.dispose();state.host.remove();states.delete(node);}
      const nodes=responseNodes(),busy=streaming();
      for(const node of nodes){
        const state=states.get(node)||addAnswer(node);
        if(!state.host.isConnected)node.insertAdjacentElement('afterend',state.host);
        state.source=markdown(node).trim();state.tracker.update();refreshAnswer(state,busy&&node===nodes.at(-1));
      }
      for(const state of states.values()){
        if(!settings.configured||state.paused||(!state.manual&&(!settings.autoTranslate||state.node!==nodes.at(-1))))continue;
        if(document.hidden){state.label.textContent+=' · 返回此标签页后翻译';continue;}
        const waiting=[...state.tracker.records.values()].filter(record=>record.status==='waiting'&&(!busy||record.closed));
        for(const record of waiting){const age=Date.now()-record.changedAt,delay=record.closed?250:tailDelay(state);if(age<delay)scheduleScan(delay-age+20);}
        pumpAnswer(state);
      }
      pumpTitles();
      if(undo&&editorText()!==undo.translated){undo=null;undoBtn.hidden=true;}
    }catch(error){notify(error.message,true);}finally{scanBusy=false;}
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
    if (message.type === 'SNAPSHOT') { sendResponse({ok: true, url: location.href, editorFound: !!editor(), streaming: streaming(), latest: latest()}); return false; }
    if (message.type === 'TRANSLATE_LATEST') { const node = responseNodes().at(-1); if (node) translateAnswer(states.get(node) || addAnswer(node)); sendResponse({ok: true, found: !!node}); return false; }
    if (message.type === 'FILL_ENGLISH') {
      if (message.expectedUrl !== location.href || HAN.test(message.text || '')) { sendResponse({ok:false, error:'会话已切换或英文中仍含汉字。'}); return false; }
      replaceComposer(message.text, '').then(() => sendResponse({ok:true,filled:true})).catch(e => sendResponse({ok:false,error:e.message})); return true;
    }
    return false;
  });
  await refreshConfig().catch(e => notify(e.message, true));
  notify(settings.configured ? settings.enterTranslateSend?'中文提问按 Enter 译后发送；Shift+Enter 换行，也可点按钮只翻译。':'中文提问可点按钮翻译；可选开启“回车译后发送”。' : '点击“设置”，接入你的翻译模型。');
  const observer = new MutationObserver(records => {
    if(records.some(record => !(record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement)?.closest('[data-bridge-ui]'))) scheduleScan(100);
  });
  observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-is-streaming']});
  document.addEventListener('scroll',()=>scheduleScan(150),{capture:true,passive:true});
  document.addEventListener('visibilitychange', () => { if(!document.hidden) scheduleScan(0); });
  window.addEventListener('pagehide',()=>{pageActive=false;if(scanTimer!==null)clearTimeout(scanTimer);scanTimer=null;scanDue=Infinity;cancelCurrent();cancelTitleJob();titleTracker.reset();for(const state of states.values()){state.tracker.dispose();state.host.remove();}states.clear();});
  window.addEventListener('pageshow',()=>{pageActive=true;scheduleScan(0);});
  setInterval(scan, 1000); scan();
})();
