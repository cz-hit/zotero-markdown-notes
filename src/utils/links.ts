/**
 * Link-opening utilities for the Markdown Note plugin.
 *
 * Called from both markdownPanel.ts and markdownReader.ts when the viewer
 * iframe forwards an `open-link` postMessage.
 */

import {
  findMarkdownTargetLinkAtSelection,
  findTargetAtSelection,
  isSupportedLinkSelection,
  type TextRange,
} from "./markdownLinks";
import { parseMarkdownTarget, type MarkdownTarget } from "./markdownLinks";

export type MarkdownLinkTarget =
  | { kind: "markdown-target"; target: MarkdownTarget }
  | { kind: "ordinary"; href: string };

export type LinkButtonState = {
  setTarget: boolean;
  setLink: boolean;
  cancel: boolean;
};

/** A target that has been set via A and is waiting for a B link. */
export type PendingTarget = MarkdownTarget & { itemId: number };

/** A source selection that has been set via B and is waiting for an A target. */
export type PendingSource = {
  itemId: number;
  libraryID: number;
  itemKey: string;
  label: string;
  from: number;
  to: number;
};

/**
 * The runtime "pending half" of a link operation. Either half of an A/B pair
 * can be set first; the other half completes the link. `null` means the editor
 * is in the normal (non-creating) state.
 */
export type PendingLinkState =
  | { kind: "target"; target: PendingTarget }
  | { kind: "source"; source: PendingSource }
  | null;

export function getLinkActionBlockedMessage(
  action: "set-target" | "set-link" | "cancel",
  selection: TextRange,
  state: LinkButtonState,
): string | null {
  if (action === "cancel" && state.cancel) return null;
  if (selection.from >= selection.to) {
    return "请在左侧 Markdown 源码编辑区选择文本";
  }
  if (action === "set-target" && !state.setTarget) {
    return "当前选区不能设置链接目标";
  }
  if (action === "set-link" && !state.setLink) {
    return "请先设置链接目标，或选择可链接的源码文本";
  }
  if (action === "cancel" && !state.cancel) {
    return "当前选区没有可取消的链接或目标";
  }
  return null;
}

export function classifyMarkdownLink(href: string): MarkdownLinkTarget {
  const target = parseMarkdownTarget(href);
  return target
    ? { kind: "markdown-target", target }
    : { kind: "ordinary", href };
}

/**
 * Derive toolbar gates from editor state without touching the DOM.
 *
 * The three buttons follow a pairwise "create a link" model:
 * - A (set-target) is available on plain text (new target) or on an existing
 *   target (reuse), unless a target is already pending.
 * - B (set-link) is available on plain text when nothing is pending, or
 *   unconditionally while a target is pending (so the target can be linked
 *   from another note or viewer).
 * - C (cancel) is available whenever a half is pending, or when the selection
 *   is a link or target that can be deleted.
 */
export function getLinkButtonState(
  markdown: string,
  selection: TextRange,
  pending: PendingLinkState,
  itemId?: number,
): LinkButtonState {
  const targetMatch = findTargetAtSelection(markdown, selection);
  const linkMatch = findMarkdownTargetLinkAtSelection(markdown, selection);
  const supported = isSupportedLinkSelection(markdown, selection);
  const onTarget = !!targetMatch;
  const onLink = !!linkMatch;

  // Linking the pending target back to itself is a self-link.
  const selfLink =
    pending?.kind === "target" &&
    onTarget &&
    pending.target.itemId === itemId &&
    pending.target.targetId === targetMatch!.targetId;

  const setTarget =
    pending?.kind !== "target" && !onLink && (supported || onTarget);
  const setLink =
    pending?.kind === "target"
      ? !selfLink
      : pending == null && supported && !onTarget && !onLink;
  const cancel = pending != null || onTarget || onLink;

  return { setTarget, setLink, cancel };
}

/**
 * Resolve a (possibly relative) markdown link href against the on-disk path
 * of the markdown file that contains it, then open it with the appropriate
 * Zotero / OS handler.
 *
 * Resolution rules:
 *   - http(s):// / mailto:  → Zotero.launchURL
 *   - relative path         → joined with the file's directory, then
 *                              Zotero.launchFile (which is already patched to
 *                              open .md files in the markdown viewer)
 *   - #anchor               → ignored (no in-page scroll support yet)
 */
export async function openMarkdownLink(
  item: Zotero.Item,
  href: string,
): Promise<void> {
  if (!href || href.startsWith("#")) return;

  // External URLs — open in the system browser
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
    Zotero.launchURL(href);
    return;
  }

  if (classifyMarkdownLink(href).kind === "markdown-target") {
    // The coordinator/bridge consumes target links; do not route them through
    // ZoteroPane, which would lose the Markdown fragment semantics.
    ztoolkit.log("[MarkdownNote] Markdown target link awaiting bridge", href);
    return;
  }

  // Zotero internal links (zotero://select/…, zotero://open-pdf/…, etc.)
  if (/^zotero:\/\//i.test(href)) {
    const win = Zotero.getMainWindow() as any;
    win?.ZoteroPane?.loadURI?.(href);
    return;
  }

  // Relative file path — resolve against the markdown file's directory
  try {
    const filePath = await (item as any).getFilePathAsync?.();
    if (!filePath) {
      ztoolkit.log(
        "[MarkdownNote] openMarkdownLink: could not get file path for item",
        item.id,
      );
      return;
    }
    const resolved = resolveRelativePath(filePath, href);
    ztoolkit.log("[MarkdownNote] openMarkdownLink: launching", resolved);
    await (Zotero as any).launchFile(resolved);
  } catch (e) {
    ztoolkit.log("[MarkdownNote] openMarkdownLink error:", e);
  }
}

/**
 * Resolve a relative path segment against a base file path.
 * Handles both Windows (backslash) and POSIX (forward slash) paths,
 * and correctly collapses `.` and `..` segments.
 *
 * @param baseFile  Absolute path to the referencing file (not its directory)
 * @param rel       Relative path from the markdown link
 */
function resolveRelativePath(baseFile: string, rel: string): string {
  // Normalise to forward slashes for processing
  const baseDir = baseFile.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
  const relFwd = rel.replace(/\\/g, "/");
  const combined = baseDir + "/" + relFwd;

  // Collapse . and .. segments
  const parts = combined.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }

  const result = resolved.join("/");
  // Re-apply Windows backslashes if the original path used them
  return baseFile.includes("\\") ? result.replace(/\//g, "\\") : result;
}
