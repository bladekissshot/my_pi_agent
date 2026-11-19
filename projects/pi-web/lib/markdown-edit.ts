import { getFileExt, TEXT_PREVIEW_MAX_BYTES } from "./file-types";

export const MARKDOWN_EDIT_MAX_BYTES = TEXT_PREVIEW_MAX_BYTES;

export function isMarkdownEditPath(filePath: string): boolean {
  return getFileExt(filePath) === "md";
}
