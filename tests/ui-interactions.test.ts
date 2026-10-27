import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { profileDrag } from "../src/ui/profile-drag";
import { renderSettings } from "../src/ui/tabs/settings-tab";
import type { Catalog, Settings } from "../src/shared";
import { CatBackground } from "../src/ui/cats";

const original = { document: globalThis.document, Image: globalThis.Image, ResizeObserver: globalThis.ResizeObserver, IntersectionObserver: globalThis.IntersectionObserver };
let cleanup = () => {};
afterEach(() => { cleanup(); Object.assign(globalThis, original); });
const photoSource = () => ({ next: async () => "https://example.test/cat.jpg", dispose() {} });

test.each([0.5, 1, 1.5])("dragging at UI scale %s saves only on drop and keeps layout sizes unchanged", scale => {
  const window = new Window(); globalThis.document = window.document as unknown as Document;
  document.documentElement.style.setProperty("--lumiverse-ui-scale", String(scale));
  const list = document.createElement("div"); document.body.append(list);
  for (const id of ["a", "b", "c"]) {
    const row = document.createElement("div"); row.className = "ao-slot"; row.dataset.slotId = id;
    const handle = document.createElement("button"); handle.className = "ao-drag-handle";
    const captured = new Set<number>();
    handle.setPointerCapture = id => { captured.add(id); }; handle.hasPointerCapture = id => captured.has(id); handle.releasePointerCapture = id => { captured.delete(id); };
    row.getBoundingClientRect = () => ({ top: Array.from(list.children).indexOf(row) * 100 * scale, width: 400 * scale, height: 100 * scale }) as DOMRect;
    row.append(handle); list.append(row);
  }
  const saved: string[][] = [], remove = profileDrag(list, ids => saved.push(ids));
  cleanup = () => { remove(); window.close(); };
  const handle = list.firstElementChild!.firstElementChild!;
  const fire = (type: string, y: number) => handle.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientY: y * scale }) as unknown as Event);
  const order = () => Array.from(list.children).filter(row => row.classList.contains("ao-slot")).map(row => (row as HTMLElement).dataset.slotId);
  fire("pointerdown", 25); fire("pointermove", 280);
  expect(order()).toEqual(["b", "c", "a"]); expect(saved).toEqual([]);
  expect(list.querySelector(".ao-drag-gap")).not.toBeNull(); expect((handle.parentElement as HTMLElement).style.position).toBe("absolute");
  expect((handle.parentElement as HTMLElement).style.width).toBe("400px");
  expect((handle.parentElement as HTMLElement).style.top).toBe("255px");
  expect(list.querySelector<HTMLElement>(".ao-drag-gap")!.style.height).toBe("100px");
  fire("pointerup", 280); expect(saved).toEqual([["b", "c", "a"]]);
  expect(list.querySelector(".ao-drag-gap")).toBeNull();
  fire("pointerdown", 280); fire("pointermove", 10); fire("pointerup", 10); expect(order()).toEqual(["a", "b", "c"]);
  fire("pointerdown", 25); fire("pointermove", 280); fire("pointercancel", 280); expect(order()).toEqual(["a", "b", "c"]); expect(saved).toHaveLength(2);
});

test("locked profiles show the editing hint on click; keyboard reordering saves when unlocked", () => {
  const window = new Window(); globalThis.document = window.document as unknown as Document;
  const host = document.createElement("div"); document.body.append(host);
  const catalog: Catalog = { settings: { version: 1, cats: true, slots: [{ id: "a", presetId: "a", connectionId: null }, { id: "b", presetId: "b", connectionId: null }] },
    presets: [{ id: "a", name: "A" }, { id: "b", name: "B" }], connections: [] };
  const saved: Settings[] = [];
  const actions = { save: (s: Settings) => saved.push(s), reload() {} };
  let remove = renderSettings(host, catalog, true, false, actions);
  expect(host.querySelector(".ao-lock-tip")).toBeNull();
  host.querySelector<HTMLButtonElement>(".ao-lock-cover")!.click();
  expect(host.querySelector(".ao-lock-tip")!.textContent?.trim()).toBe("Disable to edit profiles.");
  expect(host.querySelectorAll(".ao-pill")).toHaveLength(3);
  remove(); host.replaceChildren();
  remove = renderSettings(host, catalog, false, false, actions);
  expect(host.querySelector('[aria-label^="Move profile"]')).toBeNull();
  host.querySelector(".ao-drag-handle")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event);
  expect(saved[0].slots.map(s => s.id)).toEqual(["b", "a"]);
  cleanup = () => { remove(); window.close(); };
});

