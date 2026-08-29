import { getLocaleID } from "../utils/locale";
import {
  isMarkdownAttachment,
  findMarkdownAttachmentsUnderItem,
  findMarkdownAttachmentsInCollection,
  findMarkdownAttachmentsInLibrary,
  findMarkdownItemByTarget,
  filterNotesByTitle,
  getNoteLabel,
  readMarkdownContent,
  readMarkdownImage,
  saveMarkdownContent,
  type MarkdownNoteScope,
} from "../utils/markdown";
import { classifyMarkdownLink, openMarkdownLink } from "../utils/links";
import * as markdownLinkCoordinator from "./markdownLinkCoordinator";
import { openMarkdownReaderTab } from "./markdownReader";
import { config } from "../../package.json";

export { registerMarkdownPanel, reloadMarkdownPanel };

const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Panel-side logging. `console` is NOT a global in the item pane section
 * callback scope (Zotero 7 loads plugin scripts into a sandbox without it),
 * so a bare `console.log` throws `ReferenceError: console is not defined` and
 * crashes onInit/onItemChange before their logic runs. `Zotero.debug` is the
 * safe, always-available equivalent and appears in the Debug Output window
 * (Help → Debug Output Logging).
 */
function mdlog(...args: unknown[]): void {
  const text = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (typeof arg === "number" || typeof arg === "boolean") {
        return String(arg);
      }
      if (arg === null) return "null";
      if (arg === undefined) return "undefined";
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  try {
    Zotero.debug(`[MDPanel] ${text}`);
  } catch {
    // Never let logging break the panel.
  }
}

const PANE_ID = "markdown-note-viewer";
const VIEWER_URL = `chrome://${config.addonRef}/content/markdownViewer.html`;

let panelReload: ((item: Zotero.Item) => void) | null = null;
let currentScope: MarkdownNoteScope = "item";
let currentOwnerItem: Zotero.Item | null = null;

function reloadMarkdownPanel(item: Zotero.Item) {
  panelReload?.(item);
}

function showMarkdownLinkError(message: string): void {
  try {
    (Zotero.getMainWindow() as any)?.ZoteroPane?.displayErrorMessage?.(message);
  } catch (error) {
    mdlog("displayMarkdownLinkError failed", error);
  }
}

/** Resolve the top-level item that owns the notes shown for `item`. */
function resolveOwnerItem(item: Zotero.Item, tabType: string): Zotero.Item {
  if (tabType === "reader") return item;
  const parentID = item.parentItemID;
  const parent = parentID ? Zotero.Items.get(parentID) : null;
  return (parent as Zotero.Item) ?? item;
}

/** Resolve the note(s) for a scope, given the owning top-level item. */
async function resolveNotesForScope(
  scope: MarkdownNoteScope,
  ownerItem: Zotero.Item | null,
): Promise<Zotero.Item[]> {
  if (!ownerItem) return [];
  if (scope === "item") {
    return findMarkdownAttachmentsUnderItem(ownerItem);
  }
  if (scope === "collection") {
    const collection = (
      Zotero.getMainWindow() as any
    )?.ZoteroPane?.getSelectedCollection?.();
    if (!collection) return [];
    return findMarkdownAttachmentsInCollection(collection);
  }
  return findMarkdownAttachmentsInLibrary(ownerItem.libraryID);
}

/**
 * Register the Markdown Note Viewer sidebar panel.
 * Uses iframe + postMessage for reliable communication in Zotero 7+.
 */
