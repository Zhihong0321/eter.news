(function() {
  try {
    var startTime = Date.now();
    var maxScrollPct = 0;
    var activeReadSec = 0;
    var timer = null;

    var urlParams = new URLSearchParams(window.location.search);
    var lang = localStorage.getItem('meridian-language') || 'en';
    var path = window.location.pathname;
    
    var articleId = null;
    var match = path.match(/infographic_(\d+)/) || window.location.search.match(/id=(\d+)/);
    if (match) articleId = parseInt(match[1], 10);

    // Passive scroll depth tracking (zero performance hit)
    function checkScroll() {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      if (h > 0) {
        var pct = Math.round((window.scrollY / h) * 100);
        if (pct > maxScrollPct) maxScrollPct = Math.min(100, pct);
      }
    }
    window.addEventListener('scroll', checkScroll, { passive: true });

    // Active read time timer (only counts when document is visible)
    timer = setInterval(function() {
      if (document.visibilityState === 'visible') {
        activeReadSec++;
      }
    }, 1000);

    function sendTelemetry(eventType, extraData) {
      checkScroll();
      var data = Object.assign({
        path: path + window.location.search,
        article_id: articleId,
        event_type: eventType || 'pageview',
        referrer: document.referrer || '',
        lang: localStorage.getItem('meridian-language') || lang,
        utm_source: urlParams.get('utm_source') || '',
        utm_medium: urlParams.get('utm_medium') || '',
        utm_campaign: urlParams.get('utm_campaign') || '',
        scroll_depth: maxScrollPct,
        read_time_sec: activeReadSec
      }, extraData || {});

      var payload = JSON.stringify(data);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/analytics/event', payload);
      } else {
        fetch('/api/analytics/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true
        }).catch(function() {});
      }
    }

    // Expose global helper for custom event tracking (e.g. Share clicks, lang switch)
    window.eterTrack = function(eventType, extraData) {
      sendTelemetry(eventType, extraData);
    };

    // Initial pageview
    sendTelemetry('pageview');

    // Flush final metrics on page exit
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'hidden') {
        sendTelemetry('heartbeat');
      }
    });
  } catch(e) {}
})();
