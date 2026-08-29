export type SearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
};

export type SearchMatch = { from: number; to: number };

export function findMarkdownMatches(
  text: string,
  query: string,
  options: SearchOptions = {},
): { matches: SearchMatch[]; error?: string } {
  if (!query) return { matches: [] };
  const flags = options.caseSensitive ? "g" : "gi";
  let pattern = query;
  if (!options.useRegex) pattern = escapeRegExp(pattern);
  if (options.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (error) {
    return {
      matches: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const matches: SearchMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const from = match.index;
    const to = from + match[0].length;
    if (to > from) matches.push({ from, to });
    else regex.lastIndex += 1;
  }
  return { matches };
}

export function replaceMarkdownMatch(
  text: string,
  match: SearchMatch,
  replacement: string,
): string {
  if (match.from < 0 || match.to < match.from || match.to > text.length)
    throw new Error("Search match is out of bounds");
  return text.slice(0, match.from) + replacement + text.slice(match.to);
}

export function replaceAllMarkdownMatches(
  text: string,
  matches: SearchMatch[],
  replacement: string,
): string {
  return matches
    .slice()
    .sort((a, b) => b.from - a.from)
    .reduce(
      (result, match) => replaceMarkdownMatch(result, match, replacement),
      text,
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
