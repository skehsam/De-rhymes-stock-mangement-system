import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getAuth,onAuthStateChanged,signInWithEmailAndPassword,signOut,createUserWithEmailAndPassword,sendPasswordResetEmail} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {getFirestore,collection,doc,getDoc,getDocs,query,where,orderBy,limit,runTransaction,serverTimestamp,Timestamp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {firebaseConfig} from "./firebase-config.js";

const app=initializeApp(firebaseConfig),auth=getAuth(app),db=getFirestore(app);
const auth2=getAuth(initializeApp(firebaseConfig,"creator")); // only used to create accounts without logging the superadmin out
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const naira=n=>new Intl.NumberFormat("en-NG",{style:"currency",currency:"NGN"}).format(n||0);
const cpy=n=>n>0?`<button type="button" class="cpy" data-c="${Math.round(n*100)/100}" title="Copy price" aria-label="Copy price">Copy</button>`:"";
const num=id=>parseFloat($(id).value)||0;
const r6=n=>Math.round(n*1e6)/1e6;
let P=[],B=[],C=[],cur=null,user=null,role="staff",sort={k:"name",d:1},pf="all";
const isAdmin=()=>["admin","superadmin"].includes(role);
const isSuper=()=>role==="superadmin";
const titles={dashboard:"Dashboard",products:"Products",stockin:"Receive stock",stockout:"Stock out",movements:"Movements",pricing:"Pricing calculator",expiry:"Batches and expiry",settings:"Settings",product:"Product details",transactions:"Transactions",staff:"Staff accounts"};
const subs={dashboard:"Today's stock position at a glance.",products:"Search, edit and archive the products you sell.",stockin:"Add a new product, or receive a new batch of an existing one.",stockout:"Record sales, damages, losses and corrections.",movements:"Every stock change, newest first.",pricing:"Work out selling prices from cost, markup, margin or category rules.",expiry:"Track batches and what is close to expiring.",settings:"Categories, markup rules and expiry reminders.",product:"Everything about this product in one place.",transactions:"Search any day, week or month and export it as a CSV file.",staff:"Create and manage staff logins."};

function toast(m,bad){const t=$("toast");t.textContent=m;t.className="show"+(bad?" bad":"");setTimeout(()=>t.className="",bad?5000:3000)}
document.addEventListener("click",async e=>{const b=e.target.closest(".cpy");if(!b)return;e.preventDefault();e.stopPropagation();
  const v=b.dataset.c;
  try{await navigator.clipboard.writeText(v)}
  catch{const t=document.createElement("textarea");t.value=v;t.style.cssText="position:fixed;opacity:0";document.body.append(t);t.select();try{document.execCommand("copy")}catch{}t.remove()}
  b.textContent="Copied";b.classList.add("done");toast("Copied "+naira(Number(v)));
  setTimeout(()=>{b.textContent="Copy";b.classList.remove("done")},1500)});
async function guard(btn,fn){btn.disabled=true;try{await fn()}catch(e){console.error(e);toast(e.message||"Something went wrong. Nothing was saved.",true)}finally{btn.disabled=false}}

// ---- auth
$("loginForm").onsubmit=async e=>{e.preventDefault();$("loginErr").textContent="";
  try{let id=$("email").value.trim();
    if(!id.includes("@")){const s=await getDoc(doc(db,"usernames",id.toLowerCase()));if(!s.exists())throw 0;id=s.data().email}
    await signInWithEmailAndPassword(auth,id,$("password").value)}
  catch{$("loginErr").textContent="Wrong username, email or password."}};
$("logout").onclick=()=>signOut(auth);
$("showPw").onclick=()=>{const i=$("password"),s=i.type==="password";i.type=s?"text":"password";$("showPw").textContent=s?"Hide":"Show"};
onAuthStateChanged(auth,async u=>{user=u;$("login").hidden=!!u;$("app").hidden=!u;
  if(u){$("meName").textContent=u.email;
    try{const r=await getDoc(doc(db,"users",u.uid)),d=r.exists()?r.data():{};
      if(d.active===false){$("loginErr").textContent="This account has been deactivated.";await signOut(auth);return}
      role=d.role||"staff";$("meName").textContent=d.name||d.username||u.email;
      document.body.classList.toggle("staff",!isAdmin());
      document.body.classList.toggle("nosa",!isSuper());
      document.body.classList.toggle("super",isSuper());
      await load();show("dashboard")}
    catch(e){console.error(e);toast("Could not load data. Check your Firebase rules and config.",true)}}});

// ---- helpers: packs, categories, expiry windows
// Every product has an implicit base unit (qty 1). Extra packs are stored in p.packs as {name,qty,price?}, qty = base units inside.
const packsOf=p=>{const base={name:p.unit||"unit",qty:1};
  const ex=Array.isArray(p.packs)?p.packs:(p.packSize>1?[{name:"Carton",qty:p.packSize}]:[]);
  return [base,...ex.filter(x=>x.qty>0)]};
const packSel=(id,p)=>{$(id).innerHTML=p?packsOf(p).map((x,i)=>`<option value="${i}">${esc(x.name)}${x.qty>1?` (${x.qty} ${esc(p.unit)})`:""}</option>`).join(""):'<option value="">Select a product first</option>'};
const catOf=p=>C.find(c=>c.name===p?.category);
// minimum stock comes from the product's category; products in a category without one fall back to their own saved minimum (default 5)
const minOf=p=>{const m=catOf(p)?.minStock;return m===""||m==null?(Number(p.minStock)||5):Number(m)};
const isOut=p=>p.stock<=0,isLow=p=>p.stock>0&&p.stock<=minOf(p);
const windowDays=p=>(Number(catOf(p)?.expiryMonths)||1)*30;
const daysTo=b=>b.expiry?Math.ceil((b.expiry.toDate()-new Date())/864e5):null;
const live=B=>B.filter(b=>b.qtyRemaining>0);
const prodOf=id=>P.find(p=>p.id===id);
const batchWindow=b=>windowDays(prodOf(b.productId));
const TEST={"<":(c,v)=>c<v,"<=":(c,v)=>c<=v,">":(c,v)=>c>v,">=":(c,v)=>c>=v,"=":(c,v)=>c===v,"<>":(c,v)=>c!==v};
// returns {retail, wholesale} (either may be null) or null when nothing matches
function ruleMarkup(cat,cost){if(!cat)return null;
  const n=v=>v===""||v==null?null:Number(v);
  for(const r of cat.rules||[])if(TEST[r.op]?.(cost,Number(r.value)))return{retail:n(r.markup),wholesale:n(r.wholesale)};
  const d={retail:n(cat.defaultMarkup),wholesale:n(cat.defaultWholesale)};
  return d.retail==null&&d.wholesale==null?null:d}

// ---- data
async function load(){
  const [p,b,c]=await Promise.all([getDocs(collection(db,"products")),getDocs(collection(db,"batches")),getDocs(collection(db,"categories"))]);
  P=p.docs.map(d=>({id:d.id,...d.data()})).filter(x=>!x.archived);
  const ids=new Set(P.map(x=>x.id));
  B=b.docs.map(d=>({id:d.id,...d.data()})).filter(x=>ids.has(x.productId));
  C=c.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  fillCats($("p_category").value);badges();
}
function badges(){
  const n=P.filter(p=>isOut(p)||isLow(p)).length,e=live(B).filter(b=>b.expiry&&daysTo(b)<=batchWindow(b)).length;
  const set=(id,v)=>{$(id).hidden=!v;$(id).textContent=v};set("bLow",n);set("bExp",e)}
function fillCats(keep,extra){
  const names=C.map(c=>c.name);if(extra&&!names.includes(extra))names.push(extra);
  $("p_category").innerHTML=`<option value="">${C.length?"Select category":"No categories yet, add one in Settings"}</option>`+names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if(keep&&names.includes(keep))$("p_category").value=keep}

// ---- nav
function show(v){
  if(v==="settings"&&!isAdmin()){toast("Only admins can open Settings.",true);v="dashboard"}
  if(v==="staff"&&!isSuper()){toast("Only the superadmin can open Staff accounts.",true);v="dashboard"}
  if(v==="transactions"&&!isSuper()){toast("Only the superadmin can open Transactions.",true);v="dashboard"}
  document.querySelectorAll("main>section").forEach(s=>s.classList.toggle("on",s.id===v));
  document.querySelectorAll("aside nav button").forEach(b=>b.classList.toggle("on",b.dataset.v===(v==="product"?"products":v)));
  $("title").textContent=titles[v];$("sub").textContent=subs[v];$("side").classList.remove("open");
  ({dashboard:dash,products:prodTable,product:prodDetail,movements:moves,transactions:txView,expiry:expiry,pricing:calc,settings:settingsView,staff:staffView})[v]?.()}
const go=async v=>{try{await load()}catch(e){toast("Could not refresh data.",true)}show(v)};
document.querySelectorAll("aside nav button").forEach(b=>b.onclick=()=>{pf="all";go(b.dataset.v)});
document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>go(b.dataset.go));
$("newProd").onclick=async()=>{await go("stockin");setMode("new");$("pReset").click();$("p_name").focus()};
$("menu").onclick=()=>$("side").classList.toggle("open");
$("scrim").onclick=()=>$("side").classList.remove("open");
function setMode(m){document.querySelectorAll("#inMode button").forEach(b=>{const on=b.dataset.m===m;b.classList.toggle("on",on);b.setAttribute("aria-pressed",on)});$("pForm").hidden=m!=="new";$("inForm").hidden=m!=="batch"}
document.querySelectorAll("#inMode button").forEach(b=>b.onclick=()=>setMode(b.dataset.m));

