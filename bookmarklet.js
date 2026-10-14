/* =========================================================
   RedMem bookmarklet source.
   Exposes window.RedMemBookmarklet = { code } for the app to render a draggable link.

   The bookmarklet:
   - reads the current tab URL
   - if it looks like a Reddit post, copies it to clipboard and opens RedMem with
     a ?redmem= parameter so the input can be pre-filled
   - otherwise shows an alert

   No backend. No storage. No secrets.
   ========================================================= */

(function () {
  "use strict";

  // The bookmarklet is a single-line javascript: URL.
  // It is intentionally written without template literals or
  // arrow functions so it works in older bookmarklet hosts.

  var appUrl = (function () {
    try {
      // Try to point back to wherever this file is hosted.
      var s = document.currentScript;
      if (s && s.src) {
        return s.src.replace(/bookmarklet\.js(\?.*)?$/, "index.html");
      }
    } catch (e) {}

    // Fallback: same directory as the page that loaded this script.
    try {
      var parts = location.pathname.split("/");
      parts.pop();
      return location.origin + parts.join("/") + "/index.html";
    } catch (e2) {
      return "index.html";
    }
  })();

  var code =
    "javascript:(function(){" +
    "var u=location.href;" +
    "var re=/^https?:\\/\\/(www\\.|old\\.|np\\.|m\\.)?reddit\\.com\\/|^https?:\\/\\/redd\\.it\\//i;" +
    "if(!re.test(u)){alert('RedMem: this does not look like a Reddit post URL.');return;}" +
    "try{navigator.clipboard&&navigator.clipboard.writeText(u);}catch(e){}" +
    "var w=window.open('" +
    appUrl +
    "?redmem='+encodeURIComponent(u),'_blank');" +
    "if(!w){alert('RedMem: please allow pop-ups, or paste this URL manually:\\n'+u);}" +
    "})();";

  window.RedMemBookmarklet = { code: code, appUrl: appUrl };
})();
