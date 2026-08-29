import Cherry, { MenuHookBase } from "cherry-markdown";
import katex from "katex";
// @ts-expect-error esbuild text loader bundles CSS into the viewer.
import katexCss from "katex/dist/katex.min.css";
// @ts-expect-error esbuild text loader bundles Cherry's CSS into this file.
import cherryCss from "cherry-markdown/dist/cherry-markdown.css";
import { isDirectImageSource } from "../utils/markdownImage";
import {
  getLinkActionBlockedMessage,
  getLinkButtonState,
  type LinkButtonState,
  type PendingLinkState,
  type PendingSource,
} from "../utils/links";
import {
  getMarkdownEditorSelection,
  MARKDOWN_LINK_TOOLBAR,
} from "../utils/markdownToolbar";
import {
  findMarkdownMatches,
  replaceAllMarkdownMatches,
  type SearchMatch,
  type SearchOptions,
} from "../utils/markdownSearch";

type BridgeMessage = Record<string, unknown> & { type?: string };
type ImageEntry = { dataUrl: string | null; error?: string };
type LinkSelection = { from: number; to: number };
type LinkAction = "set-target" | "set-link" | "cancel";

let requestSequence = 0;
let pendingLinkRequestId: string | null = null;
let pending: PendingLinkState = null;
let currentItemId: number | undefined;
let activeToolbarButton: string | null = null;
let targetToScroll: string | null = null;
let scrollGeneration = 0;
// false = pure preview (default), true = source-edit + preview.
let editMode = false;

function hydratePending(value: unknown): PendingLinkState {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    kind?: unknown;
    target?: Record<string, unknown>;
    source?: Record<string, unknown>;
  };
  if (candidate.kind === "target" && candidate.target) {
    const target = candidate.target;
    if (
      typeof target.targetId === "string" &&
      typeof target.itemId === "number" &&
      typeof target.libraryID === "number" &&
      typeof target.itemKey === "string"
    ) {
      return {
        kind: "target",
        target: {
          targetId: target.targetId,
          itemId: target.itemId,
          libraryID: target.libraryID,
          itemKey: target.itemKey,
        },
      };
    }
  }
  if (candidate.kind === "source" && candidate.source) {
    const source = candidate.source as PendingSource;
    if (
      typeof source.itemId === "number" &&
      typeof source.libraryID === "number" &&
      typeof source.itemKey === "string" &&
      typeof source.label === "string" &&
      typeof source.from === "number" &&
      typeof source.to === "number"
    ) {
      return { kind: "source", source };
    }
  }
  return null;
}

function sourceSelection(): LinkSelection {
  return getMarkdownEditorSelection((cherry as any)?.editor?.editor);
}

function linkActionEnabled(state: LinkButtonState, action: string): boolean {
  if (action === "set-target") return state.setTarget;
  if (action === "set-link") return state.setLink;
  if (action === "cancel") return state.cancel;
  return false;
}

function requestLinkAction(action: LinkAction) {
  if (pendingLinkRequestId) return;
  const selection = sourceSelection();
  const state = getLinkButtonState(
    currentContent,
    selection,
    pending,
    currentItemId,
  );
  const blockedMessage = getLinkActionBlockedMessage(action, selection, state);
  if (blockedMessage) {
    setViewerStatus(blockedMessage);
    return;
  }
  setViewerStatus("");
  const requestId = `markdown-link-${++requestSequence}`;
  pendingLinkRequestId = requestId;
  activeToolbarButton = action;
  updateLinkButtonState();
  postToBackend({
    type: "markdown-link-action",
    request: { requestId, action, markdown: currentContent, selection },
  });
}

// Cherry dispatches custom menu actions through its own toolbar listener. Use
// one capture-phase listener as the single native entry point so the C action
// cannot be swallowed by a disabled-looking span or fired twice by Cherry's
// click/pointerup sequence.
document.addEventListener(
  "click",
  (event) => {
    const element = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-markdown-link-action]",
    );
    const action = element?.getAttribute("data-markdown-link-action");
    if (
      !element ||
      !action ||
      !["set-target", "set-link", "cancel"].includes(action)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!pendingLinkRequestId) requestLinkAction(action as LinkAction);
  },
  true,
);

document.addEventListener(
  "pointerup",
  (event) => {
    const element = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-markdown-link-action]",
    );
    const action = element?.getAttribute("data-markdown-link-action");
    if (
      !element ||
      !action ||
      !["set-target", "set-link", "cancel"].includes(action)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!pendingLinkRequestId) requestLinkAction(action as LinkAction);
  },
  true,
);