// ---- dashboard (all figures computed from stored records)
const DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const chart=s=>{const mx=Math.max(1,...s.flat());return `<div class="chart">${DAYS.map((d,i)=>`<div class="col"><div class="bars">${s.map((a,k)=>`<i class="c${k}" style="height:${Math.max(a[i]/mx*100,1.2)}%" title="${a[i]}"></i>`).join("")}</div><small>${d}</small></div>`).join("")}</div>`};
async function dash(){
  const low=P.filter(isLow),out=P.filter(isOut);
  const lb=live(B).filter(b=>b.expiry),exp=lb.filter(b=>daysTo(b)<0),soon=lb.filter(b=>daysTo(b)>=0&&daysTo(b)<=batchWindow(b));
  const cost=P.reduce((s,p)=>s+p.stock*p.cost,0),retail=P.reduce((s,p)=>s+p.stock*p.price,0),units=P.reduce((s,p)=>s+p.stock,0);
  const st=(l,v,sub,c="",tone="b",f="")=>`<div class="stat ${tone} ${c}"${f?` data-f="${f}" tabindex="0" role="button"`:""}><small>${l}</small><b>${v}</b><em>${sub||"&nbsp;"}</em></div>`;
  const cat={};P.forEach(p=>cat[p.category]=(cat[p.category]||0)+p.stock*p.cost);
  const cats=Object.entries(cat).sort((a,b)=>b[1]-a[1]),cmax=Math.max(1,...cats.map(c=>c[1]));
  const m=await getDocs(query(collection(db,"movements"),orderBy("at","desc"),limit(300)));
  const mv=m.docs.map(d=>d.data());
  const ws=new Date();ws.setHours(0,0,0,0);ws.setDate(ws.getDate()-ws.getDay());
  const inn=Array(7).fill(0),outq=Array(7).fill(0);
  mv.forEach(x=>{const t=x.at?.toDate();if(!t||t<ws)return;if(x.qty>0)inn[t.getDay()]+=x.qty;else outq[t.getDay()]-=x.qty});
  const pn=id=>esc(prodOf(id)?.name||"Archived product");
  const li=(a,f,e="Nothing to show.")=>a.length?a.map(f).join(""):`<p class="empty">${e}</p>`;
  $("dashboard").innerHTML=`<div class="stats">
    ${st("Total products",P.length,P.length+" active","","p","all")}${st("Units in stock",units.toLocaleString("en-NG"),"across all products","","p")}${st("Inventory cost value",naira(cost),"what the stock cost you")}${st("Potential retail value",naira(retail),"if all sold at current prices")}
    ${st("Estimated potential profit",naira(retail-cost),"retail minus cost","","p")}${st("Low stock",low.length,out.length+" out of stock",low.length||out.length?"warn":"","b","low")}
    ${st("Expiring soon",soon.length,"within each category's reminder",soon.length?"warn":"","b","expiry")}${st("Expired with stock",exp.length,"remove or write off",exp.length?"bad":"","b","expiry")}</div>
  <div class="cols">
  <div class="panel"><h4>Low-stock alerts</h4>${li(out.concat(low),p=>`<div class="li"><span>${esc(p.name)}<small>${p.stock} ${esc(p.unit)} left, minimum ${minOf(p)}</small></span><span class="tag ${isOut(p)?"t-bad":"t-warn"}">${isOut(p)?"Out":"Low"}</span></div>`,"Every product is above its minimum stock.")}</div>
  <div class="panel"><h4>Expiry alerts</h4>${li(exp.concat(soon),b=>`<div class="li"><span>${pn(b.productId)}<small>Batch ${esc(b.batchNo)}, ${b.qtyRemaining} left</small></span><span class="tag ${daysTo(b)<0?"t-bad":"t-warn"}">${daysTo(b)<0?"Expired":daysTo(b)+" days"}</span></div>`,"No batches are close to expiring.")}</div>
  <div class="panel"><h4>Stock received vs removed (this week)</h4>${chart([inn,outq])}<div class="legend"><span><i></i>Received</span><span><i class="c1"></i>Removed</span></div></div>
  <div class="panel"><h4>Recent movements</h4>${li(mv.slice(0,8),x=>`<div class="li"><span>${esc(x.reason)}<small>${pn(x.productId)}</small></span><b class="${x.qty>0?"pos":"neg"}">${x.qty>0?"+":""}${x.qty}</b></div>`,"No movements yet.")}</div>
  <div class="panel wide"><h4>Inventory value by category</h4>${cats.length?cats.map(([c,v])=>`<div class="pb"><div><span>${esc(c)}</span><span>${naira(v)}</span></div><div class="pbar"><i style="width:${v/cmax*100}%"></i></div></div>`).join(""):'<p class="empty">Nothing to show.</p>'}</div>
  </div>`;
  $("dashboard").querySelectorAll(".stat[data-f]").forEach(s=>{const f=s.dataset.f,fn=()=>{if(f==="expiry")go("expiry");else{pf=f;go("products")}};s.onclick=fn;s.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();fn()}}});
}

// ---- products
function prodTable(){
  const q=$("pSearch").value.toLowerCase();
  const cnt={all:P.length,low:P.filter(isLow).length,out:P.filter(isOut).length};
  document.querySelectorAll("#pChips button").forEach(b=>{b.classList.toggle("on",b.dataset.f===pf);b.setAttribute("aria-pressed",b.dataset.f===pf);b.querySelector("b").textContent=cnt[b.dataset.f]});
  const rows=P.filter(p=>[p.name,p.sku,p.barcode,p.category].join(" ").toLowerCase().includes(q))
    .filter(p=>pf==="low"?isLow(p):pf==="out"?isOut(p):true)
    .sort((a,b)=>{const x=a[sort.k]??"",y=b[sort.k]??"";return(typeof x==="string"?x.toLowerCase()>y.toLowerCase():x>y)?sort.d:-sort.d});
  const th=(k,l)=>`<th data-k="${k}" aria-sort="${sort.k===k?(sort.d>0?"ascending":"descending"):"none"}">${l}${sort.k===k?(sort.d>0?" ▲":" ▼"):""}</th>`;
  $("pTable").innerHTML=rows.length?`<table><tr>${th("name","Name")}${th("sku","SKU")}${th("category","Category")}<th>Packs</th>${th("cost","Cost")}${th("price","Price")}${th("stock","Stock")}<th>Min</th><th></th></tr>`+
    rows.map(p=>`<tr><td><button type="button" class="plink" data-o="${p.id}">${esc(p.name)}</button></td><td>${esc(p.sku)}</td><td>${esc(p.category)}</td>
    <td>${packsOf(p).slice(1).map(x=>`${esc(x.name)} ×${x.qty}`).join(", ")||"—"}</td>
    <td>${naira(p.cost)}</td><td>${naira(p.price)}${cpy(p.price)}</td>
    <td>${p.stock} ${esc(p.unit)} ${isOut(p)?'<span class="tag t-bad">Out</span>':isLow(p)?'<span class="tag t-warn">Low</span>':""}</td>
    <td>${minOf(p)}</td>
    <td>${isAdmin()?`<button class="btn sm ghost" data-e="${p.id}">Edit</button> <button class="btn sm ghost" data-a="${p.id}">Archive</button>`:""}</td></tr>`).join("")+"</table>":`<p class="empty">${P.length?"No products match your search or filter.":"No products yet. Add your first one from Receive stock."}</p>`;
  $("pTable").querySelectorAll("th[data-k]").forEach(h=>h.onclick=()=>{sort={k:h.dataset.k,d:sort.k===h.dataset.k?-sort.d:1};prodTable()});
  $("pTable").querySelectorAll("[data-o]").forEach(b=>b.onclick=()=>openProduct(b.dataset.o));
  $("pTable").querySelectorAll("[data-e]").forEach(b=>b.onclick=()=>edit(b.dataset.e));
  $("pTable").querySelectorAll("[data-a]").forEach(b=>b.onclick=()=>guard(b,async()=>{
    if(!confirm("Archive this product? Its history is kept."))return;
    await runTransaction(db,async t=>t.update(doc(db,"products",b.dataset.a),{archived:true,updatedAt:serverTimestamp()}));
    await load();prodTable();toast("Product archived")}));
}
// ---- product detail page
const openProduct=async id=>{cur=id;await go("product")};
const fmtDate=t=>t?t.toDate().toLocaleDateString("en-NG"):"—";
const fmtTime=t=>t?t.toDate().toLocaleString("en-NG"):"";
function preselect(p,pre){ // fills a Stock in / Stock out product picker
  $(pre+"_p").value=p.id;$(pre+"_s").value=`${p.name} (${p.sku})`;$(pre+"_i").textContent=`In stock: ${p.stock} ${p.unit}`;packSel(pre+"_u",p)}

