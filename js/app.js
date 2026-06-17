/* =========================================================================
 * app.js — منطق الواجهة والتحكم (وحدة ES)
 * يربط: رفع الملف ← التحليل ← المراجعة/التعديل ← الحساب اللحظي ← الطباعة.
 * ========================================================================= */

import * as pdfjsLib from "../lib/pdf.min.mjs";

// عامل pdf.js المحلي (لا اتصال بالإنترنت مطلوب)
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../lib/pdf.worker.min.mjs", import.meta.url).href;

const { GPA } = window;
const { parseRecord } = window.RecordParser;

// ----------------------------- الحالة العامة -----------------------------
const state = {
  scale: "5",
  student: {},
  prev: { hours: 0, gpa: 0, points: 0 },
  currentCourses: [], // { id, name, code, grade, hours }
  completed: [],
};

let courseSeq = 1;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ----------------------------- التهيئة -----------------------------------
document.addEventListener("DOMContentLoaded", () => {
  bindScaleToggle();
  bindUpload();
  bindManual();
  bindCollapsibles();
  bindResultsActions();
  bindTarget();
  $("#addCourseBtn").addEventListener("click", () => {
    addCourseRow();
    recompute();
  });
  renderScaleTable();
  // ربط حقول الحالة السابقة بالحساب اللحظي
  ["#prev_hours", "#prev_gpa", "#prev_points"].forEach((s) =>
    $(s).addEventListener("input", onPrevChange)
  );
  // ربط حقول بيانات الطالب
  ["#st_name", "#st_id", "#st_major", "#st_college", "#st_degree", "#st_date"].forEach((s) =>
    $(s).addEventListener("input", syncStudentFromInputs)
  );
});

// ----------------------------- تبديل السلّم -------------------------------
function bindScaleToggle() {
  $$(".scale-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".scale-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.scale = btn.dataset.scale;
      rebuildGradeSelects();
      renderScaleTable();
      recompute();
    });
  });
}

// ----------------------------- رفع الملف ---------------------------------
function bindUpload() {
  const dz = $("#dropzone");
  const input = $("#fileInput");

  dz.addEventListener("click", () => input.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("dragover"); })
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
}

async function handleFile(file) {
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    setStatus("error", "الرجاء اختيار ملف PDF صالح.");
    return;
  }
  setStatus("loading", "⏳ جارٍ قراءة السجل واستخلاص البيانات…");
  try {
    const buf = await file.arrayBuffer();
    const data = await parseRecord(buf, pdfjsLib);
    applyParsed(data);
    const n = data.current.length;
    if (n === 0) {
      setStatus("warn",
        "✓ تم قراءة السجل، لكن لم يتم العثور على مقررات حالية بلا تقدير. " +
        "يمكنك إضافة مقررات الفصل الحالي يدوياً بالأسفل.");
    } else {
      setStatus("success",
        `✓ تم استخلاص البيانات بنجاح: ${n} مقرر حالي و ${data.completed.length} مقرر مكتمل. ` +
        "راجع الحقول وعدّلها عند الحاجة.");
    }
  } catch (err) {
    console.error(err);
    setStatus("error",
      "تعذّر قراءة الملف. تأكد أنه سجل أكاديمي بصيغة PDF نصّية (وليس صورة ممسوحة)، " +
      "أو ابدأ الإدخال يدوياً.");
  }
}

function setStatus(type, msg) {
  const el = $("#parseStatus");
  el.hidden = false;
  el.className = "parse-status " + type;
  el.textContent = msg;
}

