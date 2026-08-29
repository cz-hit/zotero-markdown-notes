import { assert } from "chai";
import {
  MARKDOWN_TARGET_PREFIX,
  findMarkdownTargetAnchors,
  findMarkdownTargetLinkAtSelection,
  findMarkdownTargetLinks,
  findTargetAtSelection,
  insertTarget,
  isSupportedLinkSelection,
  parseMarkdownTarget,
  removeTargetAnchor,
  serializeMarkdownTarget,
  targetAnchor,
  unwrapMarkdownLink,
  wrapSelectionInTargetLink,
  type MarkdownTarget,
} from "../src/utils/markdownLinks";
import {
  getLinkActionBlockedMessage,
  getLinkButtonState,
  type PendingLinkState,
} from "../src/utils/links";
import {
  MARKDOWN_LINK_TOOLBAR,
  getMarkdownEditorSelection,
} from "../src/utils/markdownToolbar";

const target: MarkdownTarget = {
  libraryID: 1,
  itemKey: "ABCD1234",
  targetId: `${MARKDOWN_TARGET_PREFIX}12345678`,
};

const href = serializeMarkdownTarget(target);

function link(label: string, destination = href): string {
  return `[${label}](${destination})`;
}

describe("markdown cross-note link syntax and bridge contracts", function () {
  it("uses explicit custom menu names for visible link actions", function () {
    assert.deepEqual(MARKDOWN_LINK_TOOLBAR, {
      target: "customMenu_mdnTarget",
      link: "customMenu_mdnLink",
      cancel: "customMenu_mdnCancel",
    });
  });

  it("computes A/B/C gates for the pairwise link model", function () {
    const anchor = targetAnchor(target.targetId);
    const anchorLength = anchor.length;
    const markdown = `${anchor}target text`;
    const pendingTarget: PendingLinkState = {
      kind: "target",
      target: { ...target, itemId: 7 },
    };
    const pendingSource: PendingLinkState = {
      kind: "source",
      source: {
        itemId: 7,
        libraryID: 1,
        itemKey: "ABCD1234",
        label: "x",
        from: 0,
        to: 1,
      },
    };

    // Non-creating, empty selection: everything disabled.
    assert.deepEqual(getLinkButtonState(markdown, { from: 0, to: 0 }, null), {
      setTarget: false,
      setLink: false,
      cancel: false,
    });

    // Non-creating, plain text: A and B enabled, C disabled.
    assert.deepEqual(
      getLinkButtonState("plain text", { from: 0, to: 5 }, null),
      { setTarget: true, setLink: true, cancel: false },
    );

    // Non-creating, link selected: only C.
    assert.deepEqual(
      getLinkButtonState(link("label"), { from: 1, to: 3 }, null),
      { setTarget: false, setLink: false, cancel: true },
    );

    // Non-creating, existing target selected: A (reuse) and C.
    assert.deepEqual(
      getLinkButtonState(markdown, { from: 0, to: anchorLength }, null),
      { setTarget: true, setLink: false, cancel: true },
    );

    // Pending target, empty selection: A disabled, B/C enabled.
    assert.deepEqual(
      getLinkButtonState("plain text", { from: 0, to: 0 }, pendingTarget),
      { setTarget: false, setLink: true, cancel: true },
    );

    // Pending source, valid plain selection: A/C enabled, B disabled.
    assert.deepEqual(
      getLinkButtonState("plain text", { from: 0, to: 5 }, pendingSource),
      { setTarget: true, setLink: false, cancel: true },
    );

    // Pending source, empty selection: A disabled (needs a target), C enabled.
    assert.deepEqual(
      getLinkButtonState("plain text", { from: 0, to: 0 }, pendingSource),
      { setTarget: false, setLink: false, cancel: true },
    );
  });

  it("explains why a link action is unavailable", function () {
    assert.equal(
      getLinkActionBlockedMessage(
        "set-target",
        { from: 0, to: 0 },
        {
          setTarget: false,
          setLink: false,
          cancel: false,
        },
      ),
      "请在左侧 Markdown 源码编辑区选择文本",
    );
    assert.equal(
      getLinkActionBlockedMessage(
        "set-link",
        { from: 0, to: 4 },
        {
          setTarget: true,
          setLink: false,
          cancel: false,
        },
      ),
      "请先设置链接目标，或选择可链接的源码文本",
    );
    assert.isNull(
      getLinkActionBlockedMessage(
        "cancel",
        { from: 0, to: 4 },
        {
          setTarget: true,
          setLink: true,
          cancel: true,
        },
      ),
    );
  });

  it("reads CodeMirror selections from Cherry's editor view", function () {
    assert.deepEqual(
      getMarkdownEditorSelection({
        view: { state: { selection: { main: { from: 4, to: 9 } } } },
      }),
      { from: 4, to: 9 },
    );
    assert.deepEqual(
      getMarkdownEditorSelection({
        state: { selection: { main: { from: 2, to: 3 } } },
      }),
      { from: 2, to: 3 },
    );
    assert.deepEqual(getMarkdownEditorSelection({}), { from: 0, to: 0 });
  });

  it("round-trips user and group library targets", function () {
    assert.equal(
      href,
      "zotero://select/library/items/ABCD1234#mdn-target-12345678",
    );
    assert.deepEqual(parseMarkdownTarget(href), target);

    const groupTarget = { ...target, libraryID: 42, itemKey: "A B" };
    const groupHref = serializeMarkdownTarget(groupTarget);
    assert.equal(
      groupHref,
      "zotero://select/groups/42/items/A%20B#mdn-target-12345678",
    );
    assert.deepEqual(parseMarkdownTarget(groupHref), groupTarget);
  });

  it("rejects invalid targets and ordinary or unsafe URIs", function () {
    for (const invalid of [
      { ...target, libraryID: 0 },
      { ...target, libraryID: 1.5 },
      { ...target, libraryID: Number.MAX_SAFE_INTEGER + 1 },
      { ...target, libraryID: -2 },
      { ...target, targetId: "mdn-target-bad.id" },
      { ...target, targetId: "mdn-target-" },
      { ...target, itemKey: "" },
    ]) {
      assert.throws(() => serializeMarkdownTarget(invalid));
    }
    for (const ordinary of [
      "https://example.com/#mdn-target-12345678",
      "zotero://select/library/items/ABCD1234",
      "zotero://select/library/items/ABCD1234#heading",
      "zotero://select/groups/1/items/ABCD1234#mdn-target-12345678",
      "zotero://select/groups/9007199254740992/items/ABCD1234#mdn-target-12345678",
      "zotero://select/groups/42/items/%E0%A4%A#mdn-target-12345678",
      "zotero://select/library/items/ABCD1234#mdn-target-12345678/extra",
    ]) {
      assert.isNull(parseMarkdownTarget(ordinary));
    }
  });

  it("renders and inserts exact target anchors", function () {
    const anchor = targetAnchor(target.targetId);
    assert.equal(anchor, '<span id="mdn-target-12345678"></span>');
    assert.equal(
      insertTarget("before target after", { from: 7, to: 13 }, target.targetId),
      `before ${anchor}target after`,
    );
    assert.equal(
      insertTarget(
        `${anchor}target`,
        { from: anchor.length, to: anchor.length + 6 },
        target.targetId,
      ),
      `${anchor}target`,
    );
    assert.throws(() => targetAnchor("mdn-target-bad.id"));
  });

  it("wraps plain text while escaping Markdown label syntax", function () {
    assert.equal(
      wrapSelectionInTargetLink("see target now", { from: 4, to: 10 }, target),
      "see [target](zotero://select/library/items/ABCD1234#mdn-target-12345678) now",
    );
    assert.equal(
      wrapSelectionInTargetLink("a\\[b]", { from: 0, to: 5 }, target),
      "[a\\\\\\[b\\]](zotero://select/library/items/ABCD1234#mdn-target-12345678)",
    );
  });

  it("scans target links with exact source ranges", function () {
    const markdown = `x ${link("first")} y`;
    const matches = findMarkdownTargetLinks(markdown);
    assert.lengthOf(matches, 1);
    assert.deepEqual(matches[0], {
      range: { from: 2, to: 2 + link("first").length },
      labelRange: { from: 3, to: 8 },
      href,
      label: "first",
      target,
    });
  });

  it("supports nested and escaped label brackets and skips malformed links", function () {
    const nested = link("outer [inner] label");
    const escaped = link("escaped \\[brackets\\]");
    const markdown = `${nested} ${escaped} [incomplete](${href} [bad](${href}`;
    const matches = findMarkdownTargetLinks(markdown);
    assert.lengthOf(matches, 2);
    assert.equal(matches[0].label, "outer [inner] label");
    assert.equal(matches[1].label, "escaped \\[brackets\\]");
    assert.equal(matches[0].range.from, 0);
    assert.equal(matches[1].range.from, nested.length + 1);
  });

  it("skips target links in backtick and tilde fenced code", function () {
    const markdown = [
      "before",
      "```md",
      link("backtick"),
      "```",
      "after",
      "~~~",
      link("tilde"),
      "~~~",
      link("outside"),
    ].join("\n");
    assert.deepEqual(
      findMarkdownTargetLinks(markdown).map((match) => match.label),
      ["outside"],
    );
    const codeFrom = markdown.indexOf(link("backtick"));
    assert.isFalse(
      isSupportedLinkSelection(markdown, { from: codeFrom, to: codeFrom + 2 }),
    );
  });

  it("ignores pseudo-links and anchors in inline code, HTML, and comments", function () {
    const anchor = targetAnchor(target.targetId);
    const markdown = [
      `<!-- ${link("comment")} ${anchor} -->`,
      `<div data-link='${link("attribute")}' data-anchor='${anchor}'></div>`,
      "`" + link("inline") + " " + anchor + "`",
      `${anchor}${link("semantic")}`,
    ].join("\n");
    assert.deepEqual(
      findMarkdownTargetLinks(markdown).map((match) => match.label),
      ["semantic"],
    );
    const semanticAnchor = markdown.lastIndexOf(anchor);
    assert.equal(
      removeTargetAnchor(markdown, target.targetId),
      markdown.slice(0, semanticAnchor) +
        markdown.slice(semanticAnchor + anchor.length),
    );
  });

  it("rejects inline code and HTML comment selections and crossings", function () {
    const anchor = targetAnchor(target.targetId);
    const inline = "`inline code`";
    const comment = "<!-- HTML comment -->";
    const markdown = `${anchor}before ${inline} after ${comment} final`;
    const inlineFrom = markdown.indexOf("inline");
    const commentFrom = markdown.indexOf("HTML");
    assert.isFalse(
      isSupportedLinkSelection(markdown, {
        from: inlineFrom,
        to: inlineFrom + "inline".length,
      }),
    );
    assert.isFalse(
      isSupportedLinkSelection(markdown, {
        from: commentFrom,
        to: commentFrom + "HTML".length,
      }),
    );
    const finalFrom = markdown.indexOf("final");
    assert.isNull(
      findTargetAtSelection(markdown, {
        from: finalFrom,
        to: finalFrom + 2,
      }),
    );
  });

  it("does not associate a selection across a fenced code block", function () {
    const anchor = targetAnchor(target.targetId);
    const markdown = `${anchor}before\n	n\n\`\`\`\ncode\n\`\`\`\nafter`;
    const from = markdown.indexOf("after");
    assert.isNull(findTargetAtSelection(markdown, { from, to: from + 2 }));
  });

  it("supports angle destinations and optional titles without losing source text", function () {
    const angleMarkdown = `[text](<${href}>)`;
    const titledMarkdown = `[text](${href} "title")`;
    for (const markdown of [angleMarkdown, titledMarkdown]) {
      const match = findMarkdownTargetLinks(markdown)[0];
      assert.isDefined(match);
      assert.equal(match.href, markdown.slice(7, -1));
      assert.equal(unwrapMarkdownLink(markdown, match), "text");
      assert.throws(() =>
        unwrapMarkdownLink(markdown.replace("text", "other"), match),
      );
    }
  });

  it("finds the selected link and unwraps only a fresh exact match", function () {
    const markdown = `${link("first")} and ${link("second")}`;
    const first = findMarkdownTargetLinkAtSelection(markdown, {
      from: 2,
      to: 4,
    });
    assert.isNotNull(first);
    assert.equal(
      unwrapMarkdownLink(markdown, first!),
      `first and ${link("second")}`,
    );
    assert.isNull(
      findMarkdownTargetLinkAtSelection(markdown, {
        from: markdown.indexOf(" and"),
        to: markdown.indexOf(" and") + 2,
      }),
    );
    assert.throws(() => unwrapMarkdownLink(`x${markdown}`, first!));
  });

  it("matches exact target identity rather than labels or neighboring links", function () {
    const otherTarget = { ...target, targetId: "mdn-target-other" };
    const sameLabel = link("same", href);
    const differentTarget = link("same", serializeMarkdownTarget(otherTarget));
    const markdown = `${sameLabel}${differentTarget}`;
    const matches = findMarkdownTargetLinks(markdown);
    assert.lengthOf(matches, 2);
    assert.deepEqual(
      findMarkdownTargetLinkAtSelection(markdown, { from: 1, to: 2 }),
      matches[0],
    );
    assert.deepEqual(
      findMarkdownTargetLinkAtSelection(markdown, {
        from: matches[0].range.to + 1,
        to: matches[0].range.to + 2,
      }),
      matches[1],
    );
  });

  it("finds only the closest preceding anchor in the same paragraph", function () {
    const first = targetAnchor(target.targetId);
    const second = targetAnchor("mdn-target-second");
    const markdown = `${first}first paragraph\n\n${second}second paragraph`;
    const from = markdown.length - 6;
    assert.deepEqual(findTargetAtSelection(markdown, { from, to: from + 3 }), {
      range: {
        from: markdown.indexOf(second),
        to: markdown.indexOf(second) + second.length,
      },
      targetId: "mdn-target-second",
    });
    const noTarget = `${first}first\n\nno target`;
    const noTargetFrom = noTarget.indexOf("no target");
    assert.isNull(
      findTargetAtSelection(noTarget, {
        from: noTargetFrom,
        to: noTargetFrom + 2,
      }),
    );
  });

  it("removes only the requested exact anchor", function () {
    const other = targetAnchor("mdn-target-other");
    assert.equal(
      removeTargetAnchor(
        `${targetAnchor(target.targetId)}one ${other}two`,
        target.targetId,
      ),
      `one ${other}two`,
    );
    assert.equal(
      removeTargetAnchor("mdn-target-123 in text", target.targetId),
      "mdn-target-123 in text",
    );
  });

  it("scans every target anchor while skipping non-markdown contexts", function () {
    const anchor = targetAnchor(target.targetId);
    const other = targetAnchor("mdn-target-other");
    const markdown = [
      `${anchor}first`,
      "```",
      targetAnchor("mdn-target-code"),
      "```",
      `<!-- ${targetAnchor("mdn-target-comment")} -->`,
      "`" + targetAnchor("mdn-target-inline") + "`",
      `${other}second`,
    ].join("\n");

    const anchors = findMarkdownTargetAnchors(markdown);
    assert.deepEqual(
      anchors.map((a) => a.targetId),
      [target.targetId, "mdn-target-other"],
    );
    assert.equal(anchors[0].range.from, markdown.indexOf(anchor));
    assert.equal(anchors[1].range.from, markdown.indexOf(other));
  });

  it("protects all HTML tag forms", function () {
    const markdown = '</div> <!DOCTYPE html> <?xml version="1.0"?>';
    for (const token of ["</div>", "<!DOCTYPE html>", "<?xml"]) {
      const from = markdown.indexOf(token);
      assert.isFalse(
        isSupportedLinkSelection(markdown, { from, to: from + 2 }),
      );
    }
  });

  it("protects empty, out-of-bounds, HTML, and existing-link selections", function () {
    const markdown = `plain <span class="x">text</span> ${link("linked")} tail`;
    for (const selection of [
      { from: 0, to: 0 },
      { from: -1, to: 1 },
      { from: 0, to: markdown.length + 1 },
      {
        from: markdown.indexOf("<span") + 1,
        to: markdown.indexOf("<span") + 3,
      },
      { from: markdown.indexOf("linked"), to: markdown.indexOf("linked") + 2 },
    ]) {
      assert.isFalse(isSupportedLinkSelection(markdown, selection));
    }
    assert.throws(() =>
      insertTarget(
        markdown,
        {
          from: markdown.indexOf("linked"),
          to: markdown.indexOf("linked") + 2,
        },
        target.targetId,
      ),
    );
    assert.throws(() =>
      wrapSelectionInTargetLink(
        markdown,
        {
          from: markdown.indexOf("linked"),
          to: markdown.indexOf("linked") + 2,
        },
        target,
      ),
    );
  });

  it("keeps an anchor while references remain and removes it for the last reference", function () {
    const anchor = targetAnchor(target.targetId);
    let markdown = `${anchor}${link("first")} and ${link("second")}`;
    let matches = findMarkdownTargetLinks(markdown);
    assert.lengthOf(matches, 2);

    markdown = unwrapMarkdownLink(markdown, matches[0]);
    assert.equal(markdown, `${anchor}first and ${link("second")}`);
    assert.include(markdown, anchor);

    matches = findMarkdownTargetLinks(markdown);
    markdown = unwrapMarkdownLink(markdown, matches[0]);
    markdown = removeTargetAnchor(markdown, target.targetId);
    assert.equal(markdown, "first and second");
  });

  it("unwraps multiple links in descending source-range order", function () {
    const markdown = `${link("one")} ${link("two")} ${link("three")}`;
    const matches = findMarkdownTargetLinks(markdown);
    const unwrapped = matches
      .slice()
      .reverse()
      .reduce((content, match) => unwrapMarkdownLink(content, match), markdown);
    assert.equal(unwrapped, "one two three");
  });

  it("excludes ordinary Zotero links from target-link matches", function () {
    const ordinary = "zotero://select/library/items/ABCD1234";
    const markdown = `[ordinary](${ordinary}) ${link("target")}`;
    assert.deepEqual(
      findMarkdownTargetLinks(markdown).map((match) => match.label),
      ["target"],
    );
  });

  it("distinguishes adjacent links with the same label by destination", function () {
    const otherTarget = { ...target, targetId: "mdn-target-other" };
    const markdown = `${link("same", href)}${link(
      "same",
      serializeMarkdownTarget(otherTarget),
    )}`;
    const matches = findMarkdownTargetLinks(markdown);
    assert.lengthOf(matches, 2);
    assert.equal(matches[0].target.targetId, target.targetId);
    assert.equal(matches[1].target.targetId, otherTarget.targetId);
    assert.deepEqual(
      findMarkdownTargetLinkAtSelection(markdown, {
        from: matches[1].labelRange.from,
        to: matches[1].labelRange.to,
      }),
      matches[1],
    );
  });

  it("does not invent a target when an anchor is missing", function () {
    const markdown = "text without an anchor";
    const from = markdown.indexOf("without");
    assert.isNull(findTargetAtSelection(markdown, { from, to: from + 4 }));
    assert.equal(removeTargetAnchor(markdown, target.targetId), markdown);
  });

  it("ignores pseudo target links inside fenced text", function () {
    const markdown = [
      "```text",
      `literal ${link("pseudo")} and ${targetAnchor(target.targetId)}`,
      "```",
      link("real"),
    ].join("\n");
    assert.deepEqual(
      findMarkdownTargetLinks(markdown).map((match) => match.label),
      ["real"],
    );
    const pseudoFrom = markdown.indexOf("pseudo");
    assert.isNull(
      findMarkdownTargetLinkAtSelection(markdown, {
        from: pseudoFrom,
        to: pseudoFrom + 2,
      }),
    );
  });

  it("rejects invalid selections and selections crossing Markdown links", function () {
    const markdown = `${link("one")} plain ${link("two")}`;
    assert.isFalse(
      isSupportedLinkSelection(markdown, { from: 0, to: markdown.length }),
    );
    assert.isFalse(isSupportedLinkSelection(markdown, { from: 0, to: 1 }));
    assert.isNull(findTargetAtSelection(markdown, { from: 0, to: 0 }));
    assert.isNull(
      findMarkdownTargetLinkAtSelection(markdown, { from: 0, to: 0 }),
    );
  });
});