async function prodDetail(){
  const p=prodOf(cur);
  if(!p){$("product").innerHTML='<p class="empty">Product not found. It may have been archived.</p>';return}
  $("title").textContent=p.name;
  const win=windowDays(p),bs=B.filter(b=>b.productId===p.id).sort((a,b)=>(b.receivedAt?.seconds??0)-(a.receivedAt?.seconds??0));
  const lv=bs.filter(b=>b.qtyRemaining>0&&b.expiry);
  const expQty=lv.filter(b=>daysTo(b)<0).reduce((s,b)=>s+b.qtyRemaining,0);
  const soonQty=lv.filter(b=>daysTo(b)>=0&&daysTo(b)<=win).reduce((s,b)=>s+b.qtyRemaining,0);
  const next=lv.filter(b=>daysTo(b)>=0).sort((a,b)=>a.expiry.seconds-b.expiry.seconds)[0];
  const margin=p.price>0?((p.price-p.cost)/p.price*100):null;
  const st=(l,v,sub,t="b",c="")=>`<div class="stat ${t} ${c}"><small>${l}</small><b>${v}</b><em>${sub||"&nbsp;"}</em></div>`;
  const status=isOut(p)?'<span class="tag t-bad">Out of stock</span>':isLow(p)?'<span class="tag t-warn">Low stock</span>':'<span class="tag t-ok">In stock</span>';
  const packs=packsOf(p).slice(1);
  const bst=b=>{if(!(b.qtyRemaining>0))return'<span class="tag t-ok">Used up</span>';if(!b.expiry)return"No expiry";
    const d=daysTo(b);return`<span class="tag ${d<0?"t-bad":d<=win?"t-warn":"t-ok"}">${d<0?"Expired":d<=win?d+" days left":"OK"}</span>`};
  const bn={};B.forEach(b=>bn[b.id]=b.batchNo);

  $("product").innerHTML=`
  <div class="pd-top"><button class="btn ghost" id="pd_back">← Back to products</button><span class="sp"></span>
    <button class="btn ghost" id="pd_in">+ Receive stock</button><button class="btn ghost" id="pd_out">Stock out</button>
    ${isAdmin()?'<button class="btn" id="pd_edit">Edit product</button>':""}</div>
  <div class="stats">
    ${st("In stock",`${p.stock} ${esc(p.unit)}`,status,"p")}
    ${st("Cost price",naira(p.cost),"per "+esc(p.unit))}
    ${st("Retail price",p.price>0?naira(p.price)+cpy(p.price):"Not set","per "+esc(p.unit),"p")}
    ${st("Wholesale price",p.wholesalePrice>0?naira(p.wholesalePrice)+cpy(p.wholesalePrice):"Not set","per "+esc(p.unit),"p")}
    ${st("Gross margin",margin==null?"—":margin.toFixed(1)+"%","profit ÷ price")}
    ${st("Stock cost value",naira(p.stock*p.cost),"what this stock cost")}
    ${st("Stock retail value",naira(p.stock*p.price),"at current price","p")}
    ${st("Next expiry",next?fmtDate(next.expiry):"—",next?daysTo(next)+" days away":"No dated batches","b",next&&daysTo(next)<=win?"warn":"")}
    ${st("Expired / expiring soon",`${expQty} / ${soonQty}`,esc(p.unit)+" in those batches","b",expQty?"bad":soonQty?"warn":"")}
  </div>
  <div class="card"><dl class="pd-info">
    <div><dt>SKU</dt><dd>${esc(p.sku)||"—"}</dd></div>
    <div><dt>Barcode</dt><dd>${esc(p.barcode)||"—"}</dd></div>
    <div><dt>Category</dt><dd>${esc(p.category)||"—"}</dd></div>
    <div><dt>Supplier</dt><dd>${esc(p.supplier)||"—"}</dd></div>
    <div><dt>Base unit</dt><dd>${esc(p.unit)}</dd></div>
    <div><dt>Minimum stock</dt><dd>${minOf(p)} ${esc(p.unit)}</dd></div>
    <div><dt>Expiry reminder</dt><dd>${win/30} month(s) before</dd></div>
    <div><dt>Added</dt><dd>${fmtDate(p.createdAt)}</dd></div>
    <div><dt>Last updated</dt><dd>${fmtDate(p.updatedAt)}</dd></div>
  </dl></div>
  ${packs.length?`<div class="card tbl"><h4>PACKS AND PACK PRICES</h4><table><tr><th>Pack</th><th>Contains</th><th>Cost</th><th>Retail price</th><th>Wholesale price</th></tr>${packs.map(x=>`<tr><td>${esc(x.name)}</td><td>${x.qty} ${esc(p.unit)}</td><td>${naira(p.cost*x.qty)}</td><td>${x.price!=null?naira(x.price)+cpy(x.price):"Not set"}</td><td>${x.wholesale!=null?naira(x.wholesale)+cpy(x.wholesale):"Not set"}</td></tr>`).join("")}</table></div>`:""}
  <div class="card tbl"><h4>BATCHES</h4>${bs.length?`<table><tr><th>Batch</th><th>Received</th><th>Qty received</th><th>Remaining</th><th>Unit cost</th><th>Expiry</th><th>Status</th><th>Reference</th><th>By</th></tr>${bs.map(b=>`<tr><td>${esc(b.batchNo)}</td><td>${fmtDate(b.receivedAt)}</td><td>${b.qtyReceived}</td><td>${b.qtyRemaining}</td><td>${naira(b.unitCost)}</td><td>${fmtDate(b.expiry)}</td><td>${bst(b)}</td><td>${esc(b.ref||"—")}</td><td>${esc(b.by||"")}</td></tr>`).join("")}</table>`:'<p class="empty">No batches yet.</p>'}</div>
  <div class="card tbl" id="pd_moves"><h4>MOVEMENT HISTORY</h4><p class="empty">Loading…</p></div>
  ${isAdmin()?'<div class="card tbl" id="pd_prices"><h4>PRICE HISTORY</h4><p class="empty">Loading…</p></div>':""}`;

  $("pd_back").onclick=()=>go("products");
  $("pd_in").onclick=async()=>{await go("stockin");setMode("batch");preselect(p,"in");$("in_q").focus()};
  $("pd_out").onclick=async()=>{await go("stockout");preselect(p,"out");$("out_q").focus()};
  $("pd_edit")?.addEventListener("click",()=>edit(p.id));

  // history (equality filter only, so no composite index is needed; sorted here)
  try{
    const m=await getDocs(query(collection(db,"movements"),where("productId","==",p.id)));
    if(cur!==p.id)return;
    const rows=m.docs.map(d=>d.data()).sort((a,b)=>(b.at?.seconds??0)-(a.at?.seconds??0));
    $("pd_moves").innerHTML=`<h4>MOVEMENT HISTORY</h4>`+(rows.length?`<table><tr><th>When</th><th>Reason</th><th>Qty</th><th>Batch</th><th>Note</th><th>By</th></tr>${rows.map(x=>`<tr><td>${fmtTime(x.at)}</td><td>${esc(x.reason)}</td><td class="${x.qty>0?"pos":"neg"}">${x.qty>0?"+":""}${x.qty}</td><td>${esc(bn[x.batchId]||"—")}</td><td>${esc(x.note||"")}</td><td>${esc(x.by)}</td></tr>`).join("")}</table>`:'<p class="empty">No movements yet.</p>');
  }catch(e){console.error(e);$("pd_moves").innerHTML='<h4>MOVEMENT HISTORY</h4><p class="empty">Could not load history.</p>'}
  if(isAdmin())try{
    const c=await getDocs(query(collection(db,"priceChanges"),where("productId","==",p.id)));
    if(cur!==p.id)return;
    const rows=c.docs.map(d=>d.data()).sort((a,b)=>(b.at?.seconds??0)-(a.at?.seconds??0));
    $("pd_prices").innerHTML=`<h4>PRICE HISTORY</h4>`+(rows.length?`<table><tr><th>When</th><th>Old price</th><th>New price</th><th>By</th></tr>${rows.map(x=>`<tr><td>${fmtTime(x.at)}</td><td>${naira(x.oldPrice)}</td><td>${naira(x.newPrice)}</td><td>${esc(x.by)}</td></tr>`).join("")}</table>`:'<p class="empty">No price changes recorded.</p>');
  }catch(e){console.error(e);$("pd_prices").innerHTML='<h4>PRICE HISTORY</h4><p class="empty">Could not load price history.</p>'}
}

