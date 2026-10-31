export const PASSKEY_LOGIN_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>登录课程笔记</title>
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:light-dark(#f7f7f5,#181818);color:light-dark(#252525,#eee)}
main{width:min(420px,calc(100% - 36px));padding:38px 32px;background:light-dark(#fff,#222);border:1px solid light-dark(#e4e4e1,#444);border-radius:10px}
h1{margin:0 0 10px;font-size:24px;font-weight:650;letter-spacing:-.02em}
p{line-height:1.8;color:light-dark(#666,#bbb);font-size:14px;margin:0 0 23px}
button{width:100%;border:0;border-radius:6px;padding:13px 17px;background:light-dark(#252525,#eee);color:light-dark(#fff,#111);cursor:pointer;font-size:15px}
button:disabled{opacity:.55;cursor:wait}
details{border-top:1px solid light-dark(#eee,#444);margin-top:28px;padding-top:21px}
summary{font-size:14px;cursor:pointer;color:light-dark(#444,#bbb)}
label{display:block;font-size:13px;margin:19px 0 6px}
input{display:block;width:100%;font:inherit;padding:11px;border:1px solid light-dark(#ccc,#666);border-radius:5px;margin-bottom:13px;background:transparent;color:inherit}
#message{min-height:26px;line-height:1.65;margin-top:14px;font-size:13px;color:light-dark(#a13a26,#e59d87)}
small{display:block;margin-top:12px;color:light-dark(#777,#aaa);line-height:1.7}
</style></head><body>
<main>
<h1>课程笔记</h1>
<p>使用本设备的通行密钥（指纹、面容或设备密码）登录。</p>
<button id="login">使用通行密钥登录</button>
<div id="message" role="status" aria-live="polite"></div>
<details>
<summary>首次设置或添加通行密钥</summary>
<label for="code">一次性登记码</label>
<input id="code" type="password" autocomplete="off" spellcheck="false" placeholder="从服务器安全终端获取">
<button id="register">登记此设备的通行密钥</button>
<small>登记码由课程服务器临时签发，有效期 20 分钟。登记后即可直接登录本站，无须经过主站。</small>
</details>
</main>
<script>
(() => {
  const byId = id => document.getElementById(id);
  const message = text => { byId('message').textContent = text; };
  const fromB64 = input => {
    const raw = atob(String(input).replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4 - String(input).length % 4) % 4));
    return Uint8Array.from(raw, ch => ch.charCodeAt(0));
  };
  const toB64 = input => {
    const bytes = new Uint8Array(input);
    let raw = '';
    for (const b of bytes) raw += String.fromCharCode(b);
    return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  };
  const call = async (name, data) => {
    const response = await fetch('/_auth/passkey/' + name, {
      method:'POST', headers:{'content-type':'application/json'},
      credentials:'same-origin', body:JSON.stringify(data)
    });
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || '认证失败');
    return json;
  };
  const destination = () => {
    const next = new URLSearchParams(location.search).get('next') || '/admin';
    return next.startsWith('/') && !next.startsWith('//') && !/[\\]/.test(next) ? next : '/admin';
  };
  const finish = () => location.assign(destination());
  async function login() {
    const {flowId,options} = await call('login/options',{});
    const request = {
      ...options,
      challenge:fromB64(options.challenge),
      allowCredentials:(options.allowCredentials || []).map(c => ({...c,id:fromB64(c.id)}))
    };
    const cred = await navigator.credentials.get({publicKey:request});
    if (!cred) throw new Error('尚未选择通行密钥');
    const credential = {
      id:cred.id, rawId:toB64(cred.rawId), type:cred.type,
      response:{
        clientDataJSON:toB64(cred.response.clientDataJSON),
        authenticatorData:toB64(cred.response.authenticatorData),
        signature:toB64(cred.response.signature),
        userHandle:cred.response.userHandle ? toB64(cred.response.userHandle) : undefined
      },
      clientExtensionResults:cred.getClientExtensionResults(),
      authenticatorAttachment:cred.authenticatorAttachment || undefined
    };
    await call('login/verify',{flowId,credential});
    finish();
  }
  async function register() {
    const code = byId('code').value.trim();
    if (!code) throw new Error('请输入一次性登记码');
    const {flowId,options} = await call('register/options',{code});
    const request = {
      ...options, challenge:fromB64(options.challenge),
      user:{...options.user,id:fromB64(options.user.id)},
      excludeCredentials:(options.excludeCredentials || []).map(c => ({...c,id:fromB64(c.id)}))
    };
    const cred = await navigator.credentials.create({publicKey:request});
    if (!cred) throw new Error('通行密钥登记取消');
    const credential = {
      id:cred.id, rawId:toB64(cred.rawId), type:cred.type,
      response:{
        clientDataJSON:toB64(cred.response.clientDataJSON),
        attestationObject:toB64(cred.response.attestationObject),
        transports:cred.response.getTransports?.() || [],
        publicKey:cred.response.getPublicKey?.() ? toB64(cred.response.getPublicKey()) : undefined,
        publicKeyAlgorithm:cred.response.getPublicKeyAlgorithm?.()
      },
      clientExtensionResults:cred.getClientExtensionResults(),
      authenticatorAttachment:cred.authenticatorAttachment || undefined
    };
    await call('register/verify',{flowId,code,credential});
    finish();
  }
  async function action(button, fn) {
    button.disabled=true;
    message('正在等待设备验证…');
    try {
      if (!window.PublicKeyCredential) throw new Error('当前浏览器不支持通行密钥');
      await fn();
    } catch(err) {
      message(err?.name === 'NotAllowedError' ? '设备验证已取消，请重试。' : String(err?.message || '验证失败'));
    } finally { button.disabled=false; }
  }
  byId('login').addEventListener('click',()=>action(byId('login'),login));
  byId('register').addEventListener('click',()=>action(byId('register'),register));
})();
</script></body></html>`
