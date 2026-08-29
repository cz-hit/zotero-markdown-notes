import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { isMarkdownAttachment } from "../utils/markdown";
import {
  createMarkdownReaderBackend,
  type MarkdownReaderBackend,
} from "./markdownReaderBridge";

const RENAME_PATCHED = Symbol.for("markdownnote.renamePatchedexported");
const LAUNCH_FILE_PATCHED = Symbol.for("markdownnote.launchFilePatched");
const TAB_HOOKS_PATCHED = Symbol.for("markdownnote.tabHooksPatched");
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const VIEWER_URL = `chrome://${config.addonRef}/content/markdownViewer.html`;
// A chrome window needs an XHTML document (native reader/note windows are all
// .xhtml). The viewer content and script are identical to the iframe version.
const WINDOW_VIEWER_URL = `chrome://${config.addonRef}/content/markdownViewer.xhtml`;
// `parseTabType("markdown-note-reader")` splits on the first "-", so the tab
// content type Zotero keys its tabHooks on is "markdown".
const READER_TAB_CONTENT_TYPE = "markdown";
// The raw tab type passed to `Zotero_Tabs.add()`. `Zotero_Tabs.hasContextPane`
// matches against this raw type (not the parsed content type), so the context
// pane needs the full string.
const READER_TAB_TYPE = "markdown-note-reader";

type ReaderEntry = {
  item: Zotero.Item;
  iframe: HTMLIFrameElement;
  sessionId: string;
  listenerWin: Window;
  backend: MarkdownReaderBackend;
  cleanup: () => void;
};

const readerRegistries = new WeakMap<Window, Map<number, ReaderEntry>>();

function getReaderRegistry(
  win: _ZoteroTypes.MainWindow,
): Map<number, ReaderEntry> {
  const windowRef = win as unknown as Window;
  let registry = readerRegistries.get(windowRef);
  if (!registry) {
    registry = new Map<number, ReaderEntry>();
    readerRegistries.set(windowRef, registry);
  }
  return registry;
}

function isSameSource(
  source: MessageEvent["source"],
  target: Window | null | undefined,
): boolean {
  if (!source || !target) return false;
  if (source === target) return true;
  // XUL may expose distinct JS wrappers for the same content window. Compare
  // their native objects when available, while still rejecting null/foreign
  // sources rather than accepting an unverifiable message.
  try {
    return (
      ((source as any).wrappedJSObject ?? source) ===
      ((target as any).wrappedJSObject ?? target)
    );
  } catch {
    return false;
  }
}

function isCurrentIframeSource(
  event: MessageEvent,
  iframe: HTMLIFrameElement,
): boolean {
  return isSameSource(event.source, iframe.contentWindow);
}

function patchTabsRename(win: _ZoteroTypes.MainWindow) {
  const tabs = (win as any).Zotero_Tabs;
  if (!tabs || tabs[RENAME_PATCHED]) return;
  tabs[RENAME_PATCHED] = true;
  const origRename = tabs.rename.bind(tabs);
  tabs.rename = function (tabId: string, title: string) {
    if (title == null || title === "") {
      const tab = tabs._tabs?.find((t: any) => t.id === tabId);
      if (tab?.type === "markdown-note-reader") return;
    }
    return origRename(tabId, title);
  };
}

/**
 * Teach Zotero_Tabs how to move/duplicate/undo-close Markdown reader tabs.
 * The tab context menu drives its items off `_hasHook(tabContentType, action)`,
 * so registering these hooks makes "Move Tab → Move to New Window", "Duplicate
 * Tab" and "Undo Close Tab" appear automatically for our tabs.
 */
function registerTabHooks(win: _ZoteroTypes.MainWindow) {
  const tabs = (win as any).Zotero_Tabs;
  if (!tabs || tabs[TAB_HOOKS_PATCHED]) return;
  tabs[TAB_HOOKS_PATCHED] = true;
  const hooks = tabs.tabHooks;
  const type = READER_TAB_CONTENT_TYPE;

  // Teach Zotero's context pane to treat Markdown reader tabs like reader/note
  // tabs: the right-hand context pane (item info) can then be toggled for them.
  // The item resolution already handles attachments by showing their parent item.
  if (
    Array.isArray(tabs._hasContextPaneTypes) &&
    !tabs._hasContextPaneTypes.includes(READER_TAB_TYPE)
  ) {
    tabs._hasContextPaneTypes.push(READER_TAB_TYPE);
  }

  if (!hooks.moveToNewWindow[type]) {
    hooks.moveToNewWindow[type] = async (tab: any) => {
      tabs.close(tab.id);
      const item = Zotero.Items.get(tab.data?.itemID);
      if (item && isMarkdownAttachment(item)) {
        await openMarkdownReaderWindow(win, item);
      }
    };
  }
  if (!hooks.duplicate[type]) {
    hooks.duplicate[type] = async (tab: any) => {
      const item = Zotero.Items.get(tab.data?.itemID);
      if (item && isMarkdownAttachment(item)) {
        await openMarkdownReaderTab(win, item);
      }
    };
  }
  if (!hooks.undoClose[type]) {
    hooks.undoClose[type] = async (tab: any) => {
      const item = Zotero.Items.get(tab.data?.itemID);
      if (item && isMarkdownAttachment(item)) {
        await openMarkdownReaderTab(win, item);
        return true;
      }
      return false;
    };
  }
}