class LinkMenuBase extends MenuHookBase {
  action: LinkAction;
  label: string;
  accessibleLabel: string;
  constructor(
    $cherry: any,
    action: LinkAction,
    label: string,
    accessibleLabel: string,
  ) {
    super($cherry);
    this.action = action;
    this.label = label;
    this.accessibleLabel = accessibleLabel;
    this.setName(label);
  }
  private applyButtonAttributes(button: HTMLElement) {
    button.textContent = this.label;
    button.setAttribute("data-markdown-link-action", this.action);
    button.setAttribute("aria-label", this.accessibleLabel);
    button.setAttribute("title", this.accessibleLabel);
  }
  createBtn(asSubMenu = false): HTMLSpanElement {
    const button = super.createBtn(asSubMenu);
    if (!asSubMenu) this.applyButtonAttributes(button);
    return button;
  }
  afterInit(button: HTMLElement) {
    this.applyButtonAttributes(button);
    if (button.dataset.markdownLinkClickBound === "true") return;
    const handleNativeClick = () => {
      if (!pendingLinkRequestId) requestLinkAction(this.action);
    };
    button.addEventListener("click", handleNativeClick);
    button.addEventListener("pointerup", handleNativeClick);
    button.dataset.markdownLinkClickBound = "true";
  }
  onClick() {
    requestLinkAction(this.action);
  }
}

class SetTargetMenu extends LinkMenuBase {
  constructor($cherry: any) {
    super($cherry, "set-target", "A", "设置链接目标");
  }
}
class SetLinkMenu extends LinkMenuBase {
  constructor($cherry: any) {
    super($cherry, "set-link", "B", "设置链接");
  }
}
class CancelLinkMenu extends LinkMenuBase {
  constructor($cherry: any) {
    super($cherry, "cancel", "C", "取消链接或目标");
  }
}

class SearchMenu extends MenuHookBase {
  constructor($cherry: any) {
    super($cherry);
    this.setName("查找");
  }
  createBtn(asSubMenu = false): HTMLSpanElement {
    const button = super.createBtn(asSubMenu);
    if (!asSubMenu) {
      button.textContent = "查找";
      button.setAttribute("aria-label", "查找和替换");
      button.setAttribute("title", "查找和替换");
      button.setAttribute("data-markdown-search", "true");
    }
    return button;
  }
  afterInit(button: HTMLElement) {
    if (button.dataset.markdownSearchClickBound === "true") return;
    button.addEventListener("click", () => openSearchPanel(false));
    button.addEventListener("pointerup", () => openSearchPanel(false));
    button.dataset.markdownSearchClickBound = "true";
  }
  onClick() {
    openSearchPanel(false);
  }
}

/**
 * Toggle between pure-preview (default) and source-edit + preview. Lives in
 * Cherry's sidebar, which stays visible even when the top toolbar is hidden in
 * preview-only mode — so the switch back to editing is always reachable.
 */
class EditToggleMenu extends MenuHookBase {
  constructor($cherry: any) {
    super($cherry);
    this.setName("编辑", "pen");
  }
  createBtn(asSubMenu = false): HTMLSpanElement {
    const button = super.createBtn(asSubMenu);
    if (!asSubMenu) {
      button.setAttribute("data-markdown-edit-toggle", "true");
    }
    return button;
  }
  afterInit(button: HTMLElement) {
    refreshEditToggleButton(button);
  }
  onClick() {
    toggleEditMode();
  }
}

function setEditMode(enabled: boolean) {
  editMode = enabled;
  cherry?.switchModel(enabled ? "edit&preview" : "previewOnly", enabled);
  document
    .querySelectorAll<HTMLElement>("[data-markdown-edit-toggle]")
    .forEach(refreshEditToggleButton);
}

function toggleEditMode() {
  setEditMode(!editMode);
}

function refreshEditToggleButton(button: HTMLElement) {
  const icon = button.querySelector<HTMLElement>("i.ch-icon");
  if (icon) {
    icon.classList.toggle("ch-icon-pen", !editMode);
    icon.classList.toggle("ch-icon-pen-fill", editMode);
  }
  button.setAttribute(
    "title",
    editMode ? "切换到纯预览模式" : "切换到编辑模式",
  );
  button.setAttribute(
    "aria-label",
    editMode ? "切换到纯预览模式" : "切换到编辑模式",
  );
  button.setAttribute("aria-pressed", String(editMode));
  button.classList.toggle("active", editMode);
}

let searchPanel: HTMLDivElement | null = null;
let searchInput: HTMLInputElement | null = null;
let replaceInput: HTMLInputElement | null = null;
let searchMatches: SearchMatch[] = [];
let searchMatchIndex = -1;
let searchOptions: SearchOptions = {};

