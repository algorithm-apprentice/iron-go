# Iron Go

Iron Go 是一款面向 **macOS** 的轻量 Go IDE。工作台参考 VS Code，桌面架构沿用 Iron C++ 的 Tauri 2 + Monaco 思路，Go 模块和工具链由 Go 自身管理。

## 快速开始

环境：macOS 15+、Node.js 24+、Rust stable、Xcode Command Line Tools、Go。`gopls` 可选，安装后启用语言服务。Go 1.25 可使用 `gopls@v0.20.0`；使用较新的 Go 工具链时也可安装 `gopls@latest`。

```sh
npm ci
go install golang.org/x/tools/gopls@v0.20.0
npm run tauri dev
```

用 **Open Folder** 打开 Go 模块或 `go.work` 工作区，或者在 `⇧⌘P` 命令面板选择 **New Go Module**。例如打开 `examples/orbit`，右上角会自动选中唯一的可执行目标 **orbit**。如果有多个目标，请先选一个再运行。**Run and Test** 侧栏默认构建或测试所有本地包，也可选当前包，或在 **Advanced** 手动填写路径。

从 Finder 启动时也会查找 Homebrew、Go 官方安装路径和 `~/go/bin` 等常见位置。在右下角的工具状态中可以重新检测。

## 当前功能

- 文件树、多标签、脏状态、撤销、保存冲突保护、文件名快速打开与已保存文件全文搜索。
- Monaco Go 高亮；`gofmt` 格式化当前缓冲区，不自动保存。
- Dark / Light 配色，可在 **Settings → Color Theme**（`⌘,`）切换并记住选择。
- `gopls` 补全、悬停文档、工作区内定义跳转及 Problems 面板。`_test.go` 文件中的测试函数旁可以点 **Run Test** 单独运行。
- `go build` / `go run` / `go test`，真实输出、退出状态和进程停止。仅在显式运行任务时执行项目代码，请只运行可信项目。
- 快捷键：`⌘O` 打开文件夹，`⌘P` 快速打开，`⇧⌘P` 命令面板，`⌘S` 保存，`⇧⌘F` 搜索，`⇧⌥F` 格式化，`⌘↵` 运行/停止，`⌘B` 侧栏，`⌘J` 底部面板。

首版没有 Delve 调试、交互式终端、自动文件监控或 Windows 支持。`npm run dev` 仅启动浏览器预览，不能执行本机 Go 工具，也不会写回导入的本地目录。

## 构建与测试

```sh
npm run tauri build -- --bundles app  # 本机 .app，未配置签名和公证
npx playwright install chromium      # 首次运行 UI 测试时安装
npm run test:feedback                # 单元 + 无头工作台 + 原生 macOS 验收
```

各层测试命令及失败产物见 [测试说明](docs/TESTING.md)。开发约定是先写设计和验收条件、再以失败测试驱动实现：见 [AGENTS.md](AGENTS.md)、[架构](docs/ARCHITECTURE.md) 和 [ADR](docs/adr/README.md)。

## 许可证

Iron Go 源代码按 [Apache License 2.0](LICENSE) 发布。第三方依赖仍适用各自的许可证；重新分发应用时须遵守适用的第三方许可和声明要求。
