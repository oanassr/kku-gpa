/* =========================================================================
 * ocr.js — التعرّف الضوئي على السجلات المصوّرة (PDF بلا طبقة نصية)
 *
 * يُحمَّل Tesseract.js عند الحاجة فقط، ويعمل كاملاً داخل المتصفح (لا يُرفع شيء).
 * لكل صفحة: نرسمها بدقة عالية، نمسح خطوط الجداول، ثم نمرّرها على نموذجين:
 *   - العربي: للنصوص والتقديرات ورموز المقررات العربية.
 *   - الإنجليزي: للسجلات الإنجليزية وللأعداد (النموذج العربي يُسقط الفاصلة: 14.25 → 145).
 * والناتج عناصر {str,x,y,w,h,xEnd} بإحداثيات الصفحة نفسها التي يُرجعها pdf.js،
 * فيكمل parser.js التحليل بالمسار ذاته.
 * ========================================================================= */

(function () {
  "use strict";

  const BASE = new URL("../lib/tesseract/", document.currentScript.src).href;
  const SCALE = 4; // ≈ 290 نقطة/بوصة

  let loading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = BASE + "tesseract.min.js";
        s.onload = () => resolve(window.Tesseract);
        s.onerror = () => { loading = null; reject(new Error("تعذّر تحميل محرك التعرّف الضوئي")); };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  // حدود الجداول ذات الحواف المجسّمة تُربك تحليل التخطيط في Tesseract، فنمسح كل
  // خط أسود متصل أطول من الحد (بالنقاط). أطول وصلة في كلمة عربية أقصر بكثير من 40 نقطة،
  // وأطول حرف رأسي أقصر من 16 نقطة، بينما أضيق خلية في السجل ≈ 45 نقطة وارتفاع الصف ≈ 25.
  function removeLines(gray, w, h, scale, opts = {}) {
    const thr = opts.thr ?? 170;
    const minH = Math.round((opts.hLine ?? 40) * scale);
    const minV = Math.round((opts.vLine ?? 16) * scale);
    const kill = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w;) {
        if (gray[row + x] >= thr) { x++; continue; }
        let e = x;
        while (e < w && gray[row + e] < thr) e++;
        if (e - x >= minH) kill.fill(1, row + x, row + e);
        x = e;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h;) {
        if (gray[y * w + x] >= thr) { y++; continue; }
        let e = y;
        while (e < h && gray[e * w + x] < thr) e++;
        if (e - y >= minV) for (let k = y; k < e; k++) kill[k * w + x] = 1;
        y = e;
      }
    }
    for (let i = 0; i < w * h; i++) if (kill[i]) gray[i] = 255;
    return gray;
  }

  function flatWords(data) {
    const out = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) {
      for (const wd of l.words) {
        const text = (wd.text || "").trim();
        // بقايا حدود الجداول تُقرأ رموزاً منفردة مثل "|" بثقة منخفضة، وتلتصق بالكلمات المجاورة
        if (!text || (wd.confidence < 50 && !/[؀-ۿ\dA-Za-z]/.test(text))) continue;
        out.push({ text, conf: wd.confidence, ...wd.bbox });
      }
    }
    return out;
  }

  const AR = /[؀-ۿ]/;
  const NUM = /^\d+(\.\d+)?$/;

  function overlap(a, b) {
    const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ix <= 0 || iy <= 0) return 0;
    const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
    // بالنسبة للأكبر: كي لا يحلّ مربع رقمي كبير مشوّه محل رقم صغير داخله ("2" ← "2315")
    return (ix * iy) / Math.max(area(a), area(b));
  }

  const GRADE_AR = /^(\+?[أابجدعحل]\+?|\+?هـ?\+?)$/;
  const GRADE_EN = /^([ABCD]\+?|F|W[PF]?|N[PF]|I[PC]|DN|AU)$/;

  function pick(a, e, arabicPage) {
    // النموذج الإنجليزي يحفظ الفاصلة العشرية؛ نعتمده حين يرى العربي أرقاماً في الموضع نفسه
    if (NUM.test(e.text) && /\d/.test(a.text) && !AR.test(a.text)) return e;
    // خلية تقدير بحرف واحد: كلٌّ من النموذجين يقرأ حروف الآخر خطأً ("أ"↔"i"، "A"↔"ل")، فالحَكَم لغة الصفحة
    const ga = GRADE_AR.test(a.text), ge = GRADE_EN.test(e.text);
    if (ga && ge) return arabicPage ? a : e;
    if (ga && arabicPage) return a;
    // الإنجليزي لا يرى الحروف العربية: "سلم-1142" تصير عنده "1142-"
    if ((a.text.match(/[؀-ۿ]/g) || []).length >= 2 && a.conf >= 60 && !/[A-Za-z]{2}/.test(e.text)) return a;
    return e.conf > a.conf ? e : a;
  }

  // يدمج قراءتَي النموذجين كلمةً كلمة: لكل موضع نأخذ القراءة الأوثق. الكلمات غير المتقابلة تُقبل
  // من لغة الصفحة الغالبة، ومن الأخرى فقط بثقة عالية (كعناوين "تراكمي" العربية في السجل الإنجليزي).
  function mergeWords(arWords, enWords) {
    const score = (ws, re) => ws.filter((w) => re.test(w.text) && w.conf >= 70).length;
    const arabicPage = score(arWords, AR) >= score(enWords, /[A-Za-z]{2}/);
    const out = [];
    // قد تتقابل عدة أجزاء عربية مع الكلمة الإنجليزية نفسها؛ نجمعها كي لا تتكرر الكلمة ("EntrepreneurshipEntrepreneurship")
    const groups = new Map();
    for (const a of arWords) {
      let best = -1, bo = 0.4;
      enWords.forEach((e, i) => { const o = overlap(a, e); if (o > bo) { bo = o; best = i; } });
      if (best >= 0) {
        if (!groups.has(best)) groups.set(best, []);
        groups.get(best).push({ a, o: bo });
      } else if (a.conf >= (arabicPage ? 30 : 80)) {
        out.push(a);
      }
    }
    for (const [i, list] of groups) {
      const e = enWords[i];
      list.sort((x, y) => y.o - x.o);
      if (pick(list[0].a, e, arabicPage) === e) out.push(e);
      else for (const { a } of list) out.push(a);
    }
    enWords.forEach((e, i) => {
      if (groups.has(i) || e.conf < (arabicPage ? 70 : 50)) return;
      if (arabicPage && !NUM.test(e.text)) return;
      // قراءة إنجليزية لجزء من كلمة عربية (الألف تُقرأ "1") ليست كلمة مستقلة — في الصفحات العربية فقط
      if (arabicPage && arWords.some((a) => inside(e, a) > 0.5 && a.conf >= 50)) return;
      out.push(e);
    });
    return out;
  }

  function inside(e, a) {
    const ix = Math.min(a.x1, e.x1) - Math.max(a.x0, e.x0);
    const iy = Math.min(a.y1, e.y1) - Math.max(a.y0, e.y0);
    return ix > 0 && iy > 0 ? (ix * iy) / ((e.x1 - e.x0) * (e.y1 - e.y0)) : 0;
  }

  // عنوان يلتفّ على سطرين داخل إطار ضيق ("Second Semester" فوق "2024/25 (462)") يُقرأ كلمةً واحدة
  // طويلة بثقة متدنية؛ نعيد قراءة موضعه وحده بوضع "كتلة متعددة الأسطر".
  async function refineTallWords(words, image, ar, en) {
    const hs = words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
    const med = hs[hs.length >> 1] || 0;
    const tall = (w) => w.conf < 60 && w.y1 - w.y0 > med * 1.7;
    if (!words.some(tall)) return words;
    const out = [];
    {
      for (const w of words) {
        if (!tall(w)) { out.push(w); continue; }
        const pad = 8;
        const rectangle = { left: Math.max(0, w.x0 - pad), top: Math.max(0, w.y0 - pad), width: w.x1 - w.x0 + 2 * pad, height: w.y1 - w.y0 + 2 * pad };
        const [ra, re] = await Promise.all([
          ar.recognize(image, { rectangle }, { blocks: true }),
          en.recognize(image, { rectangle }, { blocks: true }),
        ]);
        const sub = mergeWords(flatWords(ra.data), flatWords(re.data));
        out.push(...(sub.length ? sub : [w]));
      }
    }
    return out;
  }

  // y = منتصف الكلمة: الأرقام أقصر من الحروف العربية ذات الصواعد والهوابط، فالحافة العليا تفرّق صفاً واحداً.
  function toItems(words, scale) {
    return words.map((wd) => {
      const h = (wd.y1 - wd.y0) / scale;
      const x = wd.x0 / scale, xEnd = wd.x1 / scale;
      return { str: wd.text, x, xEnd, w: xEnd - x, y: (wd.y0 + wd.y1) / 2 / scale, h };
    });
  }

  async function createWorkers(T) {
    const common = { workerPath: BASE + "worker.min.js", corePath: BASE + "core", langPath: BASE + "lang" };
    const [ar, en] = await Promise.all([
      T.createWorker(["ara"], 1, common),
      T.createWorker(["eng"], 1, common),
    ]);
    await ar.setParameters({ preserve_interword_spaces: "1" });
    return { ar, en };
  }

  async function renderGray(page) {
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const n = canvas.width * canvas.height;
    const gray = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) {
      const d = i * 4;
      gray[i] = (img.data[d] * 299 + img.data[d + 1] * 587 + img.data[d + 2] * 114) / 1000;
    }
    removeLines(gray, canvas.width, canvas.height, SCALE);
    for (let i = 0; i < n; i++) {
      const d = i * 4;
      img.data[d] = img.data[d + 1] = img.data[d + 2] = gray[i];
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /**
   * يُرجع عناصر كل صفحة: [[item,...], ...]. onProgress(done, total, phase)
   */
  async function ocrPdf(pdf, onProgress = () => {}) {
    onProgress(0, pdf.numPages, "load");
    const T = await loadTesseract();
    const { ar, en } = await createWorkers(T);
    try {
      const pages = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        onProgress(p - 1, pdf.numPages, "ocr");
        const canvas = await renderGray(await pdf.getPage(p));
        const [ra, re] = await Promise.all([
          ar.recognize(canvas, {}, { blocks: true }),
          en.recognize(canvas, {}, { blocks: true }),
        ]);
        const words = await refineTallWords(mergeWords(flatWords(ra.data), flatWords(re.data)), canvas, ar, en);
        pages.push(toItems(words, SCALE));
        canvas.width = canvas.height = 0;
      }
      onProgress(pdf.numPages, pdf.numPages, "done");
      return pages;
    } finally {
      await Promise.all([ar.terminate(), en.terminate()]);
    }
  }

  window.RecordOCR = { ocrPdf, removeLines, mergeWords, refineTallWords, toItems, flatWords };
})();
