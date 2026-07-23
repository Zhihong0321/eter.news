(function() {
  try {
    var urlParams = new URLSearchParams(window.location.search);
    var lang = localStorage.getItem('meridian-language') || 'en';
    var path = window.location.pathname;
    
    // Extract article ID if present
    var articleId = null;
    var match = path.match(/infographic_(\d+)/) || window.location.search.match(/id=(\d+)/);
    if (match) articleId = parseInt(match[1], 10);

    var data = {
      path: path + window.location.search,
      article_id: articleId,
      event_type: 'pageview',
      referrer: document.referrer || '',
      lang: lang,
      utm_source: urlParams.get('utm_source') || '',
      utm_medium: urlParams.get('utm_medium') || '',
      utm_campaign: urlParams.get('utm_campaign') || ''
    };

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
  } catch(e) {}
})();
