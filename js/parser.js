/* =========================================================================
 * parser.js — قراءة السجل الأكاديمي (PDF) واستخلاص بيانات الطالب والمقررات
 *
 * المنهجية:
 *   1) نقرأ عناصر النص مع إحداثياتها (x,y) عبر pdf.js — لا OCR، السجل نصّي.
 *   2) نعيد بناء الصفوف والأعمدة اعتماداً على المواقع (التخطيط ثنائي العمود/RTL).
 *   3) نلتقط المقررات عبر نمط "رمز المقرر"، ونصنّفها: مكتملة / حالية / تكميلية.
 *   4) نستخلص معلومات الترويسة والحالة التراكمية كنقطة انطلاق قابلة للمراجعة.
 *
 * كل المعالجة محلية في المتصفح. لا يُرفع الملف ولا يُحفظ.
 * ========================================================================= */

(function () {
  "use strict";

  // ---- أدوات مساعدة للنص العربي ----------------------------------------

  // pdf.js قد يُرجع الحروف العربية بصيغة العرض (Presentation Forms). نُعيدها لصيغتها الأساسية.
  // كما نزيل التشكيل ونوحّد الأرقام العربية إلى لاتينية.
  function arabicNormalize(s) {
    if (!s) return "";
    // NFKC يحوّل أشكال العرض العربية إلى الحروف الأساسية (ﺍﻟﻨﻘﺎﻁ → النقاط)
    s = s.normalize("NFKC");
    let out = "";
    for (const ch of s) {
      const code = ch.codePointAt(0);
      // أرقام عربية-هندية → لاتينية
      if (code >= 0x0660 && code <= 0x0669) { out += String(code - 0x0660); continue; }
      if (code >= 0x06f0 && code <= 0x06f9) { out += String(code - 0x06f0); continue; }
      // خطوط بعض السجلات المطبوعة من المتصفح تُرجع أشكالاً فارسية: ی ھ ک
      if (code === 0x06CC) { out += "ي"; continue; }
      if (code === 0x06BE || code === 0x06C1) { out += "ه"; continue; }
      if (code === 0x06A9) { out += "ك"; continue; }
      // إسقاط التشكيل والمحارف الاتجاهية وعلامة التطويل ومحارف صفرية العرض
      if (
        (code >= 0x0610 && code <= 0x061A) ||
        (code >= 0x064B && code <= 0x065F) ||
        code === 0x0640 || code === 0x0670 ||
        (code >= 0x06D6 && code <= 0x06ED) ||
        code === 0x200B || code === 0x200C || code === 0x200D ||
        code === 0x200E || code === 0x200F ||
        (code >= 0x202A && code <= 0x202E) ||
        (code >= 0x2066 && code <= 0x2069) ||
        code === 0xFEFF
      ) { continue; }
      out += ch;
    }
    return out.trim();
  }

  // توحيد بعض الحروف للمقارنة فقط (لا يُستخدم للعرض)
  function fold(s) {
    return arabicNormalize(s)
      .replace(/[إأآا]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- استخراج العناصر من pdf.js ---------------------------------------

  /**
   * يحوّل صفحة pdf.js إلى عناصر نصية موحّدة.
   * كل عنصر: { str, x, y, w, h } حيث y من الأعلى (top).
   */
  async function extractItems(page) {
    const content = await page.getTextContent({ disableNormalization: false });
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;
    const items = [];
    for (const it of content.items) {
      const str = arabicNormalize(it.str);
      if (!str) continue;
      const tr = it.transform; // [a,b,c,d,e,f]
      const x = tr[4];
      const yBottom = tr[5];
      const h = it.height || Math.hypot(tr[2], tr[3]) || 10;
      const top = pageHeight - yBottom - h; // نحوّل إلى إحداثي من الأعلى
      items.push({ str, x, y: top, w: it.width || 0, h, xEnd: x + (it.width || 0) });
    }
    return { items, width: viewport.width, height: pageHeight };
  }

  // ---- تجميع العناصر في صفوف -------------------------------------------

  /** تجميع العناصر التي تقع على نفس السطر تقريباً (بفارق رأسي صغير). */
  function groupRows(items, tol = 4) {
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const it of sorted) {
      let row = rows.find((r) => Math.abs(r.y - it.y) <= tol);
      if (!row) {
        row = { y: it.y, items: [] };
        rows.push(row);
      }
      row.items.push(it);
      // متوسط y لتثبيت الصف
      row.y = row.items.reduce((s, p) => s + p.y, 0) / row.items.length;
    }
    rows.forEach((r) => r.items.sort((a, b) => a.x - b.x));
    rows.sort((a, b) => a.y - b.y);
    return rows;
  }

  // ---- دمج الحروف المفرّقة ---------------------------------------------
  // صفحات EduGate المطبوعة من المتصفح تُرجع العربية حرفاً حرفاً (كل حرف عنصر مستقل).

  const HAS_AR = /[؀-ۿ]/;

  function isGlyphSplit(items) {
    const ar = items.filter((i) => HAS_AR.test(i.str));
    if (ar.length < 20) return false;
    const single = ar.filter((i) => i.str.replace(/\s+/g, "").length <= 2).length;
    return single / ar.length > 0.6;
  }

  // الفجوات المقيسة: داخل الكلمة ≈ 0، بين الكلمات ≈ 0.3 من ارتفاع الخط، بين الخلايا عشرات النقاط.
  function mergeGlyphRuns(items) {
    const out = [];
    for (const row of groupRows(items, 3)) {
      const its = row.items;
      let run = [its[0]];
      const flush = () => {
        const rtl = run.some((i) => HAS_AR.test(i.str));
        const ordered = rtl ? run.slice().reverse() : run;
        let str = ordered[0].str;
        for (let k = 1; k < ordered.length; k++) {
          const a = rtl ? ordered[k] : ordered[k - 1];
          const b = rtl ? ordered[k - 1] : ordered[k];
          const gap = b.x - a.xEnd;
          str += (gap > Math.max(a.h, b.h) * 0.1 ? " " : "") + ordered[k].str;
        }
        const x = Math.min(...run.map((i) => i.x));
        const xEnd = Math.max(...run.map((i) => i.xEnd));
        out.push({
          str: str.replace(/\s+/g, " ").trim(), x, xEnd, w: xEnd - x,
          y: run.reduce((s, i) => s + i.y, 0) / run.length,
          h: Math.max(...run.map((i) => i.h)),
        });
      };
      for (let k = 1; k < its.length; k++) {
        const prev = run[run.length - 1], cur = its[k];
        if (cur.x - prev.xEnd < Math.max(prev.h, cur.h)) run.push(cur);
        else { flush(); run = [cur]; }
      }
      flush();
    }
    return out;
  }

  // ---- أنماط التعرّف ----------------------------------------------------

  // رمز المقرر: أحرف (عربية أو لاتينية) مع 3–4 أرقام، وقد يتخللها شرطة ورقم وحدات.
  // أمثلة: "نما2044"، "نما-2044"، "6004نما-3"، "3-نما3322"، "MIS6001"، "MIS-6001".
  const COURSE_CODE_RE = /^(?=.*[A-Za-zء-ي])(?=.*\d{3,})[A-Za-zء-ي0-9\-]+$/;

  // يتحقق من أن النص رمز مقرر حقيقي وليس تاريخاً أو عنصراً آخر.
  function isCourseCode(s) {
    if (!COURSE_CODE_RE.test(s)) return false;
    // استبعاد أنماط التاريخ dd-mm-yyyy
    if (/\d{1,2}[-\/]\d{2}[-\/]\d{4}/.test(s)) return false;
    // استبعاد "1من08-10-2026" (رقم الصفحة + "من" + التاريخ في تذييل السجل الرسمي)
    if (/^\d{1,3}من\d/.test(s)) return false;
    return true;
  }

  // كشف لغة السجل من نسبة الأحرف اللاتينية مقابل العربية.
  function detectLang(items) {
    let ar = 0, la = 0;
    for (const it of items) {
      for (const ch of it.str) {
        const c = ch.codePointAt(0);
        if (c >= 0x0600 && c <= 0x06ff) ar++;
        else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) la++;
      }
    }
    return la > ar ? "en" : "ar";
  }

  // رموز التقديرات المقبولة (عربي + إنجليزي)
  const GRADE_TOKENS = new Set([
    "أ+", "أ", "ا+", "ا", "ب+", "ب", "ج+", "ج", "د+", "د", "هـ", "ه",
    "ع", "ح", "ل", "ند", "م",
    "A+", "A", "B+", "B", "C+", "C", "D+", "D", "F",
  ]);

  // تحويل التقدير الإنجليزي إلى الرمز العربي المعتمد في الواجهة.
  const EN_TO_AR_GRADE = {
    "A+": "أ+", "A": "أ", "B+": "ب+", "B": "ب", "C+": "ج+",
    "C": "ج", "D+": "د+", "D": "د", "F": "هـ",
  };

  function isGradeToken(s) {
    const t = s.replace(/\s+/g, "");
    if (GRADE_TOKENS.has(t)) return true;
    if (GRADE_TOKENS.has(t.toUpperCase())) return true;
    // أشكال مثل "+ب" بسبب الاتجاه
    if (/^\+[ابجدأاه]$/.test(t)) return true;
    return false;
  }

  function isNumberToken(s) {
    return /^-?(\d+(\.\d+)?|\.\d+)$/.test(s.replace(/\s+/g, ""));
  }

  // كلمات دلالية ثنائية اللغة في الترويسة والملخصات
  const KW = {
    name: ["الاسم", "name", "student name"],
    studentId: ["رقم الطالب", "student no", "student id", "id no", "university no"],
    civil: ["السجل المدني", "civil record", "national id", "id number"],
    major: ["التخصص", "major", "specialization", "specialty"],
    degree: ["الدرجة", "degree", "level"],
    college: ["الكلية", "college", "faculty"],
    semester: ["فصلي", "semester", "term"],
    cumulative: ["تراكمي", "cumulative", "cum gpa", "cumulative gpa"],
    earned: ["مكتسبة", "earned"],
    gpaWord: ["معدل", "gpa", "average"],
    remedialStart: ["المقررات التكميلية", "remedial courses", "preparatory courses", "complementary courses"],
    remedialEnd: ["نهاية المقررات التكميلية", "end of remedial", "end of complementary"],
    termLine: ["الفصل", "semester", "term"],
    warnings: ["الانذارات", "الإنذارات", "warnings", "warning"],
  };

  function rowText(row, lang) {
    // ترتيب القراءة: العربية من اليمين (x الأكبر) لليسار، والإنجليزية من اليسار لليمين.
    const items = row.items.slice();
    items.sort((a, b) => (lang === "en" ? a.x - b.x : b.x - a.x));
    return items.map((i) => i.str).join(" ");
  }

  // ---- تصنيف خلية التقدير (محتسب / حالة) -------------------------------

  const COUNTED_GRADES = new Set(["أ+", "أ", "ب+", "ب", "ج+", "ج", "د+", "د", "هـ"]);

  // حالات المقرر غير المحتسبة (إنجليزي + عربي)
  const STATUS_OF = {
    "W": "withdrawn", "WP": "withdrawn", "WF": "fail",
    "NP": "nopass", "NF": "absent", "DN": "denied", "AU": "audit",
    "IP": "inprogress", "IC": "inprogress",
    "ع": "excused", "ح": "absent", "ل": "withdrawn", "ند": "nopass",
    "م": "inprogress", "غ": "absent", "مستمر": "inprogress",
    "منسحب": "withdrawn", "محروم": "absent", "غائب": "absent", "راسب": "fail",
  };

  // الحالات المستبعَدة من عرض مقررات الفصل الأخير: فقط ما لا يحمل درجة فعلية
  // (غائب/محروم، منسحب، غير محتسب، معذور). الراسب (هـ/F) يُعرض لأنه درجة حقيقية تُحتسب.
  const EXCLUDE_FROM_CURRENT = new Set(["absent", "withdrawn", "nopass", "denied", "audit", "excused"]);

  // يُصنّف رمزاً في عمود التقدير: يُرجع {grade, status, raw} أو null إن لم يكن خلية تقدير.
  function classifyGradeCell(s) {
    const t = s.replace(/\s+/g, "");
    if (!t) return null;
    const g = normalizeGrade(t); // EN→AR، "+ب"→"ب+"، إلخ
    if (COUNTED_GRADES.has(g)) return { grade: g, status: g === "هـ" ? "fail" : "pass", raw: t };
    const up = t.toUpperCase();
    if (STATUS_OF[up]) return { grade: "", status: STATUS_OF[up], raw: t };
    if (STATUS_OF[t]) return { grade: "", status: STATUS_OF[t], raw: t };
    return null;
  }

  // النقاط المطبوعة = الساعات × قيمة التقدير (سلّم 5)، فهي تحدّد التقدير بدقة حين تُفقد خلية التقدير
  // أو تُقرأ ناقصة (التعرّف الضوئي يُسقط الألف المنفردة في "+أ" مثلاً).
  const GRADE_VALUES = [["أ+", 5], ["أ", 4.75], ["ب+", 4.5], ["ب", 4], ["ج+", 3.5], ["ج", 3], ["د+", 2.5], ["د", 2], ["هـ", 1]];

  // النقاط الموجبة لا تأتي إلا من تقدير محتسب (المنسحب/غير المحتسب نقاطه 0)، فتتقدّم على أي حالة مقروءة.
  function reconcileGrade(c) {
    if (!(c.points > 0) || !(c.hours > 0)) return c;
    const match = (p) => GRADE_VALUES.find(([, gv]) => Math.abs(gv - p / c.hours) < 0.01);
    // قراءة مباشرة أولاً، ثم احتمال سقوط الفاصلة العشرية ("75" بدل 7.5، "1425" بدل 14.25)
    let hit = match(c.points);
    if (!hit) {
      for (const div of [10, 100]) {
        const h = match(c.points / div);
        if (h && (!c.grade || h[0] === c.grade)) { hit = h; c.points = c.points / div; break; }
      }
    }
    if (hit && hit[0] !== c.grade) {
      c.grade = hit[0];
      c.status = hit[0] === "هـ" ? "fail" : "pass";
      c.inProgress = false;
    }
    return c;
  }

  // ---- التعرّف على الفصول الدراسية (لتحديد آخر فصل) --------------------

  // يحوّل نص ترويسة فصل إلى مفتاح ترتيبي: السنة×10 + رقم الفصل.
  function parseTermKey(txt) {
    // رمز الفصل في صفحات EduGate: "(481)" = 1448 الفصل 1. نقدّمه لأنه ثابت في النسختين العربية
    // والإنجليزية، ويبقى حين يلتفّ عنوان الفصل على سطرين ("Second Semester" / "2025/26 (472)").
    let m = txt.match(/[()](\d{2})([1-4])[()]/);
    if (m && /\d{4}|semester|الفصل/i.test(txt)) return (1400 + parseInt(m[1], 10)) * 10 + parseInt(m[2], 10);
    // إنجليزي: "First Semester 2026 / 2027" أو "First Semester 2026/2027 - Active"
    m = txt.match(/(First|Second|Third|Fourth|Summer)\s+Semester\s+(\d{4})\s*[/\-]/i);
    if (m) {
      const tn = { first: 1, second: 2, third: 3, fourth: 3, summer: 4 }[m[1].toLowerCase()];
      return parseInt(m[2], 10) * 10 + tn;
    }
    const f = fold(txt);
    // عربي صيغة 1: "الفصل الأول 1448" (الاسم ثم الرقم)
    m = f.match(/الفصل\s+(الاول|الثاني|الثالث|الرابع|الصيفي)\s+(\d{3,4})/);
    if (m) {
      const tn = { "الاول": 1, "الثاني": 2, "الثالث": 3, "الرابع": 3, "الصيفي": 4 }[m[1]];
      return parseInt(m[2], 10) * 10 + tn;
    }
    // عربي صيغة 2: "1448 الفصل الأول" (الرقم قبل الاسم بسبب ترتيب العرض)
    m = f.match(/(\d{4})\s+الفصل\s+(الاول|الثاني|الثالث|الرابع|الصيفي)/);
    if (m) {
      const tn = { "الاول": 1, "الثاني": 2, "الثالث": 3, "الرابع": 3, "الصيفي": 4 }[m[2]];
      return parseInt(m[1], 10) * 10 + tn;
    }
    return null;
  }

  // يكتشف ترويسات الفصول في صف (قد تكون عموداً أو عمودين) مع مواضعها الأفقية.
  function detectTerms(row) {
    const items = row.items.slice().sort((a, b) => a.x - b.x);
    // تجميع حسب الفجوات الأفقية لعزل العمودين
    const segs = [];
    let cur = [];
    for (const it of items) {
      if (cur.length && it.x - cur[cur.length - 1].xEnd > 30) { segs.push(cur); cur = []; }
      cur.push(it);
    }
    if (cur.length) segs.push(cur);

    const terms = [];
    for (const seg of segs) {
      const txtEn = seg.slice().sort((a, b) => a.x - b.x).map((i) => i.str).join(" ");
      const txtAr = seg.slice().sort((a, b) => b.x - a.x).map((i) => i.str).join(" ");
      const key = parseTermKey(txtEn) || parseTermKey(txtAr);
      if (key) terms.push({ x: Math.min(...seg.map((s) => s.x)), key });
    }
    return terms;
  }

  // ---- استخلاص الترويسة (بيانات الطالب) --------------------------------

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractHeader(rows, pageWidth, lang) {
    const info = {
      university: "", college: "", name: "", studentId: "",
      civilId: "", major: "", degree: "", printDate: "",
    };
    const head = rows.slice(0, 16);

    // تاريخ الطباعة (مشترك للغتين) — مع منع الالتقاط من داخل أرقام أطول كرقم المستند
    for (const r of rows) {
      const m = rowText(r, lang).match(/(?<![\d-])(\d{1,2}[-/]\d{1,2}[-/]\d{4})(?![\d-])/);
      if (m) { info.printDate = m[1]; break; }
    }

    // العربي أولاً (السجلات ثنائية اللغة عربية الأصل)، ثم استكمال الحقول الناقصة من الإنجليزي
    extractHeaderAR(head, info);
    if (lang === "en" || !info.name || !info.studentId) {
      const en = extractHeaderEN(head, { ...info, name: "", studentId: "", major: "", degree: "", college: "", civilId: "" });
      for (const k of ["name", "studentId", "major", "degree", "college", "civilId", "university"]) {
        if (!info[k] && en[k]) info[k] = en[k];
      }
    }
    return info;
  }

  // ---- ترويسة السجل العربي (مسار مُتحقَّق منه) ----
  function extractHeaderAR(head, info) {
    // نُبقي العناصر العربية والرقمية فقط حتى لا يختلط النص الإنجليزي بالقيم في السجلات ثنائية اللغة
    const arText = (r) => r.items
      .filter((i) => !/[A-Za-z]/.test(i.str))
      .sort((a, b) => b.x - a.x)
      .map((i) => i.str).join(" ");
    const fullText = head.map(arText).join("  ||  ");
    if (/الملك\s*خالد/.test(fold(fullText))) info.university = "جامعة الملك خالد";

    for (const r of head) {
      const t = arText(r);
      const tf = fold(t);
      if (!info.name && (tf.includes("الاسم") || tf.includes("اسم الطالب"))) {
        const m = t.match(/(?:الاسم|اسم الطالب)\s*:?\s*([^\:]+?)\s*(?:التخصص|رقم|الدرجة|السجل|:|$)/);
        if (m) info.name = cleanVal(m[1]);
      }
      if (!info.major && tf.includes("التخصص")) {
        const m = t.match(/التخصص\s*:?\s*([^\:]+?)\s*(?:الاسم|اسم الطالب|رقم|الدرجة|السجل|نوع|عدد|:|$)/);
        if (m) info.major = cleanVal(m[1]);
      }
      if (!info.degree && tf.includes("الدرجه")) {
        const m = t.match(/الدرجة\s*:?\s*([^\:]+?)\s*(?:رقم|الاسم|التخصص|نوع|:|$)/);
        if (m) info.degree = cleanVal(m[1]);
      }
      if (!info.studentId && tf.includes("رقم الطالب")) {
        const m = t.match(/رقم الطالب\D{0,6}(\d{6,})/) || t.match(/(\d{6,})/);
        if (m) info.studentId = m[1];
      }
      if (!info.civilId && tf.includes("السجل المدني")) {
        const m = t.match(/السجل المدني\D{0,6}(\d{8,})/) || t.match(/(\d{8,})/);
        if (m) info.civilId = m[1];
      }
      if (!info.college && tf.includes("الكليه")) {
        const m = t.match(/الكلية\s*:?\s*([^\:]+?)(?:السجل|الجامعة|$)/);
        if (m) info.college = cleanVal(m[1]);
      }
    }
    return info;
  }

  // ---- ترويسة السجل الإنجليزي (تُعاير على عيّنة حقيقية) ----
  function extractHeaderEN(head, info) {
    const fullText = head.map((r) => rowText(r, "en")).join("  ||  ");
    if (/king\s*khalid/i.test(fullText)) info.university = "King Khalid University";

    const allLabels = [].concat(
      KW.name, KW.studentId, KW.civil, KW.major, KW.degree, KW.college,
      ["print date", "page", "deanship", "academic record"]
    );
    const boundary = allLabels.map((l) => escapeRe(l)).join("|");

    const grabText = (keys) => {
      for (const k of keys) {
        const re = new RegExp(escapeRe(k) + "\\s*[:：.\\-–]+\\s*([A-Za-z][A-Za-z0-9 .,'\\-&/]+?)\\s*(?:" + boundary + "|\\|\\||[\\u0600-\\u06FF]|$)", "i");
        const m = fullText.match(re);
        // الأسماء والتخصصات لا تحوي أرقاماً؛ ما يظهر منها شوائب تعرّف ضوئي ("I1")
        if (m && m[1] && m[1].trim().length > 1) return cleanVal(m[1].replace(/\d+/g, ""));
      }
      return "";
    };
    const grabNum = (keys, minLen) => {
      for (const k of keys) {
        const re = new RegExp(escapeRe(k) + "\\D{0,12}(\\d{" + minLen + ",})", "i");
        const m = fullText.match(re);
        if (m) return m[1];
      }
      return "";
    };

    info.name = grabText(KW.name);
    info.major = grabText(KW.major);
    info.degree = grabText(KW.degree);
    info.college = grabText(KW.college);
    info.studentId = grabNum(KW.studentId, 5);
    info.civilId = grabNum(KW.civil, 8);
    return info;
  }

  function cleanVal(s) {
    return (s || "")
      .replace(/[:|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- استخلاص المقررات والفصول ----------------------------------------

  /**
   * لكل صف يحوي رمز مقرر، نستنتج خلاياه ضمن العمود الذي يقع فيه الرمز.
   * نحدد العمود (يمين/يسار) عبر منتصف الصفحة، ثم نلتقط داخل نفس العمود:
   *   رمز المقرر (x الأكبر) ← اسم المقرر ← التقدير ← الساعات ← النقاط (x الأصغر).
   */
  function parseCourses(rows, pageWidth, lang) {
    const courses = [];

    // تتبّع حالة "المقررات التكميلية / Remedial" حسب الموضع الرأسي
    let remedial = false;
    const remStartF = KW.remedialStart.map(fold);
    const remEndF = KW.remedialEnd.map(fold);

    // أعمدة الفصول النشطة حالياً: [{x, key}] — تُحدَّث عند كل صف ترويسة فصل.
    let columns = [];
    // ترويسة جدول المقررات الأخيرة (مواضع أعمدتها) — العربية والإنجليزية
    let header = null;
    let headerEN = null;

    for (const row of rows) {
      const tf = fold(rowText(row, lang));

      // تحديث أعمدة الفصول إن كان هذا الصف ترويسة فصل/فصول
      const terms = detectTerms(row);
      if (terms.length) columns = terms;

      // لا نتخطّى الصف: في التخطيط ثنائي العمود قد تقع ترويسة عمود ومقرر العمود الآخر على السطر نفسه
      // أعمدة جداول السجل الواحد ثابتة المواضع، فنكمل أي عمود فائت من الترويسة السابقة
      const h = detectCourseHeader(row);
      if (h) header = { ...(header || {}), ...h };
      const hEn = lang === "en" && detectCourseHeaderEN(row);
      if (hEn) headerEN = { ...(headerEN || {}), ...hEn };

      if (remStartF.some((k) => tf.includes(k)) && !tf.includes(fold("نهاية")) && !/end of/i.test(tf)) {
        remedial = true;
      }
      if (remEndF.some((k) => tf.includes(k)) || tf.includes(fold("لاتدخل في احتساب")) ||
          /not\s+(counted|included)/i.test(tf)) {
        remedial = false;
      }

      // ابحث عن رموز المقررات في هذا الصف (قد يوجد رمزان عند التخطيط ثنائي العمود)
      const codeItems = row.items
        .filter((it) => isCourseCode(it.str))
        .sort((a, b) => a.x - b.x);
      if (codeItems.length === 0) continue;

      // صفحات EduGate المطبوعة (العربية: الرمز في أقصى اليسار رغم الاتجاه؛ الإنجليزية: أعداد صحيحة
      // بلا فواصل) — نوزّع الخلايا على أعمدة ترويسة الجدول
      const colHeader = lang === "en" ? headerEN : (header && header.code < header.name ? header : null);
      if (colHeader && codeItems.length === 1) {
        const course = buildCourseByColumns(codeItems[0], row.items, colHeader, remedial, lang);
        if (course) {
          course.termKey = nearestTermKey(codeItems[0].x, columns);
          courses.push(course);
        }
        continue;
      }

      // نطاق خلايا كل مقرر حسب اتجاه اللغة:
      //  - العربية (RTL): الخلايا تقع يسار الرمز (x أقل) حتى رمز العمود التالي يساراً.
      //  - الإنجليزية (LTR): الخلايا تقع يمين الرمز (x أكبر) حتى رمز العمود التالي يميناً.
      for (let i = 0; i < codeItems.length; i++) {
        const codeItem = codeItems[i];
        let lo = -Infinity, hi = Infinity;
        if (lang === "en") {
          lo = codeItem.x - 0.5;
          hi = i + 1 < codeItems.length ? codeItems[i + 1].x - 0.5 : Infinity;
        } else {
          hi = codeItem.x + 0.5;
          lo = i - 1 >= 0 ? codeItems[i - 1].x + 0.5 : -Infinity;
        }
        const colItems = row.items.filter((it) => it.x > lo && it.x < hi);
        const course = buildCourse(codeItem, colItems, remedial, lang);
        if (!course) continue;
        // إسناد الفصل: أقرب عمود ترويسة أفقياً لرمز المقرر
        course.termKey = nearestTermKey(codeItem.x, columns);
        courses.push(course);
      }
    }
    return courses;
  }

  const center = (it) => (it.x + it.xEnd) / 2;

  // يتعرّف على صف ترويسة جدول مقررات عربي ويُرجع مراكز أعمدته الأفقية.
  // المطابقة بالاحتواء لا بالتساوي: التعرّف الضوئي قد يُلصق رمزاً شارداً أو يُسقط حرفاً ("التقدي").
  function detectCourseHeader(row) {
    const col = {};
    for (const it of row.items) {
      const f = fold(it.str);
      if (f.includes("رمز المقرر")) col.code = center(it);
      else if (f.includes("اسم المقرر")) col.name = center(it);
      else if (f.includes("التقدي")) col.grade = center(it);
      else if (f.includes("الساعات") || f === "س") col.hours = center(it);
      else if (f.includes("النقاط")) col.points = center(it);
    }
    return col.code != null && col.name != null && col.hours != null ? col : null;
  }

  // ترويسة جدول إنجليزية بعمود واحد (صفحة EduGate الإنجليزية): الساعات قبل النقاط والأعداد صحيحة
  // ("6" لا "6.00")، فلا يصلح تمييزها بالترتيب أو بالفاصلة. السجل الرسمي ثنائي العمود/اللغة يُترك للمسار العام.
  function detectCourseHeaderEN(row) {
    if (row.items.filter((it) => /course\s*code/i.test(it.str)).length !== 1) return null;
    if (row.items.some((it) => fold(it.str).includes("رمز المقرر"))) return null;
    const col = {};
    for (const it of row.items) {
      const s = it.str.trim();
      if (/course\s*code/i.test(s)) col.code = center(it);
      else if (/course\s*name/i.test(s)) col.name = center(it);
      else if (/credit\s*hours|^hrs$|^hours$/i.test(s)) col.hours = center(it);
      else if (/^(points|pts)$/i.test(s)) col.points = center(it);
      else if (/^grade$/i.test(s)) col.grade = center(it);
    }
    return col.code != null && col.name != null && col.hours != null ? col : null;
  }

  function buildCourseByColumns(codeItem, items, header, remedial, lang) {
    const cols = Object.entries(header);
    let grade = "", status = "blank", gradeFound = false, hours = null, points = null;
    const nameParts = [];
    for (const it of items) {
      if (it === codeItem) continue;
      const cx = center(it);
      let best = cols[0];
      for (const c of cols) if (Math.abs(cx - c[1]) < Math.abs(cx - best[1])) best = c;
      const s = it.str;
      if (best[0] === "grade") {
        const cls = classifyGradeCell(s);
        if (cls) { grade = cls.grade; status = cls.status; gradeFound = true; }
      } else if (best[0] === "hours" && isNumberToken(s)) {
        hours = Number(s);
      } else if (best[0] === "points" && isNumberToken(s)) {
        points = Number(s);
      } else if (best[0] === "name") {
        nameParts.push(it);
      }
    }
    const name = nameParts.sort((a, b) => (lang === "en" ? a.x - b.x : b.x - a.x)).map((i) => i.str).join(" ").trim();
    if (!name && hours === null && !gradeFound) return null;
    return reconcileGrade({
      code: normalizeCode(codeItem.str),
      name: name || (lang === "en" ? "(no name)" : "(بدون اسم)"),
      grade, status, hours: hours || 0, points, remedial,
      inProgress: status === "blank" || status === "inprogress",
    });
  }

  function nearestTermKey(x, columns) {
    if (!columns || !columns.length) return null;
    let best = columns[0], bd = Math.abs(x - columns[0].x);
    for (const c of columns) {
      const d = Math.abs(x - c.x);
      if (d < bd) { bd = d; best = c; }
    }
    return best.key;
  }

  function buildCourse(codeItem, colItems, remedial, lang) {
    const code = normalizeCode(codeItem.str);
    const ordered = colItems.slice().sort((a, b) => b.x - a.x);

    let grade = "";
    let status = "blank";
    let gradeFound = false;
    let hours = null;
    let points = null;
    const nameParts = [];

    for (const it of ordered) {
      if (it === codeItem) continue;
      const s = it.str;
      if (!gradeFound) {
        const cls = classifyGradeCell(s);
        if (cls) { grade = cls.grade; status = cls.status; gradeFound = true; continue; }
      }
      if (isNumberToken(s)) {
        const n = Number(s.replace(/\s+/g, ""));
        if (hours === null && Number.isInteger(n) && n >= 1 && n <= 12 && !s.includes(".")) {
          hours = n;
        } else if (points === null) {
          points = n;
        }
        continue;
      }
      nameParts.push(it);
    }

    // السجل ثنائي اللغة يحوي الاسمين؛ نكتفي بالعربي لأن الواجهة عربية
    const arParts = nameParts.filter((i) => HAS_AR.test(i.str));
    const useAr = arParts.length > 0 && arParts.length < nameParts.length;
    // اسم المقرر بترتيب القراءة: العربية يمين←يسار، الإنجليزية يسار←يمين
    const name = (useAr ? arParts : nameParts)
      .sort((a, b) => (lang === "en" && !useAr ? a.x - b.x : b.x - a.x))
      .map((i) => i.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!name && hours === null && !gradeFound) return null;

    return reconcileGrade({
      code,
      name: name || (lang === "en" ? "(no name)" : "(بدون اسم)"),
      grade, // محتسب فقط (أ+..هـ)، فارغ للحالات غير المحتسبة
      status, // pass | fail | absent | withdrawn | nopass | inprogress | blank ...
      hours: hours || 0,
      points: points,
      remedial,
      inProgress: status === "blank" || status === "inprogress",
    });
  }

  function normalizeCode(s) {
    // الرمز قد يأتي بصيغ: "نما-2044"، "6005نما-3"، "MIS6001"، "MIS-6001".
    // نُخرج صيغة موحّدة: القسم (أحرف) + رقم المقرر (3–4 أرقام)، ونُسقط لاحقة الوحدات.
    const clean = s.replace(/\s+/g, "");
    const letters = (clean.match(/[A-Za-z؀-ۿ]+/g) || []).join("");
    const nums = clean.match(/\d+/g) || [];
    const courseNum = nums.find((n) => n.length >= 3) || nums[0] || "";
    return letters && courseNum ? letters + courseNum : clean;
  }

  function normalizeGrade(s) {
    let g = s.replace(/\s+/g, "");
    if (g.startsWith("+")) g = g.slice(1) + "+"; // "+ب" → "ب+"
    // إنجليزي → الرمز العربي المعتمد
    const up = g.toUpperCase();
    if (EN_TO_AR_GRADE[up]) return EN_TO_AR_GRADE[up];
    g = g.replace(/^ا(\+?)$/, "أ$1"); // ا → أ
    if (g === "ه") g = "هـ";
    return g;
  }

  /**
   * يجمع إجماليات المقررات المكتملة لحساب الحالة التراكمية،
   * مع معالجة الإعادة: يُحتسب آخر محاولة فقط لكل رمز مقرر.
   * يُرجع: { points, hours, gpa, counted:[codes] }
   */
  function computeCompletedTotals(completed, scale = "5") {
    const G = window.GPA;
    // أبقِ آخر محاولة لكل رمز (الترتيب في القائمة = ترتيب القراءة الزمني تقريباً)
    const latest = new Map();
    for (const c of completed) {
      latest.set(c.code, c);
    }
    let points = 0, hours = 0;
    for (const c of latest.values()) {
      const g = G ? G.findGrade(c.grade, scale) : null;
      const h = Number(c.hours) || 0;
      if (!g || h <= 0) continue;
      points += g.value * h;
      hours += h;
    }
    const gpa = hours > 0 ? points / hours : 0;
    return { points, hours, gpa, courses: latest.size };
  }

  // ---- استخلاص الحالة التراكمية (نقطة انطلاق) --------------------------

  /**
   * نبحث عن صفوف "تراكمي" المطبوعة ونستخرج منها قيم الملخص لكل فصل.
   * بنية صف التراكمي تحوي أرقاماً: النقاط، الساعات المسجّلة (عمود س)، المعدل، الساعات المكتسبة.
   * الاستدلال:
   *   - المعدل = القيمة ضمن (0, 5].
   *   - النقاط = أكبر قيمة (> 5).
   *   - الساعات المسجّلة (عمود س) = أكبر القيمتين المتبقيتين (تشمل التكميلية).
   *   - الساعات المكتسبة = أصغرهما (الداخلة في المعدل).
   * نختار صف آخر فصل مكتمل = الصف ذو معدل > 0 والأكبر بالساعات المكتسبة.
   */
  // ترويسة جدول الملخّص في صفحة EduGate المطبوعة: المعدل | النقاط | نجاح | المكتسبة | المسجلة
  // ونظيرتها الإنجليزية بالمواضع نفسها: GPA | Points | Graded | Passed | Registered
  function detectSummaryHeader(row) {
    const col = {};
    for (const it of row.items) {
      const f = fold(it.str);
      if (f === "المعدل" || /^gpa$/i.test(f)) col.gpa = center(it);
      else if (f === "النقاط" || /^points$/i.test(f)) col.points = center(it);
      else if (f === "المكتسبه" || /^passed$/i.test(f)) col.earned = center(it);
      else if (f === "المسجله" || /^registered$/i.test(f)) col.registered = center(it);
      else if (f === "نجاح" || /^graded$/i.test(f)) col.passed = center(it);
    }
    return col.gpa != null && col.points != null && col.earned != null ? col : null;
  }

  const isPlaceholder = (s) => /^\*+$/.test(s.trim());

  function summaryByColumns(row, header) {
    const cols = Object.entries(header);
    const v = {};
    for (const it of row.items) {
      if (!isNumberToken(it.str)) continue;
      const cx = center(it);
      let best = cols[0];
      for (const c of cols) if (Math.abs(cx - c[1]) < Math.abs(cx - best[1])) best = c;
      v[best[0]] = Number(it.str);
    }
    if (v.gpa == null) return null;
    return { gpa: v.gpa, points: v.points ?? null, hoursEarned: v.earned ?? null, hoursRegistered: v.registered ?? null };
  }

  // السجل الرسمي: "تراكمي مكتسبة <مكتسبة> معدل <معدل> <س> <نقاط>" (يُقرأ من اليمين) أو
  // "Cumulative E-HRS <earned> GPA <gpa> <registered> <points>" (من اليسار).
  function summaryByKeywords(row, label) {
    const ar = HAS_AR.test(label.str);
    const toks = row.items
      .filter((it) => it !== label && (ar ? it.x < label.x : it.x > label.x))
      .sort((a, b) => (ar ? b.x - a.x : a.x - b.x));
    let earned = null, gpa = null, expect = null;
    const rest = [];
    for (const it of toks) {
      const s = it.str;
      if (ar ? /[A-Za-z]/.test(s) : HAS_AR.test(s)) break; // بلغنا النصف الآخر من السجل ثنائي اللغة
      const f = fold(s);
      if (ar ? f.includes("مكتسب") : /e-?hrs/i.test(s)) { expect = "earned"; continue; }
      if (ar ? f.includes("معدل") : /^gpa$/i.test(s)) { expect = "gpa"; continue; }
      const num = isNumberToken(s) ? Number(s) : (isPlaceholder(s) ? null : undefined);
      if (num === undefined) continue;
      if (expect === "earned") { earned = num; expect = null; }
      else if (expect === "gpa") { gpa = num; expect = null; }
      else if (gpa != null) { rest.push(num); if (rest.length === 2) break; }
    }
    if (gpa == null || earned == null) return null;
    return { gpa, hoursEarned: earned, hoursRegistered: rest[0] ?? null, points: rest[1] ?? null };
  }

  function extractCumulative(rows, pageWidth, lang) {
    const mid = (pageWidth || 857) / 2;
    const candidates = [];
    let columns = [];
    let sumHeader = null;
    for (const row of rows) {
      const terms = detectTerms(row);
      if (terms.length) columns = terms;
      const sh = detectSummaryHeader(row);
      if (sh) sumHeader = sh;

      // قد يحتوي الصف على عمودين؛ نعالج كل تسمية "تراكمي / Cumulative" ضمن عمودها فقط
      // لتفادي تلوّث الأرقام بترويسة العمود المجاور (مثل "الإنذارات: 1" و"1447").
      const labels = row.items.filter((it) => {
        const f = fold(it.str);
        return f.includes("تراكمي") || /cumulative|cum\b/i.test(it.str);
      }).sort((a, b) => a.x - b.x);
      if (labels.length === 0) continue;
      for (let li = 0; li < labels.length; li++) {
        const label = labels[li];
        const termKey = nearestTermKey(label.x, columns);
        const exact = (sumHeader && sumHeader.gpa > label.x && summaryByColumns(row, sumHeader)) ||
          summaryByKeywords(row, label);
        if (exact) {
          candidates.push({ ...exact, termKey, order: candidates.length });
          continue;
        }
        // اختيار خلايا الملخّص حسب الاتجاه:
        //  - العربية: نفس نصف الصفحة (التخطيط ثنائي العمود) لتفادي تلوّث العمود المجاور.
        //  - الإنجليزية: الأرقام تقع يمين التسمية حتى تسمية العمود التالي (LTR).
        let colItems;
        if (lang === "en") {
          const hiX = li + 1 < labels.length ? labels[li + 1].x - 0.5 : Infinity;
          colItems = row.items.filter((it) => it.x >= label.x - 0.5 && it.x < hiX);
        } else {
          const isRight = label.x >= mid;
          colItems = row.items.filter((it) => (isRight ? it.x >= mid : it.x < mid));
        }
        const nums = colItems
          .filter((it) => isNumberToken(it.str))
          .map((it) => Number(it.str))
          .filter((n) => Number.isFinite(n));
        if (nums.length === 0) continue;

        const gpaCand = nums.filter((n) => n > 0 && n <= 5);
        const gpa = gpaCand.length ? Math.max(...gpaCand) : 0;
        const bigs = nums.filter((n) => n > 5).sort((a, b) => b - a);
        const points = bigs.length ? bigs[0] : null;
        const rest = bigs.slice(1);
        const hoursRegistered = rest.length ? Math.max(...rest) : (bigs.length ? bigs[0] : null);
        const hoursEarned = rest.length ? Math.min(...rest) : hoursRegistered;

        candidates.push({ gpa, points, hoursRegistered, hoursEarned, termKey, order: candidates.length, heuristic: true });
      }
    }
    if (candidates.length === 0) return null;

    // آخر فصل مكتمل = أحدث فصل (بمفتاح الفصل) معدله > 0. ترتيب الفصول في الصفحة قد يكون
    // تصاعدياً (السجل الرسمي) أو تنازلياً (صفحة EduGate)، والانسحاب قد يُنقص الساعات المكتسبة،
    // لذا لا يصلح الاعتماد على الترتيب أو على أكبر ساعات.
    // صفحة EduGate تكرّر المعدل السابق في صف الفصل الجاري مع نقاط = 0؛ نستبعده
    const valid = candidates.filter((c) => c.gpa > 0 && c.hoursEarned && c.points !== 0);
    if (!valid.length) return candidates[candidates.length - 1];
    const keyed = valid.filter((c) => c.termKey != null);
    if (keyed.length) {
      return keyed.reduce((b, c) => (c.termKey > b.termKey || (c.termKey === b.termKey && !c.heuristic && b.heuristic) ? c : b));
    }
    return valid.reduce((b, c) => ((c.hoursEarned || 0) >= (b.hoursEarned || 0) ? c : b));
  }

  // ---- الدالة العامة ----------------------------------------------------

  /**
   * يحلّل ملف PDF (ArrayBuffer) ويُرجع كائن البيانات المُستخلصة.
   */
  async function parseRecord(arrayBuffer, pdfjsLib, opts = {}) {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let ocrUsed = false;

    let allRows = [];
    let pageWidth = 0;
    let allItems = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      let { items, width } = await extractItems(page);
      if (isGlyphSplit(items)) items = mergeGlyphRuns(items);
      pageWidth = Math.max(pageWidth, width);
      // نزيح y لكل صفحة لتفادي تداخل الصفوف
      const yOffset = (p - 1) * 100000;
      items.forEach((it) => (it.y += yOffset));
      allItems = allItems.concat(items);
    }

    // ملف مصوَّر: نستعين بالتعرّف الضوئي، ثم نجمع كلماته في عبارات كما في الصفحات المفرّقة
    if (allItems.length === 0 && opts.ocr) {
      const pages = await opts.ocr(pdf);
      pages.forEach((words, i) => {
        const items = mergeGlyphRuns(
          words.map((it) => ({ ...it, str: arabicNormalize(it.str) })).filter((it) => it.str)
        );
        items.forEach((it) => (it.y += i * 100000));
        allItems = allItems.concat(items);
      });
      ocrUsed = allItems.length > 0;
    }

    // ملف بلا طبقة نصية = صورة ممسوحة/ملتقطة؛ لا يمكن قراءته دون OCR
    if (allItems.length === 0) {
      return {
        noText: true, lang: "ar", student: {}, cumulative: null, cumulativePrinted: null,
        completed: [], remedial: [], current: [], _debug: { rows: 0, totalCourses: 0, pages: pdf.numPages },
      };
    }

    allRows = groupRows(allItems);

    const lang = detectLang(allItems); // "ar" أو "en"
    const student = extractHeader(allRows, pageWidth, lang);
    const courses = parseCourses(allRows, pageWidth, lang);
    const cumulativePrinted = extractCumulative(allRows, pageWidth, lang);

    const remedialCourses = courses.filter((c) => c.remedial);

    // تحديد آخر فصل دراسي عبر أكبر مفتاح فصل (السنة×10 + رقم الفصل)
    const termKeys = courses.filter((c) => !c.remedial && c.termKey != null).map((c) => c.termKey);
    const maxTermKey = termKeys.length ? Math.max(...termKeys) : null;

    let current;
    if (maxTermKey != null) {
      // مقررات الفصل الأخير، مع استبعاد الغائب/الراسب/المنسحب/غير الناجح
      current = courses.filter(
        (c) => !c.remedial && c.termKey === maxTermKey && !EXCLUDE_FROM_CURRENT.has(c.status)
      );
    } else {
      // احتياطي: لا فصول مكتشفة → المقررات الجارية (بلا تقدير)
      current = courses.filter((c) => c.inProgress && !c.remedial);
    }

    // المقررات المكتملة (المحتسبة) من الفصول السابقة — للعرض الاطلاعي والاحتساب الاحتياطي
    const completed = courses.filter(
      (c) => c.grade && !c.remedial && (maxTermKey == null || c.termKey !== maxTermKey)
    );

    // إزالة التكرار من مقررات الفصل الأخير
    const seen = new Set();
    const currentUnique = [];
    for (const c of current) {
      const key = c.code + "|" + c.name;
      if (seen.has(key)) continue;
      seen.add(key);
      currentUnique.push(c);
    }

    // الحالة التراكمية المعتمدة: تُقرأ مباشرة من صف "تراكمي" المطبوع لآخر فصل مكتمل.
    // الساعات السابقة = قيمة عمود (س) المسجّلة، والمعدل من نفس الصف، والنقاط تُشتق لاحقاً
    // (الساعات × المعدل) تماشياً مع طريقة حاسبات الجامعات المرجعية.
    // عند تعذّر القراءة المطبوعة نلجأ للاحتساب من المقررات المكتملة.
    const computed = computeCompletedTotals(completed, "5");
    let cumulative = null;
    if (cumulativePrinted && cumulativePrinted.gpa > 0 && (cumulativePrinted.hoursEarned || cumulativePrinted.hoursRegistered)) {
      // للحصول على حساب دقيق مطابق للعمادة نستخدم الساعات المكتسبة مع النقاط المطبوعة،
      // لأن المعدل التراكمي الرسمي = النقاط ÷ الساعات المكتسبة (المقررات التكميلية لا تُحتسب).
      const cp = cumulativePrinted;
      let hours = cp.hoursEarned || cp.hoursRegistered; // الساعات المكتسبة
      // صفحة EduGate تطبع "المكتسبة" شاملة ساعات لا تدخل في المعدل؛ ساعات المعدل الفعلية = النقاط ÷ المعدل
      if (cp.points > 0 && hours > 0 && Math.abs(cp.points / hours - cp.gpa) > 0.006) {
        hours = Math.round(cp.points / cp.gpa);
      }
      cumulative = {
        gpa: cp.gpa,
        hours,
        hoursRegistered: cumulativePrinted.hoursRegistered, // عمود (س) — للعرض/المرجع
        points: cumulativePrinted.points, // أسفل عمود النقاط المطبوع
        source: "printed",
      };
    } else if (computed.hours > 0) {
      cumulative = { gpa: computed.gpa, hours: computed.hours, points: computed.points, source: "computed" };
    }

    return {
      lang,
      ocr: ocrUsed,
      student,
      cumulative,
      cumulativePrinted,
      completed,
      remedial: remedialCourses,
      current: currentUnique,
      _debug: {
        lang, rows: allRows.length, totalCourses: courses.length, pageWidth,
        computed, printed: cumulativePrinted,
      },
    };
  }

  window.RecordParser = { parseRecord, arabicNormalize, fold, detectLang };
})();
