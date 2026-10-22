import {DEFAULTS, validateConfig, permissionOrigin, makeRequest, parseResponse, publicError} from './api.mjs';

const trustedStorage = Promise.all([
  chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'}),
  chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})
]);
const requests = new Map();
let preferenceWrites=Promise.resolve();
chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {});

function trustedPage(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
}
function claudeContent(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return false;
  try { return new URL(sender.url).origin === 'https://claude.ai'; } catch { return false; }
}
async function getSettings() {
  await trustedStorage;
  const [{config, savedKey}, {sessionKey}] = await Promise.all([
    chrome.storage.local.get(['config', 'savedKey']), chrome.storage.session.get('sessionKey')
  ]);
  return {config: {...DEFAULTS, ...config}, key: (config?.rememberKey ? savedKey : sessionKey) || ''};
}
async function formKey(config, candidate) {
  const old = await getSettings();
  let key = typeof candidate === 'string' ? candidate.trim() : '';
  if (key.length > 4096 || /[\r\n]/.test(key)) throw new Error('API Key 格式无效。');
  if (!key && old.config.endpoint && new URL(old.config.endpoint).origin === new URL(config.endpoint).origin && old.config.auth === config.auth) key = old.key;
  if (!key && config.auth !== 'none') throw new Error('请填写 API Key；切换 API 域名时不会沿用旧密钥。');
  return key;
}
async function runTranslation(message, config, key) {
  if (typeof message.requestId !== 'string' || message.requestId.length > 100 || requests.has(message.requestId)) throw new Error('请求编号无效。');
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 12000) throw new Error('单段文本为空或过长。');
  if (requests.size >= 2) throw new Error('已有翻译正在进行，请稍后重试。');
  const req = makeRequest(config, key, message.text, message.direction, message.format || 'text');
  if (!(await chrome.permissions.contains({origins: [permissionOrigin(req.url)]}))) throw new Error('API 访问权限已被移除，请在设置中重新授权。');
  const controller = new AbortController();
  requests.set(message.requestId, controller);
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(req.url, {...req.options, signal: controller.signal});
    if (!response.ok) {
      // Do not echo provider bodies: they may contain the key or source text.
      const hints = {400: '请求参数不兼容，请检查协议和 Token 字段。', 401: 'API Key 无效或已过期。', 403: '服务拒绝访问，请检查账户或模型权限。', 404: '接口路径或模型不存在。', 429: '频率或额度受限，请稍后手动重试。'};
      throw new Error(`API 返回 ${response.status}。${hints[response.status] || '服务暂不可用，请稍后重试。'}`);
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('接口未返回 JSON。请填写文本生成 API，而非网页或流式接口。'); }
    return {text: parseResponse(config.protocol, data)};
  } finally {
    clearTimeout(timer); requests.delete(message.requestId);
  }
}
async function dispatch(message) {
  if (message.type === 'GET_PUBLIC_CONFIG') {
    await preferenceWrites;
    const {config, key} = await getSettings();
    return {configured: !!config.endpoint && (config.auth === 'none' || !!key), autoTranslate: config.autoTranslate, enterTranslateSend: config.enterTranslateSend, translateTitles: config.translateTitles, model: config.model};
  }
  if (message.type === 'SET_AUTO'||message.type==='SET_ENTER_SEND'||message.type==='SET_TITLES') {
    const field=message.type==='SET_AUTO'?'autoTranslate':message.type==='SET_TITLES'?'translateTitles':'enterTranslateSend',enabled=!!message.enabled;
    const write=preferenceWrites.then(async()=>{const {config}=await getSettings();config[field]=enabled;await chrome.storage.local.set({config});return {[field]:enabled};});
    preferenceWrites=write.catch(()=>{});return write;
  }
  if (message.type === 'OPEN_SETTINGS') {
    await chrome.runtime.openOptionsPage();
    return {};
  }
  if (message.type === 'GET_CONFIG') {
    await preferenceWrites;
    const {config, key} = await getSettings();
    return {config, hasKey: !!key};
  }
  if (message.type === 'SAVE_CONFIG') {
    const config = validateConfig(message.config);
    if (!(await chrome.permissions.contains({origins: [permissionOrigin(config.endpoint)]}))) throw new Error('请先授权访问你填写的 API 域名。');
    const key = await formKey(config, message.apiKey);
    if (requests.size) throw new Error('请等待当前翻译结束，或先取消翻译再修改设置。');
    if (config.rememberKey) {
      await chrome.storage.local.set({config, savedKey: key});
      await chrome.storage.session.remove('sessionKey');
    } else {
      await chrome.storage.session.set({sessionKey: key});
      await chrome.storage.local.set({config});
      await chrome.storage.local.remove('savedKey');
    }
    return {config, hasKey: !!key};
  }
  if (message.type === 'CLEAR_KEY') {
    for (const r of requests.values()) r.abort();
    await trustedStorage;
    await chrome.storage.local.remove('savedKey');
    await chrome.storage.session.remove('sessionKey');
    return {};
  }
  if (message.type === 'CANCEL') {
    requests.get(message.requestId)?.abort();
    return {};
  }
  if (message.type === 'TEST_CONNECTION') {
    const config = validateConfig(message.config);
    const key = await formKey(config, message.apiKey);
    // A test uses the current form, without changing saved settings or keys.
    return runTranslation({requestId: message.requestId, text: 'Hello.', direction: 'zh'}, config, key);
  }
  if (message.type === 'TRANSLATE_CHUNK' || message.type === 'TRANSLATE_NODES') {
    const {config, key} = await getSettings();
    return runTranslation({...message,format:message.type==='TRANSLATE_NODES'?'nodes':'text'}, config, key);
  }
  throw new Error('未知操作。');
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const contentAllowed = ['GET_PUBLIC_CONFIG', 'SET_AUTO', 'SET_ENTER_SEND', 'SET_TITLES', 'TRANSLATE_CHUNK', 'TRANSLATE_NODES', 'CANCEL', 'OPEN_SETTINGS'];
  if (!trustedPage(sender) && !(claudeContent(sender) && contentAllowed.includes(message.type))) {
    sendResponse({ok: false, error: '此操作仅允许插件自己的界面调用。'}); return false;
  }
  dispatch(message).then(data => sendResponse({ok: true, ...data})).catch(error => sendResponse({ok: false, error: publicError(error)}));
  return true;
});
