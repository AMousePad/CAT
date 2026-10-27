import { catIcon, el } from "./components";
import { catPhotos } from "./cat-photos";

const RESERVE = 30;
const CONCURRENT = 4;

/** One photo stack for the background and CAT tab, with a replenished buffer of 30 decoded photos. */
export class CatBackground {
  private stack: HTMLDivElement;
  private loadingPill: HTMLDivElement;
  private ready: HTMLImageElement[] = [];
  private loading = new Map<HTMLImageElement, ReturnType<typeof setTimeout>>();
  private retiring = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  private enabled = false;
  private galleryActive = false;
  private appendCount = 0;
  private disposed = false;
  private shown = false;
  private waiting = false;
  private retry?: ReturnType<typeof setTimeout>;
  private resize: ResizeObserver;
  constructor(private root: HTMLElement, private photos = catPhotos()) {
    this.stack = this.makeStack(); root.prepend(this.stack);
    this.loadingPill = el("div", "ao-cat-loading"); this.loadingPill.hidden = true;
    this.loadingPill.setAttribute("role", "status");
    const bubble = el("span", "ao-pill");
    bubble.append(catIcon("ao-cat-icon", "cat"), el("span", "", "Loading more cats…")); this.loadingPill.append(bubble);
    const stars = el("span", "ao-cat-stars"); stars.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 5; i++) {
      const star = el("span", "ao-cat-star", i % 2 ? "✧" : "✦");
      star.style.setProperty("--star", String(i)); stars.append(star);
    }
    this.loadingPill.append(stars); root.append(this.loadingPill);
    this.resize = new ResizeObserver(() => {
      if (this.shown && this.galleryHeight(Array.from(this.stack.children) as HTMLImageElement[]) < root.clientHeight) {
        if (this.galleryActive && this.stack.childElementCount) this.appendCount = 4;
        else this.waiting = true;
      }
      this.work();
    });
    this.resize.observe(root);
    root.addEventListener("scroll", this.onScroll, { passive: true });
    this.work();
  }
  private makeStack() {
    const stack = document.createElement("div"); stack.className = "ao-cats";
    stack.setAttribute("aria-hidden", String(!this.galleryActive)); return stack;
  }
  private galleryHeight(images: HTMLImageElement[]) {
    return images.reduce((sum, image) => sum + this.root.clientWidth * image.naturalHeight / image.naturalWidth, 0);
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.updateVisibility(); this.work();
  }
  setGalleryActive(active: boolean) {
    if (active === this.galleryActive) return;
    this.galleryActive = active;
    this.appendCount = 0; this.root.scrollTop = 0;
    this.root.classList.toggle("ao-cat-view", active);
    this.stack.setAttribute("aria-hidden", String(!active));
    // A fading background must not become a second scrollable stack.
    for (const [stack, timer] of this.retiring) { clearTimeout(timer); stack.remove(); }
    this.retiring.clear(); this.stack.classList.remove("ao-cats-enter");
    this.updateVisibility();
    if (active) this.show();
    else { this.waiting = true; this.work(); }
  }
  private updateVisibility() {
    this.root.classList.toggle("ao-with-cat", (this.enabled || this.galleryActive) && !!this.stack.childElementCount);
  }
  private onScroll = () => {
    if (!this.galleryActive || this.root.scrollTop <= 0 || this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight > 800) return;
    this.appendCount = 4; this.work();
  };
  show() { this.shown = true; if (!this.stack.childElementCount) this.waiting = true; this.work(); }
  refresh() { if (this.enabled && !this.galleryActive) { this.shown = true; this.waiting = true; this.work(); } }
  private work() {
    if (this.disposed) return;
    const width = this.root.clientWidth, height = this.root.clientHeight;
    const replace = this.shown && this.waiting && (this.enabled || this.galleryActive);
    // Fill the empty panel first, then finish preloading the reserve behind it.
    const available = this.ready.length;
    let take = 0, filled = 0;
    while (take < available && filled < height) {
      const image = this.ready[take++]; filled += width * image.naturalHeight / image.naturalWidth;
    }
    const complete = width > 0 && height > 0 && filled >= height;
    if (replace && complete) {
      const next = this.makeStack(); next.append(...this.ready.splice(0, take));
      const previous = this.stack; previous.after(next); this.stack = next;
      this.root.classList.add("ao-with-cat"); next.classList.add("ao-cats-enter"); this.waiting = false;
      if (this.galleryActive) { previous.remove(); next.classList.remove("ao-cats-enter"); }
      else this.retiring.set(previous, setTimeout(() => { previous.remove(); this.retiring.delete(previous); next.classList.remove("ao-cats-enter"); }, 400));
    }
    if (this.galleryActive && !this.waiting && this.appendCount && this.ready.length >= this.appendCount) {
      this.stack.append(...this.ready.splice(0, this.appendCount)); this.appendCount = 0;
    }
    // Use decoded photos immediately and refill the buffer in the background.
    const sample = this.ready.length ? this.ready : Array.from(this.stack.children) as HTMLImageElement[];
    const averageRatio = sample.length ? sample.reduce((sum, image) => sum + image.naturalHeight / image.naturalWidth, 0) / sample.length : .8;
    const estimate = this.shown && width > 0 ? Math.max(1, Math.ceil(height / (width * averageRatio))) : 0;
    const needed = replace && this.waiting && width > 0 && height > 0 ? Math.max(estimate, take + 1) : 0;
    const target = Math.max(RESERVE, needed, this.appendCount);
    this.loadingPill.hidden = !this.galleryActive || (!this.waiting && !this.appendCount);
    if (this.retry) return;
    while (this.loading.size < CONCURRENT && this.ready.length + this.loading.size < target) this.preload();
  }
  private preload() {
    const image = new Image(); image.referrerPolicy = "no-referrer"; image.decoding = "async";
    image.alt = "A random cat"; image.className = "ao-cat";
    const failed = () => {
      if (!this.loading.has(image)) return;
      clearTimeout(this.loading.get(image)); this.loading.delete(image); image.onload = null; image.onerror = null; image.removeAttribute("src");
      if (!this.retry && !this.disposed) this.retry = setTimeout(() => { this.retry = undefined; this.work(); }, 5000);
    };
    this.loading.set(image, setTimeout(failed, 15_000));
    image.onerror = failed;
    image.onload = async () => {
      try { if (typeof image.decode === "function") await image.decode(); } catch { failed(); return; }
      if (!this.loading.has(image) || this.disposed) return;
      if (!image.naturalWidth || !image.naturalHeight) { failed(); return; }
      clearTimeout(this.loading.get(image)); this.loading.delete(image); image.onload = null; image.onerror = null;
      image.width = image.naturalWidth; image.height = image.naturalHeight; this.ready.push(image); this.work();
    };
    void this.photos.next().then(url => {
      if (!this.disposed && this.loading.has(image)) image.src = url;
    }, failed);
  }
  dispose() {
    this.disposed = true; clearTimeout(this.retry); this.photos.dispose();
    for (const [image, timeout] of this.loading) { clearTimeout(timeout); image.onload = null; image.onerror = null; image.removeAttribute("src"); }
    this.loading.clear(); this.resize.disconnect(); this.root.removeEventListener("scroll", this.onScroll);
    this.ready = []; this.stack.remove(); this.loadingPill.remove(); this.root.classList.remove("ao-cat-view", "ao-with-cat");
    for (const [stack, timer] of this.retiring) { clearTimeout(timer); stack.remove(); } this.retiring.clear();
  }
}
