import { getString } from "../utils/locale";

export { registerMarkdownAttachmentMenu };

const MENUITEM_ID = "markdownnote-new-attachment-menuitem";

function registerMarkdownAttachmentMenu(win: _ZoteroTypes.MainWindow) {
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: MENUITEM_ID,
    label: getString("markdown-new-attachment-menu"),
    isHidden: () => {
      const items = win.ZoteroPane.getSelectedItems();
      return !items.some(
        (item: any) =>
          typeof item.isRegularItem === "function" && item.isRegularItem(),
      );
    },
    commandListener: () => {
      const items = win.ZoteroPane.getSelectedItems();
      const regularItems = items.filter(
        (item: any) =>
          typeof item.isRegularItem === "function" && item.isRegularItem(),
      );
      if (regularItems.length === 0) return;
      createMarkdownAttachments(regularItems).catch((err: any) => {
        ztoolkit.log("[MarkdownNote] Failed to create attachment", err);
      });
    },
  });
}

async function createMarkdownAttachments(parentItems: Zotero.Item[]) {
  const baseName = getString("markdown-new-attachment-base-name");
  const ext = ".md";

  for (const parentItem of parentItems) {
    try {
      const fileName = await getUniqueFileName(parentItem, baseName, ext);

      const tempDir = Zotero.getTempDirectory();
      const tempFilePath = PathUtils.join(tempDir.path, fileName);

      await Zotero.File.putContentsAsync(tempFilePath, "");

      await Zotero.Attachments.importFromFile({
        file: tempFilePath,
        parentItemID: parentItem.id,
        title: fileName,
        contentType: "text/markdown",
      });

      try {
        const tempFile = Zotero.File.pathToFile(tempFilePath);
        if (tempFile?.exists()) tempFile.remove(false);
      } catch (_e) {
        /* best-effort cleanup */
      }
    } catch (err: any) {
      ztoolkit.log(
        "[MarkdownNote] Failed to create attachment for item " +
          parentItem.id,
        err,
      );
    }
  }
}

async function getUniqueFileName(
  parentItem: Zotero.Item,
  baseName: string,
  ext: string,
): Promise<string> {
  const candidate = baseName + ext;
  if (!(await attachmentNameExists(parentItem, candidate))) {
    return candidate;
  }

  let suffix = 1;
  while (suffix < 1000) {
    const c = `${baseName} (${suffix})${ext}`;
    if (!(await attachmentNameExists(parentItem, c))) return c;
    suffix++;
  }
  return `${baseName} (${Date.now()})${ext}`;
}

async function attachmentNameExists(
  parentItem: Zotero.Item,
  fileName: string,
): Promise<boolean> {
  const ids: number[] =
    typeof parentItem.getAttachments === "function"
      ? parentItem.getAttachments()
      : [];
  for (const id of ids) {
    const child = Zotero.Items.get(id);
    if (child?.isFileAttachment?.()) {
      if (
        (
          child as Zotero.Item & { attachmentFilename?: string }
        ).attachmentFilename === fileName
      )
        return true;
    }
  }
  return false;
}