export { patchViewAttachment, patchTabsRename, registerTabHooks };

export async function registerMarkdownReader() {
  patchLaunchFile();
  for (const win of Zotero.getMainWindows()) {
    patchViewAttachment(win);
    patchTabsRename(win);
    registerTabHooks(win);
  }
}

function patchLaunchFile() {
  const Z = Zotero as any;
  if (Z[LAUNCH_FILE_PATCHED]) return;
  Z[LAUNCH_FILE_PATCHED] = true;
  const origLaunch = Z.launchFile.bind(Z);
  Z.launchFile = async function (file: string) {
    const openInZotero = getPref("openInZotero");
    if (
      openInZotero === true &&
      typeof file === "string" &&
      /\.(md|markdown)$/i.test(file)
    ) {
      const item = await findItemByPath(file);
      const win = item && (Zotero.getMainWindow() as _ZoteroTypes.MainWindow);
      if (item && win) {
        await openMarkdownReaderTab(win, item);
        return;
      }
    }
    return origLaunch(file);
  };
}

async function findItemByPath(filePath: string): Promise<Zotero.Item | null> {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const target = norm(filePath);
  const selected = ((
    Zotero.getMainWindow() as any
  )?.ZoteroPane?.getSelectedItems?.() ?? []) as Zotero.Item[];
  for (const item of selected) {
    const path = await item.getFilePathAsync?.();
    if (
      isMarkdownAttachment(item) &&
      typeof path === "string" &&
      norm(path) === target
    )
      return item;
  }
  try {
    const search = new Zotero.Search();
    search.addCondition("fileTypeID", "is", "1");
    for (const id of (await search.search()) as number[]) {
      const item = Zotero.Items.get(id);
      const path = item && (await item.getFilePathAsync?.());
      if (
        item &&
        isMarkdownAttachment(item) &&
        typeof path === "string" &&
        norm(path) === target
      )
        return item;
    }
  } catch (error) {
    ztoolkit.log("findItemByPath search failed:", error);
  }
  return null;
}

const patchedWindows = new WeakSet<Window>();
function patchViewAttachment(win: _ZoteroTypes.MainWindow) {
  const pane = (win as any).ZoteroPane;
  if (!pane?.viewAttachment || patchedWindows.has(win as unknown as Window))
    return;
  patchedWindows.add(win as unknown as Window);
  const original = pane.viewAttachment.bind(pane);
  pane.viewAttachment = async function (
    itemIDs: number[],
    event?: Event,
    noLocateOnMissing?: boolean,
    forceExternalViewer?: boolean,
  ) {
    if (
      getPref("openInZotero") === true &&
      !forceExternalViewer &&
      itemIDs.length === 1
    ) {
      const item = Zotero.Items.get(itemIDs[0]);
      if (item && isMarkdownAttachment(item)) {
        await openMarkdownReaderTab(win, item);
        return;
      }
    }
    return original(itemIDs, event, noLocateOnMissing, forceExternalViewer);
  };
}