function editorView(): any {
  return (cherry as any)?.editor?.editor?.view;
}

function refreshSearchMatches() {
  if (!searchInput) return;
  searchOptions = {
    caseSensitive:
      searchPanel?.querySelector<HTMLInputElement>("[data-search-case]")
        ?.checked,
    wholeWord:
      searchPanel?.querySelector<HTMLInputElement>("[data-search-word]")
        ?.checked,
    useRegex: searchPanel?.querySelector<HTMLInputElement>(
      "[data-search-regex]",
    )?.checked,
  };
  const result = findMarkdownMatches(
    currentContent,
    searchInput.value,
    searchOptions,
  );
  searchMatches = result.matches;
  if (searchMatches.length && searchMatchIndex < 0) searchMatchIndex = 0;
  if (searchMatchIndex >= searchMatches.length)
    searchMatchIndex = searchMatches.length - 1;
  const counter = searchPanel?.querySelector<HTMLElement>(
    "[data-search-counter]",
  );
  if (counter)
    counter.textContent = result.error
      ? "正则错误"
      : `${searchMatches.length ? searchMatchIndex + 1 : 0}/${searchMatches.length}`;
  const status = searchPanel?.querySelector<HTMLElement>("[data-search-error]");
  if (status) status.textContent = result.error || "";
  searchPanel
    ?.querySelectorAll<HTMLButtonElement>("[data-search-replace]")
    .forEach((button) => {
      button.disabled = !searchMatches.length || !!result.error;
    });
}

function selectSearchMatch(index: number) {
  const view = editorView();
  const match = searchMatches[index];
  if (!view || !match) return;
  searchMatchIndex = index;
  view.dispatch({
    selection: { anchor: match.from, head: match.to },
    scrollIntoView: true,
  });
  refreshSearchMatches();
}

function replaceCurrentSearchMatch() {
  const view = editorView();
  const match = searchMatches[searchMatchIndex];
  if (!view || !match || !replaceInput) return;
  view.dispatch({
    changes: { from: match.from, to: match.to, insert: replaceInput.value },
    selection: {
      anchor: match.from,
      head: match.from + replaceInput.value.length,
    },
    scrollIntoView: true,
  });
  window.setTimeout(refreshSearchMatches, 0);
}

function replaceAllSearchMatches() {
  const view = editorView();
  if (!view || !replaceInput || !searchMatches.length) return;
  const content = replaceAllMarkdownMatches(
    currentContent,
    searchMatches,
    replaceInput.value,
  );
  view.dispatch({
    changes: { from: 0, to: currentContent.length, insert: content },
  });
  searchMatchIndex = -1;
  window.setTimeout(refreshSearchMatches, 0);
}

function closeSearchPanel() {
  searchPanel?.remove();
  searchPanel = null;
  searchInput = null;
  replaceInput = null;
  searchMatches = [];
  searchMatchIndex = -1;
}