$("pSearch").oninput=prodTable;
document.querySelectorAll("#pChips button").forEach(b=>b.onclick=()=>{pf=b.dataset.f;prodTable()});
const F={name:"p_name",sku:"p_sku",barcode:"p_barcode",category:"p_category",supplier:"p_supplier",unit:"p_unit"};
// auto-generated SKU, e.g. DR-K7M2QX (unique among current products)
const genSku=()=>{const A="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let s;
  do{s="DR-"+Array.from({length:6},()=>A[Math.floor(Math.random()*A.length)]).join("")}while(P.some(p=>p.sku===s));return s};
$("p_gen").onclick=()=>{$("p_sku").value=genSku()};

// pack rows on the product form
function addPackRow(name="",qty=""){const d=document.createElement("div");d.className="packrow";
  d.innerHTML=`<input class="pk_n" placeholder="Pack name, e.g. Carton" value="${esc(name)}"><input class="pk_q" type="number" min="0" step="any" placeholder="Base units inside" value="${esc(qty)}"><button type="button" class="btn ghost sm pk_x">Remove</button>`;
  $("packRows").append(d)}
function readPacks(strict=true){
  return [...document.querySelectorAll("#packRows .packrow")].map(r=>{
    const n=r.querySelector(".pk_n").value.trim(),raw=r.querySelector(".pk_q").value,q=parseFloat(raw);
    if(!n&&!raw)return null;
    if(!n||!(q>0)){if(strict)throw new Error("Each pack needs a name and a quantity above zero.");return null}
    return{name:n,qty:q}}).filter(Boolean)}
function refreshNs(){const keep=$("ns_u").value;
  const ps=[{name:$("p_unit").value.trim()||"Base unit",qty:1},...readPacks(false)];
  $("ns_u").innerHTML=ps.map((x,i)=>`<option value="${i}">${esc(x.name)}${x.qty>1?` (${x.qty})`:""}</option>`).join("");
  if(keep&&ps[+keep])$("ns_u").value=keep}
$("addPack").onclick=()=>{addPackRow();refreshNs()};
$("packRows").addEventListener("input",refreshNs);
$("packRows").addEventListener("click",e=>{if(e.target.closest(".pk_x")){e.target.closest(".packrow").remove();refreshNs()}});
$("p_unit").addEventListener("input",refreshNs);

// new mode shows opening-stock fields; edit mode shows cost price instead
function setEdit(on){$("initStock").hidden=on;$("p_cost_l").hidden=!on;$("pSave").textContent=on?"Save changes":"Save product & stock in"}
async function edit(id){await go("stockin");setMode("new");const p=P.find(x=>x.id===id);if(!p)return;
  $("pForm").reset();$("packRows").innerHTML="";setEdit(true);$("p_id").value=id;
  fillCats(p.category,p.category);
  for(const k in F)$(F[k]).value=p[k]??"";
  $("p_cost").value=p.cost??"";
  packsOf(p).slice(1).forEach(x=>addPackRow(x.name,x.qty));refreshNs();scrollTo(0,0)}
$("pReset").onclick=()=>{$("pForm").reset();$("packRows").innerHTML="";$("p_id").value="";setEdit(false);fillCats("");refreshNs()};
setEdit(false);refreshNs();

