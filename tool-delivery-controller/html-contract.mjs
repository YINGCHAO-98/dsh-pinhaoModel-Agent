import { safePath, validateContract, matches } from './files.mjs';

// Flag gross structural loss when updating an existing single-file page. This
// is deliberately a conservative truncation guard, not a semantic validator:
// a large rewrite can still be valid, but it must not silently pass as a small
// repair after most drawable nodes and named parts disappear together.
export function htmlStructureRegression(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  const tags = source => [...source.matchAll(/<(?:svg|g|path|rect|circle|ellipse|line|polyline|polygon|text|use|button|div|span)\b/gi)].length;
  const classes = source => new Set([...source.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)]
    .flatMap(match => match[1].split(/\s+/).filter(Boolean)));
  const priorTags = tags(before), nextTags = tags(after);
  const priorClasses = classes(before), nextClasses = classes(after);
  if (priorTags < 60 || priorClasses.size < 8) return null;
  const retained = [...priorClasses].filter(name => nextClasses.has(name));
  if (nextTags >= priorTags * 0.6 || retained.length >= priorClasses.size * 0.6) return null;
  return { priorTags, nextTags, priorClasses: priorClasses.size, retainedClasses: retained.length,
    missingClasses: [...priorClasses].filter(name => !nextClasses.has(name)).slice(0, 20) };
}

// Deployment-owned check code; the model supplies only one exact output path.
// Run in the normal verification sandbox, never execute the page's scripts.
function checkHtml(path) {
  const fs = require('node:fs');
  const { Script } = require('node:vm');
  const assert = require('node:assert/strict');
  const html = fs.readFileSync(path, 'utf8');
  const count = pattern => [...html.matchAll(pattern)].length;
  assert.equal(count(/<!doctype\s+html\s*>/gi), 1, 'Exactly one HTML doctype is required');
  assert.match(html, /^\s*<!doctype\s+html\s*>/i, 'HTML doctype must come first');
  for (const tag of ['html', 'head', 'body']) {
    assert.equal(count(new RegExp(`<${tag}\\b[^>]*>`, 'gi')), 1, `Exactly one opening ${tag} tag is required`);
    assert.equal(count(new RegExp(`</${tag}\\s*>`, 'gi')), 1, `Exactly one closing ${tag} tag is required`);
  }
  const open = tag => new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(html).index;
  const close = tag => new RegExp(`</${tag}\\s*>`, 'i').exec(html).index;
  assert.ok(open('html') < open('head') && open('head') < close('head')
    && close('head') < open('body') && open('body') < close('body')
    && close('body') < close('html'), 'HTML document sections are out of order');
  assert.match(html.slice(close('html')), /^<\/html\s*>\s*$/i, 'Content follows the closing HTML tag');
  assert.equal(count(/<svg\b/gi), count(/<\/svg\s*>/gi), 'SVG opening and closing tags must balance');
  const styleOpens = [...html.matchAll(/<style\b[^>]*>/gi)].map(match => match.index);
  const styleCloses = [...html.matchAll(/<\/style\s*>/gi)].map(match => match.index);
  assert.equal(styleOpens.length, styleCloses.length, 'Style opening and closing tags must balance');
  for (let i = 0; i < styleOpens.length; i++) {
    assert.ok(styleOpens[i] < styleCloses[i] && (i === 0 || styleCloses[i - 1] < styleOpens[i]),
      'Style tags must occur in opening/closing pairs');
  }
  assert.ok(!/<(?:script|link|img|source|video|audio|iframe|image|use)\b[^>]*(?:src|href|xlink:href)\s*=\s*["']?https?:\/\//i.test(html)
    && !/@import\b|url\(\s*["']?https?:\/\//i.test(html), 'External resources are not allowed in a self-contained HTML file');
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
