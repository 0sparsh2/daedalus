/* Daedalus preview bridge (dev only). Sends runtime errors and navigation to the workspace. */
(function () {
  if (window.parent === window) return;
  var post = function (type, data) {
    try {
      window.parent.postMessage(Object.assign({ source: "daedalus-preview", type: type, url: location.href, ts: Date.now() }, data || {}), "*");
    } catch (e) {}
  };
  var seen = {};
  var report = function (kind, message, stack) {
    var key = kind + ":" + message;
    if (seen[key]) return;
    seen[key] = 1;
    post("error", { kind: kind, message: String(message).slice(0, 2000), stack: stack ? String(stack).slice(0, 4000) : undefined });
  };
  window.addEventListener("error", function (e) {
    report("error", e.message || "Script error", e.error && e.error.stack);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason || {};
    report("unhandledrejection", r.message || String(r), r.stack);
  });
  var str = function (a) { return a && a.stack ? a.stack : typeof a === "object" ? JSON.stringify(a) : String(a); };
  // console.error("The tag <%s> is unrecognized…", "circle") → "The tag <circle> is unrecognized…"
  var format = function (args) {
    args = Array.prototype.slice.call(args);
    var first = args[0];
    if (typeof first === "string" && /%[sdifoOc]/.test(first)) {
      args.shift();
      first = first.replace(/%[sdifoOc]/g, function (m) { return args.length ? (m === "%c" ? (args.shift(), "") : str(args.shift())) : m; });
      return [first].concat(args.map(str)).join(" ");
    }
    return args.map(str).join(" ");
  };
  var origError = console.error;
  console.error = function () {
    try {
      var msg = format(arguments);
      if (!/Download the React DevTools|\[vite\]/.test(msg)) report("console", msg);
    } catch (e) {}
    return origError.apply(console, arguments);
  };
  // Vite shows compile errors in an overlay element; forward its text.
  new MutationObserver(function () {
    var overlay = document.querySelector("vite-error-overlay");
    if (overlay && overlay.shadowRoot) {
      var msg = overlay.shadowRoot.querySelector(".message");
      var file = overlay.shadowRoot.querySelector(".file");
      if (msg) report("compile", (file ? file.textContent + ": " : "") + msg.textContent);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  var sendNav = function () { post("navigate", { path: location.pathname + location.search + location.hash }); };
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); sendNav(); return r; };
  });
  window.addEventListener("popstate", sendNav);
  // Select mode: the workspace asks the user to point at an element; we describe it back.
  var selecting = false, box = null;
  var describe = function (el) {
    var path = [], n = el;
    for (var i = 0; n && n.nodeType === 1 && n !== document.body && i < 5; i++, n = n.parentElement) {
      var part = n.tagName.toLowerCase();
      if (n.id) { part += "#" + n.id; path.unshift(part); break; }
      var cls = (n.getAttribute("class") || "").split(/\s+/).filter(function (c) { return c && c.length < 24 && !/[:\[\]\/]/.test(c); }).slice(0, 2);
      if (cls.length) part += "." + cls.join(".");
      path.unshift(part);
    }
    var text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 80);
    return { tag: el.tagName.toLowerCase(), text: text, path: path.join(" > "), classes: (el.getAttribute("class") || "").slice(0, 160) };
  };
  var place = function (el) {
    if (!box) { box = document.createElement("div"); box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #0f766e;background:rgba(15,118,110,.08);border-radius:4px;transition:all .06s"; document.documentElement.appendChild(box); }
    var r = el.getBoundingClientRect(); box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.width = r.width + "px"; box.style.height = r.height + "px"; box.style.display = "block";
  };
  var onMove = function (e) { if (selecting && e.target && e.target !== box) place(e.target); };
  var onClick = function (e) {
    if (!selecting) return;
    e.preventDefault(); e.stopPropagation();
    var info = describe(e.target);
    stop();
    post("selected", info);
  };
  var stop = function () { selecting = false; if (box) box.style.display = "none"; document.documentElement.style.cursor = ""; };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", function (e) { if (selecting && e.key === "Escape") { stop(); post("select-cancelled"); } }, true);
  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.source !== "daedalus-host") return;
    if (d.type === "select-mode") { selecting = !!d.on; document.documentElement.style.cursor = selecting ? "crosshair" : ""; if (!selecting) stop(); }
    if (d.type === "reload") location.reload();
    if (d.type === "navigate" && typeof d.path === "string") { history.pushState(null, "", d.path); dispatchEvent(new PopStateEvent("popstate")); }
  });
  window.addEventListener("load", function () { post("ready", { path: location.pathname }); });
})();
