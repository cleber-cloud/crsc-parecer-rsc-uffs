/**
 * Smoke test: parse dual (texto + opcional OCR) nos PDFs de amostra.
 * Uso:
 *   node smoke-test.mjs              # só texto nativo (rápido)
 *   node smoke-test.mjs --ocr        # texto + OCR (lento, precisa rede)
 */
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIX = __dirname;
const USE_OCR = process.argv.includes("--ocr");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function contentType(p) {
  return MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
}

const server = createServer((req, res) => {
  try {
    let u = decodeURIComponent((req.url || "/").split("?")[0]);
    if (u === "/") u = "/index.html";
    const fp = path.normalize(path.join(ROOT, u.replace(/^\//, "")));
    if (!fp.startsWith(ROOT) || !existsSync(fp) || statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(fp) });
    createReadStream(fp).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

async function findPlaywright() {
  const candidates = [
    path.resolve(ROOT, "../Calculadora/node_modules/playwright"),
    path.resolve(ROOT, "node_modules/playwright"),
    "playwright",
  ];
  for (const c of candidates) {
    try {
      return await import(
        path.isAbsolute(c) || c.startsWith(".")
          ? "file://" + c.replace(/\\/g, "/") + "/index.mjs"
          : c
      );
    } catch (_) {
      try {
        if (path.isAbsolute(c)) {
          const pkg = path.join(c, "index.js");
          if (existsSync(pkg)) return await import("file://" + pkg.replace(/\\/g, "/"));
        }
      } catch (__) {}
    }
  }
  // last resort: require-style via createRequire
  const { createRequire } = await import("node:module");
  const req = createRequire(path.join(ROOT, "../Calculadora/package.json"));
  return req("playwright");
}

function summarize(data) {
  const itens = data.itens || [];
  const comQtd = itens.filter((i) => (Number(i.qtdDeclarada) || 0) > 0);
  return {
    nome: data.nome,
    siape: data.siape,
    cargo: data.cargo,
    lotacao: data.lotacao,
    email: data.email,
    dataIngresso: data.dataIngresso,
    nivelRsc: data.nivelRsc,
    pontMin: data.pontuacaoMinimaDeclarada,
    pontTotal: data.pontuacaoTotalDeclarada,
    nItens: itens.length,
    nComQtd: comQtd.length,
    sumItens:
      Math.round(
        itens.reduce((s, i) => s + (Number(i.pontosObtidos) || 0), 0) * 10
      ) / 10,
    matchedIds: comQtd.map((i) => `${i.criterionId}=${i.qtdDeclarada}`),
    unmatched: (data._catalogUnmatched || []).map((u) =>
      String(u.item?.descricao || "").slice(0, 60)
    ),
    catalogMeta: data._catalogMeta || null,
    merge: data._merge
      ? {
          scoreText: data._merge.scoreText,
          scoreOcr: data._merge.scoreOcr,
          winner: data._merge.winner,
          itensStrategy: data._merge.itensStrategy,
          fieldsAgree: data._merge.fieldsAgree,
          fieldsConflict: data._merge.fieldsConflict,
          ocrConfidence: data._merge.ocrConfidence,
        }
      : null,
    textItens: data._textOnly?.itens?.length,
    ocrItens: data._ocrOnly?.itens?.length,
    ocrError: data._ocrError || null,
  };
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  console.log("Serving", ROOT, "on", base);
  console.log("OCR:", USE_OCR ? "ON" : "OFF (texto nativo only)");

  let playwright;
  try {
    playwright = await findPlaywright();
  } catch (e) {
    console.error("Playwright não encontrado:", e.message);
    process.exit(1);
  }

  const { chromium } = playwright;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(USE_OCR ? 600000 : 120000);

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("  [browser]", msg.text());
  });

  await page.goto(base + "/index.html", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      window.RSCParseRequerimento &&
      window.pdfjsLib &&
      window.RSCRegras &&
      window.RSCCriterios &&
      window.RSC_CRITERIOS_ORDEM
  );

  const pdfs = (await readdir(FIX))
    .filter((f) => f.endsWith(".pdf"))
    .sort();

  const results = [];
  for (const name of pdfs) {
    const fp = path.join(FIX, name);
    const buf = await readFile(fp);
    console.log("\n===", name, `(${buf.length} bytes) ===`);
    const t0 = Date.now();
    const data = await page.evaluate(
      async ({ b64, useOcr }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const ab = bytes.buffer;
        return RSCParseRequerimento.parseRequerimentoPdf(ab, {
          useOcr,
          onProgress: null,
        });
      },
      { b64: buf.toString("base64"), useOcr: USE_OCR }
    );
    const ms = Date.now() - t0;
    const s = summarize(data);
    s.file = name;
    s.ms = ms;
    results.push(s);
    console.log(JSON.stringify(s, null, 2));

    // checks mínimos
    const fails = [];
    if (!s.siape || !/^\d{6,8}$/.test(String(s.siape))) fails.push("siape");
    if (!s.nome || s.nome.length < 5) fails.push("nome");
    if (!s.nivelRsc) fails.push("nivelRsc");
    if (s.nItens < 50) fails.push(`catalog-size=${s.nItens}`);
    if (!s.nComQtd) fails.push("sem-qtd");
    if (s.pontTotal != null && s.sumItens != null) {
      const d = Math.abs(s.pontTotal - s.sumItens);
      if (d > 5) fails.push(`soma-itens-diff=${d}`);
    }
    if (s.unmatched && s.unmatched.length)
      fails.push(`unmatched=${s.unmatched.length}`);
    console.log(fails.length ? "FAIL: " + fails.join(", ") : "PASS (catálogo + quantidades)");
  }

  await browser.close();
  server.close();

  const nFail = results.filter(
    (s) => !s.siape || !s.nome || !s.nivelRsc || !s.nItens
  ).length;
  console.log("\n--- resumo ---");
  console.log(
    results
      .map(
        (r) =>
          `${r.file}: ${r.nome} | SIAPE ${r.siape} | RSC ${r.nivelRsc} | ${r.nItens} itens | ${r.pontTotal} pts | ${r.ms}ms`
      )
      .join("\n")
  );
  process.exit(nFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