function openSearchPanel(expandReplace: boolean, selected = true) {
  if (searchPanel) {
    if (expandReplace) searchPanel.classList.add("is-replace-expanded");
    searchInput?.focus();
    return;
  }
  searchPanel = document.createElement("div");
  searchPanel.className = "markdown-search-panel";
  const makeButton = (label: string, attribute: string, value: string) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute(attribute, value);
    return button;
  };
  const makeInput = (attribute: string, label: string, placeholder: string) => {
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute(attribute, "true");
    input.setAttribute("aria-label", label);
    input.placeholder = placeholder;
    return input;
  };
  const searchRow = document.createElement("div");
  searchRow.className = "markdown-search-row";
  searchInput = makeInput("data-search-input", "查找", "查找");
  const counter = document.createElement("span");
  counter.setAttribute("data-search-counter", "true");
  counter.textContent = "0/0";
  searchRow.append(
    searchInput,
    counter,
    makeButton("↑", "data-search-prev", "true"),
    makeButton("↓", "data-search-next", "true"),
    makeButton("×", "data-search-close", "true"),
  );
  const replaceRow = document.createElement("div");
  replaceRow.className = "markdown-replace-row";
  replaceInput = makeInput("data-replace-input", "替换", "替换");
  replaceRow.append(
    replaceInput,
    makeButton("替换", "data-search-replace", "one"),
    makeButton("全部替换", "data-search-replace", "all"),
  );
  const optionsRow = document.createElement("div");
  optionsRow.className = "markdown-search-options";
  const addOption = (attribute: string, label: string) => {
    const wrapper = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute(attribute, "true");
    wrapper.append(checkbox, document.createTextNode(` ${label}`));
    optionsRow.append(wrapper);
  };
  addOption("data-search-case", "区分大小写");
  addOption("data-search-word", "整词");
  addOption("data-search-regex", "正则");
  const error = document.createElement("span");
  error.setAttribute("data-search-error", "true");
  optionsRow.append(error);
  searchPanel.append(searchRow, replaceRow, optionsRow);
  document.body.appendChild(searchPanel);
  searchInput = searchPanel.querySelector<HTMLInputElement>(
    "[data-search-input]",
  );
  replaceInput = searchPanel.querySelector<HTMLInputElement>(
    "[data-replace-input]",
  );
  searchPanel
    .querySelector("[data-search-close]")
    ?.addEventListener("click", closeSearchPanel);
  searchPanel
    .querySelector("[data-search-prev]")
    ?.addEventListener("click", () =>
      selectSearchMatch(
        (searchMatchIndex - 1 + searchMatches.length) % searchMatches.length,
      ),
    );
  searchPanel
    .querySelector("[data-search-next]")
    ?.addEventListener("click", () =>
      selectSearchMatch((searchMatchIndex + 1) % searchMatches.length),
    );
  searchPanel
    .querySelector('[data-search-replace="one"]')
    ?.addEventListener("click", replaceCurrentSearchMatch);
  searchPanel
    .querySelector('[data-search-replace="all"]')
    ?.addEventListener("click", replaceAllSearchMatches);
  searchPanel
    .querySelectorAll("input")
    .forEach((input) => input.addEventListener("input", refreshSearchMatches));
  if (expandReplace) searchPanel.classList.add("is-replace-expanded");
  const selection = sourceSelection();
  const view = editorView();
  const selectedText =
    selected && view
      ? view.state.doc.sliceString(selection.from, selection.to)
      : "";
  if (selectedText) searchInput.value = selectedText;
  searchInput.focus();
  searchInput.select();
  refreshSearchMatches();
}

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openSearchPanel(false);
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "h"
  ) {
    event.preventDefault();
    openSearchPanel(true);
  } else if (event.key === "Escape" && searchPanel) {
    event.preventDefault();
    closeSearchPanel();
  }
});

function updateLinkButtonState() {
  const state = getLinkButtonState(
    currentContent,
    sourceSelection(),
    pending,
    currentItemId,
  );
  document
    .querySelectorAll<HTMLElement>("[data-markdown-link-action]")
    .forEach((button) => {
      const action = button.getAttribute("data-markdown-link-action");
      if (!action) return;
      const enabled = linkActionEnabled(state, action);
      const active = action === activeToolbarButton;
      button.classList.toggle("active", active);
      button.classList.toggle("disabled", !enabled);
      button.toggleAttribute("disabled", !enabled);
      button.setAttribute("aria-disabled", String(!enabled));
      button.setAttribute("aria-pressed", String(active));
    });
}

document.addEventListener("selectionchange", updateLinkButtonState);
document.addEventListener("keyup", updateLinkButtonState);
document.addEventListener("mouseup", updateLinkButtonState);

function scrollToTarget(targetId: string) {
  targetToScroll = targetId;
  const generation = ++scrollGeneration;
  const find = (attempt: number) => {
    if (generation !== scrollGeneration || targetToScroll !== targetId) return;
    const target = document.getElementById(targetId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("markdown-target-highlight");
      window.setTimeout(
        () => target.classList.remove("markdown-target-highlight"),
        1600,
      );
      return;
    }
    if (attempt < 30) {
      window.setTimeout(() => find(attempt + 1), 50);
    } else {
      setViewerStatus(`Markdown target not found: ${targetId}`);
    }
  };
  requestAnimationFrame(() => find(0));
}

function handleMarkdownLinkResult(message: BridgeMessage) {
  if (
    typeof message.requestId !== "string" ||
    message.requestId !== pendingLinkRequestId
  )
    return;
  pendingLinkRequestId = null;
  const result = message.result as Record<string, unknown> | undefined;
  if (!result || result.success !== true) {
    activeToolbarButton = null;
    updateLinkButtonState();
    setViewerStatus(String(result?.message || "Markdown link action failed"));
    return;
  }
  // A successful backend action owns the current markdown state, including
  // cancel actions whose content is unchanged.
  invalidatePendingSave();
  if (typeof result.content === "string" && result.content !== currentContent) {
    suppressChange = true;
    currentContent = result.content;
    cherry?.setValue(result.content, false);
    suppressChange = false;
  }
  pending = hydratePending(result.pending);
  activeToolbarButton = null;
  updateLinkButtonState();
  setViewerStatus("Markdown link updated");
}

type StorageLike = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "clear" | "key"
> & {
  readonly length: number;
};