// ----------------------------- تطبيق نتائج التحليل ------------------------
function applyParsed(data) {
  // بيانات الطالب
  state.student = data.student || {};
  $("#st_name").value = state.student.name || "";
  $("#st_id").value = state.student.studentId || "";
  $("#st_major").value = state.student.major || "";
  $("#st_college").value = state.student.college || "";
  $("#st_degree").value = state.student.degree || "";
  $("#st_date").value = state.student.printDate || "";

  // قيمة الهدف الافتراضية حسب الدرجة (بكالوريوس 2.00 / دراسات عليا 3.75)
  $("#targetGpa").value = defaultTargetForDegree(state.student.degree);

  // الحالة التراكمية السابقة
  if (data.cumulative) {
    const c = data.cumulative;
    $("#prev_hours").value = c.hours != null ? Math.round(c.hours) : "";
    $("#prev_gpa").value = c.gpa != null ? Number(c.gpa).toFixed(2) : "";
    $("#prev_points").value = c.points != null ? Number(c.points).toFixed(2) : "";
  }
  onPrevChange();

  // المقررات المكتملة (اطلاعي)
  state.completed = data.completed || [];
  renderCompleted();

  // المقررات الحالية
  state.currentCourses = [];
  $("#currentBody").innerHTML = "";
  const list = (data.current && data.current.length) ? data.current : [];
  if (list.length) {
    // نمرّر التقدير المرصود (إن وُجد) ليظهر مُعبّأً مسبقاً لمقررات الفصل الأخير المرصود لها درجات
    list.forEach((c) => addCourseRow({ name: c.name, code: c.code, hours: c.hours, grade: c.grade || "" }));
  } else {
    addCourseRow();
  }

  showWorkspace();
  recompute();
}

// ----------------------------- وضع الإدخال اليدوي ------------------------
function bindManual() {
  $("#manualBtn").addEventListener("click", () => {
    state.completed = [];
    renderCompleted();
    $("#currentBody").innerHTML = "";
    state.currentCourses = [];
    addCourseRow(); addCourseRow(); addCourseRow();
    showWorkspace();
    setStatus("success", "تم تجهيز الإدخال اليدوي. أدخل حالتك التراكمية ومقرراتك.");
    recompute();
  });
}

