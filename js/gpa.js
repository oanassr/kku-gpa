/* =========================================================================
 * gpa.js — سلالم التقديرات وحسابات المعدل (نظام نقاط جامعة الملك خالد)
 * كل الحسابات تتم محلياً في المتصفح. لا تُرسل أي بيانات إلى أي خادم.
 * ========================================================================= */

/**
 * سلّم التقديرات السعودي بنظام 5.00 (المعتمد في جامعة الملك خالد)
 * والنظام البديل 4.00 — لكل تقدير: الرمز العربي، الرمز الإنجليزي، القيمة، النطاق، الوصف.
 */
const GRADE_SCALES = {
  "5": [
    { ar: "أ+", en: "A+", value: 5.0,  min: 95, max: 100, label: "ممتاز مرتفع" },
    { ar: "أ",  en: "A",  value: 4.75, min: 90, max: 94,  label: "ممتاز" },
    { ar: "ب+", en: "B+", value: 4.5,  min: 85, max: 89,  label: "جيد جداً مرتفع" },
    { ar: "ب",  en: "B",  value: 4.0,  min: 80, max: 84,  label: "جيد جداً" },
    { ar: "ج+", en: "C+", value: 3.5,  min: 75, max: 79,  label: "جيد مرتفع" },
    { ar: "ج",  en: "C",  value: 3.0,  min: 70, max: 74,  label: "جيد" },
    { ar: "د+", en: "D+", value: 2.5,  min: 65, max: 69,  label: "مقبول مرتفع" },
    { ar: "د",  en: "D",  value: 2.0,  min: 60, max: 64,  label: "مقبول" },
    { ar: "هـ", en: "F",  value: 1.0,  min: 0,  max: 59,  label: "راسب" },
  ],
  "4": [
    { ar: "أ+", en: "A+", value: 4.0,  min: 95, max: 100, label: "ممتاز مرتفع" },
    { ar: "أ",  en: "A",  value: 3.75, min: 90, max: 94,  label: "ممتاز" },
    { ar: "ب+", en: "B+", value: 3.5,  min: 85, max: 89,  label: "جيد جداً مرتفع" },
    { ar: "ب",  en: "B",  value: 3.0,  min: 80, max: 84,  label: "جيد جداً" },
    { ar: "ج+", en: "C+", value: 2.5,  min: 75, max: 79,  label: "جيد مرتفع" },
    { ar: "ج",  en: "C",  value: 2.0,  min: 70, max: 74,  label: "جيد" },
    { ar: "د+", en: "D+", value: 1.5,  min: 65, max: 69,  label: "مقبول مرتفع" },
    { ar: "د",  en: "D",  value: 1.0,  min: 60, max: 64,  label: "مقبول" },
    { ar: "هـ", en: "F",  value: 0.0,  min: 0,  max: 59,  label: "راسب" },
  ],
};

/** رموز التقديرات غير المحتسبة في المعدل (تظهر أحياناً في السجل). */
const NON_COUNTED_GRADES = new Set([
  "ع",   // عذر
  "ح",   // محروم (يُحتسب أحياناً كرسوب — نعرضه للمراجعة)
  "ل",   // منسحب بعذر
  "ند",  // غير محتسب / ناجح دون درجة
  "ج/إ", // جاري الإعداد
  "م",   // مستمر
]);

/** تطبيع رمز التقدير المُستخلص (إزالة المسافات وتوحيد الهمزة/الألف). */
function normalizeGradeSymbol(raw) {
  if (!raw) return "";
  let g = String(raw).trim();
  g = g.replace(/\s+/g, "");
  // توحيد علامة الزائد (قد تأتي قبل أو بعد الحرف بسبب اتجاه النص)
  if (g.startsWith("+")) g = g.slice(1) + "+";
  // توحيد الهمزات إلى ألف ممدودة للتقدير "أ"
  g = g.replace(/[إأآا]/g, "أ");
  // توحيد أشكال الهاء/الفاء للتقدير "هـ"
  g = g.replace(/^ه$/, "هـ").replace(/^هـ?$/, "هـ");
  if (g === "F" || g === "f") g = "هـ";
  return g;
}