function installLocalStorageShim() {
  const memory = new Map<string, string>();
  let realStorage: Storage | null = null;

  try {
    const candidate = globalThis.localStorage;
    candidate.getItem("__markdown_note_storage_probe__");
    realStorage = candidate;
  } catch {
    // Zotero chrome iframes can expose localStorage while rejecting access.
  }

  const storage: StorageLike = {
    get length() {
      if (realStorage) {
        try {
          return realStorage.length;
        } catch {
          realStorage = null;
        }
      }
      return memory.size;
    },
    getItem(key) {
      if (realStorage) {
        try {
          return realStorage.getItem(key);
        } catch {
          realStorage = null;
        }
      }
      return memory.get(key) ?? null;
    },
    setItem(key, value) {
      if (realStorage) {
        try {
          realStorage.setItem(key, value);
          return;
        } catch {
          realStorage = null;
        }
      }
      memory.set(key, value);
    },
    removeItem(key) {
      if (realStorage) {
        try {
          realStorage.removeItem(key);
          return;
        } catch {
          realStorage = null;
        }
      }
      memory.delete(key);
    },
    clear() {
      if (realStorage) {
        try {
          realStorage.clear();
          return;
        } catch {
          realStorage = null;
        }
      }
      memory.clear();
    },
    key(index) {
      if (realStorage) {
        try {
          return realStorage.key(index);
        } catch {
          realStorage = null;
        }
      }
      return Array.from(memory.keys())[index] ?? null;
    },
  };

  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
  } catch {
    try {
      globalThis.localStorage = storage as Storage;
    } catch {
      // The property is not replaceable; Cherry may still work in this context.
    }
  }
}

installLocalStorageShim();
const cherryModulePromise = import("cherry-markdown");

const SAVE_DEBOUNCE_MS = 500;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
let sessionId = "";
let pendingSaveRequestId: string | null = null;
let saveRequestSequence = 0;
let markdownFileUri = "";
let currentContent = "";
let cherry: Cherry | null = null;
let cherryInitPromise: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let imageRequestCounter = 0;
let readyRetryCount = 0;
let suppressChange = false;
const imageCache = new Map<string, ImageEntry>();
const pendingImages = new Set<string>();
let imageObserver: MutationObserver | null = null;

const style = document.createElement("style");
style.textContent = `${cherryCss}
${katexCss}
/* Cherry's own cherry--no-toolbar class (added in preview-only mode) hides both
   the top toolbar and the floating sidebar. Keep the sidebar visible so the
   edit/preview toggle and theme buttons stay reachable from preview mode. */
.cherry.cherry--no-toolbar .cherry-sidebar { display: block; height: auto; top: 0; padding-top: 8px; }
.markdown-search-panel { position: fixed; z-index: 1000; top: 42px; right: 12px; min-width: 360px; padding: 8px; color: var(--cherry-color, inherit); background: var(--cherry-bg-color, Canvas); border: 1px solid ButtonBorder; border-radius: 4px; box-shadow: 0 2px 8px rgb(0 0 0 / 25%); font: menu; }
.markdown-search-row, .markdown-replace-row, .markdown-search-options { display: flex; align-items: center; gap: 4px; margin-bottom: 5px; }
.markdown-search-row input, .markdown-replace-row input { flex: 1; min-width: 0; }
.markdown-search-panel button { padding: 2px 7px; }
.markdown-search-options { font-size: 0.85em; flex-wrap: wrap; }
.markdown-search-options span { color: #c33; }
`;
document.head.appendChild(style);

const viewerStatus = document.getElementById("viewer-status") as HTMLDivElement;

function setViewerStatus(message = "") {
  viewerStatus.textContent = message;
  viewerStatus.style.display = message ? "block" : "none";
}

function postToBackend(message: BridgeMessage) {
  const target = window.parent !== window ? window.parent : window.opener;
  if (target) target.postMessage({ ...message, sessionId }, "*");
}

/**
 * Cherry's `search` toolbar item triggers `SearcherPanel`, whose constructor
 * crashes inside Zotero's chrome iframe: `createDOM()` sets
 * `container.innerHTML = buildSearcherPanelHtml(...)` but the resulting
 * `.cherry-searcher__input` element is never produced, so `cacheElements()`
 * throws "SearcherPanel: missing element". That error is thrown from the end
 * of `initText` — AFTER the previewer has already rendered the markdown — and
 * otherwise aborts the whole Cherry constructor, which is what blocks images.
 *
 * Patching `initText` to swallow only this specific error decouples "search"
 * from everything else: Cherry init completes, images load, and the search
 * toolbar button degrades to a harmless no-op if the panel could not be built
 * (Cherry's own `triggerSearcher` already guards a missing bridge).
 */