$("pForm").onsubmit=e=>{e.preventDefault();guard($("pSave"),async()=>{
  const id=$("p_id").value,d={};
  for(const k in F)d[k]=$(F[k]).value.trim();
  if(!d.category)throw new Error("Choose a category. Admins can add categories in Settings.");
  if(!d.sku)d.sku=genSku();
  if(P.some(p=>p.sku===d.sku&&p.id!==id))throw new Error("That SKU already exists.");
  if(d.barcode&&P.some(p=>p.barcode===d.barcode&&p.id!==id))throw new Error("That barcode already exists.");
  const packs=readPacks(true);
  const old=id?prodOf(id):null;
  // keep any saved pack prices when the pack name and size are unchanged
  d.packs=packs.map(x=>{const o=old&&packsOf(old).find(y=>y.name===x.name&&y.qty===x.qty&&y.price!=null);return o?{...x,price:o.price,...(o.wholesale!=null?{wholesale:o.wholesale}:{})}:x});
  if(id){d.cost=parseFloat($("p_cost").value)||0;
    await runTransaction(db,async t=>t.update(doc(db,"products",id),{...d,updatedAt:serverTimestamp()}));
    $("pReset").click();await go("products");toast("Product saved");return}
  // new product: optional opening stock, saved in one atomic transaction
  const q=num("ns_q");
  if(q<0)throw new Error("Quantity cannot be negative.");
  if(q>0){if(!$("ns_b").value.trim())throw new Error("Enter a batch number for the opening stock.");
    if($("ns_c").value==="")throw new Error("Enter the unit cost for the opening stock.")}
  const pk=[{name:d.unit,qty:1},...d.packs][+$("ns_u").value||0]||{qty:1};
  const units=r6(q*pk.qty);
  const unitCost=units>0?(num("ns_c")*q+num("ns_x"))/units:0;
  d.cost=Math.round(unitCost*100)/100;
  const pref=doc(collection(db,"products"));
  await runTransaction(db,async t=>{
    t.set(pref,{...d,price:0,minStock:5,stock:units,archived:false,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    if(units>0){const bref=doc(collection(db,"batches"));
      t.set(bref,{productId:pref.id,batchNo:$("ns_b").value.trim(),qtyReceived:units,qtyRemaining:units,unitCost,
        expiry:$("ns_e").value?Timestamp.fromDate(new Date($("ns_e").value)):null,ref:$("ns_ref").value,receivedAt:serverTimestamp(),by:user.email});
      t.set(doc(collection(db,"movements")),{productId:pref.id,batchId:bref.id,qty:units,reason:"Stock in",note:$("ns_n").value,ref:$("ns_ref").value,by:user.email,at:serverTimestamp()})}
  });
  $("pReset").click();await load();$("p_name").focus();
  toast(units>0?"Product saved and stocked in":"Product saved")})};

// ---- product search picker (Stock in, Stock out, Pricing)
function picker(sid,hid,rid,iid,onPick,onClear){
  const s=$(sid),h=$(hid),r=$(rid),i=$(iid);
  const hit=q=>{q=q.trim().toLowerCase();return(q?P.filter(p=>[p.name,p.sku,p.barcode,p.category].join(" ").toLowerCase().includes(q)):P).slice(0,8)};
  const choose=p=>{h.value=p.id;s.value=`${p.name} (${p.sku})`;r.hidden=true;
    i.textContent=`In stock: ${p.stock} ${p.unit}`;onPick?.(p)};
  const clear=()=>{h.value="";i.textContent="";r.hidden=true;onClear?.()};
  const draw=()=>{const m=hit(s.value);
    r.innerHTML=m.length?m.map(p=>`<button type="button" data-id="${p.id}"><b>${esc(p.name)}</b><small>${esc(p.sku)}${p.barcode?" · "+esc(p.barcode):""} · ${p.stock} ${esc(p.unit)}</small></button>`).join(""):'<p class="empty">No matching product.</p>';
    r.hidden=false};
  s.oninput=()=>{const had=h.value;h.value="";i.textContent="";if(had)onClear?.();draw()};
  s.onfocus=()=>{if(!h.value)draw()};
  s.onblur=()=>setTimeout(()=>{r.hidden=true},120);
  // Enter (e.g. from a barcode scanner) picks an exact SKU/barcode match, or the only result
  s.onkeydown=ev=>{if(ev.key!=="Enter")return;ev.preventDefault();const q=s.value.trim().toLowerCase();if(!q)return;
    const ex=P.find(p=>[p.sku,p.barcode].some(v=>v&&String(v).toLowerCase()===q)),m=hit(q);
    const p=ex||(m.length===1?m[0]:null);if(p)choose(p)};
  r.onmousedown=ev=>{const b=ev.target.closest("button");if(!b)return;ev.preventDefault();choose(P.find(p=>p.id===b.dataset.id))};
  s.form.addEventListener("reset",()=>setTimeout(clear));
}
packSel("in_u",null);packSel("out_u",null);
picker("in_s","in_p","in_res","in_i",p=>packSel("in_u",p),()=>packSel("in_u",null));
picker("out_s","out_p","out_res","out_i",p=>packSel("out_u",p),()=>packSel("out_u",null));

const outHint=()=>{const p=prodOf($("out_p").value);if(!p)return;const pk=packsOf(p)[+$("out_u").value],q=num("out_q"),n=pk?r6(q*pk.qty):0;
  $("out_i").textContent=`In stock: ${p.stock} ${p.unit}`+(q>0&&pk?.qty>1?`. Removing ${n} ${p.unit}`:"")+(n>p.stock?". That is more than you have.":"")};
$("out_u").addEventListener("change",outHint);$("out_q").addEventListener("input",outHint);

// ---- stock in (one atomic transaction: product + batch + movement)
$("inForm").onsubmit=e=>{e.preventDefault();guard($("inForm").querySelector(".btn"),async()=>{
  const pid=$("in_p").value;if(!pid)throw new Error("Choose a product.");if(num("in_q")<=0)throw new Error("Quantity must be greater than zero.");
  await runTransaction(db,async t=>{
    const pref=doc(db,"products",pid),snap=await t.get(pref),p=snap.data();
    const pk=packsOf(p)[+$("in_u").value];if(!pk)throw new Error("Choose a purchase unit.");
    const units=r6(num("in_q")*pk.qty);
    const unitCost=(num("in_c")*num("in_q")+num("in_x"))/units; // landed cost per base unit
    const newStock=r6(p.stock+units);
    const avg=newStock>0?((p.stock*p.cost)+(units*unitCost))/newStock:unitCost; // weighted average cost
    const bref=doc(collection(db,"batches"));
    t.update(pref,{stock:newStock,cost:Math.round(avg*100)/100,updatedAt:serverTimestamp()});
    t.set(bref,{productId:pid,batchNo:$("in_b").value.trim(),qtyReceived:units,qtyRemaining:units,unitCost,
      expiry:$("in_e").value?Timestamp.fromDate(new Date($("in_e").value)):null,ref:$("in_ref").value,receivedAt:serverTimestamp(),by:user.email});
    t.set(doc(collection(db,"movements")),{productId:pid,batchId:bref.id,qty:units,reason:"Stock in",note:$("in_n").value,ref:$("in_ref").value,by:user.email,at:serverTimestamp()});
  });
  $("inForm").reset();await load();toast("Stock received")})};

// ---- stock out: the chosen pack is the unit; deduct from earliest-expiry batches first
$("outForm").onsubmit=e=>{e.preventDefault();guard($("outForm").querySelector(".btn"),async()=>{
  const pid=$("out_p").value,q=num("out_q"),reason=$("out_reason").value,note=$("out_n").value.trim();
  if(!pid)throw new Error("Choose a product.");
  if(q<=0)throw new Error("Quantity must be greater than zero.");
  if(reason!=="Sale"&&!note)throw new Error("Add a note explaining this adjustment.");
  const bs=B.filter(b=>b.productId===pid&&b.qtyRemaining>0).sort((a,b)=>(a.expiry?.seconds??9e12)-(b.expiry?.seconds??9e12));
  await runTransaction(db,async t=>{
    const pref=doc(db,"products",pid),p=(await t.get(pref)).data();
    const pk=packsOf(p)[+$("out_u").value];if(!pk)throw new Error("Choose the unit to stock out.");
    const qty=r6(q*pk.qty);
    if(qty>p.stock)throw new Error(`Only ${p.stock} ${p.unit} in stock (you asked for ${qty} ${p.unit}).`);
    let need=qty;const upd=[];
    for(const b of bs){if(need<=0)break;const r=doc(db,"batches",b.id),cur=(await t.get(r)).data(),take=Math.min(need,cur.qtyRemaining);
      if(take>0){upd.push([r,r6(cur.qtyRemaining-take),take,b.id]);need=r6(need-take)}}
    t.update(pref,{stock:r6(p.stock-qty),updatedAt:serverTimestamp()});
    const nt=note+(pk.qty>1?`${note?" · ":""}${q} ${pk.name} (${qty} ${p.unit})`:"");
    upd.forEach(([r,left,take,bid])=>{t.update(r,{qtyRemaining:left});
      t.set(doc(collection(db,"movements")),{productId:pid,batchId:bid,qty:-take,reason,note:nt,by:user.email,at:serverTimestamp()})});
    if(need>0)t.set(doc(collection(db,"movements")),{productId:pid,batchId:null,qty:-need,reason,note:nt,by:user.email,at:serverTimestamp()});
  });
  $("outForm").reset();await load();toast("Stock out recorded")})};

async function moves(){
  const m=await getDocs(query(collection(db,"movements"),orderBy("at","desc"),limit(50)));
  $("mTable").innerHTML=m.empty?'<p class="empty">No movements yet.</p>':"<table><tr><th>Product</th><th>Qty</th><th>Reason</th><th>Note</th><th>By</th><th>When</th></tr>"+m.docs.map(d=>{const x=d.data();
    return `<tr><td>${esc(prodOf(x.productId)?.name||"Archived")}</td><td class="${x.qty>0?"pos":"neg"}">${x.qty>0?"+":""}${x.qty}</td><td>${esc(x.reason)}</td><td>${esc(x.note||"")}</td><td>${esc(x.by)}</td><td>${x.at?x.at.toDate().toLocaleString("en-NG"):""}</td></tr>`}).join("")+"</table>"}

// ---- expiry (reminder window comes from each product's category)
function expiry(){
  const rows=live(B).filter(b=>b.expiry).sort((a,b)=>a.expiry.seconds-b.expiry.seconds);
  $("expiry").innerHTML=`<div class="card tbl">${rows.length?"<table><tr><th>Product</th><th>Category</th><th>Batch</th><th>Remaining</th><th>Expiry</th><th>Reminder</th><th>Status</th></tr>"+rows.map(b=>{const d=daysTo(b),w=batchWindow(b),p=prodOf(b.productId);
    return `<tr><td>${esc(p?.name||"Archived")}</td><td>${esc(p?.category||"")}</td><td>${esc(b.batchNo)}</td><td>${b.qtyRemaining}</td><td>${b.expiry.toDate().toLocaleDateString("en-NG")}</td><td>${w/30} mo</td>
    <td><span class="tag ${d<0?"t-bad":d<=w?"t-warn":"t-ok"}">${d<0?"Expired":d<=w?d+" days left":"OK"}</span></td></tr>`}).join("")+"</table>":'<p class="empty">No batches with expiry dates yet.</p>'}</div>`}

// ---- pricing calculator (category rules, product search, pack prices)
picker("pr_s","pr_p","pr_res","pr_i",p=>{$("pr_c").value=p.cost;calc()},()=>calc());
function calc(){
  const p=prodOf($("pr_p").value),m=$("pr_m").value,step=num("pr_r")||1;
  const baseCost=num("pr_c"),cost=baseCost+num("pr_x"),v=num("pr_v"),minM=num("pr_min");
  $("pr_vl").hidden=m==="rule";$("pr_v").required=m!=="rule";
  $("pr_vl").firstChild.textContent=m==="fixed"?"Fixed profit (₦)":m==="markup"?"Markup (%)":"Target gross margin (%)";
  let sp0=0,sw0=null,err="",note="";
  if(m==="rule"){
    if(!p)err="Search and choose a product to use its category rule.";
    else{const mk=ruleMarkup(catOf(p),baseCost);
      if(!mk||mk.retail==null)err=`No retail markup rule matches for the category "${p.category}". Add or fix it in Settings.`;
      else{sp0=cost*(1+mk.retail/100);
        if(mk.wholesale!=null)sw0=cost*(1+mk.wholesale/100);
        note=`Category rule: ${mk.retail}% retail`+(mk.wholesale!=null?`, ${mk.wholesale}% wholesale`:"")+` (${p.category})`}}}
  else if(m==="markup")sp0=cost*(1+v/100);
  else if(m==="fixed")sp0=cost+v;
  else if(v>=100)err="Margin must be below 100%.";else sp0=cost/(1-v/100);
  const roundUp=x=>Math.ceil(x/step-1e-9)*step;
  const sp=roundUp(sp0),profit=sp-cost,margin=sp?profit/sp*100:0,markup=cost?profit/cost*100:0;
  const sw=sw0==null?null:roundUp(sw0);
  const warn=!err&&(sp<cost?"Selling price is below cost.":sw!=null&&sw<cost?"Wholesale price is below cost.":margin<minM?`Margin is below your ${minM}% minimum.`:"");
  const s=(b,l,t="b")=>`<div class="stat ${t}"><small>${l}</small><b>${b}</b></div>`;
  const packRows=p?packsOf(p).map(pk=>{const price=roundUp(sp0*pk.qty),pc=cost*pk.qty;
    return {name:pk.name,qty:pk.qty,pc,price,wprice:sw0==null?null:roundUp(sw0*pk.qty),pr:price-pc}}):[];
  $("prOut").innerHTML=err?`<p class="err">${esc(err)}</p>`:`${note?`<p class="hint">${esc(note)}</p>`:""}<div class="stats">${s(naira(sp)+cpy(sp),`Retail price per ${esc(p?.unit||"unit")}`,"p")}${sw!=null?s(naira(sw)+cpy(sw),`Wholesale price per ${esc(p?.unit||"unit")}`,"p"):""}${s(naira(profit),"Retail profit per unit")}${sw!=null?s(naira(sw-cost),"Wholesale profit per unit"):""}
  ${s(margin.toFixed(1)+"%","Gross margin (profit ÷ price)","p")}${s(markup.toFixed(1)+"%","Markup (profit ÷ cost)")}
  ${p?s(naira(profit*p.stock),`Profit at current stock (${p.stock} ${esc(p.unit)})`):""}</div>
  ${packRows.length>1?`<div class="tbl"><table><tr><th>Pack</th><th>Contains</th><th>Cost</th><th>Retail price</th>${sw!=null?"<th>Wholesale price</th>":""}<th>Retail profit</th></tr>${packRows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.qty} ${esc(p.unit)}</td><td>${naira(r.pc)}</td><td><b>${naira(r.price)}</b>${cpy(r.price)}</td>${sw!=null?`<td><b>${naira(r.wprice)}</b>${cpy(r.wprice)}</td>`:""}<td>${naira(r.pr)}</td></tr>`).join("")}</table></div>`:""}
  ${warn?`<p class="err">${esc(warn)}</p>`:""}${p&&isAdmin()?`<button class="btn" id="apply" type="button">Apply prices to ${esc(p.name)}</button>`:""}`;
  $("apply")?.addEventListener("click",ev=>guard(ev.target,async()=>{
    if(sp<=0)throw new Error("Selling price must be greater than zero.");
    if(warn&&!confirm(warn+" Apply anyway?"))return;
    const packs=packRows.slice(1).map(r=>({name:r.name,qty:r.qty,price:r.price,...(r.wprice!=null?{wholesale:r.wprice}:{})}));
    await runTransaction(db,async t=>{t.update(doc(db,"products",p.id),{price:sp,...(sw!=null?{wholesalePrice:sw}:{}),packs,updatedAt:serverTimestamp()});
      t.set(doc(collection(db,"priceChanges")),{productId:p.id,oldPrice:p.price,newPrice:sp,...(sw!=null?{oldWholesale:p.wholesalePrice??null,newWholesale:sw}:{}),by:user.email,at:serverTimestamp()})});
    await load();calc();toast("Selling prices updated")}));
}
$("prForm").addEventListener("input",calc);

// ---- settings: categories, markup rules, expiry reminders (admins only)
const OPS=["<","<=",">",">=","=","<>"];
function ruleRow(r={op:"<",value:"",markup:"",wholesale:""}){const d=document.createElement("div");d.className="rulerow";
  d.innerHTML=`<span>If cost</span><select class="r_op">${OPS.map(o=>`<option value="${esc(o)}"${o===r.op?" selected":""}>${esc(o)}</option>`).join("")}</select><input class="r_v" type="number" min="0" step="0.01" placeholder="Cost (₦)" value="${esc(r.value)}"><span>retail</span><input class="r_m" type="number" min="0" step="0.01" placeholder="Retail %" value="${esc(r.markup)}"><span>% wholesale</span><input class="r_w" type="number" min="0" step="0.01" placeholder="Wholesale %" value="${esc(r.wholesale??"")}"><span>%</span><button type="button" class="btn ghost sm r_x">Remove</button>`;
  $("csRules").append(d)}
$("addRule").onclick=()=>ruleRow();
$("csRules").addEventListener("click",e=>{if(e.target.closest(".r_x"))e.target.closest(".rulerow").remove()});
const ruleText=c=>{const e=v=>v===""||v==null;
  return [...(c.rules||[]).map(r=>`cost ${r.op} ${Number(r.value).toLocaleString("en-NG")} → retail ${r.markup}%${e(r.wholesale)?"":`, wholesale ${r.wholesale}%`}`),
  e(c.defaultMarkup)&&e(c.defaultWholesale)?"":`otherwise retail ${e(c.defaultMarkup)?"none":c.defaultMarkup+"%"}, wholesale ${e(c.defaultWholesale)?"none":c.defaultWholesale+"%"}`].filter(Boolean).join("; ")||"No rules"};
function settingsView(){
  $("csList").innerHTML=C.length?"<table><tr><th>Category</th><th>Markup rules</th><th>Minimum stock</th><th>Expiry reminder</th><th>Products</th><th></th></tr>"+C.map(c=>`<tr><td>${esc(c.name)}</td><td style="white-space:normal">${esc(ruleText(c))}</td><td>${c.minStock===""||c.minStock==null?"Not set":c.minStock}</td><td>${c.expiryMonths} mo before</td><td>${P.filter(p=>p.category===c.name).length}</td>
    <td><button class="btn sm ghost" data-ce="${c.id}">Edit</button> <button class="btn sm ghost" data-cd="${c.id}">Delete</button></td></tr>`).join("")+"</table>":'<p class="empty">No categories yet. Add your first one above.</p>';
  $("csList").querySelectorAll("[data-ce]").forEach(b=>b.onclick=()=>{const c=C.find(x=>x.id===b.dataset.ce);
    $("csForm").reset();$("csRules").innerHTML="";$("cs_id").value=c.id;$("cs_name").value=c.name;$("cs_def").value=c.defaultMarkup??"";$("cs_dw").value=c.defaultWholesale??"";$("cs_exp").value=c.expiryMonths??1;$("cs_min").value=c.minStock??"";
    (c.rules||[]).forEach(r=>ruleRow(r));scrollTo(0,0)});
  $("csList").querySelectorAll("[data-cd]").forEach(b=>b.onclick=()=>guard(b,async()=>{
    const c=C.find(x=>x.id===b.dataset.cd);
    if(P.some(p=>p.category===c.name))throw new Error("Products still use this category. Move them first.");
    if(!confirm(`Delete category "${c.name}"?`))return;
    await runTransaction(db,async t=>t.delete(doc(db,"categories",c.id)));
    await load();settingsView();toast("Category deleted")}));
}
$("csReset").onclick=()=>{$("csForm").reset();$("csRules").innerHTML="";$("cs_id").value=""};
$("csForm").onsubmit=e=>{e.preventDefault();guard($("csSave"),async()=>{
  const id=$("cs_id").value,name=$("cs_name").value.trim();
  if(!name)throw new Error("Enter a category name.");
  if(C.some(c=>c.name.toLowerCase()===name.toLowerCase()&&c.id!==id))throw new Error("That category already exists.");
  const rules=[...document.querySelectorAll("#csRules .rulerow")].map(r=>{
    const op=r.querySelector(".r_op").value,v=r.querySelector(".r_v").value,mk=r.querySelector(".r_m").value,wh=r.querySelector(".r_w").value;
    if(v===""||mk==="")throw new Error("Fill in the cost and retail markup for every rule, or remove the empty rule.");
    return{op,value:parseFloat(v),markup:parseFloat(mk),wholesale:wh===""?"":parseFloat(wh)}});
  const defRaw=$("cs_def").value,dwRaw=$("cs_dw").value,expiryMonths=parseFloat($("cs_exp").value);
  if(!(expiryMonths>0))throw new Error("Expiry reminder must be above zero months.");
  const minRaw=$("cs_min").value;if(minRaw!==""&&!(parseFloat(minRaw)>=0))throw new Error("Minimum stock cannot be negative.");
  const data={name,minStock:minRaw===""?"":parseFloat(minRaw),rules,defaultMarkup:defRaw===""?"":parseFloat(defRaw),defaultWholesale:dwRaw===""?"":parseFloat(dwRaw),expiryMonths,updatedAt:serverTimestamp()};
  const old=id?C.find(c=>c.id===id):null,renamed=old&&old.name!==name?P.filter(p=>p.category===old.name):[];
  await runTransaction(db,async t=>{
    t.set(id?doc(db,"categories",id):doc(collection(db,"categories")),data);
    renamed.forEach(p=>t.update(doc(db,"products",p.id),{category:name,updatedAt:serverTimestamp()}))});
  $("csReset").click();await load();settingsView();toast("Category saved")})};

// ---- transactions (superadmin only): look up any day, week or month, then export CSV
const pad2=n=>String(n).padStart(2,"0");
const ymd=d=>`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const fromYmd=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const TX_TYPES=["Stock in","Sale","Damaged","Expired","Missing","Theft or loss","Internal consumption","Supplier return","Stock transfer","Authorized correction"];
$("tx_r").innerHTML+=TX_TYPES.map(t=>`<option>${esc(t)}</option>`).join("");
let TX=[],txReq=0,txSpan=null;
function txRange(){
  const p=$("tx_p").value;let a,b;
  if(p==="range"){if(!$("tx_f").value||!$("tx_t").value)return null;
    a=fromYmd($("tx_f").value);b=fromYmd($("tx_t").value);if(b<a)[a,b]=[b,a];
    b=new Date(b.getFullYear(),b.getMonth(),b.getDate()+1)}
  else{if(!$("tx_d").value)return null;const d=fromYmd($("tx_d").value);
    if(p==="day"){a=d;b=new Date(d.getFullYear(),d.getMonth(),d.getDate()+1)}
    else if(p==="week"){a=new Date(d.getFullYear(),d.getMonth(),d.getDate()-((d.getDay()+6)%7));b=new Date(a.getFullYear(),a.getMonth(),a.getDate()+7)}
    else{a=new Date(d.getFullYear(),d.getMonth(),1);b=new Date(d.getFullYear(),d.getMonth()+1,1)}}
  return[a,b]}
function txToggle(){const p=$("tx_p").value;$("tx_dl").hidden=p==="range";$("tx_fl").hidden=$("tx_tl").hidden=p!=="range";
  if(p==="range"&&!$("tx_f").value){$("tx_f").value=$("tx_t").value=$("tx_d").value||ymd(new Date())}}
function txView(){if(!$("tx_d").value)$("tx_d").value=ymd(new Date());txToggle();txLoad()}
async function txLoad(){
  const r=txRange(),my=++txReq;txSpan=r;
  if(!r){TX=[];$("txRange").textContent="";$("txSum").innerHTML="";$("txTable").innerHTML='<p class="empty">Pick a date to see transactions.</p>';return}
  $("txRange").textContent=`Showing ${r[0].toLocaleDateString("en-NG")} to ${new Date(r[1]-1).toLocaleDateString("en-NG")}`;
  $("txTable").innerHTML='<p class="empty">Loading…</p>';
  try{const s=await getDocs(query(collection(db,"movements"),where("at",">=",Timestamp.fromDate(r[0])),where("at","<",Timestamp.fromDate(r[1])),orderBy("at","desc")));
    if(my!==txReq)return;
    TX=s.docs.map(d=>({id:d.id,...d.data()}));txDraw()}
  catch(e){console.error(e);if(my===txReq)$("txTable").innerHTML='<p class="empty">Could not load transactions.</p>'}}
function txRows(){
  const t=$("tx_r").value,q=$("tx_q").value.trim().toLowerCase();
  return TX.map(x=>{const p=prodOf(x.productId),b=B.find(y=>y.id===x.batchId);
    return{when:x.at?.toDate()||null,product:p?.name||"Archived product",sku:p?.sku||"",category:p?.category||"",unit:p?.unit||"",qty:x.qty,reason:x.reason||"",batch:b?.batchNo||"",ref:x.ref||b?.ref||"",note:x.note||"",by:x.by||""}})
    .filter(r=>(!t||r.reason===t)&&(!q||[r.product,r.sku,r.reason,r.batch,r.ref,r.note,r.by].join(" ").toLowerCase().includes(q)))}
function txDraw(){
  const rows=txRows(),inn=rows.filter(r=>r.qty>0).reduce((s,r)=>s+r.qty,0),out=rows.filter(r=>r.qty<0).reduce((s,r)=>s-r.qty,0);
  const st=(l,v,t="b")=>`<div class="stat ${t}"><small>${l}</small><b>${v}</b><em>&nbsp;</em></div>`;
  $("txSum").innerHTML=st("Transactions",rows.length,"p")+st("Units received",r6(inn).toLocaleString("en-NG"))+st("Units removed",r6(out).toLocaleString("en-NG"))+st("Net change",(inn>=out?"+":"")+r6(inn-out).toLocaleString("en-NG"),"p");
  const MAX=500;
  $("txTable").innerHTML=rows.length?`<table><tr><th>When</th><th>Product</th><th>SKU</th><th>Qty</th><th>Type</th><th>Batch</th><th>Reference</th><th>Note</th><th>By</th></tr>`+
    rows.slice(0,MAX).map(r=>`<tr><td>${r.when?r.when.toLocaleString("en-NG"):""}</td><td>${esc(r.product)}</td><td>${esc(r.sku)}</td><td class="${r.qty>0?"pos":"neg"}">${r.qty>0?"+":""}${r.qty} ${esc(r.unit)}</td><td>${esc(r.reason)}</td><td>${esc(r.batch||"—")}</td><td>${esc(r.ref||"—")}</td><td>${esc(r.note)}</td><td>${esc(r.by)}</td></tr>`).join("")+"</table>"+(rows.length>MAX?`<p class="empty">Showing the first ${MAX} of ${rows.length}. Export the CSV to get all of them.</p>`:""):'<p class="empty">No transactions in this period.</p>'}
const csvCell=v=>{let s=String(v??"");if(typeof v==="string"&&/^[=+\-@\t\r]/.test(s))s="'"+s;return/[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s};
function txExport(){
  if(!isSuper())return;const rows=txRows();
  if(!rows.length){toast("Nothing to export for this period.",true);return}
  const head=["Date","Time","Product","SKU","Category","Type","Quantity (base units)","Unit","Batch","Reference","Note","By"];
  const lines=[head,...rows.map(r=>[r.when?ymd(r.when):"",r.when?`${pad2(r.when.getHours())}:${pad2(r.when.getMinutes())}:${pad2(r.when.getSeconds())}`:"",r.product,r.sku,r.category,r.reason,r.qty,r.unit,r.batch,r.ref,r.note,r.by])].map(l=>l.map(csvCell).join(","));
  const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"}),a=document.createElement("a");
  a.href=URL.createObjectURL(blob);a.download=`transactions_${ymd(txSpan[0])}_to_${ymd(new Date(txSpan[1]-1))}.csv`;
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  toast(`Exported ${rows.length} transactions`)}
$("tx_p").onchange=()=>{txToggle();txLoad()};
["tx_d","tx_f","tx_t"].forEach(id=>$(id).onchange=txLoad);
$("tx_r").onchange=txDraw;$("tx_q").oninput=txDraw;$("tx_csv").onclick=txExport;
// ---- staff accounts (superadmin only)
const normUser=s=>s.trim().toLowerCase();
const okUser=s=>/^[a-z0-9._-]{3,20}$/.test(s);
const USER_ERR="Username must be 3 to 20 characters: letters, numbers, dot, dash or underscore.";
let U=[];
async function staffView(){
  const s=await getDocs(collection(db,"users"));
  U=s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.name||a.email||"").localeCompare(String(b.name||b.email||"")));
  $("stList").innerHTML=U.length?"<table><tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>"+U.map(u=>{const me=u.id===user.uid,off=u.active===false;
    return `<tr><td>${esc(u.name||"—")}</td><td>${esc(u.username||"—")}</td><td>${esc(u.synthetic?"(none)":u.email||"—")}</td><td>${esc(u.role)}</td>
    <td><span class="tag ${off?"t-bad":"t-ok"}">${off?"Deactivated":"Active"}</span></td>
    <td>${!u.username?`<button class="btn sm ghost" data-un="${u.id}">Set username</button> `:""}${u.email&&!u.synthetic?`<button class="btn sm ghost" data-rs="${u.id}">Reset password email</button> `:""}${me?"You":`<button class="btn sm ghost" data-tg="${u.id}">${off?"Reactivate":"Deactivate"}</button>`}</td></tr>`}).join("")+"</table>":'<p class="empty">No accounts yet.</p>';
  const q=a=>$("stList").querySelectorAll(a);
  q("[data-tg]").forEach(b=>b.onclick=()=>guard(b,async()=>{
    const u=U.find(x=>x.id===b.dataset.tg),off=u.active!==false;
    if(!confirm(`${off?"Deactivate":"Reactivate"} ${u.name||u.username||u.email}?`))return;
    await runTransaction(db,async t=>t.update(doc(db,"users",u.id),{active:!off}));
    await staffView();toast(off?"Account deactivated":"Account reactivated")}));
  q("[data-rs]").forEach(b=>b.onclick=()=>guard(b,async()=>{
    const u=U.find(x=>x.id===b.dataset.rs);await sendPasswordResetEmail(auth,u.email);toast("Reset email sent to "+u.email)}));
  q("[data-un]").forEach(b=>b.onclick=()=>guard(b,async()=>{
    const u=U.find(x=>x.id===b.dataset.un),n=normUser(prompt("Username for "+(u.name||u.email||"this account"))||"");
    if(!n)return;if(!okUser(n))throw new Error(USER_ERR);
    await runTransaction(db,async t=>{
      if((await t.get(doc(db,"usernames",n))).exists())throw new Error("That username is taken.");
      t.set(doc(db,"usernames",n),{uid:u.id,email:u.email});
      t.update(doc(db,"users",u.id),{username:n})});
    await staffView();toast("Username saved")}));
}
$("stForm").onsubmit=e=>{e.preventDefault();guard($("stSave"),async()=>{
  const name=$("st_name").value.trim(),un=normUser($("st_user").value),em=$("st_email").value.trim().toLowerCase(),pw=$("st_pw").value,rl=$("st_role").value;
  if(!okUser(un))throw new Error(USER_ERR);
  if(pw.length<6)throw new Error("Password must be at least 6 characters.");
  if((await getDoc(doc(db,"usernames",un))).exists())throw new Error("That username is taken.");
  const synthetic=!em,email=em||`${un}@staff.derhymes.app`;
  let uid;
  try{uid=(await createUserWithEmailAndPassword(auth2,email,pw)).user.uid}
  catch(err){throw new Error(err.code==="auth/email-already-in-use"?"That email already has an account.":err.message)}
  finally{await signOut(auth2).catch(()=>{})}
  await runTransaction(db,async t=>{
    t.set(doc(db,"users",uid),{name,username:un,email,synthetic,role:rl,active:true,createdAt:serverTimestamp()});
    t.set(doc(db,"usernames",un),{uid,email})});
  $("stForm").reset();await staffView();toast("Account created")})};
// ---- biometric login (WebAuthn + PRF). The password is stored encrypted on this device only.
const BIO_KEY="dr_bio_v1",bu8=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
const b64=u=>btoa(String.fromCharCode(...new Uint8Array(u)));
const bioSalt=new TextEncoder().encode("de-rhymes-stock-console-bio-v1");
const bioRec=()=>{try{return JSON.parse(localStorage.getItem(BIO_KEY))}catch{return null}};
const bioSupported=async()=>!!(window.PublicKeyCredential&&await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(()=>false));
const bioAesKey=async prf=>crypto.subtle.importKey("raw",await crypto.subtle.digest("SHA-256",prf),"AES-GCM",false,["encrypt","decrypt"]);
async function bioPrf(credId){ // asks for Face ID / fingerprint and returns the device-bound secret
  const a=await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rpId:location.hostname,
    allowCredentials:credId?[{type:"public-key",id:credId}]:[],userVerification:"required",timeout:60000,
    extensions:{prf:{eval:{first:bioSalt}}}}});
  const r=a.getClientExtensionResults().prf?.results?.first;
  if(!r)throw new Error("This browser or device does not support biometric login. Please update it or use your password.");
  return{prf:r,id:new Uint8Array(a.rawId)}}
