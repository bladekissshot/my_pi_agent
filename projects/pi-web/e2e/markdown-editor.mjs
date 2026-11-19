// Run against a local Pi Web with this checkout's code:
// PI_WEB_TEST_URL=http://127.0.0.1:30142 node e2e/markdown-editor.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { showSidebarFiles } from "./sidebar.mjs";

const baseUrl = process.env.PI_WEB_TEST_URL || "http://127.0.0.1:30142";
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-markdown-browser-")));
const markdown = path.join(root, "test note.MD");
const other = path.join(root, "other.txt");
const initial = "# Before\n\nFirst paragraph.\n";
const draft = "# 浏览器保存\n\n中文和 ASCII 🙂\n";
let browser;
try {
  await fs.writeFile(markdown, initial);
  await fs.writeFile(other, "other file\n");
  browser = await chromium.launch({ channel: process.env.PI_WEB_TEST_BROWSER || undefined });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
  const url = new URL(baseUrl);
  url.searchParams.set("cwd", root);
  assert.equal((await page.goto(url.href)).status(), 200);
  await showSidebarFiles(page);
  const openFile = (file) => page.getByTitle(file.replaceAll("\\", "/"), { exact: true }).first().click();
  await openFile(markdown);
  const panel = page.locator("#file-panel");
  const openEdit = () => panel.getByRole("button", { name: /^Edit(?: •)?$/ }).click();
  const editor = panel.getByRole("textbox", { name: "Markdown source editor" });
  await panel.getByRole("heading", { name: "Before", exact: true }).waitFor();
  await openEdit();
  await editor.waitFor();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await editor.press(`${modifier}+a`);
  await page.keyboard.insertText(draft);
  await panel.getByText("Unsaved changes", { exact: true }).waitFor();
  await editor.press(`${modifier}+z`);
  assert.match(await editor.innerText(), /First paragraph/);
  await editor.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
  assert.match(await editor.innerText(), /浏览器保存/);

  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  await panel.getByRole("heading", { name: "Before", exact: true }).waitFor();
  assert.equal(await fs.readFile(markdown, "utf8"), initial);
  await openFile(other);
  await panel.getByText("other file", { exact: true }).waitFor();
  await openFile(markdown);
  await openEdit();
  await editor.waitFor();
  assert.match(await editor.innerText(), /中文和 ASCII/);
  page.once("dialog", (dialog) => dialog.dismiss());
  await panel.getByRole("button", { name: "Close test note.MD", exact: true }).click();
  assert.equal(await editor.isVisible(), true, "cancelling a dirty-tab close keeps the draft");
  const saves = (status) => page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).searchParams.get("type") === "edit" && response.status() === status);
  await Promise.all([saves(200), editor.press(`${modifier}+s`)]);
  assert.equal(await fs.readFile(markdown, "utf8"), draft);
  await panel.getByRole("button", { name: "Preview", exact: true }).click();
  await panel.getByRole("heading", { name: "浏览器保存", exact: true }).waitFor();

  await openEdit();
  await editor.press(`${modifier}+a`);
  await page.keyboard.insertText("# unsaved browser draft");
  await fs.writeFile(markdown, "# 外部修改\n");
  await Promise.all([saves(412), editor.press(`${modifier}+s`)]);
  await panel.getByText(/Your draft is still here/).waitFor();
  assert.equal(await fs.readFile(markdown, "utf8"), "# 外部修改\n");
  assert.match(await editor.innerText(), /unsaved browser draft/);
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Reload from disk" }).click();
  await editor.getByText("# 外部修改", { exact: true }).waitFor();
  console.log("PASS: browser Markdown editing, undo/redo, draft across tabs, save, and conflict recovery");
} finally {
  await browser?.close();
  await fs.rm(root, { recursive: true, force: true });
}
