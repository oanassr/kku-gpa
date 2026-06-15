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

  // رمز المقرر: أحرف عربية (اسم القسم مثل "نما"/"عربي"/"سلم") متبوعة/مسبوقة بأرقام،
  // وقد يتخللها شرطة ورقم وحدات. أمثلة بعد التطبيع قد تظهر:
  //   "نما2044", "نما-2044", "نما6004-3", "6004نما-3"
  // نلتقط أي قطعة تحوي 3 أرقام متتالية على الأقل مع وجود أحرف عربية.
  const COURSE_CODE_RE = /^(?=.*[ء-ي])(?=.*\d{3,})[ء-ي0-9\-]+$/;

  // رموز التقديرات المقبولة (عربي)
  const GRADE_TOKENS = new Set([
    "أ+", "أ", "ا+", "ا", "ب+", "ب", "ج+", "ج", "د+", "د", "هـ", "ه",
    "ع", "ح", "ل", "ند", "م",
  ]);

  function isGradeToken(s) {
    const t = s.replace(/\s+/g, "");
    if (GRADE_TOKENS.has(t)) return true;
    // أشكال مثل "+ب" بسبب الاتجاه
    if (/^\+[ابجدأاه]$/.test(t)) return true;
    return false;
  }

  function isNumberToken(s) {
    return /^-?\d+(\.\d+)?$/.test(s.replace(/\s+/g, ""));
  }

  // كلمات دلالية في الترويسة والملخصات
  const KW = {
    name: ["الاسم"],
    studentId: ["رقم الطالب"],
    civil: ["السجل المدني"],
    major: ["التخصص"],
    degree: ["الدرجة"],
    college: ["الكلية"],
    semester: ["فصلي"],
    cumulative: ["تراكمي"],
    earned: ["مكتسبة"],
    gpaWord: ["معدل"],
    remedialStart: ["المقررات التكميلية"],
    remedialEnd: ["نهاية المقررات التكميلية"],
    termLine: ["الفصل"],
    warnings: ["الانذارات", "الإنذارات"],
  };

  function rowText(row) {
    // النص بترتيب القراءة العربي: من اليمين (x الأكبر) إلى اليسار
    return row.items
      .slice()
      .sort((a, b) => b.x - a.x)
      .map((i) => i.str)
      .join(" ");
  }

  // ---- استخلاص الترويسة (بيانات الطالب) --------------------------------

  function extractHeader(rows, pageWidth) {
    const info = {
      university: "", college: "", name: "", studentId: "",
      civilId: "", major: "", degree: "", printDate: "",
    };
    // نبحث في أعلى الصفحة (أول ~12 صفاً)
    const head = rows.slice(0, 14);
    const fullText = head.map(rowText).join("  ||  ");

    // الجامعة
    if (/الملك\s*خالد/.test(fold(fullText).replace(/ا/g, "ا"))) {
      info.university = "جامعة الملك خالد";
    }

    // دوال التقاط "تسمية : قيمة" داخل نص صف
    const grab = (text, keys) => {
      for (const k of keys) {
        const kf = fold(k);
        const tf = fold(text);
        const idx = tf.indexOf(kf);
        if (idx === -1) continue;
        // القيمة تقع يساراً (بعد التسمية في ترتيب القراءة) أو بعد النقطتين
        // نأخذ ما بعد ":" الأقرب للكلمة
        const after = text.slice(text.indexOf(":", text.indexOf(k.charAt(0))) + 1);
        return after;
      }
      return "";
    };

    for (const r of head) {
      const t = rowText(r);
      const tf = fold(t);

      if (!info.name && tf.includes("الاسم")) {
        // الاسم بين "الاسم :" وبداية التسمية التالية
        const m = t.match(/الاسم\s*:?\s*([^\:]+?)(?:التخصص|رقم|الدرجة|السجل|$)/);
        if (m) info.name = cleanVal(m[1]);
        else {
          const i = t.indexOf("الاسم");
          info.name = cleanVal(t.slice(i + 5).replace(/^[\s:]+/, ""));
        }
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

    // تاريخ الطباعة (لاتيني أو هجري)
    for (const r of rows) {
      const t = rowText(r);
      const m = t.match(/(\d{1,2}-\d{1,2}-\d{4})/);
      if (m) { info.printDate = m[1]; break; }
    }

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
  function parseCourses(rows, pageWidth) {
    const mid = pageWidth / 2;
    const courses = [];

    // تتبّع حالة "المقررات التكميلية" حسب الموضع الرأسي
    let remedial = false;

    for (const row of rows) {
      const t = rowText(row);
      const tf = fold(t);

      if (tf.includes(fold("المقررات التكميلية")) && !tf.includes(fold("نهاية"))) {
        remedial = true;
      }
      if (tf.includes(fold("نهاية المقررات التكميلية")) ||
          tf.includes(fold("لاتدخل في احتساب"))) {
        remedial = false;
      }

      // ابحث عن رموز المقررات في هذا الصف (قد يوجد رمزان: عمود يمين وعمود يسار)
      const codeItems = row.items.filter((it) => COURSE_CODE_RE.test(it.str));
      if (codeItems.length === 0) continue;

      for (const codeItem of codeItems) {
        const isRight = codeItem.x >= mid;
        // الخلايا ضمن نفس العمود فقط
        const colItems = row.items.filter((it) =>
          isRight ? it.x >= mid : it.x < mid
        );

        const course = buildCourse(codeItem, colItems, remedial);
        if (course) courses.push(course);
      }
    }
    return courses;
  }

  function buildCourse(codeItem, colItems, remedial) {
    const code = normalizeCode(codeItem.str);
    // الترتيب البصري داخل العمود من اليمين (الرمز) إلى اليسار (النقاط)
    const ordered = colItems.slice().sort((a, b) => b.x - a.x);

    let grade = "";
    let hours = null;
    let points = null;
    const nameParts = [];

    for (const it of ordered) {
      if (it === codeItem) continue;
      const s = it.str;
      if (!grade && isGradeToken(s)) { grade = normalizeGrade(s); continue; }
      if (isNumberToken(s)) {
        const n = Number(s.replace(/\s+/g, ""));
        // الساعات عدد صحيح صغير (1..9)، النقاط رقم عشري عادةً
        if (hours === null && Number.isInteger(n) && n >= 1 && n <= 12 && !s.includes(".")) {
          hours = n;
        } else if (points === null) {
          points = n;
        }
        continue;
      }
      // غير ذلك: جزء من اسم المقرر
      nameParts.push(it);
    }

    // اسم المقرر بترتيب القراءة (يمين ← يسار)
    const name = nameParts
      .sort((a, b) => b.x - a.x)
      .map((i) => i.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!name && hours === null && !grade) return null;

    const hasGrade = !!grade && grade !== "م";
    return {
      code,
      name: name || "(بدون اسم)",
      grade: hasGrade ? grade : "",
      hours: hours || 0,
      points: points,
      remedial,
      inProgress: !hasGrade, // بلا تقدير = مسجّل حالياً / جارٍ
    };
  }

  function normalizeCode(s) {
    // الرمز قد يأتي بصيغ مختلفة بعد التطبيع: "نما-2044" أو "6005نما-3".
    // نُخرج صيغة موحّدة: القسم (أحرف عربية) + رقم المقرر (3–4 أرقام)، ونُسقط لاحقة الوحدات.
    const clean = s.replace(/\s+/g, "");
    const ar = (clean.match(/[؀-ۿ]+/g) || []).join("");
    const nums = clean.match(/\d+/g) || [];
    const courseNum = nums.find((n) => n.length >= 3) || nums[0] || "";
    return ar && courseNum ? ar + courseNum : clean;
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

  function normalizeGrade(s) {
    let g = s.replace(/\s+/g, "");
    if (g.startsWith("+")) g = g.slice(1) + "+";
    g = g.replace(/^ا(\+?)$/, "أ$1"); // ا → أ
    if (g === "ه") g = "هـ";
    return g;
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
  function extractCumulative(rows, pageWidth) {
    const mid = (pageWidth || 857) / 2;
    const candidates = [];
    for (const row of rows) {
      // قد يحتوي الصف على عمودين؛ نعالج كل تسمية "تراكمي" ضمن عمودها فقط
      // لتفادي تلوّث الأرقام بترويسة العمود المجاور (مثل "الإنذارات: 1" و"1447").
      const labels = row.items.filter((it) => fold(it.str).includes("تراكمي"));
      if (labels.length === 0) continue;
      for (const label of labels) {
        const isRight = label.x >= mid;
        const colItems = row.items.filter((it) => (isRight ? it.x >= mid : it.x < mid));
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

    const student = extractHeader(allRows, pageWidth);
    const courses = parseCourses(allRows, pageWidth);
    const cumulativePrinted = extractCumulative(allRows, pageWidth);

    const completed = courses.filter((c) => !c.inProgress && !c.remedial);
    const remedialCourses = courses.filter((c) => c.remedial);
    const current = courses.filter((c) => c.inProgress && !c.remedial);

    // إزالة التكرار من المقررات الحالية (قد تتكرر بين الفصول)
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
      student,
      cumulative,
      cumulativePrinted,
      completed,
      remedial: remedialCourses,
      current: currentUnique,
      _debug: {
        rows: allRows.length, totalCourses: courses.length, pageWidth,
        computed, printed: cumulativePrinted,
      },
    };
  }

  window.RecordParser = { parseRecord, arabicNormalize, fold };
})();