/**
 * اشتقاق التقدير من الدرجة المئوية (0–100) ضمن سلّم محدد.
 * يُرجع كائن التقدير المطابق للنطاق، أو null إن كانت الدرجة غير صالحة.
 */
function gradeFromScore(score, scale = "5") {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  const table = GRADE_SCALES[scale] || GRADE_SCALES["5"];
  if (s > 100) return table[0];
  if (s < 0) return table[table.length - 1];
  for (const g of table) {
    if (s >= g.min && s <= g.max) return g;
  }
  return null;
}

/** البحث عن كائن التقدير المطابق لرمز عربي/إنجليزي ضمن سلّم محدد. */
function findGrade(symbol, scale = "5") {
  const norm = normalizeGradeSymbol(symbol);
  const table = GRADE_SCALES[scale] || GRADE_SCALES["5"];
  // مطابقة مباشرة بالرمز العربي
  let found = table.find((g) => g.ar === norm);
  if (found) return found;
  // مطابقة بالرمز الإنجليزي (حساس لحالة الأحرف بعد التطبيع)
  const up = norm.toUpperCase();
  found = table.find((g) => g.en === up);
  return found || null;
}

/**
 * حساب المعدل من قائمة مقررات.
 * كل مقرر: { hours:Number, value:Number, counts:Boolean }
 * يُرجع: { points, hours, gpa }
 *  - points: مجموع النقاط (القيمة × الساعات)
 *  - hours: مجموع الساعات المحتسبة
 *  - gpa: المعدل = points / hours
 */
function computeGPA(courses) {
  let points = 0;
  let hours = 0;
  for (const c of courses) {
    if (c.counts === false) continue;
    const h = Number(c.hours) || 0;
    const v = Number(c.value);
    if (h <= 0 || !Number.isFinite(v)) continue;
    points += v * h;
    hours += h;
  }
  const gpa = hours > 0 ? points / hours : 0;
  return { points, hours, gpa };
}

/**
 * دمج المعدل السابق (التراكمي) مع مقررات الفصل الحالي للحصول على التراكمي المتوقع.
 * @param {Object} prev   { points, hours }  الحالة التراكمية السابقة
 * @param {Object} sem    { points, hours }  نتيجة الفصل الحالي
 */
function combineCumulative(prev, sem) {
  const points = (Number(prev.points) || 0) + (Number(sem.points) || 0);
  const hours = (Number(prev.hours) || 0) + (Number(sem.hours) || 0);
  const gpa = hours > 0 ? points / hours : 0;
  return { points, hours, gpa };
}

/** التقدير العام (مستوى الأداء) المقابل لمعدّل ضمن سلّم محدد. */
function generalStanding(gpa, scale = "5") {
  if (!gpa || gpa <= 0) return "—";
  const ranges5 = [
    [4.5, "ممتاز"],
    [3.75, "جيد جداً"],
    [2.75, "جيد"],
    [2.0, "مقبول"],
    [0, "ضعيف"],
  ];
  const ranges4 = [
    [3.5, "ممتاز"],
    [2.75, "جيد جداً"],
    [1.75, "جيد"],
    [1.0, "مقبول"],
    [0, "ضعيف"],
  ];
  const ranges = scale === "4" ? ranges4 : ranges5;
  for (const [min, label] of ranges) {
    if (gpa >= min) return label;
  }
  return "—";
}

/** تنسيق رقم لخانتين عشريتين (للعرض). */
function fmt(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

// إتاحة الوحدة عالمياً للتطبيق
window.GPA = {
  GRADE_SCALES,
  NON_COUNTED_GRADES,
  normalizeGradeSymbol,
  findGrade,
  gradeFromScore,
  computeGPA,
  combineCumulative,
  generalStanding,
  fmt,
};