test("the thirty-photo buffer serves replacements immediately and keeps existing cats until a complete new panel is ready", async () => {
  const window = new Window(); globalThis.document = window.document as unknown as Document;
  const images: HTMLImageElement[] = [];
  globalThis.Image = class {
    constructor() {
      const image = document.createElement("img"); let url = "";
      Object.defineProperties(image, { naturalWidth: { value: 900 }, naturalHeight: { value: 600 },
        decode: { value: () => Promise.resolve() }, src: { get: () => url, set: value => { url = value; image.setAttribute("data-src", value); } } });
      images.push(image); return image;
    }
  } as unknown as typeof Image;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  const root = document.createElement("div"); document.body.append(root);
  Object.defineProperties(root, { clientWidth: { value: 300 }, clientHeight: { value: 900 } });
  const cats = new CatBackground(root, photoSource()); cleanup = () => { cats.dispose(); window.close(); };
  expect(images).toHaveLength(4);
  const loaded = async (image: HTMLImageElement) => { image.dispatchEvent(new window.Event("load") as unknown as Event); await Bun.sleep(0); };
  const current = () => Array.from(root.querySelectorAll(".ao-cats")).at(-1)!;
  const ready = () => (cats as unknown as { ready: HTMLImageElement[] }).ready.length;
  for (let i = 0; i < 30; i++) await loaded(images[i]);
  expect(ready()).toBe(30); expect(images).toHaveLength(30); expect(root.querySelector("img")).toBeNull();
  cats.setEnabled(true); cats.show();
  expect(root.classList.contains("ao-with-cat")).toBe(true);
  expect(current().querySelectorAll("img")).toHaveLength(5); expect(ready()).toBe(25);
  for (let i = 30; i < 35; i++) await loaded(images[i]);
  expect(ready()).toBe(30);
  const prior = current(); cats.refresh();
  expect(current()).not.toBe(prior); expect(ready()).toBe(25);
  for (let i = 35; i < 40; i++) await loaded(images[i]);
  expect(current()).not.toBe(prior); expect(current().querySelectorAll("img")).toHaveLength(5); expect(ready()).toBe(30);
  for (let i = 0; i < 6; i++) cats.refresh();
  expect(ready()).toBe(0);
  const last = current(); cats.refresh();
  for (let i = 40; i < 44; i++) await loaded(images[i]);
  expect(current()).toBe(last); expect(ready()).toBe(4);
  images[44].dispatchEvent(new window.Event("error") as unknown as Event);
  expect(current()).toBe(last); expect(current().querySelectorAll("img")).toHaveLength(5);
});

test("cold startup shows a complete decoded panel before the reserve fills", async () => {
  const window = new Window(); globalThis.document = window.document as unknown as Document;
  const images: HTMLImageElement[] = [];
  let finishDecode!: () => void;
  const decoding = new Promise<void>(resolve => { finishDecode = resolve; });
  globalThis.Image = class {
    constructor() {
      const image = document.createElement("img"), index = images.length;
      Object.defineProperties(image, { naturalWidth: { value: 900 }, naturalHeight: { value: 600 },
        decode: { value: () => index === 4 ? decoding : Promise.resolve() } });
      images.push(image); return image;
    }
  } as unknown as typeof Image;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  const root = document.createElement("div"); document.body.append(root);
  Object.defineProperties(root, { clientWidth: { value: 300 }, clientHeight: { value: 900 } });
  const cats = new CatBackground(root, photoSource()); cleanup = () => { finishDecode(); cats.dispose(); window.close(); };
  cats.setEnabled(true); cats.show();
  cats.setGalleryActive(true);
  const pill = root.querySelector<HTMLElement>(".ao-cat-loading")!;
  expect(pill.hidden).toBe(false); expect(pill.getAttribute("role")).toBe("status");
  expect(pill.textContent).toContain("Loading more cats…");
  for (let i = 0; i < 5; i++) {
    images[i].dispatchEvent(new window.Event("load") as unknown as Event); await Bun.sleep(0);
    expect(root.querySelector("img")).toBeNull();
  }
  finishDecode(); await Bun.sleep(0);
  expect(root.querySelectorAll("img")).toHaveLength(5);
  expect(pill.hidden).toBe(true); // Refilling the reserve is not a visible wait.
  expect((cats as unknown as { ready: HTMLImageElement[] }).ready).toHaveLength(0);
  expect(images.length).toBeLessThan(30);
});


