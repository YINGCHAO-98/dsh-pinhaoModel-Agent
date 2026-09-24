import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const page = pathToFileURL(resolve(process.argv[2] ?? 'pelican-bicycle.html')).href;
const profile = await mkdtemp(resolve(tmpdir(), 'pelican-browser-smoke-'));
const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
  '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let socket;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await wait(100); }
  }
  assert.ok(port, 'Chrome DevTools port did not open');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  assert.ok(target, 'Chrome page target missing');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0, exceptions = [];
  const pending = new Map(), listeners = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); pending.delete(message.id); task?.(message); }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    listeners.get(message.method)?.(message.params);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, response => response.error ? reject(new Error(response.error.message)) : resolve(response.result));
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const loaded = new Promise(resolve => listeners.set('Page.loadEventFired', resolve));
  await send('Page.navigate', { url: page });
  await loaded;
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const initial = await evaluate(`({svg:!!document.querySelector('svg#scene'),bird:!!document.querySelector('.pelicanBob'),
    wheels:document.querySelectorAll('.wheelSpin').length, button:!!document.getElementById('playBtn'),
    running:getComputedStyle(document.querySelector('.wheelSpin')).animationPlayState})`);
  assert.equal(initial.svg, true);
  assert.equal(initial.bird, true);
  assert.equal(initial.wheels, 2);
  assert.equal(initial.button, true);
  assert.equal(initial.running, 'running');
  const layers = await evaluate(`([...document.querySelectorAll('.hillScroll,.cloudDrift')].map(g => ({
    kind:g.classList.contains('cloudDrift')?'cloud':'hill',
    offsets:[...g.querySelectorAll('use')].map(u => Number(u.getAttribute('x')))
  })))`);
  assert.equal(layers.length, 4);
  for (const layer of layers) assert.deepEqual(layer.offsets,
    layer.kind === 'cloud' ? [-320, 320, 640, 960] : [-400, 400, 800, 1200]);
  const frameA = (await send('Page.captureScreenshot', { format: 'png' })).data;
  await wait(300);
  const frameB = (await send('Page.captureScreenshot', { format: 'png' })).data;
  assert.notEqual(frameA, frameB, 'Two animation frames should differ');
  const paused = await evaluate(`(document.getElementById('playBtn').click(),
    getComputedStyle(document.querySelector('.wheelSpin')).animationPlayState)`);
  assert.equal(paused, 'paused');
  const resumed = await evaluate(`(document.getElementById('playBtn').click(),
    getComputedStyle(document.querySelector('.wheelSpin')).animationPlayState)`);
  assert.equal(resumed, 'running');
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ status: 'passed', page, ...initial, periodicLayers: layers.length, movingFrames: true,
    pauseResume: true, runtimeExceptions: exceptions }));
} finally {
  socket?.close();
  child.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
