const {Client}=require("pg");
const cfg={host:process.env.PGHOST||"localhost",port:+(process.env.PGPORT||5432),database:process.env.PGDATABASE||"bulkbook_test",user:process.env.PGUSER||"postgres"};
let pass=0,fail=0;
const ok=(n,c,extra)=>{if(c){pass++;console.log("ok   "+n)}else{fail++;console.log("FAIL "+n+(extra?" :: "+extra:""))}};
const ROLE=(sub,role="authenticated")=>({sub,role});
async function as(claims,fn){ // run fn(client) inside a txn as the given Supabase role + claims
  const c=new Client(cfg);await c.connect();
  try{await c.query("begin");await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims||{})]);await c.query(`set local role ${claims&&claims.role?claims.role:"anon"}`);
    const r=await fn(c);await c.query("commit");return r;}
  catch(e){try{await c.query("rollback")}catch(_){ }throw e}finally{await c.end()}
}
const tryit=async(f)=>{try{return {v:await f()}}catch(e){return {e}}};
const sup=async(sql,p)=>{const c=new Client(cfg);await c.connect();try{return await c.query(sql,p)}finally{await c.end()}};
(async()=>{
  await sup(`insert into profiles(clerk_user_id,full_name,login_name,role) values
    ('user_owner','Maya Okafor','maya','owner'),('user_emp1','Daniel Reyes','daniel','employee'),('user_emp2','Priya Shah','priya','employee')`);
  await sup(`insert into products(sku,name,category,sell_type,pieces_per_box,price_piece,price_box,price_bag,cost,stock_base,low_base) values
    ('TOM-1','Tomato paste','Canned','box',50,8.50,400,null,6.40,1217,300),
    ('RIC-1','Rice 25kg','Grains','bag',null,null,null,320,270,240,60),
    ('OIL-1','Oil 1L','Oils','box',12,38,440,null,31,10,48)`);
  const pid=async n=>(await sup("select id from products where name=$1",[n])).rows[0].id;
  const TOM=await pid("Tomato paste"),RIC=await pid("Rice 25kg"),OIL=await pid("Oil 1L");
  const O=ROLE("user_owner"),E1=ROLE("user_emp1"),E2=ROLE("user_emp2"),X=ROLE("user_stranger"),A={role:"anon"};

  // ---- access control ----
  let r=await tryit(()=>as(A,c=>c.query("select * from products")));ok("anon cannot read products",!!r.e&&/permission denied/.test(r.e.message),r.e&&r.e.message);
  r=await tryit(()=>as(A,c=>c.query("select create_sale(null,null,null,null,'Cash','[]')")));ok("anon cannot call create_sale",!!r.e&&/permission denied/.test(r.e.message));
  r=await tryit(()=>as(X,c=>c.query("select id,name from products")));ok("stranger (no profile) sees 0 products",r.v&&r.v.rows.length===0);
  r=await tryit(()=>as(X,c=>c.query("select * from create_sale(null,null,null,null,'Cash',$1)",[JSON.stringify([{product_id:TOM,unit:"piece",quantity:1}])])));ok("stranger cannot sell",!!r.e&&/not allowed/.test(r.e.message),r.e&&r.e.message);
  r=await tryit(()=>as(X,c=>c.query("select * from customer_summary()")));ok("stranger sees no customers",r.v&&r.v.rows.length===0);
  r=await tryit(()=>as(E1,c=>c.query("select * from products")));ok("employee: select * on products blocked (cost column)",!!r.e&&/permission denied/.test(r.e.message));
  r=await tryit(()=>as(E1,c=>c.query("select id,name,price_box,stock_base from products")));ok("employee reads products without cost",r.v&&r.v.rows.length===3);
  r=await tryit(()=>as(E1,c=>c.query("select * from product_costs()")));ok("employee product_costs() returns nothing",r.v&&r.v.rows.length===0);
  r=await tryit(()=>as(O,c=>c.query("select * from product_costs()")));ok("owner product_costs() returns 3",r.v&&r.v.rows.length===3);
  for(const [n,sql] of [["insert","insert into products(sku,name,category,sell_type,price_bag) values('x','x','x','bag',1)"],["update","update products set price_box=1"],["delete","delete from products"]]){
    r=await tryit(()=>as(O,c=>c.query(sql)));ok(`even the owner cannot ${n} products directly`,!!r.e&&/permission denied/.test(r.e.message),r.e&&r.e.message);}
  r=await tryit(()=>as(E1,c=>c.query("select * from update_product($1,1,1,null,1,1)",[TOM])));ok("employee cannot change prices",!!r.e&&/Only the owner/.test(r.e.message));
  r=await tryit(()=>as(E1,c=>c.query("select * from purge_old_receipts()")));ok("employee cannot purge",!!r.e&&/Only the owner/.test(r.e.message));
  r=await tryit(()=>as(E1,c=>c.query("select * from profiles")));ok("employee sees only own profile",r.v&&r.v.rows.length===1&&r.v.rows[0].clerk_user_id==="user_emp1");
  r=await tryit(()=>as(O,c=>c.query("select * from profiles")));ok("owner sees all profiles",r.v&&r.v.rows.length===3);
  r=await tryit(()=>as(E1,c=>c.query("select * from activity_log")));ok("employee cannot read activity log",r.v&&r.v.rows.length===0);
  r=await tryit(()=>as(E1,c=>c.query("select cogs from receipts")));ok("employee cannot read receipts.cogs",!!r.e&&/permission denied/.test(r.e.message));

  // ---- selling ----
  const sale=(who,cust,nn,np,paid,m,lines)=>as(who,c=>c.query("select * from create_sale($1,$2,$3,$4,$5,$6)",[cust,nn,np,paid,m,JSON.stringify(lines)]));
  r=await tryit(()=>sale(E1,null,null,null,null,"Cash",[{product_id:TOM,unit:"box",quantity:1,price:0.01},{product_id:TOM,unit:"piece",quantity:3},{product_id:RIC,unit:"half",quantity:1}]));
  ok("walk-in sale works",!!r.v,r.e&&r.e.message);
  const rec1=r.v.rows[0];ok("receipt numbers start at 1001",String(rec1.out_receipt_no)==="1001");
  let q=await sup("select total,cogs,paid_at,employee_name,customer_id from receipts where id=$1",[rec1.out_receipt_id]);
  // 400 + 3*8.5 + half bag 160 = 585.50 ; cogs 50*6.4 + 3*6.4 + 135 = 320+19.2+135=474.2
  ok("total uses DB prices (ignores spoofed price) = 585.50",+q.rows[0].total===585.5,q.rows[0].total);
  ok("cogs computed = 474.20",+q.rows[0].cogs===474.2,q.rows[0].cogs);
  ok("walk-in is fully paid (paid_at set), employee name kept",q.rows[0].paid_at&&q.rows[0].employee_name==="Daniel Reyes"&&q.rows[0].customer_id===null);
  q=await sup("select stock_base from products where id=$1",[TOM]);ok("box stock fell by 53 pieces (1217→1164)",q.rows[0].stock_base===1164);
  q=await sup("select stock_base from products where id=$1",[RIC]);ok("half bag fell by 1 half-bag (240→239)",q.rows[0].stock_base===239);
  q=await sup("select unit,quantity,unit_price,line_total from receipt_lines where receipt_id=$1 order by unit",[rec1.out_receipt_id]);
  ok("half-bag line priced at exactly half (160.00)",q.rows.some(x=>x.unit==="half"&&+x.unit_price===160&&+x.line_total===160));
  q=await sup("select count(*)::int n from payments where receipt_id=$1",[rec1.out_receipt_id]);ok("payment row written for walk-in",q.rows[0].n===1);
  r=await tryit(()=>sale(E1,null,null,null,null,"Cash",[{product_id:OIL,unit:"piece",quantity:6},{product_id:OIL,unit:"piece",quantity:6}]));ok("two lines of same goods are added up for the stock check (12>10)",!!r.e&&/Not enough Oil/.test(r.e.message),r.e&&r.e.message);
  r=await tryit(()=>sale(E1,null,null,null,null,"Cash",[{product_id:TOM,unit:"half",quantity:1}]));ok("wrong unit for goods type rejected",!!r.e&&/cannot sell/.test(r.e.message));
  r=await tryit(()=>sale(E1,null,null,null,null,"Cash",[{product_id:TOM,unit:"piece",quantity:2.5}]));ok("fractional quantity rejected",!!r.e&&/whole numbers/.test(r.e.message));
  r=await tryit(()=>sale(E1,null,null,null,null,"Cash",[{product_id:TOM,unit:"piece",quantity:0}]));ok("zero quantity rejected",!!r.e);
  r=await tryit(()=>sale(E1,null,null,null,null,"Cash",[]));ok("empty order rejected",!!r.e&&/no items/.test(r.e.message));
  r=await tryit(()=>sale(E1,null,null,null,null,"Barter",[{product_id:TOM,unit:"piece",quantity:1}]));ok("unknown payment method rejected",!!r.e);
  q=await sup("select stock_base from products where id=$1",[TOM]);ok("failed sales did not change stock",q.rows[0].stock_base===1164);

  // ---- customers & borrowing ----
  r=await tryit(()=>sale(E1,null,"Kofi & Sons","024 555 0102",100,"Mobile money",[{product_id:RIC,unit:"bag",quantity:2}])); // 640, pays 100, owes 540
  ok("new customer sale on credit works",!!r.v,r.e&&r.e.message);const recK1=r.v.rows[0];
  r=await tryit(()=>sale(E2,null,"Other","+233 24-555-0102",null,"Cash",[{product_id:TOM,unit:"piece",quantity:1}]));ok("same phone (different formatting) rejected with owner's name",!!r.e&&/already belongs to Kofi/.test(r.e.message),r.e&&r.e.message);
  r=await tryit(()=>sale(E2,null,"Bad","abc",null,"Cash",[{product_id:TOM,unit:"piece",quantity:1}]));ok("bad phone rejected",!!r.e&&/9 to 15 digits/.test(r.e.message));
  r=await tryit(()=>sale(E2,null,"","0245550111",null,"Cash",[{product_id:TOM,unit:"piece",quantity:1}]));ok("phone without a name rejected",!!r.e&&/name/.test(r.e.message));
  const cust=(await sup("select id from customers where name='Kofi & Sons'")).rows[0].id;
  r=await tryit(()=>sale(E2,cust,null,null,0,"Cash",[{product_id:RIC,unit:"bag",quantity:1}])); // 320 owed, pays nothing
  ok("customer who owes can buy again (pays nothing)",!!r.v,r.e&&r.e.message);const recK2=r.v.rows[0];
  r=await tryit(()=>sale(E2,cust,null,null,9999,"Cash",[{product_id:RIC,unit:"half",quantity:1}]));ok("paying more than the total rejected",!!r.e&&/between 0 and the total/.test(r.e.message));
  r=await tryit(()=>as(E1,c=>c.query("select * from customer_summary() where name='Kofi & Sons'")));
  ok("customer_summary: owes 860.00 (540+320), oldest set, spent hidden from employee",r.v&&+r.v.rows[0].owes===860&&r.v.rows[0].oldest_unpaid&&r.v.rows[0].spent===null,JSON.stringify(r.v&&r.v.rows[0]));
  r=await tryit(()=>as(O,c=>c.query("select * from customer_summary() where name='Kofi & Sons'")));ok("owner sees total bought 960.00 and 2 receipts",r.v&&+r.v.rows[0].spent===960&&r.v.rows[0].receipts_count===2,JSON.stringify(r.v&&r.v.rows[0]));
  r=await tryit(()=>as(E1,c=>c.query("select * from customer_unpaid($1)",[cust])));ok("unpaid list oldest first (receipt of 540 then 320)",r.v&&r.v.rows.length===2&&+r.v.rows[0].balance===540&&+r.v.rows[1].balance===320);
  const pay=(who,amt,m="Cash")=>as(who,c=>c.query("select record_payment($1,$2,$3) as r",[cust,amt,m]));
  r=await tryit(()=>pay(E1,1000));ok("overpayment rejected",!!r.e&&/more than the customer owes/.test(r.e.message),r.e&&r.e.message);
  r=await tryit(()=>pay(E1,0));ok("zero payment rejected",!!r.e);
  r=await tryit(()=>pay(E1,0.001));ok("sub-cent payment rejected",!!r.e);
  r=await tryit(()=>pay(E1,600,"Mobile money"));ok("payment of 600 accepted",!!r.v,r.e&&r.e.message);
  const pr_=r.v.rows[0].r;ok("600 settles the oldest (540) fully, 60 to next",pr_.receipts[0].paid_in_full===true&&pr_.receipts[1].paid_in_full===false&&pr_.receipts[0].no==recK1.out_receipt_no);
  q=await sup("select r.no,r.paid_at is not null as done, r.total - coalesce((select sum(amount) from payments where receipt_id=r.id),0) as bal from receipts r where customer_id=$1 order by no",[cust]);
  ok("balances after payment: first 0 & paid_at set, second 260",q.rows[0].done&&+q.rows[0].bal===0&&!q.rows[1].done&&+q.rows[1].bal===260,JSON.stringify(q.rows));
  q=await sup("select received_by_name, kind from payments where customer_id=$1 and kind='later' order by created_at",[cust]);ok("payment recorded under the confirming employee",q.rows.every(x=>x.received_by_name==="Daniel Reyes"));
  r=await tryit(()=>pay(E2,260));ok("final payment accepted, customer owes 0",!!r.v);
  r=await tryit(()=>as(O,c=>c.query("select owes from customer_summary() where name='Kofi & Sons'")));ok("owes now 0.00",r.v&&+r.v.rows[0].owes===0);

  // ---- row-level visibility of receipts ----
  r=await tryit(()=>as(E1,c=>c.query("select no,employee_name,customer_id from receipts order by no")));
  ok("employee sees own receipts + all customer receipts, not others' walk-ins",r.v&&r.v.rows.every(x=>x.employee_name==="Daniel Reyes"||x.customer_id!==null),JSON.stringify(r.v&&r.v.rows));
  await sale(E2,null,null,null,null,"Cash",[{product_id:TOM,unit:"piece",quantity:2}]); // Priya walk-in
  r=await tryit(()=>as(E1,c=>c.query("select count(*)::int n from receipts where employee_name='Priya Shah' and customer_id is null")));ok("Daniel cannot see Priya's walk-in receipt",r.v&&r.v.rows[0].n===0);
  r=await tryit(()=>as(O,c=>c.query("select count(*)::int n from receipts")));ok("owner sees all receipts",r.v&&r.v.rows[0].n===4,JSON.stringify(r.v&&r.v.rows));
  r=await tryit(()=>as(E1,c=>c.query("select count(*)::int n from receipt_lines")));
  const own=await tryit(()=>as(E1,c=>c.query("select count(*)::int n from receipt_lines l join receipts r on r.id=l.receipt_id")));ok("receipt lines follow receipt visibility",r.v.rows[0].n===own.v.rows[0].n);

  // ---- reports ----
  r=await tryit(()=>as(E1,c=>c.query("select * from report_daily(30)")));
  ok("employee daily report has only own name",r.v&&r.v.rows.length>0&&r.v.rows.every(x=>x.employee_name==="Daniel Reyes"),JSON.stringify(r.v&&r.v.rows));
  const ownerDaily=await as(O,c=>c.query("select * from report_daily(30)"));
  ok("owner daily report includes everyone",new Set(ownerDaily.rows.map(x=>x.employee_name)).size>=2);
  const totSales=ownerDaily.rows.reduce((t,x)=>t+ +x.sales,0),dbSales=+(await sup("select sum(total) s from receipts")).rows[0].s;
  ok("daily sales total equals receipts total",Math.abs(totSales-dbSales)<0.005,totSales+" vs "+dbSales);
  const totRecv=ownerDaily.rows.reduce((t,x)=>t+ +x.received,0),dbRecv=+(await sup("select sum(amount) s from payments")).rows[0].s;ok("daily money received equals payments total",Math.abs(totRecv-dbRecv)<0.005);
  r=await tryit(()=>as(E1,c=>c.query("select * from report_monthly(12)")));ok("employee monthly report hides cogs",r.v&&r.v.rows.length>0&&r.v.rows.every(x=>x.cogs===null));
  r=await tryit(()=>as(O,c=>c.query("select * from report_monthly(12)")));ok("owner monthly report shows cogs",r.v&&r.v.rows.every(x=>x.cogs!==null));
  r=await tryit(()=>as(X,c=>c.query("select * from report_daily(30)")));ok("stranger cannot run reports",!!r.e&&/not allowed/.test(r.e.message));

  // ---- products: add / stock / owner edit ----
  r=await tryit(()=>as(E1,c=>c.query("select add_product('Maize 50kg','Grains','bag',null,null,null,300,999,15) id")));ok("employee can add goods",!!r.v,r.e&&r.e.message);
  q=await sup("select cost,stock_base,low_base,sku from products where name='Maize 50kg'");ok("employee's cost ignored (null), 7.5 bags stored as 15 half-bags",q.rows[0].cost===null&&q.rows[0].stock_base===15,JSON.stringify(q.rows[0]));
  r=await tryit(()=>as(O,c=>c.query("select add_product('Spaghetti','Canned','box',20,3,55,null,2.1,0) id")));ok("owner can add goods with cost",!!r.v);
  q=await sup("select cost from products where name='Spaghetti'");ok("owner's cost kept",+q.rows[0].cost===2.1);
  r=await tryit(()=>as(E1,c=>c.query("select add_product('Bad','Canned','box',1,3,55,null,null,0)")));ok("box with 1 piece rejected",!!r.e);
  r=await tryit(()=>as(E1,c=>c.query("select add_stock($1,48)",[TOM])));ok("employee can add stock",!!r.v);
  q=await sup("select stock_base from products where id=$1",[TOM]);ok("stock increased by 48",q.rows[0].stock_base===1164-2+48-0||q.rows[0].stock_base===1210,q.rows[0].stock_base);
  r=await tryit(()=>as(O,c=>c.query("select update_product($1,9,420,null,7,1000)",[TOM])));ok("owner can change prices/cost/stock",!!r.v,r.e&&r.e.message);
  q=await sup("select price_piece,price_box,cost,stock_base from products where id=$1",[TOM]);ok("new prices stored",+q.rows[0].price_piece===9&&+q.rows[0].price_box===420&&+q.rows[0].cost===7&&q.rows[0].stock_base===1000);
  r=await tryit(()=>as(O,c=>c.query("select update_settings('Mensah & Co','Not/AZone')")));ok("invalid time zone rejected",!!r.e);
  r=await tryit(()=>as(O,c=>c.query("select update_settings('Mensah & Co','Africa/Lagos')")));ok("owner can set shop name and time zone",!!r.v,r.e&&r.e.message);

  // ---- concurrency: two sales race for the last units ----
  await sup("update products set stock_base=5 where id=$1",[OIL]);
  const race=await Promise.allSettled([sale(E1,null,null,null,null,"Cash",[{product_id:OIL,unit:"piece",quantity:4}]),sale(E2,null,null,null,null,"Cash",[{product_id:OIL,unit:"piece",quantity:4}])]);
  const won=race.filter(x=>x.status==="fulfilled").length;q=await sup("select stock_base from products where id=$1",[OIL]);
  ok("two simultaneous sales cannot oversell (1 wins, stock 1)",won===1&&q.rows[0].stock_base===1,`won=${won} stock=${q.rows[0].stock_base}`);

  // ---- clean-up of old receipts ----
  // make: (a) an old fully-paid walk-in (b) an old fully-paid customer receipt (c) an old but still-owing receipt
  const oldWalk=(await sale(E1,null,null,null,null,"Cash",[{product_id:RIC,unit:"bag",quantity:1}])).rows[0];
  const c2=(await sale(E1,null,"Esi Mart","0245550999",null,"Cash",[{product_id:RIC,unit:"bag",quantity:2}])).rows[0]; // paid in full (paid null→total)
  const oweOld=(await sale(E1,null,"Yaa Shop","0245550888",0,"Cash",[{product_id:RIC,unit:"bag",quantity:1}])).rows[0]; // owes 320
  await sup("update receipts set created_at=now()-interval '150 days', paid_at=now()-interval '140 days' where id=any($1)",[[oldWalk.out_receipt_id,c2.out_receipt_id]]);
  await sup("update receipts set created_at=now()-interval '150 days' where id=$1",[oweOld.out_receipt_id]);
  await sup("update payments set created_at=now()-interval '140 days' where receipt_id=any($1)",[[oldWalk.out_receipt_id,c2.out_receipt_id]]);
  const mBefore=(await as(O,c=>c.query("select sum(sales)::numeric s,sum(receipts)::int n from report_monthly(12)"))).rows[0];
  const sBefore=(await as(O,c=>c.query("select name,spent,receipts_count,owes from customer_summary() order by name"))).rows;
  const cnt=(await as(O,c=>c.query("select old_receipts_count() n"))).rows[0].n;ok("old_receipts_count = 2 (not the owing one)",cnt===2,cnt);
  r=await tryit(()=>as(E1,c=>c.query("select old_receipts_count() n")));ok("employee sees count 0",r.v&&r.v.rows[0].n===0);
  const del=(await as(O,c=>c.query("select purge_old_receipts() n"))).rows[0].n;ok("owner purge deletes 2",del===2,del);
  const mAfter=(await as(O,c=>c.query("select sum(sales)::numeric s,sum(receipts)::int n from report_monthly(12)"))).rows[0];
  ok("monthly sales & receipt totals unchanged by purge",+mBefore.s===+mAfter.s&&mBefore.n===mAfter.n,JSON.stringify([mBefore,mAfter]));
  const sAfter=(await as(O,c=>c.query("select name,spent,receipts_count,owes from customer_summary() order by name"))).rows;
  ok("customer lifetime totals & debts unchanged by purge",JSON.stringify(sBefore)===JSON.stringify(sAfter),JSON.stringify([sBefore,sAfter]));
  q=await sup("select count(*)::int n from receipts where id=$1",[oweOld.out_receipt_id]);ok("old receipt that still owes was NOT deleted",q.rows[0].n===1);
  q=await sup("select count(*)::int n from receipt_lines where receipt_id=any($1)",[[oldWalk.out_receipt_id,c2.out_receipt_id]]);ok("lines of deleted receipts are gone",q.rows[0].n===0);
  const again=(await as(O,c=>c.query("select purge_old_receipts() n"))).rows[0].n;ok("second purge deletes nothing",again===0);
  r=await tryit(()=>as(ROLE("x","service_role"),c=>c.query("select _purge_old_receipts('Server') n")));ok("service role can run the scheduled clean-up",!!r.v,r.e&&r.e.message);
  r=await tryit(()=>as(O,c=>c.query("select _purge_old_receipts('x')")));ok("owner cannot call the internal clean-up directly",!!r.e&&/permission denied/.test(r.e.message));
  r=await tryit(()=>as(A,c=>c.query("select purge_old_receipts()")));ok("anon cannot purge",!!r.e);
  console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.error("CRASH",e);process.exit(2)});