async function bioEnable(){
  if(!await bioSupported())throw new Error("This device has no Face ID or fingerprint available.");
  const pw=prompt("Enter your password to turn on biometric login on this device");if(!pw)return;
  try{await signInWithEmailAndPassword(auth,user.email,pw)}catch{throw new Error("Wrong password.")}
  const cred=await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),
    rp:{name:"De Rhymes Stock Console",id:location.hostname},
    user:{id:new TextEncoder().encode(user.uid).slice(0,64),name:user.email,displayName:user.email},
    pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-257}],
    authenticatorSelection:{authenticatorAttachment:"platform",userVerification:"required",residentKey:"preferred"},
    timeout:60000,extensions:{prf:{}}}});
  const id=new Uint8Array(cred.rawId),{prf}=await bioPrf(id); // second prompt reads the secret
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:"AES-GCM",iv},await bioAesKey(prf),new TextEncoder().encode(JSON.stringify({e:user.email,p:pw})));
  localStorage.setItem(BIO_KEY,JSON.stringify({id:b64(id),iv:b64(iv),ct:b64(ct)}));
  bioUi();toast("Biometric login turned on for this device")}
async function bioSignIn(){
  const rec=bioRec();if(!rec)return;
  const {prf}=await bioPrf(bu8(rec.id));
  const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:bu8(rec.iv)},await bioAesKey(prf),bu8(rec.ct));
  const c=JSON.parse(new TextDecoder().decode(pt));
  await signInWithEmailAndPassword(auth,c.e,c.p)}
function bioUi(){
  $("bioLogin").hidden=!bioRec();
  const t=$("bioToggle");t.hidden=!user;t.textContent=bioRec()?"Turn off biometric login":"Turn on biometric login"}
$("bioLogin").onclick=()=>guard($("bioLogin"),async()=>{
  try{await bioSignIn()}
  catch(e){if(e.name==="NotAllowedError")return; // cancelled
    if(e.code?.startsWith("auth/")){localStorage.removeItem(BIO_KEY);bioUi();throw new Error("Your password has changed. Sign in with it once, then turn biometric login on again.")}
    throw e}});
$("bioToggle").onclick=()=>guard($("bioToggle"),async()=>{
  if(bioRec()){localStorage.removeItem(BIO_KEY);bioUi();toast("Biometric login turned off");return}
  try{await bioEnable()}catch(e){if(e.name==="NotAllowedError")return;throw e}});
onAuthStateChanged(auth,bioUi);
bioUi();