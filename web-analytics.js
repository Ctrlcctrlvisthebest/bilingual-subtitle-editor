export function initWebAnalytics() {
  const {origin, pathname} = window.location;
  if (origin !== 'https://ctrlcctrlvisthebest.github.io' ||
      !(pathname === '/bilingual-subtitle-editor' || pathname.startsWith('/bilingual-subtitle-editor/'))) return;

  const script = document.createElement('script');
  script.type = 'module';
  script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  script.setAttribute('data-cf-beacon', '{"token":"1ecf1746620a421eb5689ccc9b4cc255"}');
  document.body.appendChild(script);
}
