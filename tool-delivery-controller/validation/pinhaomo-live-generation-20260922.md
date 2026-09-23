# 拼好模自行生成：实际追踪与修复

用户明确要求拼好模自行生成，不接受 Codex 代写成品。Codex 曾在 /tmp/pelican-delivery 创建一个临时 HTML，但未复制到目标工作区，也未作为拼好模输入。

## 已发现的实际问题

- acf7a3df-fbff-40eb-b7b2-208049c82521：Kimi 生成了 HTML，single-html 检查 passed；独立审查 180 秒超时。delivery_resume 遇到 Duplicate capability request，根模型取消交付后从头生成，产物一直未同步。
- 修复 CapabilityControl：只对控制器自动审查的 timeout blocked 记录允许一次新尝试；成功后重用该尝试的完整报告。活动请求、人工能力请求、非超时失败不能借此重复派发。
- 修复控制器：审查超时原快照重试一次，不重新实现。预算耗尽终止，不无效 resume。审查适配器传入真实工具执行记录。
- 原会话实际重跑 9f89c996-cf5b-49b9-a190-8530ce703e06：Kimi read 成功，随后生成运行至 600 秒总时限仍未写入，状态 failed。
- 针对简单单 HTML，新增 deployment-owned singleHtmlWorker 路由，使用已接入的 doubao/deepseek-v4-1-flash（low、16384 tokens）；通用实现仍为 Kimi。尚未修改文件的超时可使用同一 DeepSeek 备用路由一次；不重放写入和 shell 操作。仍保留独立 Kimi 审查和同步保护。

## 验证与当前阻塞

126 项单元/控制器回归通过；9 项真实 DSH 工具入口集成通过（模拟模型、实际临时文件与沙箱）。已重启 Harness。16:03 在原会话提交新版路由的真实生成请求，但主模型立即 Connection error / TRANSPORT，尚未调用交付工具。

无凭据 HTTPS 诊断：经本机代理 CONNECT 后和 --noproxy 直接访问 ark.cn-beijing.volces.com，两次均在 TLS 握手失败（curl error 35 / SSL_ERROR_SYSCALL）。这只能确认当前连通性阻塞，不能确定本机、链路或服务端哪一处故障。未修改系统代理、凭据或服务地址。

尚未端到端验收新版真实模型交付；目标工作区未收到 Codex 代写文件。不能宣称 pelican-bicycle.html 已成功生成同步。
