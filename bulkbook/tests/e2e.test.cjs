const {JSDOM}=require("jsdom");const fs=require("fs");const {Pool,types}=require("pg");
types.setTypeParser(1082,v=>v);types.setTypeParser(1700,v=>parseFloat(v));types.setTypeParser(20,v=>Number(v));
const cfg={host:process.env.PGHOST||"localhost",port:+(process.env.PGPORT||5432),database:process.env.PGDATABASE||"bulkbook_test",user:process.env.PGUSER||"postgres"};
const pool=new Pool({...cfg,max:6});
const sup=(sql,p)=>pool.query(sql,p);
const PUB=__dirname+"/../public/",APP=fs.readFileSync(PUB+"app.js","utf8"),HTML=fs.readFileSync(PUB+"index.html","utf8").replace(/<link[^>]*>/g,"").replace(/<script src="\/app.js"><\/script>/,"");
let pass=0,fail=0;const ok=(n,c,x)=>{c?(pass++,console.log("ok   "+n)):(fail++,console.log("FAIL "+n+(x?" :: "+x:"")))};
const jserrs=[];process.on("unhandledRejection",e=>jserrs.push("unhandled "+(e&&e.message)));
const rpcLog=[];
function splitTop(s){const out=[];let d=0,cur="";for(const ch of s){if(ch==="(")d++;if(ch===")")d--;if(ch===","&&d===0){out.push(cur.trim());cur=""}else cur+=ch}if(cur.trim())out.push(cur.trim());return out}
function makeSb(getSub){
  const run=async fn=>{const c=await pool.connect();try{await c.query("begin");await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:getSub(),role:"authenticated"})]);await c.query("set local role authenticated");const r=await fn(c);await c.query("commit");return r}catch(e){await c.query("rollback").catch(()=>{});throw e}finally{c.release()}};
  class QB{constructor(t){this.t=t;this.cols="*";this.f=[];this.o=null;this.l=null}
    select(c){this.cols=c;return this}eq(c,v){this.f.push([c,v]);return this}order(c,o={}){this.o=[c,o.ascending===false?"desc":"asc"];return this}limit(n){this.l=n;return this}
    then(a,b){return this.exec().then(a,b)}
    async exec(){try{return{data:await run(c=>this.go(c)),error:null}}catch(e){return{data:null,error:{message:e.message}}}}
    async go(c){const parts=splitTop(this.cols),flat=parts.filter(p=>!p.includes("(")),emb=parts.filter(p=>p.includes("("));
      let sql=`select ${flat.join(",")} from public.${this.t}`;const params=[];
      if(this.f.length)sql+=" where "+this.f.map((x,i)=>{params.push(x[1]);return `${x[0]} = $${i+1}`}).join(" and ");
      if(this.o)sql+=` order by ${this.o[0]} ${this.o[1]}`;if(this.l)sql+=` limit ${this.l}`;
      const rows=(await c.query(sql,params)).rows;
      for(const e of emb){const name=e.slice(0,e.indexOf("(")),inner=e.slice(e.indexOf("(")+1,-1);rows.forEach(r=>r[name]=[]);
        if(rows.length){const r2=await c.query(`select receipt_id,${inner} from public.${name} where receipt_id = any($1)`,[rows.map(r=>r.id)]);r2.rows.forEach(x=>{const row=rows.find(r=>r.id===x.receipt_id);if(row)row[name].push(x)})}}
      return rows}}
  return {from:t=>new QB(t),rpc(name,args={}){rpcLog.push(name);const keys=Object.keys(args);
    const p={then:(a,b)=>ex().then(a,b)};
    const ex=async()=>{try{const data=await run(async c=>{const proc=(await c.query("select proretset from pg_proc where proname=$1 and pronamespace='public'::regnamespace",[name])).rows[0];if(!proc)throw new Error("no such function "+name);
        const sql=`select * from public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(",")})`;
        const r=await c.query(sql,keys.map(k=>{const v=args[k];return v!==null&&typeof v==="object"?JSON.stringify(v):v}));return proc.proretset?r.rows:r.rows[0][name]});return{data,error:null}}catch(e){return{data:null,error:{message:e.message}}}};
    return p}};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function openApp(sub){
  const dom=new JSDOM(HTML,{runScripts:"outside-only",pretendToBeVisual:true,url:"https://shop.example/"});const w=dom.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","")};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");this.dispatchEvent(new w.Event("close"))};w.scrollTo=()=>{};w.matchMedia=()=>({matches:false});
  w.addEventListener("error",e=>jserrs.push("ERR "+e.message));
  const fakeFetch=async(url,init={})=>{
    if(url==="/api/config")return new Response(JSON.stringify({clerkPublishableKey:"pk_test_x",supabaseUrl:"https://x.supabase.co",supabasePublishableKey:"sb_publishable_x"}),{status:200});
    if(url==="/api/staff"&&init.method==="POST"){const b=JSON.parse(init.body);staffCalls.push(["create",b,init.headers.authorization]);const id="user_"+b.login;await sup("insert into profiles(clerk_user_id,full_name,login_name,role) values($1,$2,$3,'employee')",[id,b.name,b.login]);return new Response(JSON.stringify({id}),{status:201})}
    if(url.startsWith("/api/staff/")&&init.method==="DELETE"){const id=decodeURIComponent(url.split("/").pop());staffCalls.push(["delete",id]);await sup("update profiles set status='deleted' where clerk_user_id=$1",[id]);return new Response("{}",{status:200})}
    return new Response("{}",{status:404})};
  w.__BB_DEPS__={fetch:fakeFetch,clerk:{user:{id:sub},session:{getToken:async()=>"fake.jwt."+sub,user:{id:sub}},addListener(){},mountSignIn(){},signOut:async()=>{}},createClient:()=>makeSb(()=>sub)};
  w.eval(APP);const d=w.document;
  const A={w,d,
    vis(){return ["#app","#dlg","#toast"].map(x=>{const e=d.querySelector(x);return(x==="#dlg"&&!e.open)?"":e.textContent}).join(" ").replace(/\s+/g," ")},
    click(sel){const e=d.querySelector(sel);if(!e)throw new Error("missing "+sel+" | "+A.vis().slice(0,160));e.click()},
    type(sel,v){const e=d.querySelector(sel);if(!e)throw new Error("missing "+sel);e.value=v;e.dispatchEvent(new w.Event("input",{bubbles:true}));e.dispatchEvent(new w.Event("change",{bubbles:true}))},
    submit(sel){const f=d.querySelector(sel);if(!f)throw new Error("missing "+sel);f.dispatchEvent(new w.Event("submit",{cancelable:true,bubbles:true}))},
    async until(t,ms=4000){const s=Date.now();while(Date.now()-s<ms){if(A.vis().includes(t))return true;await sleep(25)}throw new Error('timeout waiting for "'+t+'" | now: '+A.vis().slice(0,200))},
    async nav(v){A.click(`.nav-d [data-action="nav"][data-view="${v}"]`);await sleep(20)},
    close(){try{w.close()}catch(_){}}};
  return A;
}
const staffCalls=[];
const step=async(n,f)=>{try{await f();ok(n,true)}catch(e){ok(n,false,e.message)}};
const must=(c,m)=>{if(!c)throw new Error(m)};
const PID=async n=>(await sup("select id from products where name=$1",[n])).rows[0].id;
const fmt=n=>"GH\u20B5 "+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
(async()=>{
  await sup(`insert into profiles(clerk_user_id,full_name,login_name,role) values('user_owner','Maya Okafor','maya','owner'),('user_emp1','Daniel Reyes','daniel','employee'),('user_emp2','Priya Shah','priya','employee')`);
  await sup(`insert into products(sku,name,category,sell_type,pieces_per_box,price_piece,price_box,price_bag,cost,stock_base,low_base) values
   ('TOM-1','Tomato paste','Canned','box',50,8.50,400,null,6.40,1217,300),('RIC-1','Rice 25kg','Grains','bag',null,null,null,320,270,240,60),('OIL-1','Oil 1L','Oils','box',12,38,440,null,31,10,48)`);
  const TOM=await PID("Tomato paste"),RIC=await PID("Rice 25kg");
  let D;
  await step("employee boots, signs in via Clerk, profile + data load",async()=>{D=await openApp("user_emp1");await D.until("Your sales today");must(D.vis().includes("Employee"),"role label");must(D.vis().includes("Sell goods"),"tiles")});
  await step("employee has no Employees/Staff nav",async()=>{must(!D.d.querySelector('.nav-d [data-view="staff"]'),"staff nav visible")});
  await step("sell: add 2 boxes tomato + 1 half bag rice",async()=>{await D.nav("sell");
    D.click(`.pcard[data-pid="${TOM}"] button[data-action="openprod"]`);D.click('[data-action="pstep"][data-d="1"]');must(D.vis().includes(fmt(800)),"line price 2 boxes = 800");D.click('[data-action="padd"]');
    D.click(`.pcard[data-pid="${RIC}"] button[data-action="openprod"]`);D.click('[data-action="punit"][data-u="half"]');must(D.vis().includes(fmt(160)),"half bag = 160");D.click('[data-action="padd"]')});
  await step("finish sale as NEW customer paying half → receipt 1001 with balance",async()=>{D.click(".fab");await D.until("Who is buying?");D.click('[data-action="mode"][data-m="customer"]');
    must(!D.d.querySelector("select#cust"),"old select");D.type("#cq","Kofi");await D.until('No customer found for "Kofi"');D.click('[data-action="newcust"]');
    D.type("#np","024 555 0102");must(D.d.querySelector("#nn").value==="Kofi","name prefilled from search");D.type("#nn","Kofi & Sons");D.click('[data-action="setpaid"][data-v="480"]');
    D.click('[data-action="checkout"]');await D.until("Receipt number 1001");const t=D.vis();
    must(t.includes("Served by: Daniel Reyes")&&t.includes("Kofi & Sons")&&t.includes("Balance owed: "+fmt(480))&&t.includes("2 boxes")&&t.includes("1 half bag"),t.slice(0,400))});
  await step("database really changed: stock, receipt, customer, payment",async()=>{
    must((await sup("select stock_base from products where id=$1",[TOM])).rows[0].stock_base===1117,"tomato stock");must((await sup("select stock_base from products where id=$1",[RIC])).rows[0].stock_base===239,"rice stock");
    const r=(await sup("select total,paid_at,employee_name from receipts where no=1001")).rows[0];must(+r.total===960&&r.paid_at===null&&r.employee_name==="Daniel Reyes","receipt "+JSON.stringify(r));
    must((await sup("select count(*)::int n from customers where name='Kofi & Sons'")).rows[0].n===1,"customer")});
  await step("second sale: SEARCH finds existing customer, warns he owes, pays nothing",async()=>{D.click('[data-action="closedlg"]');await D.nav("sell");D.click(`.pcard[data-pid="${RIC}"] button[data-action="openprod"]`);D.click('[data-action="padd"]');D.click(".fab");await D.until("Who is buying?");
    D.click('[data-action="mode"][data-m="customer"]');D.type("#cq","kof");must(D.d.querySelectorAll(".cr").length===1,"1 match");D.type("#cq","0102");must(D.d.querySelectorAll(".cr").length===1&&D.vis().includes("Owes "+fmt(480)),"phone search + owes chip");
    D.click(".cr");must(D.vis().includes("already owes "+fmt(480)),"warning note");D.click('[data-action="setpaid"][data-v="0"]');D.click('[data-action="checkout"]');await D.until("Receipt number 1002");must(D.vis().includes("Balance owed: "+fmt(320)),"balance 320")});
  await step("duplicate phone typed differently is refused with server message",async()=>{D.click('[data-action="closedlg"]');await D.nav("sell");D.click(`.pcard[data-pid="${TOM}"] button[data-action="openprod"]`);D.click('[data-action="punit"][data-u="piece"]');D.click('[data-action="padd"]');D.click(".fab");await D.until("Who is buying?");
    D.click('[data-action="mode"][data-m="customer"]');D.click('[data-action="newcust"]');D.type("#nn","Someone Else");D.type("#np","+233 24-555-0102");D.click('[data-action="checkout"]');await D.until("already belongs to Kofi & Sons");
    must((await sup("select count(*)::int n from customers")).rows[0].n===1,"no duplicate customer")});
  await step("owing view shows 800 owed; record payment of 500 settles oldest first",async()=>{await D.nav("owing");must(D.vis().includes("Owes "+fmt(800)),"owes 800");D.click('[data-action="payform"]');await D.until("Record a payment");must(D.vis().includes("Receipt 1001")&&D.vis().includes("Receipt 1002"),"unpaid list");
    D.type("#pa","500");D.type("#pm","Mobile money");D.submit('[data-form="pay"]');await D.until("recorded for Kofi");must(D.vis().includes("1001 (paid in full)"),D.vis().slice(-200));
    must(D.vis().includes("Owes "+fmt(300)),"now owes 300");const p=(await sup("select method,received_by_name from payments where kind='later' order by created_at")).rows;must(p.length===2&&p.every(x=>x.received_by_name==="Daniel Reyes"&&x.method==="Mobile money"),JSON.stringify(p))});
  await step("overpaying is refused",async()=>{D.click('[data-action="payform"]');await D.until("Record a payment");D.type("#pa","9999");D.submit('[data-form="pay"]');await D.until("Enter an amount up to");D.click('[data-action="closedlg"]')});
  await step("employee goods: no 'Change prices'; add bag goods 7.5 bags; add stock 2 bags",async()=>{await D.nav("goods");must(!D.vis().includes("Change prices"),"change prices visible");
    D.click('[data-action="addprod"]');await D.until("Add new goods");D.type("#ap-type","bag");D.type("#ap-name","Maize 50kg");D.type("#ap-cat","Grains");D.type("#ap-pg","300");D.type("#ap-sg","7.5");D.submit('[data-form="addprod"]');await D.until("Added Maize 50kg");
    const m=(await sup("select stock_base,cost,price_bag from products where name='Maize 50kg'")).rows[0];must(m.stock_base===15&&m.cost===null&&+m.price_bag===300,JSON.stringify(m));
    const card=[...D.d.querySelectorAll("article.card")].find(c=>c.textContent.includes("Maize"));card.querySelector('[data-action="addstock"]').click();D.type("#as-g","2");D.submit('[data-form="addstock"]');await D.until("Added 2 bags to Maize");
    must((await sup("select stock_base from products where name='Maize 50kg'")).rows[0].stock_base===19,"stock 19")});
  await step("employee reports: own sales only, no profit, no customers tab",async()=>{D.click('.nav-m [data-action="more"]');must(!D.vis().includes("Employees and shop"),"staff in More");D.click('#dlg [data-action="nav"][data-view="reports"]');await D.until("Sales by person");
    must(D.vis().includes("Daniel Reyes")&&!D.vis().includes("Priya"),"names");must(!D.d.querySelector('[data-action="reptab"][data-t="customers"]'),"customers tab");D.click('[data-action="reptab"][data-t="monthly"]');must(!D.vis().includes("Profit"),"profit shown to employee")});
  await step("employee receipts: sees own receipts, not owner-only clean-up card",async()=>{D.click('.nav-m [data-action="more"]');D.click('#dlg [data-action="nav"][data-view="receipts"]');await D.until("Find a receipt");must(!D.vis().includes("Old receipts")&&D.vis().includes("No. 1001"),"receipts view");D.click('[data-action="openrc"]');await D.until("Receipt number")});
  D.close();

  // ---------------- owner ----------------
  const O=await openApp("user_owner");
  await step("owner boots and sees everyone's sales for today",async()=>{await O.until("Sales today, everyone");const tot=+(await sup("select coalesce(sum(total),0) s from receipts where created_at::date=now()::date")).rows[0].s;must(O.vis().includes(fmt(tot)),"today total "+fmt(tot)+" | "+O.vis().slice(0,200))});
  await step("owner sees Cost needed on employee-added goods and can set price+cost",async()=>{await O.nav("goods");must(O.vis().includes("Cost needed"),"chip");const card=[...O.d.querySelectorAll("article.card")].find(c=>c.textContent.includes("Maize"));card.querySelector('[data-action="editprod"]').click();await O.until("Change Maize 50kg");
    O.type("#ep-pg","310");O.type("#ep-cost","250");O.submit('[data-form="editprod"]');await O.until("Saved Maize 50kg");const m=(await sup("select price_bag,cost,stock_base from products where name='Maize 50kg'")).rows[0];must(+m.price_bag===310&&+m.cost===250&&m.stock_base===19,JSON.stringify(m))});
  await step("owner monthly report shows Profit; customers tab shows total bought",async()=>{O.click('.nav-m [data-action="more"]');O.click('#dlg [data-action="nav"][data-view="reports"]');await O.until("Sales by person");O.click('[data-action="reptab"][data-t="monthly"]');must(O.vis().includes("Profit"),"profit");
    O.click('[data-action="reptab"][data-t="customers"]');must(O.vis().includes("Kofi & Sons")&&O.vis().includes(fmt(1280)),"Kofi total bought 1,280 | "+O.vis().slice(0,300))});
  await step("owner: shop settings saved and printed on receipts",async()=>{O.click('.nav-m [data-action="more"]');O.click('#dlg [data-action="nav"][data-view="staff"]');await O.until("Shop settings");O.type("#shn","Mensah Wholesale");O.type("#shz","Africa/Lagos");O.submit('[data-form="settings"]');await O.until("Settings saved");
    const s=(await sup("select shop_name,timezone from app_settings")).rows[0];must(s.shop_name==="Mensah Wholesale"&&s.timezone==="Africa/Lagos",JSON.stringify(s))});
  await step("owner creates an employee through the server API (Bearer token sent)",async()=>{O.type("#sn","Kojo Mensah");O.type("#sl","kojo");O.type("#sp","longpass1");O.submit('[data-form="addstaff"]');await O.until("Login created for Kojo Mensah");
    must(staffCalls.some(c=>c[0]==="create"&&c[1].login==="kojo"&&c[2]==="Bearer fake.jwt.user_owner"),"server call");must(O.vis().includes("Kojo Mensah"),"listed")});
  await step("owner deletes the employee (confirmation first)",async()=>{O.click('[data-action="delask"][data-uid="user_kojo"]');await O.until("Delete Kojo Mensah?");O.click('[data-action="delgo"]');await O.until("The login was deleted");must(!O.d.querySelector('#app [data-uid="user_kojo"]'),"still listed");
    must((await sup("select status from profiles where clerk_user_id='user_kojo'")).rows[0].status==="deleted","profile kept as deleted")});
  await step("activity log shows who did what",async()=>{must(O.vis().includes("Made receipt 1001")&&O.vis().includes("Confirmed payment"),"log")});
  O.close();

  // ---------------- clean-up through the UI ----------------
  await sup("update receipts set created_at=now()-interval '150 days', paid_at=now()-interval '140 days' where no=1001");await sup("update payments set created_at=now()-interval '140 days' where receipt_id=(select id from receipts where no=1001)");
  const before=(await sup("select sum(total) s from receipts")).rows[0].s;
  const O2=await openApp("user_owner");
  await step("old paid receipt is counted (not the one that still owes)",async()=>{await O2.until("Old receipts to delete");must(/Old receipts to delete\s*1(?!\d)/.test(O2.vis()),O2.vis().slice(0,500));await O2.nav("receipts");await O2.until("1 ready to delete")});
  await step("owner confirms and receipts are deleted, totals kept",async()=>{O2.click('[data-action="purgeask"]');await O2.until("Delete 1 old receipt?");O2.click('[data-action="purgego"]');await O2.until("Deleted 1 old receipt");
    must((await sup("select count(*)::int n from receipts where no=1001")).rows[0].n===0,"receipt 1001 gone");must((await sup("select count(*)::int n from receipts where no=1002")).rows[0].n===1,"owing receipt kept");
    const after=(await sup("select coalesce(sum(total),0) s from receipts")).rows[0].s;const arch=(await sup("select coalesce(sum(sales),0) s from monthly_archive")).rows[0].s;must(Math.abs(+before-(+after+ +arch))<0.005,`before ${before} vs ${after}+${arch}`);
    await O2.nav("reports");O2.click('[data-action="reptab"][data-t="customers"]');must(O2.vis().includes(fmt(1280)),"Kofi lifetime total unchanged after purge | "+O2.vis().slice(0,300))});
  O2.close();

  // ---------------- a signed-in stranger ----------------
  const X=await openApp("user_stranger");
  await step("signed-in person with no profile gets 'No access yet' and no data",async()=>{await X.until("No access yet");must(!X.vis().includes("Kofi")&&!X.vis().includes("Tomato"),"leaked");X.close()});
  const used=[...new Set(rpcLog)];console.log("RPCs used by the app:",used.join(", "));
  ok("no unexpected page errors",jserrs.length===0,jserrs.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);await pool.end();process.exit(fail?1:0);
})().catch(e=>{console.error("CRASH",e);process.exit(2)});
