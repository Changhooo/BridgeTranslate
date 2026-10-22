import {DEFAULTS, validateConfig, permissionOrigin, planTranslation, protectInline} from './api.mjs';
const $ = id => document.getElementById(id);
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{323AF}]/u;
let config = {...DEFAULTS}, hasKey = false, tab = null, snapshot = null, job = null, toastTimer;
async function rpc(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '插件连接失败，请重新加载插件。');
  return result;
}
function toast(text, error = false) {
  $('toast').textContent = text; $('toast').className = error ? 'error' : ''; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 12000 : 5000);
}
function selectTab(name) {
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === name));
  document.querySelectorAll('.tab').forEach(el => { const selected = el.dataset.tab === name; el.classList.toggle('active', selected); el.setAttribute('aria-selected', String(selected)); });
}
document.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => selectTab(el.dataset.tab)));
function updateButtons() {
  const text = $('english').value.trim(), han = HAN.test(text);
  $('hanWarning').hidden = !han; $('copyEnglish').disabled = !text;
  $('fillEnglish').disabled = !text || han || !tab || !!job;
  $('draftCount').textContent = `${$('draft').value.length} / 60000`;
}
function renderConfig() {
  for (const key of ['protocol', 'endpoint', 'model', 'auth', 'maxTokens', 'tokenField', 'glossary']) $(key).value = config[key];
  $('rememberKey').checked = config.rememberKey; $('autoTranslate').checked = config.autoTranslate;
  $('enterTranslateSend').checked=config.enterTranslateSend??false;
  $('translateTitles').checked=config.translateTitles??true;
  $('apiKey').value = ''; $('keyState').textContent = hasKey ? '密钥已配置' : '尚未配置';
  $('providerLabel').textContent = config.endpoint ? config.model + ' · ' + new URL(config.endpoint).hostname : '先配置模型，即可开始';
}
function readForm() {
  return validateConfig({
    protocol: $('protocol').value, endpoint: $('endpoint').value, model: $('model').value, auth: $('auth').value,
    maxTokens: Number($('maxTokens').value), tokenField: $('tokenField').value, glossary: $('glossary').value,
    rememberKey: $('rememberKey').checked, autoTranslate: $('autoTranslate').checked,enterTranslateSend:$('enterTranslateSend').checked,translateTitles:$('translateTitles').checked
  });
}
async function connect() {
  tab = null; snapshot = null;
  const [active] = await chrome.tabs.query({active: true, currentWindow: true});
  if (active?.url && new URL(active.url).origin === 'https://claude.ai') {
    try {
      const snap = await chrome.tabs.sendMessage(active.id, {type:'SNAPSHOT'});
      if (!snap?.ok) throw new Error('未能连接');
      tab = active; snapshot = snap;
      $('connectionDot').className = 'on'; $('connectionTitle').textContent = '已连接 Claude 网页';
      $('connectionSub').textContent = '网页右下角可直接翻译提问'; $('readState').textContent = snap.streaming ? 'Claude 正在生成回答' : '中文译文显示在对应英文段落下方';
    } catch {
      $('connectionDot').className = ''; $('connectionTitle').textContent = '请刷新 Claude 网页'; $('connectionSub').textContent = '安装插件后，已打开的页面需要刷新';
    }
  } else {
    $('connectionDot').className = ''; $('connectionTitle').textContent = '模型设置与备用翻译'; $('connectionSub').textContent = '打开 Claude 网页即可使用页内翻译'; $('readState').textContent = '请在 Claude 网页中打开侧边栏';
  }
  updateButtons();
}
$('connectBtn').addEventListener('click', () => connect().catch(e => toast(e.message, true)));
$('configForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const next = readForm();
    // Request directly from the click gesture before awaiting any storage calls.
    const granted = await chrome.permissions.request({origins:[permissionOrigin(next.endpoint)]});
    if (!granted) throw new Error('没有获得 API 域名权限，设置未保存。');
    const result = await rpc({type:'SAVE_CONFIG', config:next, apiKey:$('apiKey').value});
    config = result.config; hasKey = result.hasKey; renderConfig(); toast('已保存。网页将在几秒内使用新配置。');
  } catch (e) { toast(e.message, true); }
});
$('toggleKey').addEventListener('click', () => { const shown = $('apiKey').type === 'password'; $('apiKey').type = shown ? 'text' : 'password'; $('toggleKey').textContent = shown ? '隐藏' : '显示'; });
$('clearKey').addEventListener('click', async () => {
  try { await rpc({type:'CLEAR_KEY'}); hasKey = false; $('apiKey').value=''; $('keyState').textContent='尚未配置'; toast('已删除密钥，正在进行的接口请求已取消。'); }
  catch(e) { toast(e.message,true); }
});
$('autoTranslate').addEventListener('change', async () => {
  try { await rpc({type:'SET_AUTO',enabled:$('autoTranslate').checked}); config.autoTranslate=$('autoTranslate').checked; }
  catch(e) { toast(e.message,true); }
});
async function translate(text, direction, title) {
  if(job) throw new Error('请先等待当前翻译结束或取消。');
  if(!text.trim() || text.length>60000) throw new Error('单次翻译支持 1～60000 字。');
  const task={cancelled:false,requestId:null}; job=task;
  $('jobBar').hidden=false; $('translateDraft').disabled=true; $('testApi').disabled=true; updateButtons();
  try {
    let output='', index=0; const units=planTranslation(text), total=units.filter(u=>u.kind==='text'&&u.text.trim()).length;
    for (const unit of units) {
      if(task.cancelled) throw new Error('翻译已取消。');
      if(unit.kind==='code'||!unit.text.trim()) {output+=unit.text;continue;}
      $('jobLabel').textContent=`${title} ${++index}/${total}…`;
      const part=protectInline(unit.text.trim(),crypto.randomUUID().replace(/-/g,'')); task.requestId=crypto.randomUUID();
      const result=await rpc({type:'TRANSLATE_CHUNK',requestId:task.requestId,text:part.text,direction});
      if(task.cancelled) throw new Error('翻译已取消。');
      output+=unit.text.match(/^\s*/)[0]+part.restore(result.text)+unit.text.match(/\s*$/)[0];
    }
    return output.trim();
  } finally { job=null; $('jobBar').hidden=true; $('translateDraft').disabled=false; $('testApi').disabled=false; updateButtons(); }
}
$('cancelJob').addEventListener('click',()=>{if(job){job.cancelled=true;if(job.requestId)rpc({type:'CANCEL',requestId:job.requestId}).catch(()=>{});}});
$('testApi').addEventListener('click',async()=>{
  let task;
  try {
    if (job) throw new Error('请先等待当前翻译结束或取消。');
    const next = readForm();
    const apiKey = $('apiKey').value;
    const granted = await chrome.permissions.request({origins:[permissionOrigin(next.endpoint)]});
    if (!granted) throw new Error('没有获得 API 域名权限，无法测试连接。');
    if (job) throw new Error('已有翻译正在进行，请稍后测试。');
    task = {cancelled:false,requestId:crypto.randomUUID()}; job = task;
    $('jobBar').hidden = false; $('jobLabel').textContent = '正在测试当前填写的配置…';
    $('translateDraft').disabled = true; $('testApi').disabled = true; $('saveConfig').disabled = true; updateButtons();
    const result = await rpc({type:'TEST_CONNECTION', config:next, apiKey, requestId:task.requestId});
    if (task.cancelled) throw new Error('连接测试已取消。');
    toast('当前配置连接成功：'+result.text.slice(0,100)+'（网页翻译请先点击“授权并保存”）');
  } catch(e) { toast(e.message,true); }
  finally {
    if (task && job === task) {
      job = null; $('jobBar').hidden = true; $('translateDraft').disabled = false;
      $('testApi').disabled = false; $('saveConfig').disabled = false; updateButtons();
    }
  }
});
$('apiKey').addEventListener('input', () => {
  $('keyState').textContent = $('apiKey').value.trim() ? '已填写，尚未保存' : hasKey ? '密钥已配置' : '尚未配置';
});
async function translateDraft(){try{$('english').value=await translate($('draft').value,'en','翻译提问');updateButtons();toast('英文已生成，可编辑后填入。');}catch(e){toast(e.message,true);}}
$('translateDraft').addEventListener('click',translateDraft);
$('draft').addEventListener('input',updateButtons);$('english').addEventListener('input',updateButtons);
$('draft').addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();translateDraft();}});
$('copyEnglish').addEventListener('click',()=>navigator.clipboard.writeText($('english').value).then(()=>toast('英文已复制。')).catch(()=>toast('复制失败，请手动选中文字复制。',true)));
$('fillEnglish').addEventListener('click',async()=>{
  try{
    if(!tab||!snapshot)throw new Error('请先连接 Claude 页面。');
    const result=await chrome.tabs.sendMessage(tab.id,{type:'FILL_ENGLISH',text:$('english').value.trim(),expectedUrl:snapshot.url});
    if(!result?.ok)throw new Error(result?.error||'填入失败');toast('英文已填入，请在网页中检查后发送。');
  }catch(e){toast(e.message,true);}
});
$('clearDraft').addEventListener('click',()=>{if(job){toast('请先取消翻译。',true);return;}$('draft').value='';$('english').value='';updateButtons();});
$('translateLatest').addEventListener('click',async()=>{
  try{await connect();if(!tab)throw new Error('请在 Claude 网页中打开侧边栏。');const result=await chrome.tabs.sendMessage(tab.id,{type:'TRANSLATE_LATEST'});toast(result?.found?'已请求逐段翻译，请在英文段落下方查看。':'还没有找到回答。');}
  catch(e){toast(e.message,true);}
});
$('clearAnswers').hidden=true;
chrome.tabs.onActivated.addListener(()=>connect().catch(()=>{}));
chrome.tabs.onUpdated.addListener((id,change)=>{if(id===tab?.id&&change.status==='complete')connect().catch(()=>{});});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.config){config.autoTranslate=changes.config.newValue?.autoTranslate??true;$('autoTranslate').checked=config.autoTranslate;config.enterTranslateSend=changes.config.newValue?.enterTranslateSend??false;$('enterTranslateSend').checked=config.enterTranslateSend;config.translateTitles=changes.config.newValue?.translateTitles??true;$('translateTitles').checked=config.translateTitles;}});
try{
  const result=await rpc({type:'GET_CONFIG'});config=result.config;hasKey=result.hasKey;renderConfig();
  const ownTab = await chrome.tabs.getCurrent();
  selectTab(location.hash==='#settings'||ownTab||!config.endpoint?'settings':'write');await connect();
}catch(e){toast(e.message,true);}