function patchSearcherCrash(CherryConstructor: unknown) {
  const prototype = (
    CherryConstructor as {
      prototype?: { initText?: (...args: unknown[]) => unknown };
    }
  ).prototype;
  if (!prototype) return;
  const original = prototype.initText;
  if (typeof original !== "function") return;
  prototype.initText = function (this: unknown, ...args: unknown[]) {
    try {
      return original.apply(this, args);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text.includes("SearcherPanel")) {
        console.warn("[MDViewer] SearcherPanel unavailable:", error);
        setViewerStatus("search unavailable (Cherry bug in Zotero iframe)");
        return;
      }
      throw error;
    }
  };
}

async function setContent(content: string) {
  currentContent = content;
  setViewerStatus("");
  if (!cherry && cherryInitPromise) {
    await cherryInitPromise;
    if (!cherry) return;
    suppressChange = true;
    cherry.setValue(content, false);
    suppressChange = false;
    requestImages();
    return;
  }
  if (!cherry) {
    let resolveInit!: () => void;
    cherryInitPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    console.log("[MDViewer] setContent: initializing Cherry");
    try {
      const { default: CherryConstructor } = await cherryModulePromise;
      patchSearcherCrash(CherryConstructor);
      cherry = new CherryConstructor({
        el: document.getElementById("cherry-markdown") as HTMLElement,
        value: content,
        nameSpace: "markdown-note-viewer",
        locale: "en_US",
        editor: {
          defaultModel: "previewOnly",
          height: "100%",
          codemirror: { autofocus: false },
        },
        engine: {
          syntax: {
            mathBlock: { engine: "katex" },
            inlineMath: { engine: "katex" },
            htmlBlock: { filterStyle: false },
          },
        },
        // Disable Cherry's lazy image loading entirely (noLoadImgNum = -1 keeps
        // every <img> on a plain `src` attribute instead of moving it to
        // `data-src`).  The panel bridge is the single owner of image loading:
        // it reads the markdown-relative `src`, resolves it against the item's
        // storage directory, and returns a data URL.  If Cherry's lazy loader
        // runs in parallel it races with that bridge and can overwrite the data
        // URL with the unresolved relative path.
        previewer: {
          lazyLoadImg: { noLoadImgNum: -1 },
        },
        externals: { katex },
        toolbars: {
          showToolbar: true,
          toolbar: [
            "bold",
            "italic",
            "strikethrough",
            "header",
            "quote",
            "list",
            "ol",
            "ul",
            "checklist",
            "code",
            "link",
            "image",
            "table",
            "quickTable",
            "formula",
            "color",
            "toc",
            "undo",
            "redo",
            "customMenu_mdnSearch",
            "fullScreen",
            MARKDOWN_LINK_TOOLBAR.target,
            MARKDOWN_LINK_TOOLBAR.link,
            MARKDOWN_LINK_TOOLBAR.cancel,
          ],
          // Editing-unrelated controls live in the floating sidebar, which
          // stays visible in pure-preview mode when the top toolbar is hidden.
          sidebar: ["customMenu_mdnEdit", "theme"],
          customMenu: {
            [MARKDOWN_LINK_TOOLBAR.target]: SetTargetMenu,
            [MARKDOWN_LINK_TOOLBAR.link]: SetLinkMenu,
            [MARKDOWN_LINK_TOOLBAR.cancel]: CancelLinkMenu,
            customMenu_mdnSearch: SearchMenu,
            customMenu_mdnEdit: EditToggleMenu,
          },
          toc: { defaultModel: "full", position: "absolute" },
          config: { formula: { showLatexLive: true } },
        },
        callback: {
          afterChange: (text: string) => {
            if (suppressChange) return;
            currentContent = text;
            scheduleSave(text);
            requestImages();
            if (searchPanel) refreshSearchMatches();
          },
          onClickPreview: (event: MouseEvent) => {
            const anchor = (event.target as Element | null)?.closest("a");
            const href = anchor?.getAttribute("href");
            if (!href || href.startsWith("#")) return;
            event.preventDefault();
            postToBackend({ type: "open-link", href });
            return false;
          },
        },
      });
    } catch (error) {
      cherry = null;
      console.error("[MDViewer] Cherry init failed:", error);
      setViewerStatus(
        `Cherry init failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      resolveInit();
      cherryInitPromise = null;
      return;
    }
    observeRenderedImages();
    requestImages();
    resolveInit();
    cherryInitPromise = null;
    return;
  }

  suppressChange = true;
  console.log(
    "[MDViewer] setContent: cherry.setValue(len=",
    content.length,
    ")",
  );
  cherry.setValue(content, false);
  suppressChange = false;
  requestImages();
}

function invalidatePendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingSaveRequestId = null;
}

function clearContent(error: unknown) {
  invalidatePendingSave();
  imageCache.clear();
  pendingImages.clear();
  suppressChange = true;
  setContent("");
  suppressChange = false;
  setViewerStatus(
    typeof error === "string" ? error : "Failed to load Markdown file",
  );
}

function scheduleSave(content: string) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    postToBackend({
      type: "markdown-save",
      requestId:
        (pendingSaveRequestId = `markdown-save-${++saveRequestSequence}`),
      content,
    });
  }, SAVE_DEBOUNCE_MS);
}

function getBridgeImageSource(source: string): string {
  // Reverse a browser-resolved chrome://<host>/content/<path> URL back to the
  // markdown-relative path.  This must NOT depend on document.baseURI: in
  // Zotero's item pane the viewer iframe runs under a null principal, so
  // document.baseURI is about:blank while the browser still resolves a
  // relative image src against the chrome:// document URL.  Any chrome://
  // src on an <img> is always a mis-resolved Markdown path — there is no
  // legitimate chrome:// image in a Markdown file.
  const match = /^chrome:\/\/[^/]+\/content\/(.+)$/.exec(source);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return source;
}

function requestImages() {
  const root = document.getElementById("cherry-markdown");
  if (!root) return;
  const imgs = root.querySelectorAll<HTMLImageElement>("img");
  const scanned = Array.from(imgs).map((img) => ({
    dataMarkdown: img.getAttribute("data-markdown-image-src"),
    dataSrc: img.getAttribute("data-src"),
    src: img.getAttribute("src"),
  }));
  console.log(
    "[MDViewer] requestImages: found",
    imgs.length,
    "img(s)",
    JSON.stringify(scanned),
  );
  setViewerStatus(
    `img scan: ${imgs.length} img(s), iframes=${document.querySelectorAll("iframe").length}`,
  );
  imgs.forEach((img) => {
    const source =
      img.getAttribute("data-markdown-image-src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("src");
    const bridgeSource = source ? getBridgeImageSource(source) : "";
    if (!bridgeSource || isDirectImageSource(bridgeSource)) return;
    img.setAttribute("data-markdown-image-src", bridgeSource);
    // Stop Cherry's lazy loader (and the browser) from racing with the bridge:
    // drop every `data-src`/`data-original`/`src` while we own this image.
    img.removeAttribute("data-src");
    img.removeAttribute("data-original");
    const cached = imageCache.get(bridgeSource);
    if (cached) {
      applyImage(img, cached);
      return;
    }
    img.removeAttribute("src");
    if (pendingImages.has(bridgeSource)) return;
    pendingImages.add(bridgeSource);
    imageRequestCounter += 1;
    console.log("[MDViewer] load-image ->", bridgeSource);
    setViewerStatus(`img: loading ${bridgeSource}`);
    postToBackend({
      type: "load-image",
      requestId: `image-${imageRequestCounter}`,
      src: bridgeSource,
    });
  });
}

function observeRenderedImages() {
  const root = document.getElementById("cherry-markdown");
  if (!root || imageObserver) return;
  imageObserver = new MutationObserver(() => requestImages());
  imageObserver.observe(root, { childList: true, subtree: true });
  requestAnimationFrame(() => requestImages());
  setTimeout(requestImages, 100);
  setTimeout(requestImages, 500);
}

function applyImage(img: HTMLImageElement, entry: ImageEntry) {
  if (entry.dataUrl) {
    img.setAttribute("src", entry.dataUrl);
    img.removeAttribute("data-src");
    img.removeAttribute("data-original");
    img.removeAttribute("title");
    img.classList.remove("markdown-image-error");
  } else {
    img.removeAttribute("src");
    img.setAttribute("title", entry.error || "Failed to load image");
    img.classList.add("markdown-image-error");
  }
}

function handleImageResult(message: BridgeMessage) {
  const src = message.src;
  if (typeof src !== "string") return;
  pendingImages.delete(src);
  const entry: ImageEntry = {
    dataUrl: typeof message.dataUrl === "string" ? message.dataUrl : null,
    error: typeof message.error === "string" ? message.error : undefined,
  };
  console.log(
    "[MDViewer] image-result:",
    src,
    entry.dataUrl
      ? `ok (${Math.round(entry.dataUrl.length / 1024)} KiB data URL)`
      : `ERROR ${entry.error}`,
  );
  setViewerStatus(
    entry.dataUrl
      ? `img: ok ${src}`
      : `img: ERROR ${src} — ${entry.error || "unknown"}`,
  );
  imageCache.set(src, entry);
  document
    .getElementById("cherry-markdown")
    ?.querySelectorAll<HTMLImageElement>("img[data-markdown-image-src]")
    .forEach((img) => {
      if (img.getAttribute("data-markdown-image-src") === src)
        applyImage(img, entry);
    });
}

window.addEventListener("message", (event: MessageEvent<BridgeMessage>) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "set-content") {
    if (typeof message.sessionId === "string" && message.sessionId) {
      if (message.sessionId !== sessionId) {
        closeSearchPanel();
        pendingLinkRequestId = null;
        pendingSaveRequestId = null;
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        activeToolbarButton = null;
      }
      sessionId = message.sessionId;
    }
    pending = hydratePending(message.pending);
    const fileUri = message.fileUri;
    if (typeof message.itemId === "number") currentItemId = message.itemId;
    if (typeof fileUri === "string" && fileUri !== markdownFileUri) {
      markdownFileUri = fileUri;
      imageCache.clear();
      pendingImages.clear();
    }
    console.log(
      "[MDViewer] set-content:",
      "sessionId=",
      message.sessionId,
      "fileUri=",
      message.fileUri,
      "contentLen=",
      typeof message.content === "string" ? message.content.length : "n/a",
      "error=",
      message.error ?? "none",
    );
    if (message.error) {
      clearContent(message.error);
      return;
    }
    if (typeof message.content === "string") {
      setContent(message.content).then(() => {
        if (typeof message.targetId === "string")
          scrollToTarget(message.targetId);
        updateLinkButtonState();
      });
    }
  } else if (
    message.type === "pending-link-changed" &&
    message.sessionId === sessionId
  ) {
    pending = hydratePending(message.pending);
    activeToolbarButton = null;
    updateLinkButtonState();
  } else if (
    message.type === "scroll-to-target" &&
    message.sessionId === sessionId &&
    typeof message.targetId === "string"
  ) {
    scrollToTarget(message.targetId);
  } else if (
    message.type === "markdown-link-result" &&
    message.sessionId === sessionId
  ) {
    handleMarkdownLinkResult(message);
  } else if (
    message.type === "image-result" &&
    message.sessionId === sessionId
  ) {
    handleImageResult(message);
  } else if (
    message.type === "save-result" &&
    message.sessionId === sessionId &&
    typeof message.requestId === "string" &&
    message.requestId === pendingSaveRequestId
  ) {
    pendingSaveRequestId = null;
    if (!message.success)
      setViewerStatus(String(message.error || "Markdown save failed"));
  }
});

let zoomLevel = 1;
try {
  const stored = Number.parseFloat(localStorage.getItem("mdn-zoom") || "");
  if (Number.isFinite(stored))
    zoomLevel = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, stored));
} catch {
  // localStorage is unavailable in some Zotero browsing contexts.
}

function applyZoom() {
  const fontSize = `${16 * zoomLevel}px`;
  document.documentElement.style.fontSize = fontSize;
  document.documentElement.style.setProperty("--base-font-size", fontSize);
  document.documentElement.style.setProperty(
    "--font-size-xs",
    `${12 * zoomLevel}px`,
  );
  document.documentElement.style.setProperty(
    "--font-size-sm",
    `${14 * zoomLevel}px`,
  );
  document.documentElement.style.setProperty("--font-size-md", fontSize);
  document.documentElement.style.setProperty(
    "--font-size-lg",
    `${18 * zoomLevel}px`,
  );
  document.documentElement.style.setProperty(
    "--font-size-xl",
    `${20 * zoomLevel}px`,
  );
  document.documentElement.style.setProperty(
    "--font-size-2xl",
    `${24 * zoomLevel}px`,
  );
  document.documentElement.style.setProperty(
    "--font-size-3xl",
    `${30 * zoomLevel}px`,
  );
  document
    .querySelectorAll<HTMLElement>(
      ".cherry-editor, .cherry-previewer, .cm-content, .cm-gutters",
    )
    .forEach((element) => {
      element.style.fontSize = fontSize;
    });
  try {
    localStorage.setItem("mdn-zoom", String(zoomLevel));
  } catch {
    // Ignore unavailable storage.
  }
}

document.addEventListener(
  "wheel",
  (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomLevel = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        zoomLevel + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP),
      ),
    );
    applyZoom();
  },
  { passive: false },
);
applyZoom();

function sendViewerReady() {
  postToBackend({
    type: "viewer-ready",
    env: {
      url: location.href,
      origin,
      baseURI: document.baseURI,
      iframes: document.querySelectorAll("iframe").length,
    },
  });
  if (!currentContent && readyRetryCount < 20) {
    readyRetryCount += 1;
    setTimeout(sendViewerReady, 250);
  }
}

sendViewerReady();
