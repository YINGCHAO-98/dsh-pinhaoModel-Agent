import { spawn } from 'node:child_process';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import { seatbeltProfile } from './runner.mjs';
import { hash } from './files.mjs';

export function webEntries(files) {
  return Object.keys(files).filter(path => /\.html?$/iu.test(path) && !/(^|\/)(node_modules|validation|tests?|fixtures?|coverage)\//u.test(path)).sort();
}
export function needsWebReview(files) {
  return webEntries(files).length > 0 || Object.keys(files).some(path => /\.(jsx|tsx|vue|svelte)$/u.test(path));
}
export function snapshotResponse(url, files) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://snapshot.invalid') throw new Error('WEB_EXTERNAL_REQUEST_BLOCKED');
  const path = decodeURIComponent(parsed.pathname.slice(1));
  if (!Object.hasOwn(files, path)) throw new Error('WEB_RESOURCE_MISSING: ' + path);
  return { responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: {
    '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  }[extname(path)] ?? 'application/octet-stream' }], body: files[path] };
}

// Browser receives only this immutable snapshot. OS policy denies all networking
// and host user-file reads; CDP uses anonymous pipes, never an open debug port.
export async function captureWeb(files, { signal, executable } = {}) {
  if (typeof executable !== 'string' || !executable.startsWith('/')) throw new Error('WEB_BROWSER_UNAVAILABLE: configure an absolute Headless Shell executable');
  const entries = webEntries(files);
  if (!entries.length || entries.length > 8) throw new Error('WEB_PREVIEW_REQUIRED: expected 1..8 built HTML entries; build framework output first');
  if (process.platform !== 'darwin') throw new Error('WEB_BROWSER_UNAVAILABLE: this adapter requires macOS seatbelt');
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
  signal.throwIfAborted();
  const scratch = await realpath(await mkdtemp('/private/tmp/ph-web-'));
  let child, pending = new Map(), next = 0, buffer = '', sessionId, abort;
  const stop = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  const failures = [], screenshots = [], motion = [];
  try {
    const profile = seatbeltProfile(scratch, scratch, executable, { extraReadRoots: ['/Library/Fonts', '/Library/Preferences'] });
    child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, '--no-sandbox', '--headless=new', '--disable-gpu', '--no-first-run',
      '--disable-background-networking', '--disable-extensions', '--remote-debugging-pipe', `--user-data-dir=${scratch}`, 'about:blank'],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: { HOME: scratch, TMPDIR: scratch, PATH: '/usr/bin:/bin' } });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    const rejectAll = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
    abort = () => { stop(); rejectAll(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', rejectAll);
    child.on('exit', () => rejectAll(new Error('WEB_BROWSER_EXITED: ' + stderr)));
    child.stdio[3].on('error', rejectAll);
    const send = (method, params = {}, session = sessionId) => new Promise((resolveCall, reject) => {
      if (signal.aborted || (child.exitCode !== null || child.signalCode !== null)) return reject(signal.reason ?? new Error('WEB_BROWSER_EXITED'));
      const id = ++next; pending.set(id, { resolve: resolveCall, reject });
      child.stdio[3].write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + '\0');
    });
    child.stdio[4].on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\0')) {
        const offset = buffer.indexOf('\0'), message = JSON.parse(buffer.slice(0, offset)); buffer = buffer.slice(offset + 1);
        if (message.id) { const p = pending.get(message.id); pending.delete(message.id); if (p) message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
        if (message.method === 'Page.loadEventFired') { pending.get('page-load')?.resolve(); pending.delete('page-load'); }
        if (message.method === 'Fetch.requestPaused') {
          let response;
          try { response = snapshotResponse(message.params.request.url, files); }
          catch (error) { failures.push(error.message); }
          send(response ? 'Fetch.fulfillRequest' : 'Fetch.failRequest', { requestId: message.params.requestId,
            ...(response ?? { errorReason: 'BlockedByClient' }) }, message.sessionId).catch(rejectAll);
        }
        if (message.method === 'Runtime.exceptionThrown') failures.push(message.params.exceptionDetails.text);
      }
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
    await send('Page.enable'); await send('Runtime.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    for (const entry of entries) for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
      const loaded = new Promise((resolve, reject) => pending.set('page-load', { resolve, reject }));
      loaded.catch(() => {});
      const navigation = await send('Page.navigate', { url: 'https://snapshot.invalid/' + entry.split('/').map(encodeURIComponent).join('/') });
      if (navigation.errorText) throw new Error(navigation.errorText);
      await loaded;
      await send('Runtime.evaluate', { expression: 'new Promise(r => { const done = () => document.fonts.ready.then(() => setTimeout(r, 300)); if(document.readyState === "complete") done(); else addEventListener("load",done,{once:true}); })', awaitPromise: true });
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      if (!data || Buffer.from(data, 'base64').subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('WEB_SCREENSHOT_INVALID');
      const firstHash = hash(Buffer.from(data, 'base64'));
      screenshots.push({ entry, viewport, data, sha256: firstHash });
      const animationState = await send('Runtime.evaluate', { expression: '({runningAnimations:document.getAnimations().filter(a => a.playState === "running").length,smilAnimations:document.querySelectorAll("animate,animateTransform,animateMotion,set").length})', returnByValue: true });
      if (animationState.exceptionDetails) throw new Error('WEB_ANIMATION_INSPECTION_FAILED');
      await send('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, 380))', awaitPromise: true });
      const later = (await send('Page.captureScreenshot', { format: 'png' })).data;
      if (!later || Buffer.from(later, 'base64').subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('WEB_SCREENSHOT_INVALID');
      const laterHash = hash(Buffer.from(later, 'base64'));
      motion.push({ entry, viewport, data: later, sha256: laterHash, ...animationState.result.value,
        framesDiffer: firstHash !== laterHash, intervalMs: 380 });
    }
    signal.removeEventListener('abort', abort);
    return { screenshots, motion, failures: [...new Set(failures)] };
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    if (child && child.exitCode === null && child.signalCode === null) { const exited = new Promise(r => child.once('exit', r)); stop(); await exited; }
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export function enforceVisualReport(report, visual) {
  if (!visual) return report;
  if (!visual.screenshots?.length) return { ...report, status: 'blocked', summary: 'WEB_SCREENSHOT_REQUIRED' };
  if (visual.failures.length) return { ...report, status: 'failed', summary: 'Browser execution failed: ' + visual.failures.join('; '), evidence: [...report.evidence, ...visual.failures] };
  return report;
}
