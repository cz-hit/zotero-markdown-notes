export function filePathToUri(filePath: string): string | undefined {
  if (!filePath) return undefined;

  const normalized = filePath.replace(/\\/g, "/");

  try {
    if (normalized.startsWith("//")) {
      const [host, ...segments] = normalized.slice(2).split("/");
      if (!host) return undefined;
      const encodedPath = segments.map(encodeURIComponent).join("/");
      return `file://${host}/${encodedPath}`;
    }
    if (/^[a-zA-Z]:\//.test(normalized)) {
      return new URL(`file:///${normalized}`).href;
    }
    if (normalized.startsWith("/")) {
      return new URL(`file://${normalized}`).href;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function resolveMarkdownImageSrc(
  src: string,
  markdownFileUri: string,
): string {
  if (!src || !markdownFileUri) return src;

  const windowsPath = /^[a-zA-Z]:[\\/]/.test(src);
  if (windowsPath) {
    return filePathToUri(src) ?? src;
  }

  if (src.startsWith("\\\\")) {
    return filePathToUri(src) ?? src;
  }

  if (src.startsWith("//") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(src)) {
    return src;
  }

  try {
    return new URL(src.replace(/\\/g, "/"), markdownFileUri).href;
  } catch {
    return src;
  }
}

export function isDirectImageSource(src: string): boolean {
  return (
    src.startsWith("//") || /^(?:https?|data|blob|chrome|resource):/i.test(src)
  );
}

export function resolveMarkdownImagePath(
  markdownFilePath: string,
  src: string,
): string | undefined {
  if (!markdownFilePath || !src || isDirectImageSource(src)) return undefined;

  const withoutSuffix = src.replace(/[?#].*$/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    decoded = withoutSuffix;
  }

  const windowsBase = markdownFilePath.includes("\\");

  if (/^file:/i.test(decoded)) {
    try {
      const url = new URL(decoded);
      let path = decodeURIComponent(url.pathname);
      if (url.host) {
        path = `//${url.host}${path}`;
      } else if (/^\/[a-zA-Z]:\//.test(path)) {
        path = path.slice(1);
      }
      return windowsBase ? path.replace(/\//g, "\\") : path;
    } catch {
      return undefined;
    }
  }

  if (/^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith("\\\\")) {
    return windowsBase ? decoded.replace(/\//g, "\\") : decoded;
  }
  if (decoded.startsWith("/")) {
    return windowsBase ? decoded.replace(/\//g, "\\") : decoded;
  }

  const baseDir = markdownFilePath.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
  const combined = `${baseDir}/${decoded.replace(/\\/g, "/")}`;
  const parts = combined.split("/");
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "..") {
      if (resolved.length > 1) resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }

  const result = resolved.join("/");
  return windowsBase ? result.replace(/\//g, "\\") : result;
}

export function getImageMimeType(filePath: string): string | undefined {
  const extension = filePath.replace(/[?#].*$/, "").match(/\.([^.\\/]+)$/)?.[1];
  if (!extension) return undefined;

  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
  };

  return mimeTypes[extension.toLowerCase()];
}

export function binaryToBase64(
  data: string | ArrayBuffer | Uint8Array,
): string {
  if (typeof data === "string") return btoa(data);

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}
