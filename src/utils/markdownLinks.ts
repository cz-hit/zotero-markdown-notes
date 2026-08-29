export const MARKDOWN_TARGET_PREFIX = "mdn-target-";

export type MarkdownTarget = {
  libraryID: number;
  itemKey: string;
  targetId: string;
};

export type TextRange = { from: number; to: number };

export type MarkdownLinkMatch = {
  range: TextRange;
  labelRange: TextRange;
  href: string;
  label: string;
  target: MarkdownTarget;
};

export type MarkdownTargetMatch = {
  range: TextRange;
  targetId: string;
};

type RawMarkdownLink = {
  range: TextRange;
  labelRange: TextRange;
  href: string;
  label: string;
};

const TARGET_ID_PATTERN = /^mdn-target-[A-Za-z0-9_-]+$/;
const TARGET_ID_IN_ANCHOR = /<span id="(mdn-target-[A-Za-z0-9_-]+)"><\/span>/g;

export function serializeMarkdownTarget(target: MarkdownTarget): string {
  if (
    !target ||
    !Number.isSafeInteger(target.libraryID) ||
    target.libraryID < 1 ||
    typeof target.itemKey !== "string" ||
    target.itemKey.length === 0 ||
    typeof target.targetId !== "string" ||
    !TARGET_ID_PATTERN.test(target.targetId)
  ) {
    throw new Error("Invalid Markdown target");
  }

  const path =
    target.libraryID === 1
      ? `zotero://select/library/items/${encodeURIComponent(target.itemKey)}`
      : `zotero://select/groups/${target.libraryID}/items/${encodeURIComponent(target.itemKey)}`;
  return `${path}#${target.targetId}`;
}

export function parseMarkdownTarget(href: string): MarkdownTarget | null {
  if (typeof href !== "string") return null;

  const fragment = "(mdn-target-[A-Za-z0-9_-]+)";
  const user = new RegExp(
    `^zotero://select/library/items/([^/?#]+)#${fragment}$`,
  ).exec(href);
  if (user) {
    return decodedTarget(1, user[1], user[2]);
  }

  const group = new RegExp(
    `^zotero://select/groups/(\\d+)/items/([^/?#]+)#${fragment}$`,
  ).exec(href);
  if (!group) return null;

  const libraryID = Number(group[1]);
  if (!Number.isSafeInteger(libraryID) || libraryID < 2) return null;
  return decodedTarget(libraryID, group[2], group[3]);
}

function decodedTarget(
  libraryID: number,
  encodedItemKey: string,
  targetId: string,
): MarkdownTarget | null {
  try {
    const itemKey = decodeURIComponent(encodedItemKey);
    return itemKey ? { libraryID, itemKey, targetId } : null;
  } catch {
    return null;
  }
}

export function targetAnchor(targetId: string): string {
  if (typeof targetId !== "string" || !TARGET_ID_PATTERN.test(targetId)) {
    throw new Error("Invalid Markdown target ID");
  }
  return `<span id="${targetId}"></span>`;
}

export function insertTarget(
  markdown: string,
  selection: TextRange,
  targetId: string,
): string {
  if (findTargetAtSelection(markdown, selection)) return markdown;
  if (!isSupportedLinkSelection(markdown, selection)) {
    throw new Error("Selection is not safe for a Markdown target");
  }
  const anchor = targetAnchor(targetId);
  return (
    markdown.slice(0, selection.from) + anchor + markdown.slice(selection.from)
  );
}

export function wrapSelectionInTargetLink(
  markdown: string,
  selection: TextRange,
  target: MarkdownTarget,
): string {
  if (!isSupportedLinkSelection(markdown, selection)) {
    throw new Error("Selection is not supported for a Markdown link");
  }
  const label = markdown
    .slice(selection.from, selection.to)
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
  const href = serializeMarkdownTarget(target);
  return `${markdown.slice(0, selection.from)}[${label}](${href})${markdown.slice(selection.to)}`;
}

export function findTargetAtSelection(
  markdown: string,
  selection: TextRange,
): MarkdownTargetMatch | null {
  if (!validNonEmptyRange(markdown, selection)) return null;
  const protectedRanges = nonHtmlSyntaxRanges(markdown);
  if (protectedRanges.some((range) => rangesOverlap(selection, range))) {
    return null;
  }

  let nearest: MarkdownTargetMatch | null = null;

  for (const anchor of scanTargetAnchors(markdown)) {
    const afterAnchor = markdown.slice(anchor.range.to, selection.from);
    const sameParagraph = !/\n\s*\n/.test(afterAnchor);
    const crossesProtectedRange = protectedRanges.some(
      (protectedRange) =>
        protectedRange.from >= anchor.range.to &&
        protectedRange.to <= selection.from,
    );
    const isInOrAfterAnchor =
      rangesOverlap(selection, anchor.range) ||
      (selection.from >= anchor.range.to &&
        sameParagraph &&
        !crossesProtectedRange);
    if (
      isInOrAfterAnchor &&
      (!nearest || anchor.range.from > nearest.range.from)
    ) {
      nearest = anchor;
    }
  }
  return nearest;
}