function showWorkspace() {
  $("#reviewSection").hidden = false;
  $("#resultsSection").hidden = false;
  $("#reviewSection").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ----------------------------- صفوف المقررات -----------------------------
function gradeOptionsHTML(selected) {
  const scale = GPA.GRADE_SCALES[state.scale];
  let html = `<option value="">— غير محدد —</option>`;
  for (const g of scale) {
    const sel = g.ar === selected ? "selected" : "";
    html += `<option value="${g.ar}" ${sel}>${g.ar} (${g.en}) — ${g.value.toFixed(2)}</option>`;
  }
  return html;
}

function addCourseRow(data = {}) {
  const id = "c" + courseSeq++;
  const course = {
    id,
    name: data.name || "",
    code: data.code || "",
    score: data.score != null ? data.score : "",
    grade: data.grade || "",
    hours: data.hours || "",
  };
  state.currentCourses.push(course);

  const tr = document.createElement("tr");
  tr.dataset.id = id;
  tr.innerHTML = `
    <td class="col-name"><input type="text" class="f-name" value="${escAttr(course.name)}" placeholder="اسم المقرر" /></td>
    <td class="col-code"><input type="text" class="f-code" value="${escAttr(course.code)}" placeholder="—" /></td>
    <td class="col-score"><input type="number" class="f-score" min="0" max="100" step="0.5" value="${course.score}" placeholder="0–100" /></td>
    <td class="col-grade"><select class="f-grade">${gradeOptionsHTML(course.grade)}</select></td>
    <td class="col-hours"><input type="number" class="f-hours" min="0" max="12" step="1" value="${course.hours}" placeholder="0" /></td>
    <td class="cell-points col-points" data-points>—</td>
    <td class="col-act"><button class="row-del" title="حذف">×</button></td>
  `;
  $("#currentBody").appendChild(tr);

  // ربط الأحداث
  tr.querySelector(".f-name").addEventListener("input", (e) => { course.name = e.target.value; });
  tr.querySelector(".f-code").addEventListener("input", (e) => { course.code = e.target.value; });
  tr.querySelector(".f-score").addEventListener("input", (e) => { course.score = e.target.value; recompute(); });
  tr.querySelector(".f-grade").addEventListener("change", (e) => { course.grade = e.target.value; course.autoFilled = false; recompute(); });
  tr.querySelector(".f-hours").addEventListener("input", (e) => { course.hours = e.target.value; recompute(); });
  tr.querySelector(".row-del").addEventListener("click", () => {
    state.currentCourses = state.currentCourses.filter((c) => c.id !== id);
    tr.remove();
    recompute();
  });
}

function rebuildGradeSelects() {
  $$("#currentBody tr").forEach((tr) => {
    const id = tr.dataset.id;
    const course = state.currentCourses.find((c) => c.id === id);
    const sel = tr.querySelector(".f-grade");
    if (course && sel) sel.innerHTML = gradeOptionsHTML(course.grade);
  });
}

// ----------------------------- الحالة السابقة ----------------------------
function onPrevChange() {
  const h = parseFloat($("#prev_hours").value) || 0;
  const g = parseFloat($("#prev_gpa").value) || 0;
  let p = parseFloat($("#prev_points").value);
  // إذا لم تُدخل النقاط، احسبها من المعدل×الساعات
  if (!Number.isFinite(p) || p === 0) {
    p = g * h;
    if (p > 0) $("#prev_points").value = p.toFixed(2);
  }
  state.prev = { hours: h, gpa: g, points: p || g * h };
  recompute();
}

function syncStudentFromInputs() {
  state.student = {
    name: $("#st_name").value, studentId: $("#st_id").value,
    major: $("#st_major").value, college: $("#st_college").value,
    degree: $("#st_degree").value, printDate: $("#st_date").value,
  };
}

// ----------------------------- الحساب اللحظي -----------------------------
function recompute() {
  const semCourses = [];
  $$("#currentBody tr").forEach((tr) => {
    const id = tr.dataset.id;
    const course = state.currentCourses.find((c) => c.id === id);
    if (!course) return;
    const hours = parseFloat(course.hours) || 0;
    const cell = tr.querySelector("[data-points]");
    const sel = tr.querySelector(".f-grade");
    const hasScore = course.score !== "" && course.score != null && !isNaN(parseFloat(course.score));

    let gradeObj;
    if (hasScore) {
      // الدرجة تُحدّد التقدير تلقائياً، ويُقفل اختيار التقدير لتفادي التعارض
      gradeObj = GPA.gradeFromScore(course.score, state.scale);
      if (gradeObj) { course.grade = gradeObj.ar; sel.value = gradeObj.ar; }
      sel.disabled = true;
      sel.classList.add("auto");
    } else {
      sel.disabled = false;
      sel.classList.remove("auto");
      gradeObj = GPA.findGrade(course.grade, state.scale);
    }

    if (gradeObj && hours > 0) {
      const pts = gradeObj.value * hours;
      cell.textContent = pts.toFixed(2);
      semCourses.push({ hours, value: gradeObj.value });
    } else {
      cell.textContent = "—";
    }
  });

  const sem = GPA.computeGPA(semCourses);
  const prev = { points: state.prev.points || 0, hours: state.prev.hours || 0 };
  const cum = GPA.combineCumulative(prev, sem);

  // عرض المعدل الفصلي
  $("#r_sem_gpa").textContent = sem.hours ? GPA.fmt(sem.gpa) : "—";
  $("#r_sem_hours").textContent = sem.hours;
  $("#r_sem_points").textContent = GPA.fmt(sem.points);
  $("#r_sem_standing").textContent = sem.hours ? GPA.generalStanding(sem.gpa, state.scale) : "—";

  // عرض التراكمي المتوقع
  $("#r_cum_gpa").textContent = cum.hours ? GPA.fmt(cum.gpa) : "—";
  $("#r_cum_hours").textContent = cum.hours;
  $("#r_cum_points").textContent = GPA.fmt(cum.points);
  $("#r_cum_standing").textContent = cum.hours ? GPA.generalStanding(cum.gpa, state.scale) : "—";

  state._lastResult = { sem, cum };
}

// ----------------------------- المقررات المكتملة -------------------------
function renderCompleted() {
  const body = $("#completedTableBody");
  body.innerHTML = "";
  $("#completedCount").textContent = state.completed.length;
  if (!state.completed.length) {
    $("#completedCard").style.display = "none";
    return;
  }
  $("#completedCard").style.display = "";
  for (const c of state.completed) {
    const tr = document.createElement("tr");
    const pts = c.points != null ? Number(c.points).toFixed(2) : "—";
    tr.innerHTML = `<td class="name" style="text-align:right">${esc(c.name)}</td>
      <td>${esc(c.code)}</td><td><span class="ltr">${esc(c.grade) || "—"}</span></td>
      <td>${c.hours || "—"}</td><td>${pts}</td>`;
    body.appendChild(tr);
  }
}

// ----------------------------- المطويات ----------------------------------
function bindCollapsibles() {
  const pairs = [
    ["#completedToggle", "#completedCard"],
    ["#scaleToggle", "#scaleInfo"],
  ];
  for (const [tog, card] of pairs) {
    const t = $(tog), c = $(card);
    if (t && c) {
      c.classList.add("collapsed");
      t.addEventListener("click", () => c.classList.toggle("collapsed"));
    }
  }
}

// ----------------------------- جدول السلّم -------------------------------
function renderScaleTable() {
  const scale = GPA.GRADE_SCALES[state.scale];
  let html = `<thead><tr><th>التقدير</th><th>الرمز</th><th>النقاط</th><th>النسبة</th><th>الوصف</th></tr></thead><tbody>`;
  for (const g of scale) {
    const range = g.max >= 100 ? `${g.min}–100` : (g.min === 0 ? `أقل من ${g.max + 1}` : `${g.min}–${g.max}`);
    html += `<tr><td class="g-sym">${g.ar}</td><td>${g.en}</td><td>${g.value.toFixed(2)}</td><td>${range}</td><td>${g.label}</td></tr>`;
  }
  html += `</tbody>`;
  $("#scaleTable").innerHTML = html;
}

// ----------------------------- الأزرار النهائية --------------------------
function bindResultsActions() {
  $("#printBtn").addEventListener("click", printReport);
  $("#resetBtn").addEventListener("click", () => {
    if (confirm("سيتم مسح كل المدخلات والبدء من جديد. متابعة؟")) location.reload();
  });
}

// ----------------------------- الهدف العكسي (معدل مستهدف) -----------------
function bindTarget() {
  $$(".chip-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      $("#targetGpa").value = btn.dataset.target;
      $$(".chip-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      calcTarget();
    })
  );
  $("#calcTargetBtn").addEventListener("click", calcTarget);
}

