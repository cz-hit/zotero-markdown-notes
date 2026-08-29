import {
  findMarkdownAttachments,
  readMarkdownContent,
  saveMarkdownContent,
} from "../utils/markdown";
import {
  findMarkdownTargetAnchors,
  findMarkdownTargetLinkAtSelection,
  findMarkdownTargetLinks,
  findTargetAtSelection,
  insertTarget,
  isSupportedLinkSelection,
  removeTargetAnchor,
  serializeMarkdownTarget,
  targetAnchor,
  unwrapMarkdownLink,
  wrapSelectionInTargetLink,
  type MarkdownLinkMatch,
  type MarkdownTarget,
  type MarkdownTargetMatch,
  type TextRange,
} from "../utils/markdownLinks";
import type {
  PendingLinkState,
  PendingSource,
  PendingTarget,
} from "../utils/links";

export type LinkOperationResult = {
  success: boolean;
  content?: string;
  message?: string;
  pending?: PendingLinkState;
};

type FileState = { item: Zotero.Item; content: string };

let pending: PendingLinkState = null;
const pendingListeners = new Set<(p: PendingLinkState) => void>();

function publishPending(): void {
  for (const listener of pendingListeners) listener(pending);
}

function setPending(next: PendingLinkState): void {
  pending = next;
  publishPending();
}

export function subscribePendingLink(
  listener: (p: PendingLinkState) => void,
): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

export function getPendingLink(): PendingLinkState {
  return pending;
}

export function clearPendingLink(): void {
  setPending(null);
}

const fileUpdatedListeners = new Set<(itemId: number) => void>();

/** Subscribe to programmatic file writes so viewers can reload stale content. */
export function subscribeFileUpdated(
  listener: (itemId: number) => void,
): () => void {
  fileUpdatedListeners.add(listener);
  return () => fileUpdatedListeners.delete(listener);
}

export function notifyFileUpdated(itemId: number): void {
  for (const listener of fileUpdatedListeners) listener(itemId);
}