test("CAT scrolls the same background using its buffer, refills it, and replaces photos only after leaving", async () => {
  const window = new Window(); globalThis.document = window.document as unknown as Document;
  const images: HTMLImageElement[] = [];
  globalThis.Image = class {
    constructor() {
      const image = document.createElement("img");
      Object.defineProperties(image, { naturalWidth: { value: 900 }, naturalHeight: { value: 600 }, decode: { value: () => Promise.resolve() } });
      images.push(image); return image;
    }
  } as unknown as typeof Image;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  const root = document.createElement("div"); document.body.append(root);
  const current = () => Array.from(root.querySelectorAll(".ao-cats")).at(-1)!;
  Object.defineProperties(root, { clientWidth: { value: 300 }, clientHeight: { value: 300 },
    scrollHeight: { get: () => (current()?.childElementCount ?? 0) * 200 } });
  const cats = new CatBackground(root, photoSource()); cleanup = () => { cats.dispose(); window.close(); };
  const ready = () => (cats as unknown as { ready: HTMLImageElement[] }).ready.length;
  const loaded = async (index: number) => { images[index].dispatchEvent(new window.Event("load") as unknown as Event); await Bun.sleep(0); };
  cats.setEnabled(true); cats.show();
  for (let i = 0; i < 32; i++) await loaded(i);
  const background = current(), first = background.firstElementChild;
  cats.setGalleryActive(true); cats.refresh();
  expect(root.querySelectorAll(".ao-cats")).toHaveLength(1);
  expect(current()).toBe(background); expect(current().firstElementChild).toBe(first);
  expect(root.classList.contains("ao-cat-view")).toBe(true); expect(background.getAttribute("aria-hidden")).toBe("false");
  expect(images).toHaveLength(32); expect(ready()).toBe(30);
  const pill = root.querySelector<HTMLElement>(".ao-cat-loading")!;
  expect(pill.hidden).toBe(true);
  root.scrollTop = 50; root.dispatchEvent(new window.Event("scroll") as unknown as Event);
  expect(current().children).toHaveLength(6); expect(ready()).toBe(26); expect(pill.hidden).toBe(true);
  for (let i = 32; i < 36; i++) await loaded(i);
  expect(current()).toBe(background); expect(current().children).toHaveLength(6); expect(ready()).toBe(30);
  expect(pill.hidden).toBe(true);
  root.scrollTop = 1; root.dispatchEvent(new window.Event("scroll") as unknown as Event);
  expect(images).toHaveLength(36);
  cats.setGalleryActive(false);
  expect(root.scrollTop).toBe(0); expect(root.classList.contains("ao-cat-view")).toBe(false);
  expect(pill.hidden).toBe(true);
  expect(current()).not.toBe(background); expect(current().children).toHaveLength(2); expect(ready()).toBe(28);
  await loaded(36); await loaded(37); expect(ready()).toBe(30);
  cats.setGalleryActive(true);
  root.scrollTop = 50; root.dispatchEvent(new window.Event("scroll") as unknown as Event);
  cats.setGalleryActive(false);
  for (let i = 38; i < 44; i++) await loaded(i);
  expect(current().children).toHaveLength(2);
  expect(ready()).toBeGreaterThanOrEqual(30);
  cats.setEnabled(false); cats.setGalleryActive(true);
  expect(root.classList.contains("ao-with-cat")).toBe(true);
  cats.dispose();
  const requested = images.length;
  root.dispatchEvent(new window.Event("scroll") as unknown as Event);
  expect(images).toHaveLength(requested); expect(root.querySelector("img")).toBeNull(); expect(ready()).toBe(0);
});