// يضع قيمة هدف افتراضية حسب الدرجة (بكالوريوس 2.00 / دراسات عليا 3.75)
function defaultTargetForDegree(degree) {
  const d = (degree || "").toLowerCase();
  const grad = /ماجستير|دكتوراه|دبلوم عالي|عليا|master|phd|doctor|graduate/.test(d);
  return grad ? "3.75" : "2.00";
}

/**
 * يحسب التقدير الموحّد المطلوب في المقررات المتبقية (بلا تقدير/درجة) لبلوغ معدل تراكمي مستهدف،
 * ثم يُعبّئها به. يأخذ في الحسبان المقررات المرصودة (الثابتة) والحالة التراكمية السابقة.
 */
function calcTarget() {
  const out = $("#targetResult");
  const T = parseFloat($("#targetGpa").value);
  const scaleArr = GPA.GRADE_SCALES[state.scale];
  const maxV = scaleArr[0].value;
  const minV = scaleArr[scaleArr.length - 1].value;

  const show = (cls, html) => { out.hidden = false; out.className = "target-result " + cls; out.innerHTML = html; };

  if (!Number.isFinite(T) || T <= 0) { show("warn", "أدخل معدلاً تراكمياً مستهدفاً صحيحاً."); return; }
  if (T > maxV) { show("bad", `المعدل المستهدف لا يمكن أن يتجاوز سقف السلّم (${maxV.toFixed(2)}).`); return; }

  // الحالة السابقة
  const prevPts = Number(state.prev.points) || 0;
  const prevHrs = Number(state.prev.hours) || 0;

  // تقسيم مقررات الفصل: مرصودة (تقدير/درجة) ثابتة، ومتبقية (فارغة) قابلة للتعبئة
  let fixedPts = 0, fixedHrs = 0, ungrHrs = 0, ungrCount = 0;
  const ungraded = [];
  for (const c of state.currentCourses) {
    const h = parseFloat(c.hours) || 0;
    if (h <= 0) continue;
    const hasScore = c.score !== "" && c.score != null && !isNaN(parseFloat(c.score));
    // المقررات القابلة للتعبئة: بلا درجة فعلية مُدخلة من المستخدم (تشمل ما عبّأه الهدف سابقاً)
    const fillable = !hasScore && (!c.grade || c.autoFilled);
    const g = fillable ? null : (hasScore ? GPA.gradeFromScore(c.score, state.scale) : GPA.findGrade(c.grade, state.scale));
    if (g) { fixedPts += g.value * h; fixedHrs += h; }
    else { ungrHrs += h; ungrCount++; ungraded.push(c); }
  }

  const totalHrs = prevHrs + fixedHrs + ungrHrs;
  if (totalHrs <= 0) { show("warn", "لا توجد ساعات لاحتساب المطلوب."); return; }

  if (ungrHrs <= 0) {
    const proj = (prevPts + fixedPts) / totalHrs;
    const okNow = proj >= T;
    show(okNow ? "ok" : "bad",
      `لا توجد مقررات بلا تقدير لتعبئتها. المعدل التراكمي المتوقع الحالي <b>${GPA.fmt(proj)}</b> ` +
      (okNow ? "≥ المستهدف ✓" : `أقل من المستهدف <b>${GPA.fmt(T)}</b>.`));
    return;
  }

  // النقاط المطلوبة من المقررات المتبقية ثم متوسط التقدير المطلوب لكل منها
  const needFromUngraded = T * totalHrs - prevPts - fixedPts;
  const reqAvg = needFromUngraded / ungrHrs;
  const reqSemGpa = (T * totalHrs - prevPts) / (fixedHrs + ungrHrs); // معدل فصلي مطلوب (شامل المرصود)

  if (reqAvg <= minV) {
    show("ok",
      `🎉 مضمون: ستحقّق معدلاً تراكمياً <b>${GPA.fmt(T)}</b> حتى لو حصلت على أدنى تقدير في المقررات المتبقية (${ungrCount}).`);
    return;
  }
  if (reqAvg > maxV + 1e-9) {
    show("bad",
      `يتعذّر بلوغ <b>${GPA.fmt(T)}</b> هذا الفصل: تحتاج إلى متوسط <b>${GPA.fmt(reqAvg)}</b> في المقررات المتبقية، ` +
      `وهو أعلى من سقف السلّم (${maxV.toFixed(2)}).`);
    return;
  }

  // أصغر تقدير قيمته ≥ المتوسط المطلوب
  let reqGrade = scaleArr[0];
  for (const g of scaleArr) { if (g.value >= reqAvg - 1e-9) reqGrade = g; }

  // تعبئة المقررات المتبقية بهذا التقدير (مع وسمها كمعبّأة آلياً لإعادة الاحتساب لاحقاً)
  ungraded.forEach((c) => { c.grade = reqGrade.ar; c.autoFilled = true; });
  $$("#currentBody tr").forEach((tr) => {
    const course = state.currentCourses.find((c) => c.id === tr.dataset.id);
    if (course && ungraded.includes(course)) {
      const sel = tr.querySelector(".f-grade");
      sel.value = reqGrade.ar; sel.disabled = false; sel.classList.remove("auto");
    }
  });
  recompute();

  show("ok",
    `للوصول إلى معدل تراكمي <b>${GPA.fmt(T)}</b> تحتاج إلى <b>${reqGrade.ar} (${reqGrade.en} — ${reqGrade.value.toFixed(2)})</b> ` +
    `على الأقل في كل مقرر من المقررات المتبقية (${ungrCount}). ` +
    `المتوسط الدقيق المطلوب ≈ <b>${GPA.fmt(reqAvg)}</b>، والمعدل الفصلي المطلوب ≈ <b>${GPA.fmt(reqSemGpa)}</b>. ` +
    `تم تعبئة التقديرات المطلوبة في الجدول.`);
}

