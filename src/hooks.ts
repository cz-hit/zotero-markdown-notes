import { BasicExampleFactory } from "./modules/examples";
// 以下为模板示例工厂，需要时取消注释即可启用:
// import {
//   HelperExampleFactory,
//   KeyExampleFactory,
//   PromptExampleFactory,
//   UIExampleFactory,
// } from "./modules/examples";
import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import {
  registerMarkdownPanel,
  reloadMarkdownPanel,
} from "./modules/markdownPanel";
import {
  registerMarkdownReader,
  patchViewAttachment,
  patchTabsRename,
  registerTabHooks,
} from "./modules/markdownReader";
import { registerMarkdownAttachmentMenu } from "./modules/markdownAttachment";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // 注册设置面板（必需）
  BasicExampleFactory.registerPrefs();

  // 注册 Notifier 观察者（必需，用于监听 item/tab/file 事件）
  BasicExampleFactory.registerNotifier();

  // ── 以下为模板示例注册，已注释掉 ────────────────────────
  // KeyExampleFactory.registerShortcuts();
  // await UIExampleFactory.registerExtraColumn();
  // await UIExampleFactory.registerExtraColumnWithCustomCell();
  // UIExampleFactory.registerItemPaneCustomInfoRow();
  // UIExampleFactory.registerItemPaneSection();
  // UIExampleFactory.registerReaderItemPaneSection();
  // ─────────────────────────────────────────────────────────

  // ── Markdown Note Viewer ──────────────────────────────
  await registerMarkdownPanel();
  await registerMarkdownReader();
  // ──────────────────────────────────────────────────────

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  // Patch viewAttachment for this window so double-click respects the pref
  patchViewAttachment(win);
  patchTabsRename(win);
  registerTabHooks(win);

  // Register right-click menu item for creating new markdown attachment
  registerMarkdownAttachmentMenu(win);

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // ── 以下为模板示例 UI 注册，已注释掉 ────────────────────
  // 启动进度弹窗（模板示例，每次启动都会弹出）:
  // const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
  //   closeOnClick: true,
  //   closeTime: -1,
  // })
  //   .createLine({
  //     text: getString("startup-begin"),
  //     type: "default",
  //     progress: 0,
  //   })
  //   .show();
  // await Zotero.Promise.delay(1000);
  // popupWin.changeLine({ progress: 30, text: `[30%] ${getString("startup-begin")}` });

  // UIExampleFactory.registerStyleSheet(win);          // 会把条目面板背景变红！
  // UIExampleFactory.registerRightClickMenuItem();
  // UIExampleFactory.registerRightClickMenuPopup(win);
  // UIExampleFactory.registerWindowMenuWithSeparator();
  // PromptExampleFactory.registerNormalCommandExample();
  // PromptExampleFactory.registerAnonymousCommandExample(win);
  // PromptExampleFactory.registerConditionalCommandExample();

  // await Zotero.Promise.delay(1000);
  // popupWin.changeLine({ progress: 100, text: `[100%] ${getString("startup-finish")}` });
  // popupWin.startCloseTimer(5000);

  // 每次启动都弹出的示例对话框（模板示例）:
  // addon.hooks.onDialogEvents("dialogExample");
  // ─────────────────────────────────────────────────────────
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Zotero 事件分发器：item/tab/file 变化时触发。
 * 具体业务逻辑放在独立函数中，保持此处简洁。
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (event === "select" && type === "tab") {
    for (const win of Zotero.getMainWindows()) {
      const selectedItems = (win as any).ZoteroPane?.getSelectedItems?.() ?? [];
      const markdownItem = selectedItems.find(
        (item: Zotero.Item) =>
          item?.isFileAttachment?.() &&
          /\.(md|markdown)$/i.test((item as any).attachmentFilename || ""),
      );
      if (markdownItem) reloadMarkdownPanel(markdownItem);
    }
  }

  // 模板示例：选中 reader 标签时弹窗提示 —— 已注释
  // if (event == "select" && type == "tab" && extraData[ids[0]].type == "reader") {
  //   BasicExampleFactory.exampleNotifierCallback();
  // }
}

/**
 * This function is just an example of dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this funcion clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

// 模板示例快捷键回调 —— 已注释，需要时取消注释并恢复 KeyExampleFactory import
// function onShortcuts(type: string) {
//   switch (type) {
//     case "larger":
//       KeyExampleFactory.exampleShortcutLargerCallback();
//       break;
//     case "smaller":
//       KeyExampleFactory.exampleShortcutSmallerCallback();
//       break;
//     default:
//       break;
//   }
// }
function onShortcuts(_type: string) {
  // 暂无快捷键绑定
}

// 模板示例对话框事件 —— 已注释，需要时取消注释并恢复 HelperExampleFactory import
// function onDialogEvents(type: string) {
//   switch (type) {
//     case "dialogExample":      HelperExampleFactory.dialogExample();       break;
//     case "clipboardExample":   HelperExampleFactory.clipboardExample();    break;
//     case "filePickerExample":  HelperExampleFactory.filePickerExample();   break;
//     case "progressWindowExample": HelperExampleFactory.progressWindowExample(); break;
//     case "vtableExample":      HelperExampleFactory.vtableExample();       break;
//     default: break;
//   }
// }
function onDialogEvents(_type: string) {
  // 暂无对话框事件
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