function newTargetId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues)
    crypto.getRandomValues(bytes);
  else
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Math.floor(Math.random() * 256);
  return `mdn-target-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function readFiles(): Promise<{
  files: FileState[];
  error?: string;
  skipped: { filename: string; reason: string }[];
}> {
  const files: FileState[] = [];
  const skipped: { filename: string; reason: string }[] = [];
  try {
    for (const item of await findMarkdownAttachments()) {
      const result = await readMarkdownContent(item);
      if (result.content === null) {
        // A missing/oversized file must not abort the whole scan; record it so
        // callers can surface the gap without losing the readable files.
        const filename = (item as any).attachmentFilename || String(item.id);
        const reason = result.error ?? "Failed to read Markdown file";
        skipped.push({ filename, reason });
        ztoolkit.log(
          `[MarkdownNote] Skip unreadable Markdown file ${filename}: ${reason}`,
        );
        continue;
      }
      files.push({ item, content: result.content });
    }
    return { files, skipped };
  } catch (error: any) {
    return {
      files: [],
      skipped,
      error: error?.message ?? "Failed to scan Markdown files",
    };
  }
}

function sameTarget(a: MarkdownTarget, b: MarkdownTarget): boolean {
  return (
    a.libraryID === b.libraryID &&
    a.itemKey === b.itemKey &&
    a.targetId === b.targetId
  );
}

async function preflightWrites(
  files: FileState[],
  changes: Map<Zotero.Item, string>,
): Promise<string | undefined> {
  for (const file of files) {
    if (!changes.has(file.item) || changes.get(file.item) === file.content)
      continue;
    const path = await (file.item as any).getFilePathAsync?.();
    if (!path) return "Markdown file path not available";
    const diskFile = (Zotero as any).File?.pathToFile?.(path);
    if (!diskFile?.exists?.()) return "Markdown file not found";
    if (typeof (Zotero as any).File?.putContentsAsync !== "function")
      return "Write API not available";
  }
}

async function writeChanges(
  files: FileState[],
  changes: Map<Zotero.Item, string>,
): Promise<LinkOperationResult> {
  const written: FileState[] = [];
  try {
    const preflightError = await preflightWrites(files, changes);
    if (preflightError) return { success: false, message: preflightError };
    for (const file of files) {
      const changed = changes.get(file.item);
      if (changed === undefined || changed === file.content) continue;
      // Track the attempted write before calling saveMarkdownContent. That
      // helper may write the file successfully and then fail while saving the
      // Zotero transaction, so the failing file also needs restoration.
      written.push(file);
      const result = await saveMarkdownContent(file.item, changed);
      if (!result.success)
        throw new Error(result.error ?? "Failed to save Markdown file");
    }
    return { success: true };
  } catch (error: any) {
    const writtenNames = written.map(
      (file) => (file.item as any).attachmentFilename || String(file.item.id),
    );
    const rollbackFailures: string[] = [];
    for (const file of [...written].reverse()) {
      const restored = await saveMarkdownContent(file.item, file.content);
      if (!restored.success)
        rollbackFailures.push(
          (file.item as any).attachmentFilename || String(file.item.id),
        );
    }
    const details = writtenNames.length
      ? `; already written: ${writtenNames.join(", ")}`
      : "";
    const rollback = rollbackFailures.length
      ? `; rollback failed: ${rollbackFailures.join(", ")}`
      : "; previous files restored where possible";
    return {
      success: false,
      message: `${error?.message ?? "Failed to save Markdown file"}${details}${rollback}`,
    };
  }
}

type TextEdit = { from: number; to: number; insert: string };

/** Apply a set of non-overlapping edits whose ranges reference the original text. */
function applyTextEdits(content: string, edits: TextEdit[]): string {
  let result = content;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  }
  return result;
}

/** Insert an anchor and wrap a link in the same source text (B-first, same note). */
function combineTargetAndLink(
  markdown: string,
  targetSelection: TextRange,
  targetId: string,
  target: MarkdownTarget,
  linkSelection: TextRange,
): string {
  const label = markdown.slice(linkSelection.from, linkSelection.to);
  const escaped = label
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
  return applyTextEdits(markdown, [
    {
      from: targetSelection.from,
      to: targetSelection.from,
      insert: targetAnchor(targetId),
    },
    {
      from: linkSelection.from,
      to: linkSelection.to,
      insert: `[${escaped}](${serializeMarkdownTarget(target)})`,
    },
  ]);
}

async function completeSourceToTarget(
  item: Zotero.Item,
  markdown: string,
  selection: TextRange,
  source: PendingSource,
): Promise<LinkOperationResult> {
  const existing = findTargetAtSelection(markdown, selection);
  const targetId = existing?.targetId ?? newTargetId();
  const target: MarkdownTarget = {
    libraryID: item.libraryID,
    itemKey: item.key,
    targetId,
  };

  // Same note: both halves live in the current content.
  if (source.itemId === item.id) {
    if (selection.from < source.to && source.from < selection.to)
      return { success: false, message: "目标不能与链接文本重叠" };
    if (
      source.from < 0 ||
      source.from >= source.to ||
      source.to > markdown.length ||
      markdown.slice(source.from, source.to) !== source.label
    )
      return { success: false, message: "Link text changed; reselect it" };
    try {
      const content = existing
        ? wrapSelectionInTargetLink(
            markdown,
            { from: source.from, to: source.to },
            target,
          )
        : combineTargetAndLink(markdown, selection, targetId, target, {
            from: source.from,
            to: source.to,
          });
      const saved = await saveMarkdownContent(item, content);
      if (!saved.success)
        return {
          success: false,
          message: saved.error ?? "Failed to save Markdown file",
        };
      setPending(null);
      return { success: true, content, pending: null };
    } catch (error: any) {
      return {
        success: false,
        message: error?.message ?? "Selection is not safe",
      };
    }
  }

  // Cross-note: read the source file and verify the stored selection.
  const sourceItem = Zotero.Items.get(source.itemId);
  if (!sourceItem)
    return { success: false, message: "Link source note not found" };
  const sourceRead = await readMarkdownContent(sourceItem as Zotero.Item);
  if (sourceRead.content === null)
    return {
      success: false,
      message: sourceRead.error ?? "Failed to read link source",
    };
  if (
    source.from < 0 ||
    source.from >= source.to ||
    source.to > sourceRead.content.length ||
    sourceRead.content.slice(source.from, source.to) !== source.label
  )
    return { success: false, message: "Link text changed; reselect it" };

  let targetContent = markdown;
  if (!existing) targetContent = insertTarget(markdown, selection, targetId);
  const sourceContent = wrapSelectionInTargetLink(
    sourceRead.content,
    { from: source.from, to: source.to },
    target,
  );

  const files: FileState[] = [
    { item, content: markdown },
    { item: sourceItem as Zotero.Item, content: sourceRead.content },
  ];
  const changes = new Map<Zotero.Item, string>();
  if (targetContent !== markdown) changes.set(item, targetContent);
  if (sourceContent !== sourceRead.content)
    changes.set(sourceItem as Zotero.Item, sourceContent);

  const result = await writeChanges(files, changes);
  if (!result.success) return result;
  setPending(null);
  // The current viewer is refreshed by the markdown-link-result it receives.
  // The source file lives in another viewer, so tell it to reload explicitly.
  notifyFileUpdated(source.itemId);
  return {
    success: true,
    content: changes.get(item) ?? markdown,
    pending: null,
  };
}

export async function setTarget(
  item: Zotero.Item,
  markdown: string,
  selection: TextRange,
): Promise<LinkOperationResult> {
  if (pending?.kind === "target")
    return { success: false, message: "A target is already pending" };

  // Completing a B-first operation: link the stored source to this target.
  if (pending?.kind === "source")
    return completeSourceToTarget(item, markdown, selection, pending.source);

  // A-first: reuse an existing target at the selection, or create a new anchor.
  const existing = findTargetAtSelection(markdown, selection);
  const targetId = existing?.targetId ?? newTargetId();
  const target: PendingTarget = {
    itemId: item.id,
    libraryID: item.libraryID,
    itemKey: item.key,
    targetId,
  };
  if (existing) {
    setPending({ kind: "target", target });
    return {
      success: true,
      content: markdown,
      pending: { kind: "target", target },
    };
  }
  try {
    const content = insertTarget(markdown, selection, targetId);
    const saved = await saveMarkdownContent(item, content);
    if (!saved.success)
      return {
        success: false,
        message: saved.error ?? "Failed to save Markdown file",
      };
    setPending({ kind: "target", target });
    return {
      success: true,
      content,
      pending: { kind: "target", target },
    };
  } catch (error: any) {
    return {
      success: false,
      message: error?.message ?? "Selection is not safe",
    };
  }
}

export async function setLink(
  item: Zotero.Item,
  markdown: string,
  selection: TextRange,
): Promise<LinkOperationResult> {
  if (pending?.kind === "source")
    return {
      success: false,
      message: "Link text is already pending; select a target with A",
    };

  // B-first: remember the selection as the link text without writing anything.
  if (!pending) {
    if (
      !isSupportedLinkSelection(markdown, selection) ||
      findTargetAtSelection(markdown, selection)
    )
      return {
        success: false,
        message: "Selection is not supported for a Markdown link",
      };
    const source: PendingSource = {
      itemId: item.id,
      libraryID: item.libraryID,
      itemKey: item.key,
      label: markdown.slice(selection.from, selection.to),
      from: selection.from,
      to: selection.to,
    };
    setPending({ kind: "source", source });
    return {
      success: true,
      content: markdown,
      pending: { kind: "source", source },
    };
  }

  // A-first completion: link this selection to the pending target.
  const target = pending.target;
  if (
    target.itemId === item.id &&
    findTargetAtSelection(markdown, selection)?.targetId === target.targetId
  )
    return { success: false, message: "A target cannot link to itself" };
  try {
    const content = wrapSelectionInTargetLink(markdown, selection, target);
    const saved = await saveMarkdownContent(item, content);
    if (!saved.success)
      return {
        success: false,
        message: saved.error ?? "Failed to save Markdown file",
      };
    setPending(null);
    return { success: true, content, pending: null };
  } catch (error: any) {
    return {
      success: false,
      message: error?.message ?? "Selection is not safe",
    };
  }
}

async function cancelPendingTarget(
  item: Zotero.Item,
  markdown: string,
  target: PendingTarget,
): Promise<LinkOperationResult> {
  const scan = await readFiles();
  if (scan.error) return { success: false, message: scan.error };

  const referenceCount = scan.files.reduce(
    (count, file) =>
      count +
      findMarkdownTargetLinks(file.content).filter((match) =>
        sameTarget(match.target, target),
      ).length,
    0,
  );

  const changes = new Map<Zotero.Item, string>();
  if (referenceCount === 0) {
    for (const file of scan.files) {
      if (
        file.item.libraryID === target.libraryID &&
        file.item.key === target.itemKey
      ) {
        const updated = removeTargetAnchor(file.content, target.targetId);
        if (updated !== file.content) changes.set(file.item, updated);
      }
    }
  }

  const result = changes.size
    ? await writeChanges(scan.files, changes)
    : { success: true as const };
  if (!result.success) return result;
  setPending(null);
  return {
    success: true,
    content: changes.get(item) ?? markdown,
    pending: null,
  };
}

function confirmAnchorDeletion(targetId: string): boolean {
  const win = Zotero.getMainWindow() as any;
  const Services = (globalThis as any).Services ?? win?.Services;
  const prompt = Services?.prompt;
  const message = `目标 ${targetId} 可能仍有链接指向它。删除后，指向它的链接将无法跳转。是否继续删除？`;
  if (prompt?.confirmEx) {
    const flags =
      prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_0 +
      prompt.BUTTON_TITLE_CANCEL * prompt.BUTTON_POS_1;
    return (
      prompt.confirmEx(
        win,
        "删除目标锚点",
        message,
        flags,
        "删除",
        null,
        null,
        null,
        {},
      ) === 0
    );
  }
  if (win?.confirm) return win.confirm(message);
  return false;
}

export async function cancel(
  item: Zotero.Item,
  markdown: string,
  selection: TextRange,
): Promise<LinkOperationResult> {
  // Canceling a pending A-first target: undo the anchor unless referenced.
  if (pending?.kind === "target")
    return cancelPendingTarget(item, markdown, pending.target);

  // Canceling a pending B-first source: nothing was written yet.
  if (pending?.kind === "source") {
    setPending(null);
    return { success: true, content: markdown, pending: null };
  }

  // Direct deletion of an existing link or target. Only the current file is
  // touched; any dangling links or orphaned anchors left behind are cleaned up
  // by the link manager rather than a full-library scan here.
  const targetMatch = findTargetAtSelection(markdown, selection);
  const linkMatch = findMarkdownTargetLinkAtSelection(markdown, selection);
  if (!targetMatch && !linkMatch)
    return {
      success: false,
      message: "Selection is not a Markdown target or link",
    };

  const current = await readMarkdownContent(item);
  if (current.content === null)
    return {
      success: false,
      message: current.error ?? "Failed to read current Markdown file",
    };
  const source = current.content;

  if (linkMatch) {
    const match = findMarkdownTargetLinkAtSelection(source, {
      from: Math.min(linkMatch.range.from, source.length),
      to: Math.min(linkMatch.range.to, source.length),
    });
    if (!match)
      return { success: false, message: "Selected Markdown link is stale" };
    const content = unwrapMarkdownLink(source, match);
    const saved = await saveMarkdownContent(item, content);
    if (!saved.success)
      return {
        success: false,
        message: saved.error ?? "Failed to save Markdown file",
      };
    return { success: true, content, pending: null };
  }

  // Deleting a target anchor: confirm first, because other links may still
  // point at it (they become dangling and are cleaned up by the manager).
  const targetId = targetMatch!.targetId;
  if (!confirmAnchorDeletion(targetId))
    return { success: false, message: "取消删除" };
  const content = removeTargetAnchor(source, targetId);
  if (content === source) return { success: false, message: "目标锚点不存在" };
  const saved = await saveMarkdownContent(item, content);
  if (!saved.success)
    return {
      success: false,
      message: saved.error ?? "Failed to save Markdown file",
    };
  return { success: true, content, pending: null };
}

export async function applyMarkdownLinkAction(
  item: Zotero.Item,
  action: string,
  markdown: string,
  selection: TextRange,
): Promise<LinkOperationResult> {
  switch (action) {
    case "set-target":
    case "setTarget":
      return setTarget(item, markdown, selection);
    case "set-link":
    case "setLink":
      return setLink(item, markdown, selection);
    case "cancel":
      return cancel(item, markdown, selection);
    default:
      return {
        success: false,
        message: `Unknown Markdown link action: ${action}`,
      };
  }
}

export type OrphanLink = {
  itemId: number;
  libraryID: number;
  itemKey: string;
  filename: string;
  label: string;
  targetId: string;
};

export type OrphanAnchor = {
  itemId: number;
  libraryID: number;
  itemKey: string;
  filename: string;
  targetId: string;
};

export type OrphanScanResult = {
  orphanLinks: OrphanLink[];
  orphanAnchors: OrphanAnchor[];
  skipped: { filename: string; reason: string }[];
  error?: string;
};

/** Scan every readable Markdown file and report orphaned links and anchors. */
export async function scanOrphanLinks(): Promise<OrphanScanResult> {
  const scan = await readFiles();
  if (scan.error)
    return {
      orphanLinks: [],
      orphanAnchors: [],
      skipped: scan.skipped,
      error: scan.error,
    };

  const definedTargetIds = new Set<string>();
  const anchorsByFile: {
    file: FileState;
    anchors: MarkdownTargetMatch[];
  }[] = [];
  for (const file of scan.files) {
    const anchors = findMarkdownTargetAnchors(file.content);
    anchorsByFile.push({ file, anchors });
    for (const anchor of anchors) definedTargetIds.add(anchor.targetId);
  }

  const referencedTargetIds = new Set<string>();
  const linksByFile: { file: FileState; links: MarkdownLinkMatch[] }[] = [];
  for (const file of scan.files) {
    const links = findMarkdownTargetLinks(file.content);
    linksByFile.push({ file, links });
    for (const link of links) referencedTargetIds.add(link.target.targetId);
  }

  const orphanLinks: OrphanLink[] = [];
  for (const { file, links } of linksByFile) {
    for (const link of links) {
      if (definedTargetIds.has(link.target.targetId)) continue;
      orphanLinks.push({
        itemId: file.item.id,
        libraryID: file.item.libraryID,
        itemKey: file.item.key,
        filename: (file.item as any).attachmentFilename || String(file.item.id),
        label: link.label,
        targetId: link.target.targetId,
      });
    }
  }

  const orphanAnchors: OrphanAnchor[] = [];
  for (const { file, anchors } of anchorsByFile) {
    for (const anchor of anchors) {
      if (referencedTargetIds.has(anchor.targetId)) continue;
      orphanAnchors.push({
        itemId: file.item.id,
        libraryID: file.item.libraryID,
        itemKey: file.item.key,
        filename: (file.item as any).attachmentFilename || String(file.item.id),
        targetId: anchor.targetId,
      });
    }
  }

  return { orphanLinks, orphanAnchors, skipped: scan.skipped };
}

/** Delete the given orphaned links and anchors, refreshing affected viewers. */
export async function deleteOrphans(
  orphanLinks: { itemId: number; targetId: string }[],
  orphanAnchors: { itemId: number; targetId: string }[],
): Promise<{
  success: boolean;
  message?: string;
  deletedLinks: number;
  deletedAnchors: number;
}> {
  const scan = await readFiles();
  if (scan.error)
    return {
      success: false,
      message: scan.error,
      deletedLinks: 0,
      deletedAnchors: 0,
    };

  const linkKeys = new Set(orphanLinks.map((l) => `${l.itemId}:${l.targetId}`));
  const anchorKeys = new Set(
    orphanAnchors.map((a) => `${a.itemId}:${a.targetId}`),
  );

  const changes = new Map<Zotero.Item, string>();
  let deletedLinks = 0;
  let deletedAnchors = 0;

  for (const file of scan.files) {
    let content = file.content;

    for (const anchor of findMarkdownTargetAnchors(content)) {
      if (!anchorKeys.has(`${file.item.id}:${anchor.targetId}`)) continue;
      const updated = removeTargetAnchor(content, anchor.targetId);
      if (updated !== content) {
        content = updated;
        deletedAnchors += 1;
      }
    }

    const links = findMarkdownTargetLinks(content).filter((link) =>
      linkKeys.has(`${file.item.id}:${link.target.targetId}`),
    );
    for (const link of [...links].reverse()) {
      content = unwrapMarkdownLink(content, link);
      deletedLinks += 1;
    }

    if (content !== file.content) changes.set(file.item, content);
  }

  if (!changes.size) return { success: true, deletedLinks, deletedAnchors };

  const result = await writeChanges(scan.files, changes);
  if (!result.success)
    return {
      success: false,
      message: result.message,
      deletedLinks,
      deletedAnchors,
    };
  for (const changedItem of changes.keys()) notifyFileUpdated(changedItem.id);
  return { success: true, deletedLinks, deletedAnchors };
}

export class MarkdownLinkCoordinator {
  setTarget = setTarget;
  setLink = setLink;
  cancel = cancel;
  getPendingLink = getPendingLink;
  subscribePendingLink = subscribePendingLink;
  subscribeFileUpdated = subscribeFileUpdated;
  notifyFileUpdated = notifyFileUpdated;
}
