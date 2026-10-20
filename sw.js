const V="dr-v1",SHELL=["./","index.html","styles.css","app.js","firebase-config.js","logo.png"];
const CDN=["www.gstatic.com","fonts.googleapis.com","fonts.gstatic.com"];
self.addEventListener("install",e=>e.waitUntil(caches.open(V).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
const keep=(r,res)=>{if(res.ok){const cp=res.clone();caches.open(V).then(c=>c.put(r,cp))}return res};
self.addEventListener("fetch",e=>{const r=e.request,u=new URL(r.url);if(r.method!=="GET")return;
  if(u.origin===location.origin)e.respondWith(fetch(r).then(res=>keep(r,res)).catch(()=>caches.match(r,{ignoreSearch:true}).then(m=>m||caches.match("index.html"))));
  else if(CDN.includes(u.hostname))e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>keep(r,res))))});