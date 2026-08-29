import {
  findMarkdownItemByTarget,
  readMarkdownContent,
  readMarkdownImage,
  saveMarkdownContent,
} from "../utils/markdown";
import { classifyMarkdownLink, openMarkdownLink } from "../utils/links";
import * as markdownLinkCoordinator from "./markdownLinkCoordinator";

/**
 * A viewer transport. `post` sends a message to the viewer; `isSource` decides
 * whether an incoming `MessageEvent` really came from that viewer. The tab
 * (iframe) and the standalone window provide different implementations, but the
 * message protocol they speak is identical.
 */
export type ReaderEndpoint = {
  post: (message: unknown) => void;
  isSource: (event: MessageEvent) => boolean;
};

export type MarkdownReaderBackend = {
  sendContent: (targetId?: string) => Promise<void>;
  sendScrollTarget: (id: string) => void;
  handleMessage: (event: MessageEvent) => void;
  cleanup: () => void;
};

export type MarkdownReaderBackendOptions = {
  /** Current note item. Read at message time so callers may swap it. */
  getItem: () => Zotero.Item;
  /** Current session token. Read at message time. */
  getSessionId: () => string;
  endpoint: ReaderEndpoint;
  /**
   * Resolve a cross-note markdown target link. The tab opens a new tab; the
   * standalone window re-points itself at the target note.
   */
  navigateToTarget: (
    targetItem: Zotero.Item,
    targetId?: string,
  ) => Promise<void>;
  /** Whether this backend is still the active one for its viewer. */
  isCurrent: () => boolean;
  showError?: (message: string) => void;
};

/**
 * Create the backend half of a markdown viewer instance.
 *
 * This is the single owner of the viewer message protocol — reading and saving
 * content, resolving images, applying link actions and opening links. Both
 * `markdownReader.ts` (tab iframe) and the standalone window reuse it so the
 * protocol has exactly one implementation.
 */
export function createMarkdownReaderBackend(
  opts: MarkdownReaderBackendOptions,
): MarkdownReaderBackend {
  const {
    getItem,
    getSessionId,
    endpoint,
    navigateToTarget,
    isCurrent,
    showError,
  } = opts;

  let closed = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let targetToScroll: string | null = null;
  let unsubscribePendingLink: (() => void) | null = null;
  let unsubscribeFileUpdated: (() => void) | null = null;

  const post = (message: unknown) => endpoint.post(message);

  const fail = (message: string) => {
    try {
      showError?.(message);
    } catch (error) {
      ztoolkit.log("Markdown reader showError failed:", error);
    }
  };

  const isMessageFromViewer = (event: MessageEvent) =>
    endpoint.isSource(event) || event.source === null;

  async function sendContent(targetId?: string) {
    if (targetId !== undefined) targetToScroll = targetId;
    const item = getItem();
    const sessionId = getSessionId();
    if (closed) return;
    const content = await readMarkdownContent(item);
    if (closed || !isCurrent()) return;
    const lib = Zotero.Libraries.get(item.libraryID) as any;
    const itemUri =
      lib?.libraryType === "user"
        ? `zotero://select/library/items/${item.key}`
        : `zotero://select/groups/${item.libraryID}/items/${item.key}`;
    post({
      type: "set-content",
      sessionId,
      content: content.content,
      error: content.error || null,
      fileUri: content.fileUri || "",
      itemUri,
      itemId: item.id,
      targetId: targetToScroll || null,
      pending: markdownLinkCoordinator.getPendingLink(),
    });
  }

  function sendScrollTarget(id: string) {
    targetToScroll = id;
    post({
      type: "scroll-to-target",
      sessionId: getSessionId(),
      targetId: id,
    });
  }

  async function openTarget(
    sourceItem: Zotero.Item,
    href: string,
    sessionAtStart: string,
  ) {
    const classified = classifyMarkdownLink(href);
    if (classified.kind !== "markdown-target") {
      if (closed || !isCurrent()) return;
      await openMarkdownLink(sourceItem, href);
      return;
    }
    const targetItem = await findMarkdownItemByTarget(classified.target);
    if (closed || !isCurrent()) return;
    if (getSessionId() !== sessionAtStart) return;
    if (!targetItem) {
      fail("找不到目标 Markdown 笔记");
      return;
    }
    await navigateToTarget(targetItem, classified.target.targetId);
  }

  function handleMessage(event: MessageEvent) {
    const msg = event.data;
    if (!msg || typeof msg !== "object" || !msg.type) return;

    if (msg.type === "viewer-ready") {
      if (!isMessageFromViewer(event)) return;
      if (!pendingTimer)
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          void sendContent();
        }, 50);
      return;
    }

    if (!isMessageFromViewer(event)) return;
    const item = getItem();
    const sessionId = getSessionId();
    if (msg.sessionId !== sessionId) return;

    if (msg.type === "markdown-save") {
      const requestId =
        typeof msg.requestId === "string" ? msg.requestId : null;
      if (!requestId || typeof msg.content !== "string") return;
      Promise.resolve()
        .then(() => saveMarkdownContent(item, msg.content as string))
        .then((res) => {
          if (closed || !isCurrent()) return;
          post({
            type: "save-result",
            sessionId: getSessionId(),
            requestId,
            success: res.success,
            error: res.error || null,
          });
        })
        .catch((error: any) => {
          if (closed || !isCurrent()) return;
          post({
            type: "save-result",
            sessionId: getSessionId(),
            requestId,
            success: false,
            error: error?.message ?? "Markdown save failed",
          });
        });
    } else if (msg.type === "load-image") {
      const requestId = msg.requestId as string;
      const src = msg.src as string;
      if (!requestId || !src) return;
      readMarkdownImage(item, src).then((res) => {
        if (closed || !isCurrent()) return;
        post({
          type: "image-result",
          sessionId: getSessionId(),
          requestId,
          src,
          dataUrl: res.dataUrl || null,
          error: res.error || null,
        });
      });
    } else if (msg.type === "open-link") {
      void openTarget(item, msg.href as string, sessionId);
    } else if (msg.type === "markdown-link-action") {
      const request = msg.request;
      const requestId =
        request && typeof request.requestId === "string"
          ? request.requestId
          : null;
      if (!requestId) return;
      const validRequest =
        typeof request.action === "string" &&
        typeof request.markdown === "string" &&
        request.selection &&
        typeof request.selection.from === "number" &&
        typeof request.selection.to === "number";
      const postResult = (
        result: markdownLinkCoordinator.LinkOperationResult,
      ) => {
        if (closed || !isCurrent()) return;
        post({
          type: "markdown-link-result",
          sessionId: getSessionId(),
          requestId,
          result,
        });
      };
      if (!validRequest) {
        postResult({
          success: false,
          message: "Malformed Markdown link request",
        });
        return;
      }
      Promise.resolve(
        markdownLinkCoordinator.applyMarkdownLinkAction(
          item,
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
    }
  }

  unsubscribePendingLink = markdownLinkCoordinator.subscribePendingLink(
    (pending) => {
      if (closed || !isCurrent()) return;
      post({
        type: "pending-link-changed",
        sessionId: getSessionId(),
        pending,
      });
    },
  );

  unsubscribeFileUpdated = markdownLinkCoordinator.subscribeFileUpdated(
    (itemId) => {
      if (itemId !== getItem().id) return;
      void sendContent();
    },
  );

  const cleanup = () => {
    closed = true;
    unsubscribePendingLink?.();
    unsubscribePendingLink = null;
    unsubscribeFileUpdated?.();
    unsubscribeFileUpdated = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
  };

  return { sendContent, sendScrollTarget, handleMessage, cleanup };
}