export async function openMarkdownReaderTab(
  win: _ZoteroTypes.MainWindow,
  item: Zotero.Item,
  targetId?: string,
): Promise<void> {
  const tabs = (win as any).Zotero_Tabs;
  if (!tabs) return;
  const readerRegistry = getReaderRegistry(win);
  const tabId = `markdown-note-${item.id}`;
  const existing = readerRegistry.get(item.id);
  if (existing) {
    tabs.select(tabId);
    if (targetId) existing.backend.sendScrollTarget(targetId);
    return;
  }
  const tab = tabs._tabs?.find((entry: any) => entry.id === tabId);
  if (tab) {
    if (!targetId) {
      tabs.select(tabId);
      return;
    }
    // A tab can survive a plugin reload while its in-memory registry entry is
    // gone. Recreate it so a requested target is never silently dropped.
    if (typeof tabs.close === "function") await tabs.close(tabId);
    const stillOpen = tabs._tabs?.some((entry: any) => entry.id === tabId);
    if (stillOpen) {
      ztoolkit.log("Cannot recreate stale Markdown reader tab", tabId);
      (win as any).ZoteroPane?.displayErrorMessage?.(
        "无法打开 Markdown 目标：旧阅读器标签页仍在使用",
      );
      return;
    }
  }

  let cleanup: (() => void) | null = null;
  let closed = false;
  const result = tabs.add({
    id: tabId,
    type: READER_TAB_TYPE,
    title:
      (item as any).attachmentFilename ||
      item.getField("title") ||
      "Markdown Note",
    select: true,
    data: {
      itemID: item.id,
      icon: "chrome://zotero/skin/16/universal/book.svg",
    },
    onClose: () => cleanup?.(),
  }) as { container?: Element } | undefined;
  const container = result?.container;
  if (!container) return;
  const doc = container.ownerDocument;
  if (!doc) return;

  // A thin toolbar row below the tab bar, mirroring the native reader/note
  // tabs' "context pane" toggle, sits above the viewer iframe.
  const wrapper = doc.createElementNS(XHTML_NS, "div") as HTMLDivElement;
  wrapper.setAttribute(
    "style",
    "display:flex;flex-direction:column;width:100%;height:100%;",
  );

  const toolbar = doc.createElementNS(XHTML_NS, "div") as HTMLDivElement;
  toolbar.setAttribute(
    "style",
    "display:flex;flex:0 0 auto;align-items:center;gap:4px;padding:2px 6px;border-bottom:1px solid rgba(0,0,0,0.12);",
  );
  const toggleContextPaneButton = doc.createElementNS(
    XHTML_NS,
    "button",
  ) as HTMLButtonElement;
  toggleContextPaneButton.type = "button";
  toggleContextPaneButton.textContent = "条目信息";
  toggleContextPaneButton.setAttribute("title", "显示/隐藏条目信息面板");
  toggleContextPaneButton.addEventListener("click", () => {
    (win as any).ZoteroContextPane?.togglePane?.();
  });
  toolbar.appendChild(toggleContextPaneButton);

  const iframe = doc.createElementNS(XHTML_NS, "iframe") as HTMLIFrameElement;
  iframe.setAttribute("src", VIEWER_URL);
  iframe.setAttribute(
    "style",
    "width:100%;border:none;display:block;flex:1 1 auto;min-height:0;",
  );
  const sessionId = `reader-${item.id}-${Date.now()}`;
  const listenerWin = doc.defaultView ?? (win as unknown as Window);

  const isCurrentReader = () =>
    !closed &&
    readerRegistry.get(item.id)?.iframe === iframe &&
    readerRegistry.get(item.id)?.sessionId === sessionId;

  const backend = createMarkdownReaderBackend({
    getItem: () => item,
    getSessionId: () => sessionId,
    endpoint: {
      post: (message) => iframe.contentWindow?.postMessage(message, "*"),
      isSource: (event) => isCurrentIframeSource(event, iframe),
    },
    navigateToTarget: (targetItem, targetTargetId) =>
      openMarkdownReaderTab(win, targetItem, targetTargetId),
    isCurrent: isCurrentReader,
    showError: (message) =>
      (win as any).ZoteroPane?.displayErrorMessage?.(message),
  });

  const handler = (event: MessageEvent) => backend.handleMessage(event);
  listenerWin.addEventListener("message", handler);
  const loadHandler = () => void backend.sendContent();
  iframe.addEventListener("load", loadHandler);

  cleanup = () => {
    closed = true;
    backend.cleanup();
    listenerWin.removeEventListener("message", handler);
    iframe.removeEventListener("load", loadHandler);
    if (readerRegistry.get(item.id)?.iframe === iframe)
      readerRegistry.delete(item.id);
    cleanup = null;
  };
  readerRegistry.set(item.id, {
    item,
    iframe,
    sessionId,
    listenerWin,
    backend,
    cleanup,
  });
  wrapper.appendChild(toolbar);
  wrapper.appendChild(iframe);
  container.appendChild(wrapper);
  void backend.sendContent(targetId);
}

/**
 * Open the Markdown note in its own minimal chrome window (the "move to new
 * window" target). The viewer posts to its opener, so the backend listener
 * lives in `win` while the viewer document runs in the standalone window.
 */
export async function openMarkdownReaderWindow(
  win: _ZoteroTypes.MainWindow,
  item: Zotero.Item,
  targetId?: string,
): Promise<void> {
  const newWin = win.open(
    WINDOW_VIEWER_URL,
    "",
    "chrome,resizable,centerscreen",
  );
  if (!newWin) return;

  const holder = {
    item,
    sessionId: `window-${item.id}-${Date.now()}`,
  };
  let closed = false;

  const isCurrentWindow = () => !closed;
  const showError = (message: string) =>
    (win as any).ZoteroPane?.displayErrorMessage?.(message);

  const backend = createMarkdownReaderBackend({
    getItem: () => holder.item,
    getSessionId: () => holder.sessionId,
    endpoint: {
      post: (message) => newWin.postMessage(message, "*"),
      isSource: (event) => isSameSource(event.source, newWin),
    },
    // Cross-note links re-point this same window at the target note.
    navigateToTarget: async (targetItem, targetTargetId) => {
      holder.item = targetItem;
      holder.sessionId = `window-${targetItem.id}-${Date.now()}`;
      await backend.sendContent(targetTargetId);
    },
    isCurrent: isCurrentWindow,
    showError,
  });

  const handler = (event: MessageEvent) => backend.handleMessage(event);
  win.addEventListener("message", handler);
  const loadHandler = () => void backend.sendContent();
  newWin.addEventListener("load", loadHandler);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    backend.cleanup();
    win.removeEventListener("message", handler);
    newWin.removeEventListener("load", loadHandler);
  };
  newWin.addEventListener("unload", cleanup, { once: true });

  void backend.sendContent(targetId);
}
