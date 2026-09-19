// Attaches the session CSRF token to every same-origin mutating request,
// through both fetch and XMLHttpRequest. The token comes from the layout's
// <meta name="csrf-token"> and is verified server-side by the
// csrfProtection middleware mounted on /api.
(function () {
  const getToken = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  const mutating = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
  const sameOrigin = (url) =>
    typeof url === 'string' &&
    ((url.startsWith('/') && !url.startsWith('//')) || url.startsWith(window.location.origin));

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const method = (init && init.method) || 'GET';
      if (typeof input === 'string' && mutating(method) && sameOrigin(input)) {
        const token = getToken();
        if (token) {
          init = Object.assign({}, init);
          const headers = new Headers(init.headers || {});
          headers.set('X-CSRF-Token', token);
          init.headers = headers;
        }
      }
    } catch (e) { /* never break the original call */ }
    return origFetch(input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__csrfNeedsToken = mutating(method) && sameOrigin(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name) {
    if (this.__csrfNeedsToken && String(name).toLowerCase() === 'x-csrf-token') {
      this.__csrfTokenSet = true;
    }
    return origSetRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__csrfNeedsToken && !this.__csrfTokenSet) {
      const token = getToken();
      if (token) origSetRequestHeader.call(this, 'X-CSRF-Token', token);
    }
    return origSend.apply(this, arguments);
  };
})();
