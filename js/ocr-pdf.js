/**
 * OCR de páginas do PDF (Tesseract.js) + pré-processamento para documentos.
 * Comparado no parse com texto nativo (pdf.js) para alta precisão.
 */
(function (global) {
  "use strict";

  const TESS_OPTS = {
    workerPath:
      "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
    corePath:
      "https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1/tesseract-core-simd.wasm.js",
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
  };

  let workerPromise = null;

  async function getWorker(onProgress) {
    if (!global.Tesseract) {
      throw new Error("Tesseract.js não carregado");
    }
    if (!workerPromise) {
      workerPromise = (async () => {
        const worker = await global.Tesseract.createWorker("por+eng", 1, {
          ...TESS_OPTS,
          logger: (m) => {
            if (onProgress && m && m.status) {
              onProgress({
                phase: "ocr-init",
                status: m.status,
                progress: m.progress,
              });
            }
          },
        });
        // Documentos tabulares / formulários RSC
        await worker.setParameters({
          tessedit_pageseg_mode: "6", // bloco uniforme de texto
          preserve_interword_spaces: "1",
          user_defined_dpi: "300",
        });
        return worker;
      })();
    }
    return workerPromise;
  }

  async function terminateWorker() {
    if (workerPromise) {
      try {
        const w = await workerPromise;
        await w.terminate();
      } catch (_) {}
      workerPromise = null;
    }
  }

  /**
   * Melhora contraste / binarização leve para OCR de PDF impresso.
   */
  function preprocessCanvas(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    if (!width || !height) return canvas;
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    // contraste + leve threshold adaptativo simples
    const contrast = 1.35;
    const mid = 128;
    for (let i = 0; i < d.length; i += 4) {
      // grayscale luminância
      let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      g = (g - mid) * contrast + mid;
      // clarear fundo quase-branco, escurecer traço
      if (g > 200) g = 255;
      else if (g < 90) g = 0;
      g = Math.max(0, Math.min(255, g));
      d[i] = d[i + 1] = d[i + 2] = g;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /**
   * Renderiza página pdf.js em canvas (alta resolução para OCR).
   */
  async function pageToCanvas(pdfPage, scale) {
    const s = scale || 2.4;
    const viewport = pdfPage.getViewport({ scale: s });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    return preprocessCanvas(canvas);
  }

  /**
   * Corrige erros típicos de OCR em formulários RSC (PT-BR).
   */
  function normalizeOcrText(text) {
    let t = String(text || "");
    // normaliza quebras e espaços
    t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    t = t.replace(/[|¦]/g, "I");
    // confusões comuns de rótulos
    t = t.replace(/\bSIAPE\b/gi, "SIAPE");
    t = t.replace(/\bSlAPE\b/gi, "SIAPE");
    t = t.replace(/\bSIAP[EÉ]\b/gi, "SIAPE");
    t = t.replace(/\bN0me\b/gi, "Nome");
    t = t.replace(/\bNorne\b/gi, "Nome");
    t = t.replace(/\bCarg0\b/gi, "Cargo");
    t = t.replace(/\bLota[cç][aã]0\b/gi, "Lotação");
    t = t.replace(/\bE[\s\-–]*mai[l1]\b/gi, "E-mail");
    t = t.replace(/\bRSC[\s\-–—]*PCCTAE\b/gi, "RSC-PCCTAE");
    t = t.replace(/\bPCCTA[EÉ]\b/gi, "PCCTAE");
    t = t.replace(/\bPontua[cç][aã]0\b/gi, "Pontuação");
    // datas: 0I/02/2O16 → 01/02/2016 (parcial)
    t = t.replace(
      /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.]([Oo0Il]?\d{2,3})\b/g,
      (m, d, mo, y) => {
        const yy = String(y)
          .replace(/[Oo]/g, "0")
          .replace(/[Il]/g, "1");
        return `${d.padStart(2, "0")}/${mo.padStart(2, "0")}/${yy}`;
      }
    );
    // e-mail com espaços / pontos OCR
    t = t.replace(
      /([a-z0-9._%+-]+(?:\s*[.\-]\s*[a-z0-9._%+-]+)*)\s*[@©]\s*([a-z0-9.\-]+(?:\s*[.\-]\s*[a-z0-9.\-]+)+)/gi,
      (_, u, d) =>
        u.replace(/\s+/g, "") + "@" + d.replace(/\s+/g, "").replace(/,/g, ".")
    );
    // números BR: vírgula OCR como ponto em contextos de pontos
    // (mantém vírgula decimal BR se seguida de 1 dígito)
    return t;
  }

  function linesFromText(full) {
    return normalizeOcrText(full)
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  /**
   * OCR de todas as páginas. Retorna { text, lines, pageTexts, confidence }
   */
  async function ocrPdfArrayBuffer(arrayBuffer, onProgress) {
    if (!global.pdfjsLib) throw new Error("pdf.js não carregado");
    // clonar buffer: pdf.js e OCR podem consumir
    const data =
      arrayBuffer instanceof ArrayBuffer
        ? arrayBuffer.slice(0)
        : arrayBuffer;
    const pdf = await global.pdfjsLib.getDocument({ data }).promise;
    const worker = await getWorker(onProgress);
    const pageTexts = [];
    let confSum = 0;
    let confN = 0;

    for (let p = 1; p <= pdf.numPages; p++) {
      if (onProgress) {
        onProgress({
          phase: "ocr-page",
          page: p,
          total: pdf.numPages,
          progress: (p - 1) / pdf.numPages,
        });
      }
      const page = await pdf.getPage(p);
      // escala adaptativa: páginas muito largas usam 2.0; padrão 2.4
      const baseVp = page.getViewport({ scale: 1 });
      const scale = baseVp.width > 900 ? 2.0 : 2.4;
      const canvas = await pageToCanvas(page, scale);
      const result = await worker.recognize(canvas);
      const text = (result && result.data && result.data.text) || "";
      const conf =
        result && result.data && typeof result.data.confidence === "number"
          ? result.data.confidence
          : 0;
      confSum += conf;
      confN++;
      pageTexts.push(normalizeOcrText(text));
      canvas.width = 0;
      canvas.height = 0;
    }

    if (onProgress) {
      onProgress({
        phase: "ocr-page",
        page: pdf.numPages,
        total: pdf.numPages,
        progress: 1,
      });
    }

    const full = pageTexts.join("\n");
    const lines = linesFromText(full);

    return {
      text: full,
      lines,
      pageTexts,
      confidence: confN ? confSum / confN : 0,
      numPages: pdf.numPages,
    };
  }

  global.RSCOCR = {
    ocrPdfArrayBuffer,
    terminateWorker,
    pageToCanvas,
    normalizeOcrText,
    preprocessCanvas,
  };
})(typeof window !== "undefined" ? window : globalThis);
