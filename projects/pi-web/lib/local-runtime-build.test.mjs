import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: nextConfig } = await jiti.import("../next.config.ts");

function configure(isServer) {
  const existing = () => {};
  const config = { module: { rules: [] }, externals: [existing] };
  nextConfig.webpack(config, { isServer });
  return { config, existing };
}

test("linked Pi runtimes and their subpath exports stay native server imports", () => {
  const { config, existing } = configure(true);
  assert.equal(config.externals[1], existing, "keep Next's ordinary external resolver");
  const resolve = (request) => {
    let result;
    config.externals[0]({ request }, (error, value) => { assert.equal(error, null); result = value; });
    return result;
  };
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "pi-prompt-manager"]) {
    assert.equal(resolve(name), `import ${name}`);
  }
  assert.equal(resolve("@earendil-works/pi-ai/compat"), "import @earendil-works/pi-ai/compat");
  for (const other of [undefined, "react", "node:fs", "@earendil-works/pi-ai-extra", "./pi-prompt-manager"]) {
    assert.equal(resolve(other), undefined);
  }
});

test("browser bundles still include client-safe Pi helpers", () => {
  const { config, existing } = configure(false);
  assert.deepEqual(config.externals, [existing]);
  assert.equal(config.module.rules.length, 1, "keep the old-Safari Markdown loader");
});
