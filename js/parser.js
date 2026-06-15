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

  // ---- أنماط التعرّف ----------------------------------------------------

  // رمز المقرر: أحرف (عربية أو لاتينية) مع 3–4 أرقام، وقد يتخللها شرطة ورقم وحدات.
  // أمثلة: "نما2044"، "نما-2044"، "6004نما-3"، "MIS6001"، "MIS-6001".
  const COURSE_CODE_RE = /^(?=.*[A-Za-zء-ي])(?=.*\d{3,})[A-Za-zء-ي0-9\-]+$/;

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
    return /^-?\d+(\.\d+)?$/.test(s.replace(/\s+/g, ""));
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

  // الحالات المستبعَدة من عرض مقررات الفصل الأخير (غائب/راسب/منسحب/غير ناجح)
  const EXCLUDE_FROM_CURRENT = new Set(["fail", "absent", "withdrawn", "nopass", "denied", "audit", "excused"]);

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

  // ---- التعرّف على الفصول الدراسية (لتحديد آخر فصل) --------------------

  // يحوّل نص ترويسة فصل إلى مفتاح ترتيبي: السنة×10 + رقم الفصل.
  function parseTermKey(txt) {
    let m = txt.match(/(First|Second|Third|Fourth|Summer)\s+Semester\s+(\d{4})\s*\/\s*\d{4}/i);
    if (m) {
      const tn = { first: 1, second: 2, third: 3, fourth: 3, summer: 4 }[m[1].toLowerCase()];
      return parseInt(m[2], 10) * 10 + tn;
    }
    const f = fold(txt);
    m = f.match(/الفصل\s+(الاول|الثاني|الثالث|الرابع|الصيفي)\s+(\d{3,4})/);
    if (m) {
      const tn = { "الاول": 1, "الثاني": 2, "الثالث": 3, "الرابع": 3, "الصيفي": 4 }[m[1]];
      return parseInt(m[2], 10) * 10 + tn;
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

    // تاريخ الطباعة (مشترك للغتين)
    for (const r of rows) {
      const m = rowText(r, lang).match(/(\d{1,2}[-/]\d{1,2}[-/]\d{4})/);
      if (m) { info.printDate = m[1]; break; }
    }

    if (lang === "en") return extractHeaderEN(head, info);
    return extractHeaderAR(head, info);
  }

  // ---- ترويسة السجل العربي (مسار مُتحقَّق منه) ----
  function extractHeaderAR(head, info) {
    const fullText = head.map((r) => rowText(r, "ar")).join("  ||  ");
    if (/الملك\s*خالد/.test(fold(fullText))) info.university = "جامعة الملك خالد";

    for (const r of head) {
      const t = rowText(r, "ar");
      const tf = fold(t);
      if (!info.name && tf.includes("الاسم")) {
        const m = t.match(/الاسم\s*:?\s*([^\:]+?)(?:التخصص|رقم|الدرجة|السجل|$)/);
        if (m) info.name = cleanVal(m[1]);
        else info.name = cleanVal(t.slice(t.indexOf("الاسم") + 5).replace(/^[\s:]+/, ""));
      }
      if (!info.major && tf.includes("التخصص")) {
        const m = t.match(/التخصص\s*:?\s*([^\:]+?)(?:الاسم|رقم|الدرجة|السجل|$)/);
        if (m) info.major = cleanVal(m[1]);
      }
      if (!info.degree && tf.includes("الدرجه")) {
        const m = t.match(/الدرجة\s*:?\s*([^\:]+?)(?:رقم|الاسم|التخصص|$)/);
        if (m) info.degree = cleanVal(m[1]);
      }
      if (!info.studentId && tf.includes("رقم الطالب")) {
        const m = t.match(/(\d{6,})/);
        if (m) info.studentId = m[1];
      }
      if (!info.civilId && tf.includes("السجل المدني")) {
        const m = t.match(/(\d{8,})/);
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
        const re = new RegExp(escapeRe(k) + "\\s*[:：.\\-–]+\\s*([A-Za-z][A-Za-z .,'\\-&/]+?)\\s*(?:" + boundary + "|\\|\\||$)", "i");
        const m = fullText.match(re);
        if (m && m[1] && m[1].trim().length > 1) return cleanVal(m[1]);
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

    for (const row of rows) {
      const tf = fold(rowText(row, lang));

      // تحديث أعمدة الفصول إن كان هذا الصف ترويسة فصل/فصول
      const terms = detectTerms(row);
      if (terms.length) columns = terms;

      if (remStartF.some((k) => tf.includes(k)) && !tf.includes(fold("نهاية")) && !/end of/i.test(tf)) {
        remedial = true;
      }
      if (remEndF.some((k) => tf.includes(k)) || tf.includes(fold("لاتدخل في احتساب")) ||
          /not\s+(counted|included)/i.test(tf)) {
        remedial = false;
      }

      // ابحث عن رموز المقررات في هذا الصف (قد يوجد رمزان عند التخطيط ثنائي العمود)
      const codeItems = row.items
        .filter((it) => COURSE_CODE_RE.test(it.str))
        .sort((a, b) => a.x - b.x);
      if (codeItems.length === 0) continue;

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

    // اسم المقرر بترتيب القراءة: العربية يمين←يسار، الإنجليزية يسار←يمين
    const name = nameParts
      .sort((a, b) => (lang === "en" ? a.x - b.x : b.x - a.x))
      .map((i) => i.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!name && hours === null && !gradeFound) return null;

    return {
      code,
      name: name || (lang === "en" ? "(no name)" : "(بدون اسم)"),
      grade, // محتسب فقط (أ+..هـ)، فارغ للحالات غير المحتسبة
      status, // pass | fail | absent | withdrawn | nopass | inprogress | blank ...
      hours: hours || 0,
      points: points,
      remedial,
      inProgress: status === "blank" || status === "inprogress",
    };
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
  function extractCumulative(rows, pageWidth, lang) {
    const mid = (pageWidth || 857) / 2;
    const candidates = [];
    for (const row of rows) {
      // قد يحتوي الصف على عمودين؛ نعالج كل تسمية "تراكمي / Cumulative" ضمن عمودها فقط
      // لتفادي تلوّث الأرقام بترويسة العمود المجاور (مثل "الإنذارات: 1" و"1447").
      const labels = row.items.filter((it) => {
        const f = fold(it.str);
        return f.includes("تراكمي") || /cumulative|cum\b/i.test(it.str);
      }).sort((a, b) => a.x - b.x);
      if (labels.length === 0) continue;
      for (let li = 0; li < labels.length; li++) {
        const label = labels[li];
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

        candidates.push({ gpa, points, hoursRegistered, hoursEarned, y: row.y });
      }
    }
    if (candidates.length === 0) return null;

    // آخر فصل مكتمل: معدل > 0 وأكبر ساعات مكتسبة
    const valid = candidates.filter((c) => c.gpa > 0 && c.hoursEarned);
    const pool = valid.length ? valid : candidates;
    let best = pool[0];
    for (const c of pool) {
      if ((c.hoursEarned || 0) >= (best.hoursEarned || 0)) best = c;
    }
    return best;
  }

  // ---- الدالة العامة ----------------------------------------------------

  /**
   * يحلّل ملف PDF (ArrayBuffer) ويُرجع كائن البيانات المُستخلصة.
   */
  async function parseRecord(arrayBuffer, pdfjsLib) {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    let allRows = [];
    let pageWidth = 0;
    let allItems = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const { items, width } = await extractItems(page);
      pageWidth = Math.max(pageWidth, width);
      // نزيح y لكل صفحة لتفادي تداخل الصفوف
      const yOffset = (p - 1) * 100000;
      items.forEach((it) => (it.y += yOffset));
      allItems = allItems.concat(items);
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
      cumulative = {
        gpa: cumulativePrinted.gpa,
        hours: cumulativePrinted.hoursEarned || cumulativePrinted.hoursRegistered, // الساعات المكتسبة
        hoursRegistered: cumulativePrinted.hoursRegistered, // عمود (س) — للعرض/المرجع
        points: cumulativePrinted.points, // أسفل عمود النقاط المطبوع
        source: "printed",
      };
    } else if (computed.hours > 0) {
      cumulative = { gpa: computed.gpa, hours: computed.hours, points: computed.points, source: "computed" };
    }

    return {
      lang,
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
