import { createServer } from 'node:http';

createServer((request, response) => {
  const path = request.url.split('?')[0];
  const repo = path.endsWith('/b') ? 'B' : 'A';
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><html lang="en"><head><title>Shared repository header</title>
    <style>body{font:16px sans-serif;margin:30px} main{min-height:2500px} #about{margin-top:250px;padding:30px;border:1px solid} nav{display:flex;gap:20px}</style>
    </head><body><h1>Shared repository header</h1><nav>
    <a href="${path.startsWith('/mpa') ? '/mpa' : '/spa'}/a">Repository A</a>
    <a href="${path.startsWith('/mpa') ? '/mpa' : '/spa'}/b">Repository B</a></nav>
    <output id="ticker"></output><main><h2>Repository ${repo}</h2><div id="about">About</div></main>
    <script>
      // The page must not be able to erase the extension's activation state.
      if (location.pathname.startsWith('/mpa')) sessionStorage.clear();
      setInterval(() => document.querySelector('#ticker').textContent = Date.now(), 30);
      let count = 0;
      if (location.pathname.startsWith('/tabs')) {
        document.querySelector('#about').hidden = true;
        const tabs = document.createElement('nav'); tabs.setAttribute('role', 'tablist');
        tabs.innerHTML = '<button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Details</button>';
        document.body.prepend(tabs);
        tabs.addEventListener('click', event => {
          const tab = event.target.closest('button'); if (!tab) return;
          for (const button of tabs.children) button.setAttribute('aria-selected', String(button === tab));
          setTimeout(() => document.querySelector('#about').hidden = tab.textContent !== 'Details', 400);
        });
      }
      if (location.pathname.startsWith('/spa')) document.querySelector('nav').addEventListener('click', event => {
        const link = event.target.closest('a'); if (!link) return;
        event.preventDefault(); count++;
        history.pushState({}, '', link.href);
        setTimeout(() => {
          const main = document.createElement('main');
          main.innerHTML = '<h2>Repository ' + (location.pathname.endsWith('/b') ? 'B' : 'A') + '</h2><div id="about">About</div>';
          document.querySelector('main').replaceWith(main);
          // Reproduce partial-render systems that discard extension DOM nodes.
          if (count >= 3) document.querySelector('#pinokio-root')?.remove();
        }, 900);
      });
    </script></body></html>`);
}).listen(4179, '127.0.0.1');
