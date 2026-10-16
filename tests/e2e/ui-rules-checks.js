/* eslint-disable -- page-side source, evaluated as a string by rules-audit.mjs */
// In-page checks for the UI rules audit (ui-ux-pro-max quick reference §1–§3): text contrast,
// accessible names, form labels, target sizes (24 px, 44 px on touch), tiny text (< 12 px), input
// borders, heading order, duplicate ids, role=menu misuse and horizontal overflow.
// Evaluated inside the page by tests/e2e/rules-audit.mjs.
function inPage(touch) {
  const parse = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const a = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [a[0], a[1], a[2], a.length > 3 ? a[3] : 1]; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const blend = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
  const bgOf = el => { const stack = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage && cs.backgroundImage !== "none") return null; const c = parse(cs.backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } }
    let base = parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1]; for (let i = stack.length - 1; i >= 0; i--) base = blend(stack[i], base); return base; };
  const visible = el => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false; if (e.classList && (e.classList.contains("sr"))) return false; } for (let d = el.parentElement; d; d = d.parentElement) { if (d.tagName === "DETAILS" && !d.open && !el.closest("summary")?.parentElement?.isSameNode(d)) { const sum = d.querySelector(":scope > summary"); if (!(sum && sum.contains(el))) return false; } } return true; };
  const desc = el => { const t = (el.innerText || el.getAttribute("aria-label") || el.value || "").trim().replace(/\s+/g, " ").slice(0, 40); return `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}${el.dataset && el.dataset.a ? "[" + el.dataset.a + "]" : ""} "${t}"`; };
  const out = { contrast: [], noname: [], nolabel: [], small: [], tiny: [], inputBorder: [], headings: [], dupIds: [], menuRole: 0, overflow: 0 };
  // text contrast + tiny text
  for (const el of document.querySelectorAll("body *")) {
    if (!el.childNodes.length || ["SCRIPT", "STYLE", "SVG", "PATH"].includes(el.tagName)) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()); if (!own || !visible(el)) continue;
    if (el.closest("[disabled],[aria-disabled=true]")) continue;
    const cs = getComputedStyle(el); const fg = parse(cs.color); const bg = bgOf(el); if (!fg || !bg) continue;
    const fgb = fg[3] < 1 ? blend(fg, bg) : fg; const r = ratio(fgb, bg); const size = parseFloat(cs.fontSize), w = +cs.fontWeight || 400;
    const large = size >= 24 || (size >= 18.66 && w >= 700);
    if (r < (large ? 3 : 4.5)) out.contrast.push(`${r.toFixed(2)} ${desc(el)} fg=${cs.color} size=${size}`);
    if (size < 12) out.tiny.push(`${size}px ${desc(el)}`);
  }
  const ints = [...document.querySelectorAll("button,a[href],input,select,textarea,summary,[role=button],[role=tab],[tabindex]:not([tabindex='-1'])")].filter(visible);
  for (const el of ints) {
    const name = (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.innerText || el.getAttribute("title") || el.value || el.getAttribute("placeholder") || "").trim();
    if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
      const id = el.id, lab = (id && document.querySelector(`label[for="${id}"]`)) || el.closest("label") || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
      if (!lab && el.type !== "hidden") out.nolabel.push(desc(el));
      const cs = getComputedStyle(el); const b = parse(cs.borderTopColor), bg = bgOf(el.parentElement || el);
      if (b && bg && parseFloat(cs.borderTopWidth) > 0 && el.type !== "checkbox" && el.type !== "radio") { const r = ratio(b[3] < 1 ? blend(b, bg) : b, bg); if (r < 3) out.inputBorder.push(`${r.toFixed(2)} ${desc(el)}`); }
    } else if (!name) out.noname.push(desc(el));
    const r = ((el.type === "checkbox" || el.type === "radio") && el.closest("label") ? el.closest("label") : el).getBoundingClientRect(); const inline = getComputedStyle(el).display === "inline" || el.classList.contains("linkbtn"); // WCAG 2.5.8 inline exception: links inside a sentence
    const min = touch ? 44 : 24;
    if (!inline && (r.height < min - 0.5 || r.width < (touch ? 24 : 24) - 0.5)) out.small.push(`${Math.round(r.width)}x${Math.round(r.height)} ${desc(el)}`);
  }
  const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(h => { const r = h.getBoundingClientRect(); return r.width > 0 || h.classList.contains("sr"); }).map(h => +h.tagName[1]);
  if (!hs.includes(1)) out.headings.push("no h1");
  for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) out.headings.push(`h${hs[i - 1]}→h${hs[i]}`);
  const ids = {}; for (const e of document.querySelectorAll("[id]")) ids[e.id] = (ids[e.id] || 0) + 1; out.dupIds = Object.keys(ids).filter(k => ids[k] > 1);
  out.menuRole = document.querySelectorAll("[role=menu],[role=menuitem]").length;
  out.overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  return out;
}
