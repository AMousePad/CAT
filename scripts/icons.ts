import { readFileSync } from "node:fs";
import { join } from "node:path";

const fallback = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3 10 6H14L19 3 20 12C20 17 17 21 12 21S4 17 4 12ZM8 11A1 1 0 1 0 8 13 1 1 0 0 0 8 11ZM16 11A1 1 0 1 0 16 13 1 1 0 0 0 16 11ZM10 15 12 18 14 15Z" fill-rule="evenodd"/></svg>';

export function loadNavbarIcon(): string {
  return readFileSync(join(import.meta.dir, "../src/ui/navbar/paw.svg"), "utf8");
}

/** Runs during bundling; raster icons are embedded so no runtime asset requests are needed. */
export function loadIcons(directory = join(import.meta.dir, "../src/ui/icons")): string[] {
  const paths = [...new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true })]
    .filter(path => /\.(svg|png)$/i.test(path)).sort();
  return paths.length ? paths.map(path => {
    const data = readFileSync(join(directory, path));
    if (/\.svg$/i.test(path)) return data.toString("utf8");
    if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || data.toString("ascii", 12, 16) !== "IHDR") throw new Error(`Invalid PNG icon: ${path}`);
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    if (!width || !height) throw new Error(`Empty PNG icon: ${path}`);
    const side = Math.max(width, height) * 1.04;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${(width - side) / 2} ${(height - side) / 2} ${side} ${side}" width="24" height="24" preserveAspectRatio="xMidYMid meet"><image width="${width}" height="${height}" href="data:image/png;base64,${data.toString("base64")}"/></svg>`;
  }) : [fallback];
}
