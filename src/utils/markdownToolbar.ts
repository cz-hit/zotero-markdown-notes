export const MARKDOWN_LINK_TOOLBAR = {
  target: "customMenu_mdnTarget",
  link: "customMenu_mdnLink",
  cancel: "customMenu_mdnCancel",
} as const;

export type MarkdownEditorSelection = { from: number; to: number };

export function getMarkdownEditorSelection(
  editor: unknown,
): MarkdownEditorSelection {
  const candidate = editor as {
    state?: { selection?: { main?: Partial<MarkdownEditorSelection> } };
    view?: {
      state?: { selection?: { main?: Partial<MarkdownEditorSelection> } };
    };
  } | null;
  const main =
    candidate?.view?.state?.selection?.main ??
    candidate?.state?.selection?.main;
  return main && typeof main.from === "number" && typeof main.to === "number"
    ? { from: main.from, to: main.to }
    : { from: 0, to: 0 };
}
