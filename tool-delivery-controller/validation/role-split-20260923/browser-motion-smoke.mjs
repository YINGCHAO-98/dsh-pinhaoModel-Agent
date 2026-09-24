import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const executable = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const page = pathToFileURL(resolve(process.argv[2] ?? 'index.html')).href;
const profile = await mkdtemp(resolve(tmpdir(), 'web-motion-smoke-'));
const child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
  '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await pause(100); }
  }
  assert.ok(port, 'Browser DevTools port did not open');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page');
  assert.ok(target, 'Browser page target missing');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map(), listeners = new Map(), exceptions = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message); }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    listeners.get(message.method)?.(message.params);
  });
  const send = (method, params = {}) => new Promise((resolveCall, reject) => {
    const callId = ++id;
    pending.set(callId, response => response.error ? reject(new Error(response.error.message)) : resolveCall(response.result));
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  const loaded = new Promise(resolveLoad => listeners.set('Page.loadEventFired', resolveLoad));
  await send('Page.navigate', { url: page }); await loaded;
  const state = await send('Runtime.evaluate', { expression: `({svg:!!document.querySelector('svg'), animations:document.getAnimations().length,
    smilAnimations:document.querySelectorAll('animate,animateTransform,animateMotion,set').length,
    size:{width:innerWidth,height:innerHeight}, overflow:document.documentElement.scrollWidth>innerWidth})`, returnByValue: true });
  assert.equal(state.exceptionDetails, undefined);
  assert.equal(state.result.value.svg, true);
  assert.ok(state.result.value.animations + state.result.value.smilAnimations > 0, 'No browser animations');
  const first = Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  await pause(380);
  const second = Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  assert.notDeepEqual(createHash('sha256').update(first).digest(), createHash('sha256').update(second).digest(), 'Animation frames did not change');
  assert.deepEqual(exceptions, []);
  if (process.argv[3]) await writeFile(resolve(process.argv[3]), second);
  console.log(JSON.stringify({ status: 'passed', page, ...state.result.value, movingFrames: true, runtimeExceptions: exceptions }));
} finally {
  socket?.close();
  child.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
