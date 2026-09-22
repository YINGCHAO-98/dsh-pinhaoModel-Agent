import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const models = ['deepseek-v4-1-flash', 'kimi-k2-8-preview', 'glm-5-3-flash', 'doubao-seed-2-0-lite-260215', 'minimax-m3', 'kimi-k2.7-code'];
export async function prepare(workspace, require) {
  await mkdir(resolve(workspace, 'brief'), { recursive: true });
  await mkdir(resolve(workspace, 'src'), { recursive: true });
  await mkdir(resolve(workspace, 'tests'), { recursive: true });
  await writeFile(resolve(workspace, 'brief/product.md'), '# 产品说明 v1\n青芽早餐：面向上班族的预约自取早餐。谷物、鸡蛋、时蔬组合；每日限量制作。旧版试营业价 32 元，不应继续使用。禁止声称减肥、治病或零过敏原。\n');
  await writeFile(resolve(workspace, 'brief/launch.md'), '# 当前上线规则 v2（优先于旧文档）\n正式名称：青芽·晨间盒。正式售价 38 元/份；工作日 07:00–09:30 自取。预约截止为当天 08:00。不提供配送。页面应明确说明售完即止。不收集个人信息，预约按钮仅跳转页面内说明区。\n');
  await writeFile(resolve(workspace, 'brief/audience.md'), '# 用户访谈摘要\n三位受访通勤者希望：出门前确认早餐、价格透明、到店方便取走。有人误以为可以送到办公室；页面应消除误解。偏好安静、自然、有留白的设计，不喜欢夸张承诺。\n');
  await writeFile(resolve(workspace, 'brief/story.srt'), '1\n00:00:00,000 --> 00:00:04,000\n早上的时间，留给从容。\n\n2\n00:00:04,000 --> 00:00:09,000\n青芽·晨间盒，38元一份。\n\n3\n00:00:09,000 --> 00:00:14,000\n工作日07:00至09:30，到店自取。\n\n4\n00:00:14,000 --> 00:00:20,000\n08:00前预约，售完即止。\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#f6f2e8"/><rect x="48" y="40" width="864" height="520" rx="28" fill="#e3eddf"/><circle cx="742" cy="210" r="106" fill="#bfd3b4"/><path d="M700 260 Q685 130 810 135 Q813 245 700 260" fill="#31634a"/><text x="100" y="175" font-family="Arial" font-size="28" fill="#31634a">MORNING MADE SIMPLE</text><text x="100" y="255" font-family="Arial" font-weight="bold" font-size="56" fill="#193b2b">QINGYA</text><text x="100" y="320" font-family="Arial" font-size="28" fill="#31634a">Fresh start. Slow morning.</text><rect x="100" y="385" width="235" height="68" rx="34" fill="#31634a"/><text x="133" y="429" font-family="Arial" font-size="26" fill="white">RESERVE NOW</text><rect x="700" y="430" width="152" height="48" rx="9" fill="#fff"/><text x="716" y="462" font-family="Arial" font-size="24" fill="#193b2b">MINT-42</text></svg>`;
  await require('sharp')(Buffer.from(svg)).png().toFile(resolve(workspace, 'brief/reference.png'));
  await writeFile(resolve(workspace, 'src/index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>待实现</title></head><body>待实现</body></html>\n');
  await writeFile(resolve(workspace, 'tests/site.test.cjs'), `const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const html=fs.readFileSync(require('node:path').join(__dirname,'../src/index.html'),'utf8');
const text=html.replace(/<[^>]*>/g,' ');
test('brand and hero',()=>{assert.match(html,/<h1[\\s>]/i);assert.match(text,/青芽/);assert.match(text,/晨间盒/)});
test('current price, not obsolete price',()=>{assert.match(text,/38/);assert.doesNotMatch(text,/32\\s*(?:元|RMB)/i)});
test('pickup window',()=>{assert.match(text,/07:00/);assert.match(text,/09:30/);assert.match(text,/08:00/)});
test('transparent fulfillment',()=>{assert.match(text,/自取/);assert.match(text,/售完即止/)});
test('working in-page CTA',()=>{assert.match(html,/href=["']#reserve["']/);assert.match(html,/id=["']reserve["']/);assert.match(text,/预约/)});
test('responsive metadata',()=>assert.match(html,/name=["']viewport["']/i));
test('semantic page body',()=>assert.match(html,/<main[\\s>]/i));
test('self-contained page',()=>{assert.doesNotMatch(html,/<script[^>]+src=["']https?:/i);assert.doesNotMatch(html,/<link[^>]+href=["']https?:/i)});
`);
}

export const objective = `请交付一个可本地打开的“青芽·晨间盒”中文单页 src/index.html，内联 CSS、无外部依赖，完整表达正式价格、自取时段、预约截止、售完即止与预约说明，适配手机；预约 CTA 用 href="#reserve" 跳转到 id="reserve" 的说明区。不要收集个人信息。
这次需要实际完成四项专业产物并串联到代码交付。请先用 multimodel_run 执行下列 DAG（保留节点 ID 和指定工具）：
1. research：task_kimi_research，无依赖。交叉读取 brief/product.md、brief/launch.md、brief/audience.md，识别版本冲突并提炼准确事实、受众诉求与禁用承诺。交付可供文案使用的事实简报，不写代码。
2. vision：task_glm_vision，无依赖。必须用 read_image 查看 brief/reference.png，提炼布局、配色、气质，并准确识别右下角白色徽标内的代码；图像没有提供给其他节点，返回完整视觉规范和徽标代码。
3. media：task_doubao_media，无依赖。只依据 brief/story.srt 的字幕文本分析20秒节奏、信息分布、预约信息，不需要也不应声称听过音频或看过原视频。交付可复用的时段信息与脚本建议。
4. creative：task_minimax_creative，dependsOn 必须包含 research、vision、media。只在三者完成后，综合自动收到的依赖报告，输出完整中文主标题、副标题、三条卖点、预约 CTA、注意事项及20秒字幕脚本。保持上游正式价格和规则、视觉风格、徽标代码，不自行重做研究。完整产出放入 summary。
DAG 完成后将完整文案、视觉规范（包含徽标代码）和硬性约束传给 delivery_start，真实实现网页。页面显示参考图识别到的徽标代码，不需要使用原图文件。实现不能改 brief/、tests/ 或配置；已有测试必须运行，最终通过独立 Kimi 质量门禁。不要仅返回计划，也不要为每个模型做无用的可用性探测。根模型最后核对全部产物并回复实际结果。`;

export async function verify({ workspace, outcome, trace, agents }) {
  assert.equal(outcome.state, 'passed');
  const graphCalls = trace.filter(e => e.type === 'tool/call' && e.data.name === 'multimodel_run');
  assert.ok(graphCalls.length, 'Real root never dispatched the DAG');
  const graphCall = graphCalls[0];
  const graph = JSON.parse(graphCall.data.arguments);
  assert.deepEqual([...graph.nodes.find(n => n.id === 'creative').dependsOn].sort(), ['media', 'research', 'vision']);
  const resultEvent = trace.find(e => e.type === 'tool/result' && e.data.message.source.callId === graphCall.data.callId);
  assert.ok(resultEvent, 'DAG result missing');
  const toolResult = resultEvent.data.message.content[0];
  assert.equal(toolResult.isError, false);
  const results = JSON.parse(toolResult.content.find(b => b.type === 'text').text);
  for (const id of ['research', 'vision', 'media', 'creative']) assert.equal(results.find(r => r.node === id)?.status, 'passed', id);
  assert.match(results.find(r => r.node === 'vision').summary, /MINT-42/);
  assert.match(results.find(r => r.node === 'creative').summary, /MINT-42/);
  assert.match(results.find(r => r.node === 'creative').summary, /38/);
  const allAgents = [...agents.values()];
  for (const model of models) assert.ok(allAgents.some(a => a.model === model), `Model never ran: ${model}`);
  assert.ok(trace.some(e => e.type === 'tool/call' && e.data.name === 'read_image'), 'Image was not read');
  const index = await readFile(resolve(outcome.artifact, 'src/index.html'), 'utf8');
  assert.match(index, /MINT-42/); assert.match(index, /青芽/); assert.match(index, /38/);
  assert.equal(outcome.syncReceipt?.verified, true);
  assert.equal(await readFile(resolve(workspace, 'src/index.html'), 'utf8'), index);
  const originalTests = await readFile(resolve(workspace, 'tests/site.test.cjs'));
  assert.ok(originalTests.equals(await readFile(resolve(outcome.artifact, 'tests/site.test.cjs'))));
  // The scheduler passes complete upstream reports as context, after all upstream children dispose.
  const creativeAgent = allAgents.find(a => a.model === 'minimax-m3');
  const creativeInput = trace.filter(e => e.session === creativeAgent.id && e.type === 'user/message');
  const serialized = JSON.stringify(creativeInput);
  for (const report of results.filter(r => r.node !== 'creative')) assert.ok(serialized.includes(report.id), `Dependency ${report.node} was not delivered`);
  const upstream = allAgents.filter(a => ['kimi-k2-8-preview', 'glm-5-3-flash', 'doubao-seed-2-0-lite-260215'].includes(a.model));
  assert.ok(Math.max(...upstream.map(a => Date.parse(a.createdAt))) < Math.min(...upstream.map(a => Date.parse(a.disposedAt))), 'Independent nodes did not overlap');
  assert.ok(upstream.every(a => Date.parse(a.disposedAt) <= Date.parse(creativeAgent.createdAt)), 'Creative node started before dependencies completed');
  return { results, concurrencyVerified: 3, dependencyTransmissionVerified: true, imageBadgeVerified: true, testsUnchanged: true };
}