async function registerMarkdownPanel() {
  let currentItem: Zotero.Item | null = null;
  let currentIframe: HTMLIFrameElement | null = null;
  let currentWin: Window | null = null;
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  let currentRo: ResizeObserver | null = null;
  let heightCleanup: (() => void) | null = null;
  let renderGeneration = 0;
  let reloadCurrentItem: ((item: Zotero.Item) => void) | null = null;
  let unsubscribeActiveTarget: (() => void) | null = null;
  let unsubscribeFileUpdated: (() => void) | null = null;

  function cleanup() {
    renderGeneration += 1;
    unsubscribeActiveTarget?.();
    unsubscribeActiveTarget = null;
    unsubscribeFileUpdated?.();
    unsubscribeFileUpdated = null;
    if (messageHandler && currentWin) {
      currentWin.removeEventListener("message", messageHandler);
    }
    currentRo?.disconnect();
    heightCleanup?.();
    messageHandler = null;
    currentRo = null;
    heightCleanup = null;
    reloadCurrentItem = null;
    panelReload = null;
    currentItem = null;
    currentIframe = null;
    currentWin = null;
  }

  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("mdnote-section-head-text"),
      icon: "chrome://zotero/skin/16/universal/book.svg",
    },
    sidenav: {
      l10nID: getLocaleID("mdnote-section-sidenav-tooltip"),
      icon: "chrome://zotero/skin/20/universal/save.svg",
    },
    bodyXHTML: `
      <html:div id="${PANE_ID}-toolbar" style="display:flex;flex-direction:column;flex:0 0 auto;width:100%;">
        <html:div id="${PANE_ID}-controls" style="display:flex;gap:4px;align-items:center;padding:4px;width:100%;">
          <html:select id="${PANE_ID}-scope" aria-label="笔记范围" style="flex:0 0 auto;max-width:120px;">
            <html:option value="item">当前条目</html:option>
            <html:option value="collection">当前分类</html:option>
            <html:option value="library">当前文库</html:option>
          </html:select>
          <html:input id="${PANE_ID}-search" type="text" placeholder="搜索笔记…" style="flex:1 1 auto;min-width:0;" />
        </html:div>
        <html:div id="${PANE_ID}-list" style="display:none;overflow-y:auto;max-height:220px;width:100%;border-top:1px solid rgba(0,0,0,0.12);"></html:div>
      </html:div>
      <html:iframe id="${PANE_ID}-iframe" src="${VIEWER_URL}" style="width:100%;height:100%;min-height:400px;border:none;display:block;" />
    `,

    onInit: () => {
      mdlog("Markdown Note panel init");
    },

    onDestroy: () => {
      cleanup();
      mdlog("Markdown Note panel destroy");
    },

    onItemChange: ({ item, setEnabled, tabType }) => {
      let enabled = false;
      let noteToShow: Zotero.Item | null = null;
      if (tabType === "reader") {
        const children = item ? findMarkdownAttachmentsUnderItem(item) : [];
        enabled = children.length > 0;
        noteToShow = children[0] ?? null;
      } else {
        enabled = isMarkdownAttachment(item);
        noteToShow = enabled ? item : null;
      }
      setEnabled(enabled);
      mdlog(
        "[MDPanel] onItemChange: item=",
        item?.id,
        "tabType=",
        tabType,
        "enabled=",
        enabled,
      );
      if (enabled && noteToShow && item) {
        currentOwnerItem = resolveOwnerItem(item, tabType);
        reloadCurrentItem?.(noteToShow);
      }
      return true;
    },

    onRender: async ({ body, item, tabType }) => {
      if (!item) return;

      cleanup();
      const generation = renderGeneration;

      const ownerItem = resolveOwnerItem(item, tabType);
      const initialNote =
        tabType === "reader"
          ? (findMarkdownAttachmentsUnderItem(item)[0] ?? null)
          : item;
      currentItem = initialNote;
      currentOwnerItem = ownerItem;

      const iframe = body.querySelector(
        `#${PANE_ID}-iframe`,
      ) as HTMLIFrameElement | null;
      const toolbarEl = body.querySelector(
        `#${PANE_ID}-toolbar`,
      ) as HTMLElement | null;
      const listEl = body.querySelector(
        `#${PANE_ID}-list`,
      ) as HTMLElement | null;
      const scopeEl = body.querySelector(
        `#${PANE_ID}-scope`,
      ) as HTMLSelectElement | null;
      const searchEl = body.querySelector(
        `#${PANE_ID}-search`,
      ) as HTMLInputElement | null;

      const doc = body.ownerDocument!;
      const winRef = doc.defaultView!;

      mdlog(
        "[MDPanel] onRender: item=",
        item.id,
        "tabType=",
        tabType,
        "initialNote=",
        initialNote?.id,
      );

      // Calculate height from viewport to fill all available space below the
      // toolbar, accounting for the (possibly visible) note list.
      const sectionEl = body.closest(
        "collapsible-section",
      ) as HTMLElement | null;
      const paneContainer = body.closest(
        ".zotero-view-item-container, .item-pane-container-root",
      ) as HTMLElement | null;
      const applyHeight = () => {
        const bodyElement = body as HTMLElement;
        const rect = bodyElement.getBoundingClientRect();
        const toolbarHeight = toolbarEl?.offsetHeight ?? 0;
        const availableHeight = winRef.innerHeight - rect.top - toolbarHeight;
        const h = Math.max(availableHeight - 10, 200);
        iframe?.style.setProperty("height", `${h}px`);
      };
      applyHeight();

      // Keep it in sync when the pane is expanded/collapsed or the window
      // changes. `body` is content-driven — its height is the iframe's fixed
      // height — so it never fires a ResizeObserver by itself. Watch the
      // collapsible-section and the pane's scroll container (which do resize)
      // plus the section's toggle animation.
      const ro = new winRef.ResizeObserver(applyHeight);
      currentRo = ro;
      for (const target of [body, sectionEl, paneContainer]) {
        if (target) ro.observe(target as Element);
      }
      const onSectionToggle = () => {
        // Measure after the open/close transition, then again after it settles.
        winRef.requestAnimationFrame(applyHeight);
        setTimeout(applyHeight, 250);
      };
      sectionEl?.addEventListener("toggle", onSectionToggle);
      winRef.addEventListener("resize", applyHeight);
      heightCleanup = () => {
        sectionEl?.removeEventListener("toggle", onSectionToggle);
        winRef.removeEventListener("resize", applyHeight);
      };

      if (iframe) {
        iframe.style.width = "100%";
        iframe.style.border = "none";
        iframe.style.display = "block";
      }

      currentIframe = iframe;
      currentWin = iframe?.ownerDocument?.defaultView ?? null;
      mdlog("[MDPanel] onRender: item=", item.id, "currentWin=", !!currentWin);

      if (!iframe || !currentWin) return;
      if (!initialNote) return;

      // Unique token for this render cycle — the viewer echoes it on every
      // outgoing message, letting us identify messages from our own iframe
      // even when event.source identity checks are unreliable in XUL chrome.
      const mySessionId = `panel-${initialNote.id}-${Date.now()}`;
      let sendContentPending = false;
      let renderItem = initialNote;
      let renderSessionId = mySessionId;
      const renderIframe = iframe;
      const renderWin = currentWin;

      function isCurrentRender() {
        return (
          generation === renderGeneration &&
          currentItem?.id === renderItem.id &&
          currentIframe === renderIframe
        );
      }

      unsubscribeActiveTarget = markdownLinkCoordinator.subscribePendingLink(
        (pending) => {
          if (!isCurrentRender()) return;
          renderIframe.contentWindow?.postMessage(
            {
              type: "pending-link-changed",
              sessionId: renderSessionId,
              pending,
            },
            "*",
          );
        },
      );

      unsubscribeFileUpdated = markdownLinkCoordinator.subscribeFileUpdated(
        (itemId) => {
          if (!isCurrentRender() || itemId !== renderItem.id) return;
          void loadAndSendContent();
        },
      );

      // Read .md file and push content into the iframe
      async function loadAndSendContent() {
        if (!isCurrentRender()) return;
        const itemAtStart = renderItem;
        const sessionAtStart = renderSessionId;
        const result = await readMarkdownContent(itemAtStart);
        if (
          !isCurrentRender() ||
          renderItem !== itemAtStart ||
          renderSessionId !== sessionAtStart
        )
          return;
        const lib = Zotero.Libraries.get(itemAtStart.libraryID);
        const libType = lib && (lib as any).libraryType;
        const itemUri =
          libType === "user"
            ? `zotero://select/library/items/${itemAtStart.key}`
            : `zotero://select/groups/${itemAtStart.libraryID}/items/${itemAtStart.key}`;
        renderIframe.contentWindow?.postMessage(
          {
            type: "set-content",
            sessionId: sessionAtStart,
            content: result.content,
            error: result.error || null,
            fileUri: result.fileUri || "",
            itemUri,
            itemId: itemAtStart.id,
            pending: markdownLinkCoordinator.getPendingLink(),
          },
          "*",
        );
        mdlog("[MDPanel] postMessage sent");
      }

      function switchItem(nextItem: Zotero.Item) {
        if (!isCurrentRender()) {
          mdlog(
            "[MDPanel] switchItem skipped (stale render): item=",
            nextItem.id,
          );
          return;
        }
        renderItem = nextItem;
        renderSessionId = `panel-${nextItem.id}-${Date.now()}`;
        currentItem = nextItem;
        sendContentPending = false;
        mdlog(
          "[MDPanel] switchItem: item=",
          nextItem.id,
          "session=",
          renderSessionId,
        );
        loadAndSendContent();
      }

      reloadCurrentItem = switchItem;
      panelReload = switchItem;

      // ── Note switcher ──────────────────────────────────────────────
      const showNoteList = () => {
        if (listEl) listEl.style.display = "block";
        applyHeight();
      };
      const hideNoteList = () => {
        if (listEl) listEl.style.display = "none";
        applyHeight();
      };

      async function refreshNoteList() {
        if (!listEl) return;
        const query = searchEl?.value ?? "";
        const notes = await resolveNotesForScope(
          currentScope,
          currentOwnerItem,
        );
        const filtered = filterNotesByTitle(notes, query);
        listEl.textContent = "";
        for (const note of filtered) {
          const entry = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
          entry.textContent = getNoteLabel(note);
          entry.style.cssText =
            "padding:4px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
          if (note.id === renderItem.id) {
            entry.style.background = "var(--accent-blue, rgba(0,0,0,0.08))";
          }
          entry.addEventListener("mousedown", () => {
            switchItem(note);
            hideNoteList();
            if (searchEl) searchEl.value = "";
          });
          listEl.appendChild(entry);
        }
      }

      if (scopeEl) {
        scopeEl.value = currentScope;
        scopeEl.addEventListener("change", () => {
          currentScope = scopeEl.value as MarkdownNoteScope;
          void refreshNoteList();
        });
      }
      if (searchEl) {
        searchEl.addEventListener("focus", () => {
          showNoteList();
          void refreshNoteList();
        });
        searchEl.addEventListener("input", () => {
          showNoteList();
          void refreshNoteList();
        });
        searchEl.addEventListener("blur", () => {
          // Delay so a mousedown on a list entry fires first.
          setTimeout(() => {
            if (listEl && !listEl.matches(":hover")) hideNoteList();
          }, 150);
        });
      }

      // Listen for postMessage events from the iframe.
      // viewer-ready has no sessionId yet (it fires before set-content), so we
      // accept it unconditionally but guard it with the iframe reference check.
      // All subsequent messages (markdown-save, open-link) carry our sessionId.
      messageHandler = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object" || !msg.type) return;

        if (msg.type === "viewer-ready") {
          // A ready message has no session token yet, so bind it to this iframe.
          if (
            event.source &&
            renderIframe.contentWindow &&
            event.source !== renderIframe.contentWindow
          )
            return;
          mdlog("[MDPanel] viewer-ready received, env=", msg.env);
          if (!sendContentPending) {
            sendContentPending = true;
            setTimeout(() => {
              sendContentPending = false;
              loadAndSendContent();
            }, 50);
          }
        } else if (msg.sessionId !== renderSessionId) {
          // All other messages must carry our session token
          return;
        } else if (msg.type === "markdown-save" && isCurrentRender()) {
          const content = msg.content as string;
          const requestId =
            typeof msg.requestId === "string" ? msg.requestId : null;
          if (!requestId || typeof content !== "string") return;
          saveMarkdownContent(renderItem, content)
            .then((result) => {
              if (!isCurrentRender()) return;
              renderIframe.contentWindow?.postMessage(
                {
                  type: "save-result",
                  sessionId: renderSessionId,
                  requestId,
                  success: result.success,
                  error: result.error || null,
                },
                "*",
              );
            })
            .catch((error: any) => {
              if (!isCurrentRender()) return;
              renderIframe.contentWindow?.postMessage(
                {
                  type: "save-result",
                  sessionId: renderSessionId,
                  requestId,
                  success: false,
                  error: error?.message ?? "Markdown save failed",
                },
                "*",
              );
            });
        } else if (msg.type === "load-image" && isCurrentRender()) {
          const requestId = msg.requestId as string;
          const src = msg.src as string;
          const target = renderIframe.contentWindow;
          if (!requestId || !src || !target) return;
          mdlog("[MDPanel] load-image: src=", src);
          readMarkdownImage(renderItem, src).then((result) => {
            if (!isCurrentRender()) return;
            target.postMessage(
              {
                type: "image-result",
                sessionId: renderSessionId,
                requestId,
                src,
                dataUrl: result.dataUrl || null,
                error: result.error || null,
              },
              "*",
            );
          });
        } else if (msg.type === "markdown-link-action" && isCurrentRender()) {
          const itemAtStart = renderItem;
          const sessionAtStart = renderSessionId;
          const request = msg.request;
          const requestId =
            request && typeof request.requestId === "string"
              ? request.requestId
              : null;
          if (!requestId) return;
          const target = renderIframe.contentWindow;
          const postResult = (
            result: markdownLinkCoordinator.LinkOperationResult,
          ) => {
            if (
              !isCurrentRender() ||
              renderItem !== itemAtStart ||
              renderSessionId !== sessionAtStart
            )
              return;
            target?.postMessage(
              {
                type: "markdown-link-result",
                sessionId: sessionAtStart,
                requestId,
                result,
              },
              "*",
            );
          };
          const validRequest =
            typeof request.action === "string" &&
            typeof request.markdown === "string" &&
            request.selection &&
            typeof request.selection.from === "number" &&
            typeof request.selection.to === "number";
          if (!validRequest) {
            postResult({
              success: false,
              message: "Malformed Markdown link request",
            });
            return;
          }
          Promise.resolve(
            markdownLinkCoordinator.applyMarkdownLinkAction(
              itemAtStart,
              request.action,
              request.markdown,
              request.selection,
            ),
          )
            .then(postResult)
            .catch((error: any) =>
              postResult({
                success: false,
                message: error?.message ?? "Markdown link action failed",
              }),
            );
        } else if (msg.type === "open-link" && isCurrentRender()) {
          const href = msg.href as string;
          const classified = classifyMarkdownLink(href);
          if (classified.kind !== "markdown-target") {
            void openMarkdownLink(renderItem, href);
            return;
          }
          const target = classified.target;
          const itemAtStart = renderItem;
          const sessionAtStart = renderSessionId;
          const win = Zotero.getMainWindow() as _ZoteroTypes.MainWindow;
          void findMarkdownItemByTarget(target)
            .then((targetItem) => {
              if (
                !isCurrentRender() ||
                renderItem !== itemAtStart ||
                renderSessionId !== sessionAtStart
              )
                return;
              if (!targetItem) {
                showMarkdownLinkError("找不到目标 Markdown 笔记");
                return;
              }
              return openMarkdownReaderTab(win, targetItem, target.targetId);
            })
            .catch((error: any) => {
              mdlog("open Markdown target failed", error);
              showMarkdownLinkError("无法打开目标 Markdown 笔记");
            });
        }
      };
      renderWin.addEventListener("message", messageHandler);

      // Always send content immediately — the viewer handles set-content at
      // any time, whether it has already fired viewer-ready or not.
      // Also keep the load listener as a fallback for cold-load or reload.
      loadAndSendContent();

      iframe.addEventListener("load", () => {
        mdlog("[MDPanel] iframe load event fired");
        loadAndSendContent();
      });
    },
  });
}
