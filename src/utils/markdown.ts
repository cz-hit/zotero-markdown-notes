import {
  binaryToBase64,
  filePathToUri,
  getImageMimeType,
  resolveMarkdownImagePath,
} from "./markdownImage";

export {
  isMarkdownAttachment,
  findMarkdownAttachments,
  findMarkdownAttachmentsUnderItem,
  findMarkdownAttachmentsInCollection,
  findMarkdownAttachmentsInLibrary,
  findMarkdownItemByTarget,
  getNoteLabel,
  filterNotesByTitle,
  readMarkdownContent,
  readMarkdownImage,
  saveMarkdownContent,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
};
export type { MarkdownNoteScope };

const MAX_FILE_SIZE = 1_048_576; // 1MB
const MAX_IMAGE_SIZE = 20 * 1_048_576; // 20MB

/**
 * Check if a Zotero item is an .md file attachment.
 * Returns true only for child attachments whose filename ends with .md or .markdown.
 */
function isMarkdownAttachment(
  item: Zotero.Item | null | undefined,
): item is Zotero.Item {
  if (!item) return false;
  if (!item.isFileAttachment?.()) return false;
  // In Zotero, isFileAttachment returns true for the attachment itself;
  // the attachment item has a filename accessible via getFilePath or attachmentFilename
  const filename =
    (item as Zotero.Item & { attachmentFilename?: string })
      .attachmentFilename || "";
  return /\.(md|markdown)$/i.test(filename);
}

/** Return every Markdown file attachment visible in the available libraries. */
async function findMarkdownAttachments(): Promise<Zotero.Item[]> {
  const result: Zotero.Item[] = [];
  const libraries = (Zotero as any).Libraries?.getAll?.() ?? [{ libraryID: 1 }];
  for (const library of libraries) {
    const rawItems = await Promise.resolve(
      (Zotero as any).Items?.getAll?.(library.libraryID),
    );
    const items = Array.isArray(rawItems) ? rawItems : [];
    for (const entry of items) {
      const item =
        typeof entry === "number" || typeof entry === "string"
          ? (Zotero as any).Items?.get?.(entry)
          : entry;
      if (isMarkdownAttachment(item)) result.push(item);
    }
  }
  return result;
}

/** Return every Markdown file attachment whose parent item is `parentItem`. */
function findMarkdownAttachmentsUnderItem(
  parentItem: Zotero.Item,
): Zotero.Item[] {
  const result: Zotero.Item[] = [];
  const ids: number[] =
    typeof parentItem.getAttachments === "function"
      ? parentItem.getAttachments()
      : [];
  for (const id of ids) {
    const child = Zotero.Items.get(id);
    if (isMarkdownAttachment(child)) result.push(child);
  }
  return result;
}

/** Return every Markdown file attachment owned by items in `collection`. */
async function findMarkdownAttachmentsInCollection(
  collection: Zotero.Collection,
): Promise<Zotero.Item[]> {
  const result: Zotero.Item[] = [];
  const items = collection.getChildItems() as Zotero.Item[];
  for (const item of items) {
    result.push(...findMarkdownAttachmentsUnderItem(item));
  }
  return result;
}

/** Return every Markdown file attachment in a single library. */
async function findMarkdownAttachmentsInLibrary(
  libraryID: number,
): Promise<Zotero.Item[]> {
  const result: Zotero.Item[] = [];
  const rawItems = await Promise.resolve(
    (Zotero as any).Items?.getAll?.(libraryID),
  );
  const items = Array.isArray(rawItems) ? rawItems : [];
  for (const entry of items) {
    const item =
      typeof entry === "number" || typeof entry === "string"
        ? (Zotero as any).Items?.get?.(entry)
        : entry;
    if (isMarkdownAttachment(item)) result.push(item);
  }
  return result;
}

/**
 * Resolve a Markdown attachment item from a `{ libraryID, itemKey }` target.
 * Returns null when the item does not exist or is not a Markdown attachment.
 */
async function findMarkdownItemByTarget(target: {
  libraryID: number;
  itemKey: string;
}): Promise<Zotero.Item | null> {
  const items = Zotero.Items as any;
  let item = items.getByLibraryAndKey?.(target.libraryID, target.itemKey);
  if (item && typeof item.then === "function") item = await item;

  // getByLibraryAndKey is the efficient and supported lookup. Older Zotero
  // versions may not expose it, so fall back to a library-scoped getAll.
  if (!item && typeof items.getAll === "function") {
    try {
      const all = await Promise.resolve(items.getAll(target.libraryID));
      for (const entry of Array.isArray(all) ? all : []) {
        const candidate = typeof entry === "number" ? items.get(entry) : entry;
        if (
          candidate?.libraryID === target.libraryID &&
          candidate?.key === target.itemKey
        ) {
          item = candidate;
          break;
        }
      }
    } catch (error) {
      ztoolkit.log("findMarkdownItemByTarget fallback failed:", error);
    }
  }
  return item && isMarkdownAttachment(item) ? item : null;
}

