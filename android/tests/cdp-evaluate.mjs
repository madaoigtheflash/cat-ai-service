const endpoint = process.argv[2] || 'http://127.0.0.1:9222/json';
const encodedExpression = process.argv[3];

if (!encodedExpression) {
  throw new Error('Usage: node cdp-evaluate.mjs <endpoint> <base64-expression>');
}

const targets = await (await fetch(endpoint)).json();
const page = targets.find(target => target.type === 'page');
if (!page?.webSocketDebuggerUrl) throw new Error('No debuggable WebView page found');

const expression = Buffer.from(encodedExpression, 'base64').toString('utf8');
const socket = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('CDP evaluation timed out')), 120_000);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
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
