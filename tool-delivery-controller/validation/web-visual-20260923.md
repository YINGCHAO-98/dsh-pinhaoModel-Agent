# 网页截图验收接入与模型实测（2026-09-23）

## 接入结果
- 当前路由为 GLM-5.3 实现与修复、Kimi K2.8 独立代码及网页验收；Kimi K2.7 已从本 preset 的交付路由移除。
- 当前快照包含 HTML/JSX/TSX/Vue/Svelte 时，已验证交付必须完成截图验收；纯框架源码无构建 HTML 会 blocked。
- 真实浏览器提供 1280×800 与 390×844 截图，以持久 attachment + SHA256 传给视觉模型；视觉会话不读取实现源码或实现模型总结。
- 同步与最终通过的持久状态机均验证同一快照下的 web-visual 证据。失败或缺失不能通过；修复快照必须重新验收。
- Browser 使用官方 Chrome Headless Shell 151.0.7922.34（官方下载）+ macOS Seatbelt，全进程禁网、文件权限限制、匿名 CDP 管道，无调试端口。普通 Chrome 的单实例启动不兼容此隔离，未放宽网络绑定权限。

## 验证证据
- 170 项单元/状态机测试通过，包括缺失截图、错误快照、视觉失败不能通过、外部/未知资源拒绝。
- `tests/web-browser.integration.mjs` 实际浏览器测试通过；截图及结果在 `web-browser-20260923/`。覆盖桌面和移动尺寸、外部资源拒绝、JS 异常报告。
- `kimi-vision-probe.json`：实际 `kimi-k2-8-preview` 图片请求成功，识别鹈鹕、自行车、页面标题和暂停按钮；有局部视觉误判。
- `web-visual-live.json`：真实 DSH subagent + provider + browser 链路；两个合成页面、两种模型、每页两种尺寸。正常页面均 passed，不可见付款按钮页面均 failed。Kimi 两次约 13.5/20.8 秒，GLM 两次约 43.6/57.1 秒（仅本次端到端观察，不能推广为性能排名）。小样本不能证明模型全面优劣；解释中存在误推断，不能当作绝对正确性保证。

## 范围与生效状态
- 静态/已构建 HTML、首屏截图；不支持启动任意开发服务器或访问远程 API/CDN。截图不证明点击、动画或业务流程正确。用户明确不验证的受限交付仍标记 unverified。
- 宿主 settings.yaml 已添加 GLM-5.3 并为 K2.8 配置 input: [text,image]；浏览器安装在 ~/.cache/pinhaomo-web/。
- 检查 Desktop 时另有进行中的任务，未重启 Harness；磁盘代码和隔离测试均完成，正在运行的旧会话需任务结束后重启 Harness 才能确认加载新实现。
