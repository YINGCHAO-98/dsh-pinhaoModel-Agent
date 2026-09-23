# Read 路径恢复验证

问题场景：会话目录为多项目父目录，任务材料位于 `demo1-candidate/docs/BUSINESS_RULES.md`，模型根据项目文档请求了 `docs/BUSINESS\_RULES.md`。旧 Runtime 将 Markdown 的反斜杠当成文件名字符，并且不会从父目录定位唯一的嵌套项目文件，因此第一次 read 直接失败。

修复位于 `workspace.mjs` 的真实工具执行路径：

- 工具解析时只还原 Markdown 标点转义；
- read 的目标不存在时，在工作区内按完整相对路径后缀进行有界查找；
- 唯一候选自动映射；多个候选明确拒绝，避免跨项目猜错；
- 写入、编辑和 Shell 不启用模糊恢复；
- 查找跳过符号链接、`.git`、`node_modules` 与 `.delivery`，最多检查 5000 项。

验证覆盖纯路径还原、唯一嵌套候选、同名歧义拒绝，以及真实 Seatbelt 文件工具读取。对用户的实际目录只读探测确认 `docs/BUSINESS_RULES.md` 唯一映射为 `demo1-candidate/docs/BUSINESS_RULES.md`。
