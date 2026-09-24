# 拼好模通用交付链路验证（2026-09-23）

生产规则面向通用交付：DeepSeek V4.1 Flash 编排，MiniMax M3 设计，GLM-5.3 标准版实现与修复，Kimi K2.8 负责代码及网页截图验收，GLM-5.3 Flash 保留静态视觉分析。Kimi K2.7 不参与本 preset。生产代码和配置没有“鹈鹕骑车”专用判定；该题目只用于真实测试。

最终自然语言输入：`创建一个单html，内容是SVG 绘制一个鹈鹕骑自行车的2D动画。`

`DSH_LIVE=1 DSH_LIVE_SCENARIO=single-html node tool-delivery-controller/tests/live-e2e.mjs` **退出码 0**，报告位于临时运行目录 `pinhaomo-live-MjwCZ9/report.json`。DeepSeek 实际调用 `delivery_start`，MiniMax 设计报告被接受，GLM 写入 `index.html`，Kimi 双视口网页审查与独立代码验收通过。控制器状态 `passed`，单 HTML 检查和网页截图检查均 `passed`，最终快照 `8dc794c50c72b21c658fab41b072f848d12a3a27ebdabb54caba1fe52b0e751a`，同步回执 `verified: true`。完整的模型角色、检查与状态摘要见 [live-attempts.json](./live-attempts.json)。

最终交付 HTML 为 [final-index.html](./final-index.html)。在独立 Chrome 动效烟测中，页面有 7 个活动动画、间隔帧不同、无脚本异常；隔离浏览器在 1280×800 和 390×844 两个视口均截图成功、帧间变化为真且无资源或运行异常。截图为 [桌面](./final-preview-1280x800.png) 和 [移动](./final-preview-390x844.png)。

此前真实运行发现并修复了通用问题：GLM 的不受支持的关闭思考参数会产生 HTTP 400；低推理参数经真实接口验证后使 GLM 能及时写入；MiniMax 方案字符串曾在交接时丢失；Kimi 原配置读码后超时，低推理参数和 300 秒上限经真实接口与端到端验证；只读验收提示曾暴露不可访问的源项目路径；HTML 中游离 `</style>` 可绕过旧结构检查，现由程序校验配对；静态网页截图无法显示动画，现每视口采集两帧并记录 CSS/SMIL 动画数和帧差。Kimi 的 `passed` 必须伴随实际成功的 `bash` 检查，控制器拒绝只读后口头通过。以上均是通用执行逻辑或参数配置，不依赖测试题目。

回归：170/170 单元测试、17/17 DSH 适配与参数测试、4/4 preset 端到端夹具测试、1/1 真实隔离浏览器集成测试通过。`git diff --check` 通过。双帧证据证明短时可见运动；长周期动画细节仍由代码验收和可复现实机检查判断。
