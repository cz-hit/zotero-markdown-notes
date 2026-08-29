# Markdown Note Viewer · Markdown 笔记查看器

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![license](https://img.shields.io/badge/License-AGPL--3.0-blue?style=flat-square)](./LICENSE)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[简体中文](README.md) | English

A Markdown note viewer and editor for [Zotero 7](https://www.zotero.org/). It lets you view and edit Markdown attachments directly inside Zotero, and create clickable **cross-note links** between different Markdown notes.

## Features

- **Embedded Markdown reader tab**: open `.md` / `.markdown` attachments as tabs inside Zotero, without switching to an external editor.
- **Item pane sidebar**: adds a "Markdown Notes" section to the item info panel, with browsing and searching across "current item / current collection / current library" scopes.
- **Editing and preview powered by Cherry Markdown**:
  - Source / preview / split view, with a rich-text toolbar (bold, italic, headings, lists, code, links, images, tables, table of contents, etc.);
  - KaTeX math rendering;
  - Mermaid diagram rendering;
  - Code highlighting, text color / background color (highlight);
  - Clickable table of contents (TOC) navigation;
  - Local relative-path image rendering.
- **Cross-note links**: create jumpable, bidirectional links between any Markdown notes via the "set link target / set link" actions (see below).
- **Orphan link manager**: scan and clean up orphan links pointing to non-existent targets, and orphan anchors referenced by no link.
- **New Markdown attachment**: create a blank Markdown attachment for an item from the context menu.

## Installation

1. Download the latest `.xpi` file (see [Releases](../../releases)).
2. In Zotero, open `Tools → Add-ons`, click the gear icon in the top-right corner, and choose `Install Add-on From File…`.
3. Select the downloaded `.xpi` file and confirm.

> This plugin is built on [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) and requires Zotero 7 or later.

## Usage

### Opening a Markdown note

- **Double-click** a `.md` / `.markdown` attachment in the item list to open it in a Zotero tab (requires "open in Zotero" to be enabled in preferences).
- Once opened, the "Markdown Notes" section in the item info panel (right side) stays in sync with the current note.

### Editing and previewing

Edit using the Cherry Markdown toolbar; edits are saved back to the corresponding `.md` file. The toolbar supports source / preview / split modes, plus formulas, tables, table of contents, colors, and other rich-text capabilities.

### Cross-note links

Create clickable links between Markdown notes. Links are built on **HTML anchors** and **Zotero protocol links** (`zotero://`), using the two toolbar buttons (A / B):

1. **Set link target (A)**: select some text in the target note and click "set link target" to insert an HTML target anchor and enter the "pending" state.
2. **Set link (B)**: in another location (either the same note or **another note**), select the text to use as the link label and click "set link" to wrap it into a Zotero protocol link pointing at that target.
3. You can also do **B before A**: first select the link text (B), then select the target (A) to complete the link.
4. **Cancel (C)**: cancel the pending operation, or delete the currently selected link / target anchor.

Clicking a link opens the target note's reader tab and scrolls to the corresponding anchor.

The plugin also supports **Zotero's native PDF annotation jumps**: for Zotero's native `zotero://` links that point to a PDF annotation / mark, clicking them opens the PDF in Zotero's native reader and jumps to that annotation.

### Orphan link manager

In `Tools → Add-ons → Markdown Note Viewer → Link Manager`, click "scan and clean orphan links/anchors". The plugin will:

- find **orphan links** pointing to non-existent targets;
- find **orphan anchors** referenced by no link;
- list them for you to review and delete.

### New Markdown attachment

Right-click an item (not an attachment) and choose "New Markdown attachment" to create a blank `.md` attachment for that item.

## Preferences

Configure under `Tools → Add-ons → Markdown Note Viewer`:

- **Open .md files in a Zotero tab on double-click**: when enabled, double-clicking a `.md` attachment opens it inside Zotero (instead of the system default editor).

## Development

```bash
# Install dependencies
npm install

# Start the development server (auto-build + hot reload)
npm start

# Production build (produces the .xpi)
npm run build

# Release (bump version, build, and publish to GitHub)
npm run release
```

Build output is under `.scaffold/build/`. See [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold) for details.

## Acknowledgements / Third-party libraries

This project is built on [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) and uses the following open-source libraries:

- [Cherry Markdown](https://github.com/Tencent/cherry-markdown) (Apache-2.0) — Markdown editor and rendering core
- [KaTeX](https://github.com/KaTeX/KaTeX) (MIT) — math rendering
- [Mermaid](https://github.com/mermaid-js/mermaid) (MIT) — diagram rendering
- [highlight.js](https://github.com/highlightjs/highlight.js) (BSD-3-Clause) — code highlighting
- [CodeMirror](https://github.com/codemirror/dev) (MIT) — editor foundation
- [marked](https://github.com/markedjs/marked) (MIT) — Markdown parsing
- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) (MIT) — plugin development toolkit

## Support

Developing and maintaining a plugin takes a lot of time and effort. If you find it useful, please consider supporting it with a **Star**, a donation, or by reporting issues and suggesting improvements; your support helps accelerate future updates.

<div align="center">
  <img src="assets/wechat-pay.jpg" alt="WeChat Pay" width="180" />
  <img src="assets/alipay.jpg" alt="Alipay" width="180" />
</div>

## License

This project is open-sourced under [AGPL-3.0](./LICENSE). Use of this code comes with no warranty; please comply with your local laws.
