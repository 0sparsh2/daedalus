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
  var origError = console.error;
  console.error = function () {
    try {
      var msg = Array.prototype.map.call(arguments, function (a) { return a && a.stack ? a.stack : typeof a === "object" ? JSON.stringify(a) : String(a); }).join(" ");
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
  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.source !== "daedalus-host") return;
    if (d.type === "reload") location.reload();
    if (d.type === "navigate" && typeof d.path === "string") { history.pushState(null, "", d.path); dispatchEvent(new PopStateEvent("popstate")); }
  });
  window.addEventListener("load", function () { post("ready", { path: location.pathname }); });
})();
