import { assert } from "chai";
import { filterNotesByTitle } from "../src/utils/markdown";

describe("filterNotesByTitle", function () {
  function makeItem(
    id: number,
    attachmentFilename: string,
    title = "",
  ): Zotero.Item {
    return {
      id,
      attachmentFilename,
      getField: () => title,
    } as unknown as Zotero.Item;
  }

  it("returns every item for an empty or whitespace query", function () {
    const items = [makeItem(1, "notes.md"), makeItem(2, "reading.md")];
    assert.lengthOf(filterNotesByTitle(items, ""), 2);
    assert.lengthOf(filterNotesByTitle(items, "   "), 2);
  });

  it("matches filename case-insensitively", function () {
    const items = [makeItem(1, "Notes.md"), makeItem(2, "reading.md")];
    const result = filterNotesByTitle(items, "NOTES");
    assert.lengthOf(result, 1);
    assert.equal(result[0].id, 1);
  });

  it("falls back to the item title when the filename is empty", function () {
    const items = [
      makeItem(1, "", "A Reading Log"),
      makeItem(2, "", "Unrelated"),
    ];
    const result = filterNotesByTitle(items, "reading log");
    assert.lengthOf(result, 1);
    assert.equal(result[0].id, 1);
  });

  it("returns no items when nothing matches", function () {
    const items = [makeItem(1, "notes.md")];
    assert.lengthOf(filterNotesByTitle(items, "does-not-exist"), 0);
  });
});