// ----------------------------- تقرير الطباعة -----------------------------
function printReport() {
  recompute();
  const r = state._lastResult || { sem: {}, cum: {} };
  const s = state.student || {};
  const scaleTxt = state.scale === "5" ? "5.00" : "4.00";
  const today = new Date().toLocaleDateString("ar-SA-u-nu-latn");

  const rows = state.currentCourses.map((c) => {
    const hasScore = c.score !== "" && c.score != null && !isNaN(parseFloat(c.score));
    const g = hasScore ? GPA.gradeFromScore(c.score, state.scale) : GPA.findGrade(c.grade, state.scale);
    const hours = parseFloat(c.hours) || 0;
    const pts = g && hours ? (g.value * hours).toFixed(2) : "—";
    const scoreTxt = hasScore ? parseFloat(c.score) : "—";
    const gradeTxt = g ? g.ar : (esc(c.grade) || "—");
    return `<tr>
      <td class="name">${esc(c.name) || "—"}</td>
      <td>${esc(c.code) || "—"}</td>
      <td>${scoreTxt}</td>
      <td><span class="ltr">${gradeTxt}</span></td>
      <td>${hours || "—"}</td>
      <td>${pts}</td></tr>`;
  }).join("");

  const meta = (label, val) => `<div><b>${label}:</b> ${esc(val) || "—"}</div>`;

  const html = `
  <div class="pr-doc">
    <div class="pr-header">
      <div>
        <div class="pr-uni">جامعة الملك خالد</div>
        <div class="pr-sub">تقرير احتساب المعدل الفصلي والتراكمي (غير رسمي)</div>
      </div>
      <img class="pr-logo" src="assets/logo.svg" alt="" />
    </div>

    <div class="pr-title">تقرير المعدل المتوقّع</div>

    <div class="pr-meta">
      ${meta("الاسم", s.name)}
      ${meta("الرقم الجامعي", s.studentId)}
      ${meta("التخصص", s.major)}
      ${meta("الكلية", s.college)}
      ${meta("الدرجة", s.degree)}
      ${meta("تاريخ التقرير", today)}
    </div>

    <div class="pr-section-title">مقررات الفصل الحالي والدرجات المتوقعة</div>
    <table class="pr-table">
      <thead><tr><th>اسم المقرر</th><th>الرمز</th><th>الدرجة</th><th>التقدير</th><th>الساعات</th><th>النقاط</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">لا توجد مقررات</td></tr>`}</tbody>
    </table>

    <div class="pr-section-title">النتيجة</div>
    <div class="pr-summary">
      <div class="pr-sum-box">
        <div class="lbl">المعدل الفصلي المتوقع (من ${scaleTxt})</div>
        <div class="val">${r.sem.hours ? GPA.fmt(r.sem.gpa) : "—"}</div>
        <div class="std">${r.sem.hours ? GPA.generalStanding(r.sem.gpa, state.scale) : ""}</div>
        <div class="lbl">${r.sem.hours || 0} ساعة · ${GPA.fmt(r.sem.points)} نقطة</div>
      </div>
      <div class="pr-sum-box">
        <div class="lbl">المعدل التراكمي المتوقع (من ${scaleTxt})</div>
        <div class="val">${r.cum.hours ? GPA.fmt(r.cum.gpa) : "—"}</div>
        <div class="std">${r.cum.hours ? GPA.generalStanding(r.cum.gpa, state.scale) : ""}</div>
        <div class="lbl">${r.cum.hours || 0} ساعة · ${GPA.fmt(r.cum.points)} نقطة</div>
      </div>
    </div>

    <div class="pr-stamp">
      <span class="seal">تقرير تقديري<br/>غير رسمي<br/>${today}</span>
    </div>

    <div class="pr-footer">
      <span>تم إنشاؤه عبر حاسبة المعدل — جامعة الملك خالد</span>
      <span>الحالة السابقة: ${state.prev.hours || 0} ساعة بمعدل ${GPA.fmt(state.prev.gpa)}</span>
    </div>
  </div>`;

  const target = $("#printReport");
  target.innerHTML = html;
  target.hidden = false;
  window.print();
  // إخفاء بعد الطباعة لتفادي ظهوره ضمن الصفحة
  setTimeout(() => { target.hidden = true; }, 500);
}

// ----------------------------- أدوات مساعدة ------------------------------
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }
