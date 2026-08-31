import fs from 'node:fs';

const endpoint = process.argv[2] || 'http://127.0.0.1:9222/json';
const imagePath = process.argv[3];
if (!imagePath) throw new Error('Usage: node emulator-identify.mjs <endpoint> <image>');

const targets = await (await fetch(endpoint)).json();
const page = targets.find(target => target.type === 'page');
if (!page?.webSocketDebuggerUrl) throw new Error('No debuggable WebView page found');

const imageBase64 = fs.readFileSync(imagePath).toString('base64');
const expression = `(async()=>{
  const bytes=Uint8Array.from(atob(${JSON.stringify(imageBase64)}),c=>c.charCodeAt(0));
  const form=new FormData();
  form.append('image',new Blob([bytes],{type:'image/jpeg'}),'emulator-cat.jpg');
  form.append('model','bundled');
  const started=performance.now();
  const response=await fetch('/api/cat/identify',{method:'POST',body:form});
  const result=await response.json();
  return {
    ok:response.ok,
    status:response.status,
    elapsed_ms:Math.round(performance.now()-started),
    model_used:result.model_used,
    breed:result.identification?.breed,
    confidence:result.identification?.confidence,
    estimated_age:result.identification?.estimated_age,
    has_knowledge:Boolean(result.knowledge),
    detail:result.detail
  };
})()`;

const socket = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Image identification timed out')), 240_000);
  socket.addEventListener('open', () => socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  })));
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timeout);
    if (message.error || message.result?.exceptionDetails) {
      reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      return;
    }
    resolve(message.result?.result?.value);
  });
  socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed')));
});

socket.close();
console.log(JSON.stringify(result));
