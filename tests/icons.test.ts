import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Window } from "happy-dom";
import { IconCycle } from "../src/ui/icon-cycle";
import { catIcon, refreshCatIcons, rotateCatIcons } from "../src/ui/cat-icons";
import { CAT_ICON_POOL } from "../src/ui/icons";
import { loadIcons } from "../scripts/icons";

test("the icon pool follows the folder instead of requiring a fixed set of files", () => {
  const window = new Window();
  try {
    expect(CAT_ICON_POOL).toEqual(loadIcons());
    expect(CAT_ICON_POOL.length).toBeGreaterThan(0);
    for (const source of CAT_ICON_POOL) {
      const doc = new window.DOMParser().parseFromString(source, "image/svg+xml");
      const svg = doc.documentElement;
      expect(svg.localName).toBe("svg");
    }
  } finally { window.close(); }
});

test("browser builds pick up added and deleted SVGs and PNGs, including nested and uppercase filenames", async () => {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, "cat-icons-"));
  const icons = join(directory, "icons");
  const entry = join(directory, "entry.ts");
  const first = '<svg viewBox="0 0 20 10" fill="none" stroke="currentColor"><path d="M1 1L9 9"/></svg>';
  const second = '<svg viewBox="0 0 24 24"><circle r="5"/></svg>';
  async function build() {
    const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
    if (!result.success) throw new AggregateError(result.logs, "Icon fixture build failed");
    const source = await result.outputs[0].text();
    expect(source).not.toMatch(/node:fs|readFileSync|Bun\.Glob/);
    return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default as string[];
  }
  try {
    await mkdir(join(icons, "nested"), { recursive: true });
    await writeFile(entry, `import { loadIcons } from ${JSON.stringify(join(import.meta.dir, "../scripts/icons.ts"))} with { type: "macro" }; export default loadIcons(${JSON.stringify(icons)});`);
    const fallback = await build();
    expect(fallback).toHaveLength(1); expect(fallback[0]).toContain("<svg");
    await writeFile(join(icons, "one.svg"), first);
    await writeFile(join(icons, "credits.json"), "{}");
    expect(await build()).toEqual([first]);
    await writeFile(join(icons, "nested", "two.SVG"), second);
    expect(await build()).toEqual([second, first]);
    await unlink(join(icons, "one.svg"));
    expect(await build()).toEqual([second]);
    await unlink(join(icons, "nested", "two.SVG"));
    expect(await build()).toEqual(fallback);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await writeFile(join(icons, "nested", "box.PNG"), png);
    const raster = await build();
    expect(raster).toHaveLength(1);
    expect(raster[0]).toContain('<image width="1" height="1"');
    expect(raster[0]).toContain('href="data:image/png;base64,');
    expect(raster[0]).toContain('preserveAspectRatio="xMidYMid meet"');
    await unlink(join(icons, "nested", "box.PNG"));
    expect(await build()).toEqual(fallback);
  } finally {
    if (dirname(resolve(directory)) !== tempRoot) throw new Error("Unexpected icon test directory");
    await rm(directory, { recursive: true, force: true });
  }
});

test("one design can be used on every control without breaking click rotation", () => {
  const cycle = new IconCycle(["cat"]);
  for (let i = 0; i < 4; i++) { cycle.shuffle(); expect(cycle.at(i)).toBe("cat"); }
});

test("every shuffle changes each design and keeps all designs, even with a fixed random source", () => {
  for (const count of [2, 3, 19]) for (const value of [0, 0.5, 0.999999]) {
    const cycle = new IconCycle(Array.from({ length: count }, (_, i) => i), () => value);
    for (let step = 0; step < 25; step++) {
      const before = Array.from({ length: count }, (_, i) => cycle.at(i));
      cycle.shuffle();
      const after = Array.from({ length: count }, (_, i) => cycle.at(i));
      expect(new Set(after).size).toBe(count);
      expect(after.every((value, i) => value !== before[i])).toBe(true);
    }
  }
});

test("click rotation updates owned icons without replacing controls, focus, or unrelated SVGs", () => {
  const previous = globalThis.document;
  const window = new Window(); globalThis.document = window.document as unknown as Document;
  try {
    const control = document.createElement("button");
    const icons = [catIcon(), catIcon("custom", "settings"), catIcon("ao-cat-icon", "cat")];
    const unrelated = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    unrelated.innerHTML = '<circle r="5"/>';
    control.append(...icons); document.body.append(control, unrelated); control.focus();
    icons[0].setAttribute("stroke", "hotpink");
    control.addEventListener("click", rotateCatIcons); control.click();
    expect(document.activeElement).toBe(control);
    expect(icons[1].getAttribute("class")).toBe("custom");
    expect(icons[0].getAttribute("stroke")).toBe(catIcon().getAttribute("stroke"));
    expect(unrelated.innerHTML).toBe('<circle r="5"></circle>');
    // A status/stream render gets the same choice until another click.
    expect(catIcon().innerHTML).toBe(icons[0].innerHTML);
    expect(catIcon("", "settings").innerHTML).toBe(icons[1].innerHTML);
    expect(catIcon("", "cat").innerHTML).toBe(icons[2].innerHTML);
    const detachedDrawer = document.createElement("div");
    const detachedIcon = catIcon(); detachedDrawer.append(detachedIcon);
    control.click();
    refreshCatIcons(detachedDrawer);
    expect(detachedIcon.innerHTML).toBe(icons[0].innerHTML);
  } finally { window.close(); globalThis.document = previous; }
});