/** Human-readable label for a Markdown note entry. */
function getNoteLabel(item: Zotero.Item): string {
  const filename = (item as Zotero.Item & { attachmentFilename?: string })
    .attachmentFilename;
  if (filename) return filename;
  const title = item.getField?.("title");
  if (title) return title;
  return String(item.id);
}

/** Scope for the sidebar note switcher. Never crosses libraries. */
type MarkdownNoteScope = "item" | "collection" | "library";

/** Filter note items by filename/title. Empty query returns every item. */
function filterNotesByTitle(
  items: Zotero.Item[],
  query: string,
): Zotero.Item[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => getNoteLabel(item).toLowerCase().includes(q));
}

/**
 * Read the text content of an .md attachment.
 * Returns null if the file cannot be read, doesn't exist, or is too large.
 */
async function readMarkdownContent(item: Zotero.Item): Promise<{
  content: string | null;
  error?: string;
  fileUri?: string;
}> {
  try {
    const filepath = await item.getFilePathAsync?.();
    if (!filepath) {
      return { content: null, error: "File not found" };
    }

    const fileUri = filePathToUri(filepath);

    // Check if file exists
    const file = (Zotero as any).File?.pathToFile
      ? (Zotero as any).File.pathToFile(filepath)
      : null;

    if (!file || !file.exists?.()) {
      return { content: null, error: "File not found on disk" };
    }

    // Check file size
    const fileSize = file.fileSize ?? 0;
    if (fileSize > MAX_FILE_SIZE) {
      return { content: null, error: "File too large" };
    }

    // Read file content — check API availability first
    const getContents = Zotero.File.getContentsAsync;
    if (typeof getContents === "function") {
      const content: string | null = (await getContents(filepath)) as
        | string
        | null;
      if (content !== null && content !== undefined) {
        return { content, fileUri };
      }
    }
    // Fallback: try binary read for older Zotero versions
    const getBinaryContents = (Zotero.File as any).getBinaryContentsAsync;
    if (typeof getBinaryContents === "function") {
      const data = await getBinaryContents(filepath);
      if (data) {
        return {
          content: new TextDecoder("utf-8").decode(data),
          fileUri,
        };
      }
    }
    return { content: null, error: "Failed to read file" };
  } catch (err: any) {
    return {
      content: null,
      error: err?.message || "Unknown error reading file",
    };
  }
}

async function readMarkdownImage(
  item: Zotero.Item,
  src: string,
): Promise<{ dataUrl?: string; error?: string }> {
  try {
    const markdownFilePath = await item.getFilePathAsync?.();
    if (!markdownFilePath) return { error: "Markdown file path not available" };

    const imagePath = resolveMarkdownImagePath(markdownFilePath, src);
    if (!imagePath) return { error: "Unsupported image path" };

    const mimeType = getImageMimeType(imagePath);
    if (!mimeType) return { error: "Unsupported image type" };

    const file = (Zotero as any).File?.pathToFile?.(imagePath);
    if (!file?.exists?.()) return { error: "Image file not found" };
    if ((file.fileSize ?? 0) > MAX_IMAGE_SIZE) {
      return { error: "Image file too large" };
    }

    const data = await IOUtils.read(imagePath);
    if (!data.length) return { error: "Failed to read image" };

    return {
      dataUrl: `data:${mimeType};base64,${binaryToBase64(data)}`,
    };
  } catch (err: any) {
    return { error: err?.message || "Unknown error reading image" };
  }
}

/**
 * Save text content back to the .md attachment file.
 * Returns success status and optional error message.
 */
async function saveMarkdownContent(
  item: Zotero.Item,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const filepath = await item.getFilePathAsync?.();
    if (!filepath) {
      return { success: false, error: "File path not available" };
    }

    // Check if the write API is available
    const putContents = (Zotero.File as any).putContentsAsync;
    if (typeof putContents !== "function") {
      return { success: false, error: "Write API not available" };
    }

    // Write the content
    await putContents(filepath, content);

    // Force Zotero to re-index the attachment
    await item.saveTx?.();

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || "Unknown error saving file",
    };
  }
}
