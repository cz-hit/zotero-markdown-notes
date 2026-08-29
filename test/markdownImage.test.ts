import { assert } from "chai";
import {
  binaryToBase64,
  filePathToUri,
  getImageMimeType,
  isDirectImageSource,
  resolveMarkdownImagePath,
  resolveMarkdownImageSrc,
} from "../src/utils/markdownImage";

describe("markdown image paths", function () {
  const markdownUri = "file:///G:/notes/folder/note.md";

  it("resolves relative paths against the markdown file", function () {
    assert.equal(
      resolveMarkdownImageSrc("images/photo.png", markdownUri),
      "file:///G:/notes/folder/images/photo.png",
    );
    assert.equal(
      resolveMarkdownImageSrc("./images/photo.png", markdownUri),
      "file:///G:/notes/folder/images/photo.png",
    );
    assert.equal(
      resolveMarkdownImageSrc("../shared/photo.png", markdownUri),
      "file:///G:/notes/shared/photo.png",
    );
  });

  it("encodes spaces and non-ASCII characters", function () {
    assert.equal(
      resolveMarkdownImageSrc("图片/照片 1.png", markdownUri),
      "file:///G:/notes/folder/%E5%9B%BE%E7%89%87/%E7%85%A7%E7%89%87%201.png",
    );
  });

  it("accepts Windows separators and absolute paths", function () {
    assert.equal(
      resolveMarkdownImageSrc("images\\photo.png", markdownUri),
      "file:///G:/notes/folder/images/photo.png",
    );
    assert.equal(
      resolveMarkdownImageSrc("D:\\images\\photo.png", markdownUri),
      "file:///D:/images/photo.png",
    );
    assert.equal(
      resolveMarkdownImageSrc("\\\\server\\share\\photo.png", markdownUri),
      "file://server/share/photo.png",
    );
  });

  it("preserves URLs that already have a scheme", function () {
    const sources = [
      "https://example.com/photo.png",
      "data:image/png;base64,AAAA",
      "file:///G:/images/photo.png",
      "chrome://markdownnote/content/photo.png",
      "//cdn.example.com/photo.png",
    ];

    for (const src of sources) {
      assert.equal(resolveMarkdownImageSrc(src, markdownUri), src);
    }
  });

  it("preserves empty values or relative paths without a base URI", function () {
    assert.equal(resolveMarkdownImageSrc("", markdownUri), "");
    assert.equal(resolveMarkdownImageSrc("photo.png", ""), "photo.png");
  });

  it("converts native file paths to file URIs", function () {
    assert.equal(
      filePathToUri("G:\\notes\\图片 1.md"),
      "file:///G:/notes/%E5%9B%BE%E7%89%87%201.md",
    );
    assert.equal(
      filePathToUri("/home/user/notes/note.md"),
      "file:///home/user/notes/note.md",
    );
  });

  it("resolves local image paths for backend loading", function () {
    const markdownPath = "G:\\storage\\V55DM9G6\\paper.md";
    assert.equal(
      resolveMarkdownImagePath(
        markdownPath,
        "images/a6b17ebe3f9f7f775a67d00d0562ae616.jpg",
      ),
      "G:\\storage\\V55DM9G6\\images\\a6b17ebe3f9f7f775a67d00d0562ae616.jpg",
    );
    assert.equal(
      resolveMarkdownImagePath(markdownPath, "../shared/图片 1.png"),
      "G:\\storage\\shared\\图片 1.png",
    );
  });

  it("classifies sources that can load directly", function () {
    assert.isTrue(isDirectImageSource("https://example.com/photo.png"));
    assert.isTrue(isDirectImageSource("data:image/png;base64,AAAA"));
    assert.isTrue(isDirectImageSource("//cdn.example.com/photo.png"));
    assert.isFalse(isDirectImageSource("images/photo.png"));
    assert.isFalse(isDirectImageSource("file:///G:/images/photo.png"));
  });

  it("detects image MIME types", function () {
    assert.equal(getImageMimeType("photo.JPG"), "image/jpeg");
    assert.equal(getImageMimeType("diagram.svg"), "image/svg+xml");
    assert.isUndefined(getImageMimeType("document.pdf"));
  });

  it("encodes binary image data as base64", function () {
    assert.equal(binaryToBase64(new Uint8Array([0, 1, 2, 255])), "AAEC/w==");
  });
});