export function findMarkdownTargetLinks(markdown: string): MarkdownLinkMatch[] {
  return scanMarkdownLinks(markdown)
    .map((match) => {
      const target = parseMarkdownTarget(normalizeDestination(match.href));
      return target ? { ...match, target } : null;
    })
    .filter((match): match is MarkdownLinkMatch => match !== null);
}

/** Return every target anchor in the document (used for orphan scans). */
export function findMarkdownTargetAnchors(
  markdown: string,
): MarkdownTargetMatch[] {
  return scanTargetAnchors(markdown);
}

export function findMarkdownTargetLinkAtSelection(
  markdown: string,
  selection: TextRange,
): MarkdownLinkMatch | null {
  if (!validNonEmptyRange(markdown, selection)) return null;
  return (
    findMarkdownTargetLinks(markdown).find((match) =>
      rangesOverlap(selection, match.range),
    ) ?? null
  );
}

export function unwrapMarkdownLink(
  markdown: string,
  match: MarkdownLinkMatch,
): string {
  if (
    !match ||
    !validRange(markdown, match.range) ||
    markdown.slice(match.range.from, match.range.to) !==
      `[${match.label}](${match.href})`
  ) {
    throw new Error("Markdown link match is stale");
  }
  return (
    markdown.slice(0, match.range.from) +
    match.label +
    markdown.slice(match.range.to)
  );
}

export function removeTargetAnchor(markdown: string, targetId: string): string {
  const anchor = targetAnchor(targetId);
  const ranges = scanTargetAnchors(markdown)
    .filter((match) => match.targetId === targetId)
    .map((match) => match.range)
    .reverse();
  let result = markdown;
  for (const range of ranges) {
    if (result.slice(range.from, range.to) !== anchor) continue;
    result = result.slice(0, range.from) + result.slice(range.to);
  }
  return result;
}

export function isSupportedLinkSelection(
  markdown: string,
  selection: TextRange,
): boolean {
  if (!validNonEmptyRange(markdown, selection)) return false;
  if (
    nonHtmlSyntaxRanges(markdown).some((range) =>
      rangesOverlap(selection, range),
    )
  ) {
    return false;
  }
  if (
    htmlTagRanges(markdown).some((range) => rangesOverlap(selection, range))
  ) {
    return false;
  }
  return !scanMarkdownLinks(markdown).some((match) =>
    rangesOverlap(selection, match.range),
  );
}

function validNonEmptyRange(markdown: string, range: TextRange): boolean {
  return (
    typeof markdown === "string" &&
    validRange(markdown, range) &&
    range.from < range.to
  );
}

function validRange(markdown: string, range: TextRange): boolean {
  return (
    !!range &&
    Number.isInteger(range.from) &&
    Number.isInteger(range.to) &&
    range.from >= 0 &&
    range.to <= markdown.length
  );
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.from < b.to && b.from < a.to;
}

function scanTargetAnchors(markdown: string): MarkdownTargetMatch[] {
  const protectedRanges = nonHtmlSyntaxRanges(markdown);
  const tagRanges = htmlTagRanges(markdown);
  const anchors: MarkdownTargetMatch[] = [];
  TARGET_ID_IN_ANCHOR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TARGET_ID_IN_ANCHOR.exec(markdown))) {
    const range = { from: match.index, to: match.index + match[0].length };
    const inNonHtmlSyntax = protectedRanges.some((protectedRange) =>
      rangesOverlap(range, protectedRange),
    );
    const inAnotherHtmlTag = tagRanges.some(
      (tagRange) => range.from > tagRange.from && range.from < tagRange.to,
    );
    if (!inNonHtmlSyntax && !inAnotherHtmlTag) {
      anchors.push({ range, targetId: match[1] });
    }
  }
  return anchors;
}

function scanMarkdownLinks(markdown: string): RawMarkdownLink[] {
  const links: RawMarkdownLink[] = [];
  const protectedRanges = markdownSyntaxRanges(markdown);
  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown[i] !== "[" || isEscaped(markdown, i)) continue;
    const labelEnd = findClosingBracket(markdown, i);
    if (labelEnd < 0 || markdown[labelEnd + 1] !== "(") continue;

    const destination = findDestination(markdown, labelEnd + 2);
    if (!destination || !destination.href.trim()) continue;
    const range = { from: i, to: destination.to };
    const hasProtectedSyntax = protectedRanges.some((protectedRange) => {
      const isAngleDestination =
        protectedRange.from === labelEnd + 2 &&
        markdown[protectedRange.from] === "<";
      return rangesOverlap(range, protectedRange) && !isAngleDestination;
    });
    if (hasProtectedSyntax) {
      continue;
    }
    links.push({
      range,
      labelRange: { from: i + 1, to: labelEnd },
      href: destination.href,
      label: markdown.slice(i + 1, labelEnd),
    });
  }
  return links;
}

