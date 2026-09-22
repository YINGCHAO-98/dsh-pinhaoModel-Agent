import { safePath, validateContract, matches } from './files.mjs';

// Deployment-owned check code; the model supplies only one exact output path.
// Run in the normal verification sandbox, never execute the page's scripts.
function checkHtml(path) {
  const fs = require('node:fs');
  const { Script } = require('node:vm');
  const assert = require('node:assert/strict');
  const html = fs.readFileSync(path, 'utf8');
  assert.ok(/<!doctype\s+html\s*>/i.test(html), 'Missing HTML doctype');
  for (const tag of ['html', 'head', 'body']) {
    assert.ok(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*<\\/${tag}\\s*>`, 'i').test(html), `Missing ${tag} document element`);
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    assert.ok(!/\bsrc\s*=/i.test(match[1]), 'Single HTML must inline scripts');
    const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(match[1])?.[1]?.toLowerCase();
    if (!type || ['text/javascript', 'application/javascript'].includes(type)) new Script(match[2], { filename: path });
  }
  // Conservative check for the concrete SVG defect reproduced in a browser:
  // CSS transform keyframes replace an SVG transform attribute on that node.
  // Position a wrapper and animate its child instead. This is not a renderer.
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(m => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const transformAnimations = [];
  for (const match of css.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1, end = match.index + match[0].length;
    const start = end;
    for (; end < css.length && depth; end++) { if (css[end] === '{') depth++; else if (css[end] === '}') depth--; }
    if (/(?:^|[;{])\s*transform\s*:/i.test(css.slice(start, end))) transformAnimations.push(match[1]);
  }
  for (const svg of html.matchAll(/<svg\b[^>]*>([\s\S]*?)<\/svg\s*>/gi)) {
    for (const tag of svg[1].matchAll(/<[a-z][\w:-]*\s+([^>]+)>/gi)) {
      if (!/\btransform\s*=\s*["'][^"']+["']/i.test(tag[1])) continue;
      const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag[1])?.[1];
      const classes = /\bclass\s*=\s*["']([^"']+)["']/i.exec(tag[1])?.[1]?.split(/\s+/) ?? [];
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = rule[1].split(',').map(s => s.trim());
        if (!selectors.some(s => s === '#' + id || classes.some(c => s === '.' + c))) continue;
        const animation = /(?:^|;)\s*animation(?:-name)?\s*:\s*([^;]+)/i.exec(rule[2])?.[1];
        if (animation && transformAnimations.some(name => animation.split(/[^\w-]+/).includes(name)))
          assert.fail('SVG_TRANSFORM_ANIMATION_CONFLICT: ' + (id ?? classes.join('.')) + ' has positioning transform and CSS transform animation. Keep positioning on an outer group and animate a child.');
      }
    }
  }
  console.log('HTML document structure and inline classic JavaScript syntax passed; visual behavior requires independent review.');
}

export function singleHtmlContract(path, base) {
  safePath(path);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.html$/u.test(path))
    throw new Error('singleHtmlPath must name one root-level .html file');
  if (base.protectedPaths.some(rule => matches(path, rule))) throw new Error(`Protected path: ${path}`);
  // Keep deployment protection and repair limits, but do not inherit Node-only
  // test fixtures. The requested output is mandatory after implementation.
  return validateContract({
    version: 1, editablePaths: [path], protectedPaths: base.protectedPaths,
    requiredPaths: [], requiredOutputs: [path], maxRepairs: base.maxRepairs,
    checks: [{ id: 'single-html', argv: ['node', '-e', `(${checkHtml.toString()})(${JSON.stringify(path)})`], timeoutMs: 10000 }],
  });
}
