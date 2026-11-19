import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasParentDirectorySegment, isPathWithinRoots, resolveRealRoots } from "./path-security";
import { samePath } from "./paths";
import { MARKDOWN_EDIT_MAX_BYTES, isMarkdownEditPath } from "./markdown-edit";

export class MarkdownEditError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function conflict(): MarkdownEditError {
  return new MarkdownEditError(412, "File changed on disk since it was opened");
}

function version(bytes: Buffer): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function authorizedFile(filePath: string, roots: Set<string>): string {
  if (hasParentDirectorySegment(filePath) || !isPathWithinRoots(filePath, roots)) {
    throw new MarkdownEditError(403, "Access denied");
  }
  if (!isMarkdownEditPath(filePath) || (process.platform === "win32" && path.basename(filePath).includes(":"))) {
    throw new MarkdownEditError(415, "Only Markdown (.md) files can be edited");
  }
  // A linked workspace directory is fine when its real path is authorized;
  // the final entry must be a regular file, never a symbolic link.
  const destination = path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
  if (!isPathWithinRoots(destination, resolveRealRoots(roots))) {
    throw new MarkdownEditError(403, "Access denied");
  }
  return destination;
}

function readBytes(destination: string) {
  const entry = fs.lstatSync(destination);
  if (!entry.isFile()) throw new MarkdownEditError(415, "Only regular files can be edited");
  if (entry.size > MARKDOWN_EDIT_MAX_BYTES) throw new MarkdownEditError(413, "Markdown editing is limited to 256 KiB");

  // Keep the read bounded even if the file grows after the stat.
  const fd = fs.openSync(destination, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev) throw conflict();
    const buffer = Buffer.allocUnsafe(MARKDOWN_EDIT_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MARKDOWN_EDIT_MAX_BYTES) throw new MarkdownEditError(413, "Markdown editing is limited to 256 KiB");
    return { bytes: buffer.subarray(0, size), stat };
  } finally {
    fs.closeSync(fd);
  }
}

function decode(bytes: Uint8Array): string {
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!content.includes("\0")) return content;
  } catch { /* Non-UTF-8 files stay read-only. */ }
  throw new MarkdownEditError(415, "Only UTF-8 Markdown files can be edited");
}

function decodeMarkdown(bytes: Buffer) {
  const decoded = decode(bytes);
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = decoded.slice(bom.length);
  const crlf = text.includes("\r\n");
  const remaining = crlf ? text.replaceAll("\r\n", "") : text;
  if (remaining.includes("\r") || (crlf && remaining.includes("\n"))) {
    throw new MarkdownEditError(415, "Files with mixed or unsupported line endings cannot be edited");
  }
  return { content: crlf ? text.replaceAll("\r\n", "\n") : text, crlf, bom };
}

export function getMarkdownEdit(filePath: string, roots: Set<string>) {
  const { bytes } = readBytes(authorizedFile(filePath, roots));
  return { content: decodeMarkdown(bytes).content, etag: version(bytes) };
}

export function saveMarkdownEdit(filePath: string, roots: Set<string>, expected: string, body: Uint8Array) {
  const destination = authorizedFile(filePath, roots);
  const current = readBytes(destination);
  if (version(current.bytes) !== expected) throw conflict();
  const { bom, crlf } = decodeMarkdown(current.bytes);
  const text = decode(body);
  if (text.includes("\r")) throw new MarkdownEditError(400, "Submit Markdown text with LF line endings");
  const bytes = Buffer.from(bom + (crlf ? text.replaceAll("\n", "\r\n") : text));
  if (bytes.length > MARKDOWN_EDIT_MAX_BYTES) throw new MarkdownEditError(413, "Markdown editing is limited to 256 KiB");
  const etag = version(bytes);
  if (etag === expected) return { etag };
  fs.accessSync(destination, fs.constants.W_OK);

  const staged = path.join(path.dirname(destination), `.pi-edit-${randomUUID()}.tmp`);
  let stagedCreated = false;
  try {
    const fd = fs.openSync(staged, "wx", 0o600);
    stagedCreated = true;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, current.stat.mode & 0o777);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Recheck after staging. Keeping this check and the rename synchronous
    // serializes Pi Web saves; other processes don't share its concurrency rules.
    if (!samePath(destination, authorizedFile(filePath, roots)) || version(readBytes(destination).bytes) !== expected) {
      throw conflict();
    }
    fs.renameSync(staged, destination);
    stagedCreated = false;
    return { etag };
  } finally {
    if (stagedCreated) fs.unlinkSync(staged);
  }
}
