# 2026-09-21 运行时旧插件排障

用户再次报告 `Tool requires an active delivery Worker`。实际 Desktop 当前会话 10:14–10:17 的调用仍同时出现旧快照异常，当前维护目录已不存在这两个旧错误字符串。

宿主安装包 `dsh-agent-presets/lib/index.js` 的 `ensureStanding()` 只比较组合 YAML 的 mtime/size，已加入会话保留旧 generation；修改插件 .mjs 不足以重新加载其代码。因此仅验证磁盘源码或创建会话，不能证明当前进程已使用更新。

本次处置：确认会话空闲，通过 Desktop 的 Harness → 重启 Harness 完整重启后端。未修改权限、生产逻辑或 agent.cordis.yml。

验证证据：

- 本地真实 DSH 集成测试 3/3，通过根工具隐藏/拒绝、Worker 适配、模拟 Worker 单 HTML 产物真实沙箱验收及同步。
- 在原 Desktop 会话执行一次只读诊断，实际 `delivery_status({})` 成功返回 `[]`，不启动旧 HTML 任务。
- 10:19 新请求的上下文工具定义由 30 项变为 14 项。直接查看工具列表确认只有交付/能力/技能/todo/提问入口，不再包含 bash、write、glob、read、edit、grep、read_image 或 snapshot_explore。
- 新请求已包含 `delivery_resume`、`request_capability` 和 `delivery_start.singleHtmlPath`，确认运行中的会话已经切换到当前控制器。

本次完成的是运行时更新生效及工具分配故障处置；没有重跑原来的真实动画交付，不能据此声称 HTML 已生成。今后修改本地插件实现后，需要完整重启 Harness 并核验新的实际请求，而非仅凭文件保存或旧上下文面板确认生效。
