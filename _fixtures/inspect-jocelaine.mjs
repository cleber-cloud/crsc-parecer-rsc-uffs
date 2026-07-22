import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const req = createRequire(path.join(ROOT, "../Calculadora/package.json"));
const { chromium } = req("playwright");
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
};

const server = createServer((req, res) => {
  let u = decodeURIComponent((req.url || "/").split("?")[0]);
  if (u === "/") u = "/index.html";
  const fp = path.normalize(path.join(ROOT, u.replace(/^\//, "")));
  if (!fp.startsWith(ROOT) || !existsSync(fp) || statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end("nf");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(fp)] || "application/octet-stream",
  });
  createReadStream(fp).pipe(res);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => window.RSCParseRequerimento);
const buf = await readFile(path.join(__dirname, "jocelaine.pdf"));
const info = await page.evaluate(async (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const { lines, rawJoin } = await RSCParseRequerimento.extractPdfLines(
    bytes.buffer
  );
  const hits = lines.filter((l) =>
    /RSC|n[ií]vel|pretendido|m[ií]nima|total|excedente|\[\s*x|^\s*x\s*$|PCCTAE/i.test(
      l
    )
  );
  // around "Nível de RSC"
  let idx = lines.findIndex((l) => /N[ií]vel de RSC/i.test(l));
  const window =
    idx >= 0 ? lines.slice(Math.max(0, idx - 2), idx + 30) : lines.slice(-40);
  return {
    hits,
    window,
    rawSnippet: rawJoin.slice(
      Math.max(0, rawJoin.search(/N[ií]vel de RSC|RSC-PCCTAE/i) - 50),
      Math.max(0, rawJoin.search(/N[ií]vel de RSC|RSC-PCCTAE/i) - 50) + 800
    ),
  };
}, buf.toString("base64"));

console.log("--- hits ---");
console.log(info.hits.join("\n"));
console.log("\n--- window ---");
console.log(info.window.join("\n"));
console.log("\n--- raw ---");
console.log(info.rawSnippet);
await browser.close();
server.close();
