import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { packageFiles } from "../scripts/package";

test("the public ZIP contains bundles, reproducible source and credits, with no local data", async () => {
  const files = unzipSync(await packageFiles(resolve(import.meta.dir, "..")));
  const manifest = JSON.parse(strFromU8(files["spindle.json"]));
  expect(files[manifest.entry_backend]?.length).toBeGreaterThan(0);
  expect(files[manifest.entry_frontend]?.length).toBeGreaterThan(0);
  for (const path of ["LICENSE", "CREDITS.md", "README.md", "CONTRIBUTING.md", "AGENTS.md", "src/backend.ts", "src/frontend.ts", "scripts/package.ts", "bun.lock"])
    expect(files[path]?.length).toBeGreaterThan(0);
  for await (const path of new Bun.Glob("src/ui/icons/**/*").scan({ cwd: resolve(import.meta.dir, ".."), onlyFiles: true }))
    if (/\.(svg|png|json)$/i.test(path)) expect(files[path.replaceAll("\\", "/")]?.length).toBeGreaterThan(0);
  expect(Object.keys(files).some(path => /(^|\/)(local|node_modules|\.git|\.env)(\/|$)/.test(path))).toBe(false);
  expect(Object.keys(files).some(path => path.includes("\\"))).toBe(false);
});