function findClosingBracket(markdown: string, start: number): number {
  let depth = 1;
  for (let i = start + 1; i < markdown.length; i += 1) {
    if (markdown[i] === "\\") {
      i += 1;
      continue;
    }
    if (markdown[i] === "[") depth += 1;
    if (markdown[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

type Destination = { href: string; to: number };

function findDestination(markdown: string, start: number): Destination | null {
  let depth = 1;
  let quote = "";
  let angle = markdown[start] === "<";
  for (let i = start; i < markdown.length; i += 1) {
    const char = markdown[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (angle) {
      if (char === ">") angle = false;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")" && --depth === 0) {
      const href = markdown.slice(start, i);
      return isValidDestination(href) ? { href, to: i + 1 } : null;
    }
  }
  return null;
}

function normalizeDestination(destination: string): string {
  const trimmed = destination.trim();
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close < 0) return trimmed;
    return trimmed.slice(1, close);
  }
  const title = /^(\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(trimmed);
  return title ? title[1] : trimmed;
}

function isValidDestination(destination: string): boolean {
  const trimmed = destination.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close < 1) return false;
    return (
      !trimmed.slice(close + 1).trim() ||
      isValidTitle(trimmed.slice(close + 1).trim())
    );
  }
  if (!/\S+/.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/);
  return (
    parts.length === 1 || isValidTitle(trimmed.slice(parts[0].length).trim())
  );
}

function isValidTitle(title: string): boolean {
  return /^(?:"[^"]*"|'[^']*'|\([^)]*\))$/.test(title);
}

function isEscaped(markdown: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && markdown[i] === "\\"; i -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function nonHtmlSyntaxRanges(markdown: string): TextRange[] {
  return [
    ...fencedCodeRanges(markdown),
    ...inlineCodeRanges(markdown),
    ...htmlCommentRanges(markdown),
  ];
}

function markdownSyntaxRanges(markdown: string): TextRange[] {
  return [...nonHtmlSyntaxRanges(markdown), ...htmlTagRanges(markdown)];
}

function htmlCommentRanges(markdown: string): TextRange[] {
  const ranges: TextRange[] = [];
  const commentStart = /<!--/g;
  let match: RegExpExecArray | null;
  while ((match = commentStart.exec(markdown))) {
    const end = markdown.indexOf("-->", match.index + 4);
    const to = end < 0 ? markdown.length : end + 3;
    ranges.push({ from: match.index, to });
    commentStart.lastIndex = to;
  }
  return ranges;
}

function inlineCodeRanges(markdown: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown[i] !== "`" || isEscaped(markdown, i)) continue;
    let runLength = 1;
    while (markdown[i + runLength] === "`") runLength += 1;
    const delimiter = "`".repeat(runLength);
    const close = markdown.indexOf(delimiter, i + runLength);
    const to = close < 0 ? markdown.length : close + runLength;
    ranges.push({ from: i, to });
    i = to - 1;
  }
  return ranges;
}

function htmlTagRanges(markdown: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown[i] !== "<" || markdown.startsWith("<!--", i)) continue;
    let quote = "";
    for (let j = i + 1; j < markdown.length; j += 1) {
      const char = markdown[j];
      if (quote) {
        if (char === quote && !isEscaped(markdown, j)) quote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        ranges.push({ from: i, to: j + 1 });
        i = j;
        break;
      }
    }
  }
  return ranges;
}

function fencedCodeRanges(markdown: string): TextRange[] {
  const ranges: TextRange[] = [];
  let open: { from: number; char: string; length: number } | null = null;
  let offset = 0;
  const lines = markdown.match(/[^\n]*(?:\n|$)/g) ?? [];
  for (const lineWithBreak of lines) {
    if (!lineWithBreak) continue;
    const line = lineWithBreak.replace(/\n$/, "").replace(/\r$/, "");
    const lineEnd = offset + lineWithBreak.length;
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open && fence) {
      open = { from: offset, char: fence[1][0], length: fence[1].length };
    } else if (
      open &&
      new RegExp(
        `^ {0,3}${escapeRegExp(open.char)}{${open.length},}\\s*$`,
      ).test(line)
    ) {
      ranges.push({ from: open.from, to: lineEnd });
      open = null;
    }
    offset = lineEnd;
  }
  if (open) ranges.push({ from: open.from, to: markdown.length });
  return ranges;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
