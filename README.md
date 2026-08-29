# Markdown Note Viewer · Markdown 笔记查看器

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![license](https://img.shields.io/badge/License-AGPL--3.0-blue?style=flat-square)](./LICENSE)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[English](README.en.md) | 简体中文

一个为 [Zotero 7](https://www.zotero.org/) 打造的 Markdown 笔记查看与编辑器插件。它能在 Zotero 内直接查看、编辑 Markdown 附件，并在不同 Markdown 笔记之间建立可点击跳转的**跨笔记链接**。

## 功能特性

- **内嵌 Markdown 阅读器标签页**：在 Zotero 内以标签页形式打开 `.md` / `.markdown` 附件，无需切换外部编辑器。
- **条目面板侧边栏**：在条目信息面板中新增 "Markdown 笔记" 区块，支持按「当前条目 / 当前分类 / 当前文库」范围浏览与搜索笔记。
- **基于 Cherry Markdown 的编辑与预览**：
  - 源码 / 预览 / 分屏切换，富文本工具栏（加粗、斜体、标题、列表、代码、链接、图片、表格、目录等）；
  - KaTeX 数学公式渲染；
  - Mermaid 图表渲染；
  - 代码高亮、文字颜色 / 背景色（荧光高亮）；
  - 标题目录（TOC）点击跳转；
  - 本地相对路径图片渲染。
- **跨笔记链接**：通过「设置链接目标 / 设置链接」两个操作，在任意 Markdown 笔记之间建立可跳转的双向链接（详见下文）。
- **孤立链接管理器**：扫描并清理指向不存在目标的孤立链接、以及无任何引用指向的孤立锚点。
- **新建 Markdown 附件**：右键菜单一键为条目创建空白 Markdown 附件。

## 安装

1. 下载最新版本的 `.xpi` 文件（见 [Releases](../../releases)）。
2. 在 Zotero 中打开 `工具 → 插件`，点击右上角齿轮图标，选择 `从文件安装插件…`。
3. 选中下载的 `.xpi` 文件并确认安装。

> 本插件基于 [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) 构建，需要 Zotero 7 及以上版本。

## 使用说明

### 打开 Markdown 笔记

- 在条目列表中**双击** `.md` / `.markdown` 附件，即可在 Zotero 标签页中打开（需在设置中开启「在 Zotero 中打开」）。
- 打开后，条目信息面板（右侧）的 "Markdown 笔记" 区块会同步显示当前笔记。

### 编辑与预览

使用 Cherry Markdown 的工具栏进行编辑；编辑内容会保存回对应的 `.md` 文件。工具栏支持源码 / 预览 / 分屏三种模式，以及公式、表格、目录、颜色等富文本能力。

### 跨笔记链接

在 Markdown 笔记之间建立可点击跳转的链接。链接采用 **HTML 锚点**与 **Zotero 协议链接**（`zotero://`）实现，通过工具栏的两个按钮（A / B）配合完成：

1. **设置链接目标（A）**：选中目标笔记中某处文本，点击「设置链接目标」，会在该处插入一个 HTML 目标锚点，并进入"待链接"状态。
2. **设置链接（B）**：在另一处（可以是同一篇笔记，也可以是**另一篇笔记**）选中要作为链接文本的内容，点击「设置链接」，将其包装成指向该目标的 Zotero 协议链接。
3. 也可以**先 B 后 A**：先选中链接文本（B），再选中目标（A）完成链接。
4. **取消（C）**：取消待处理的链接操作，或删除当前选中的链接 / 目标锚点。

点击链接会打开目标笔记的阅读器标签页，并滚动到对应锚点位置。

此外，插件也支持 **Zotero 原生的 PDF 标记跳转**：对于指向 PDF 注释 / 标记的 Zotero 原生 `zotero://` 链接，点击后会在 Zotero 原生阅读器中打开对应 PDF 并跳转到该标记位置。

### 孤立链接管理器

在 `工具 → 插件 → Markdown 笔记查看器 → 链接管理器` 中，点击「扫描并清理孤立链接/锚点」，插件会：

- 找出指向不存在目标的**孤立链接**；
- 找出没有任何链接引用的**孤立锚点**；
- 以列表形式展示，供你勾选并删除。

### 新建 Markdown 附件

右键点击一个条目（非附件），选择「新建 Markdown 附件」，即可为该条目创建一个空白的 `.md` 附件。

## 设置

在 `工具 → 插件 → Markdown 笔记查看器` 中可配置：

- **双击 .md 文件时在 Zotero 标签页中打开**：开启后，双击 `.md` 附件会在 Zotero 内打开（而非系统默认编辑器）。

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器（自动编译 + 热重载）
npm start

# 生产构建（生成 .xpi）
npm run build

# 发布（版本号自增、构建并发布到 GitHub）
npm run release
```

构建产物位于 `.scaffold/build/` 目录。详细说明见 [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)。

## 致谢 / 第三方库

本项目基于 [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) 构建，并使用了以下开源库：

- [Cherry Markdown](https://github.com/Tencent/cherry-markdown)（Apache-2.0）—— Markdown 编辑器与渲染内核
- [KaTeX](https://github.com/KaTeX/KaTeX)（MIT）—— 数学公式渲染
- [Mermaid](https://github.com/mermaid-js/mermaid)（MIT）—— 图表渲染
- [highlight.js](https://github.com/highlightjs/highlight.js)（BSD-3-Clause）—— 代码高亮
- [CodeMirror](https://github.com/codemirror/dev)（MIT）—— 编辑器底层
- [marked](https://github.com/markedjs/marked)（MIT）—— Markdown 解析
- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)（MIT）—— 插件开发工具

## 支持

插件的开发与维护需要投入大量时间和精力。如果你觉得这个插件对你有帮助，欢迎通过 **Star**、打赏、反馈问题或提出改进建议来支持；你的支持将有助于加速后续版本的更新。

<div align="center">
  <img src="assets/wechat-pay.jpg" alt="微信支付" width="180" />
  <img src="assets/alipay.jpg" alt="支付宝" width="180" />
</div>

## License

本项目以 [AGPL-3.0](./LICENSE) 协议开源。使用本代码不提供任何担保，请遵守当地法律法规。
