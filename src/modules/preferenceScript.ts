import {
  deleteOrphans,
  scanOrphanLinks,
  type OrphanScanResult,
} from "./markdownLinkCoordinator";

export async function registerPrefsScripts(_window: Window) {
  // 设置面板加载时调用（见 addon/content/preferences.xhtml onpaneload）
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
      columns: [],
      rows: [],
    };
  } else {
    addon.data.prefs.window = _window;
  }

  bindLinkManagerButton();
}

function bindLinkManagerButton() {
  const win = addon.data.prefs?.window;
  if (!win) return;
  const button = win.document.querySelector(
    `#zotero-prefpane-${addon.data.config.addonRef}-scan-orphans`,
  );
  button?.addEventListener("command", () => {
    void runOrphanScan();
  });
}

async function runOrphanScan() {
  try {
    const result = await scanOrphanLinks();
    if (result.error) {
      notify(`扫描失败：${result.error}`);
      return;
    }
    await showOrphanDialog(result);
  } catch (error: any) {
    notify(`扫描失败：${error?.message ?? "未知错误"}`);
  }
}

type OrphanItem = {
  kind: "link" | "anchor";
  itemId: number;
  targetId: string;
  text: string;
};

async function showOrphanDialog(result: OrphanScanResult): Promise<void> {
  const items: OrphanItem[] = [
    ...result.orphanLinks.map((link) => ({
      kind: "link" as const,
      itemId: link.itemId,
      targetId: link.targetId,
      text: `链接 — ${link.filename}：「${link.label}」→ ${link.targetId}`,
    })),
    ...result.orphanAnchors.map((anchor) => ({
      kind: "anchor" as const,
      itemId: anchor.itemId,
      targetId: anchor.targetId,
      text: `锚点 — ${anchor.filename}：${anchor.targetId}`,
    })),
  ];

  if (items.length === 0) {
    const skipped = result.skipped.length
      ? `（已跳过 ${result.skipped.length} 个不可读文件）`
      : "";
    notify(`未发现孤立链接或锚点${skipped}`);
    return;
  }

  const skipped = result.skipped.length
    ? `；注意：有 ${result.skipped.length} 个文件读取失败已跳过，结果可能不完整`
    : "";

  const dialog = new ztoolkit.Dialog(items.length + 1, 1);
  const dialogData: Record<string, unknown> = {
    // These are auto-populated by setDialogData; declared for the awaited
    // unload lock and last-clicked-button id.
  };

  dialog.addCell(0, 0, {
    tag: "h3",
    namespace: "html",
    properties: {
      innerText: `孤立链接 ${result.orphanLinks.length} 个、孤立锚点 ${result.orphanAnchors.length} 个${skipped}`,
    },
  });

  items.forEach((item, index) => {
    dialogData[`checked-${index}`] = true;
    dialog.addCell(index + 1, 0, {
      tag: "label",
      namespace: "html",
      children: [
        {
          tag: "input",
          namespace: "html",
          attributes: {
            type: "checkbox",
            "data-bind": `checked-${index}`,
            "data-prop": "checked",
          },
        },
        {
          tag: "span",
          namespace: "html",
          properties: { innerText: ` ${item.text}` },
        },
      ],
    });
  });

  dialog.addButton("删除选中项", "delete");
  dialog.addButton("取消", "cancel");
  dialog.setDialogData(dialogData).open("链接管理器", {
    centerscreen: true,
    fitContent: true,
    resizable: true,
  });

  await (dialogData.unloadLock as { promise: Promise<void> })?.promise;
  if (dialogData._lastButtonId !== "delete") return;

  const linkKeys: { itemId: number; targetId: string }[] = [];
  const anchorKeys: { itemId: number; targetId: string }[] = [];
  items.forEach((item, index) => {
    if (!dialogData[`checked-${index}`]) return;
    if (item.kind === "link") {
      linkKeys.push({ itemId: item.itemId, targetId: item.targetId });
    } else {
      anchorKeys.push({ itemId: item.itemId, targetId: item.targetId });
    }
  });

  if (!linkKeys.length && !anchorKeys.length) return;

  const res = await deleteOrphans(linkKeys, anchorKeys);
  notify(
    res.success
      ? `已删除 ${res.deletedLinks} 个孤立链接、${res.deletedAnchors} 个孤立锚点`
      : `删除失败：${res.message ?? "未知错误"}`,
  );
}

function notify(message: string) {
  const alertFn = (globalThis as any).alert ?? ztoolkit.getGlobal("alert");
  alertFn?.(message);
}
