# 本地验证记录

日期：2026-09-20。环境：macOS、Node.js v24.21.0；DSH 本机源码构建版本 0.1.5-rc.2。

| 检查 | 结果 |
| --- | --- |
| `npm test` | 12/12 通过：强制验证、自动修复、预算、路径保护、快照绑定、产物失效、取消、互斥和进程中断恢复 |
| `npm run test:sandbox` | 3/3 通过：真实 Seatbelt 文件隔离、验证超时、无测试报告的零退出码拒绝 |
| `DSH_SOURCE=… npm run test:dsh` | 2/2 通过：真实工具注册器拒绝全局/局部/后注册旁路；子 Agent 输出合同与释放 |
| `DSH_SOURCE=… npm run test:dsh-e2e` | 1/1 通过：真实 YAML/preset 加载 → 用户命令 → spawn 子 Agent → 结构化输出 → 真实隔离测试 → 自动修复 → passed |
| `npm run demo` | 首轮失败，修复 1 次，验证 2 次后 passed，生成 11 条任务事件和独立产物 |

共 18 项自动测试通过，另完成闭环演示。真实 DSH 端到端测试只替换 LLM 响应为确定性 fixture；未调用 DeepSeek/其他付费模型。测试没有安装用户 preset、重载正在运行的 DSH，或修改原始交付项目。

测试定位并修复了两项实际集成问题：macOS 动态加载器需要根目录自身只读访问；DSH standing preset 上的空 allowlist 会连同继承的状态工具一起隐藏，故根层采用单调执行 guard，Worker 独立使用空 allowlist。

未验证：Docker 后端、远端/多主机部署、真实模型凭证与模型输出质量。当前默认验收合同仅适用于小型 Node 项目，生产使用前需要维护者按项目调整。详细能力和边界见 README.md。
