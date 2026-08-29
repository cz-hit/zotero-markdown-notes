import { assert } from "chai";
import {
  findMarkdownMatches,
  replaceAllMarkdownMatches,
  replaceMarkdownMatch,
} from "../src/utils/markdownSearch";

describe("markdown search", function () {
  it("finds case-insensitive matches by default", function () {
    assert.deepEqual(findMarkdownMatches("One one", "one").matches, [
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });

  it("supports whole word and regex options", function () {
    assert.deepEqual(
      findMarkdownMatches("cat scatter", "cat", { wholeWord: true }).matches,
      [{ from: 0, to: 3 }],
    );
    assert.deepEqual(
      findMarkdownMatches("a1 a22", "a\\d+", { useRegex: true }).matches,
      [
        { from: 0, to: 2 },
        { from: 3, to: 6 },
      ],
    );
  });

  it("returns an error for invalid regular expressions", function () {
    assert.isNotEmpty(
      findMarkdownMatches("text", "[", { useRegex: true }).error,
    );
  });

  it("replaces one or all matches without interpreting replacement text", function () {
    const matches = findMarkdownMatches("x x", "x").matches;
    assert.equal(replaceMarkdownMatch("x x", matches[0], "$1"), "$1 x");
    assert.equal(replaceAllMarkdownMatches("x x", matches, "$1"), "$1 $1");
  });
});
