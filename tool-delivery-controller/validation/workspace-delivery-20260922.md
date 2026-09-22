# 通用工作区交付修复（2026-09-22）

## 根因及采用的行为

会话包 session-9d20163b-d052-4b08-b41e-3997f5aca2bc 的 cwd 是 standardDS，业务文件在 demo1-candidate。默认部署合同却固定 editablePaths=src/、requiredPaths=tests/，因此已发现的 demo1-candidate/src 路径仍被拒绝。模型另把测试命令当成 checkIds，加剧了重试。

参考安装包 standard preset 的原生文件工具与 dsh-fs-local 的 cwd 路径语义，按用户后续要求移除默认布局与测试命令。未采用基于 tests/src 的自动项目识别。

- delivery-contract.json：通用 workspace 合同，允许普通工作区相对文件，无必需目录、默认保护项目文件或固定 Node 检查。
- delivery_context：只读返回真实交付目录、合法范围与检查 ID。
- delivery_start：默认会话 cwd；显式 projectRoot 可选相对子目录，不接受绝对、穿越和符号链接目录。
- 已选择的目录贯穿快照、实现器、审查者、同步与状态输出。子模型访问宿主项目绝对路径仍映射至隔离副本。
- 空检查列表有明确 not_configured 标记；状态机仍核对全部已配置证据及独立审查证据。专项合同与单 HTML 产物要求继续有效。
- 明确任务范围、已有沙箱、隐藏/二进制限制、冲突保护和同步机制保留。未改变技能或 persona。

## 验证

- Node 单元/控制器回归：118/118 通过。
- DSH_SOURCE 指向 /Applications/DSH Desktop.app/Contents/Resources/app 的原生工具入口集成：8/8 通过，模拟模型，真实临时文件与 DSH 沙箱。
- 覆盖：无 src/tests 的空项目创建 notes.txt；父工作区 candidate/ 文件交付；显式 projectRoot 的最终写回；实现与审查目录传递；保护路径、绝对路径、穿越、符号链接拒绝；无配置检查不产生测试通过记录。
- 初次集成运行因外层沙箱不允许 sandbox_apply 而受阻，随后在获准的外层沙箱外执行全部通过。

## 生效限制

未重启用户的 DSH Harness，未执行真实模型交付，也未更改原会话业务文件。依当前运行时加载方式，需重启 Harness 载入更新后的插件代码。已有交付记录的不可变合同保持原样，新交付使用新默认合同。
