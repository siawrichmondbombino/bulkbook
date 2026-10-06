import { createHandler } from '../src/worker.js';
let pass=0,fail=0;const ok=(n,c,x)=>{c?(pass++,console.log("ok   "+n)):(fail++,console.log("FAIL "+n+(x?" :: "+x:"")))};
const env={CLERK_PUBLISHABLE_KEY:"pk_test_abc",SUPABASE_URL:"https://x.supabase.co",SUPABASE_PUBLISHABLE_KEY:"sb_publishable_x",CLERK_SECRET_KEY:"sk_test_SECRET",SUPABASE_SERVICE_ROLE_KEY:"eyJ.service.role",APP_ORIGIN:"https://shop.example",ASSETS:{fetch:async()=>new Response("asset")}};
function make(opts={}){
  const calls=[],profiles={user_owner:{role:"owner",status:"active",full_name:"Maya"},user_emp:{role:"employee",status:"active",full_name:"Daniel"},user_gone:{role:"employee",status:"deleted",full_name:"Old"}};
  const clerkCalls=[];
  const deps={
    verifyToken:async(t,o)=>{calls.push({verify:o});if(t==="bad")throw new Error("bad");if(t==="errs")return{errors:[{}]};
      const map={owner:"user_owner",emp:"user_emp",gone:"user_gone",ghost:"user_ghost"};return opts.wrapData?{data:{sub:map[t]}}:{sub:map[t]}},
    createClerkClient:({secretKey})=>({users:{
      createUser:async a=>{clerkCalls.push(["create",a,secretKey]);if(opts.clerkFail){const e=new Error("x");e.errors=[{longMessage:"That password has been found in a data breach."}];throw e}return{id:"user_new123"}},
      deleteUser:async id=>{clerkCalls.push(["delete",id]);if(opts.delete404){const e=new Error("nf");e.status=404;throw e}if(opts.deleteFail)throw new Error("boom")}}}),
    fetch:async(url,init={})=>{calls.push({url,init});const u=new URL(url);
      if(init.method==="POST"&&u.pathname.endsWith("/profiles")){if(opts.profileFail)return new Response("dup",{status:409});return new Response(JSON.stringify([JSON.parse(init.body)]),{status:201})}
      if(init.method==="PATCH")return new Response(JSON.stringify([{}]),{status:200});
      if(init.method==="POST"&&u.pathname.endsWith("/activity_log"))return new Response("[]",{status:201});
      if(u.pathname.endsWith("/rpc/_purge_old_receipts"))return new Response("7",{status:200});
      if(u.pathname.endsWith("/profiles")){const id=u.searchParams.get("clerk_user_id").replace("eq.","");return new Response(JSON.stringify(profiles[id]?[profiles[id]]:[]),{status:200})}
      return new Response("[]",{status:200})}};
  return {h:createHandler(deps),calls,clerkCalls};
}
const req=(m,p,{tok,body}={})=>new Request("https://shop.example"+p,{method:m,headers:{...(tok?{authorization:"Bearer "+tok}:{}),"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
const run=async(t,r,e=env)=>{const res=await t.h.fetch(r,e,{waitUntil:()=>{}});let b=null;try{b=await res.clone().json()}catch{};return{res,b,text:await res.clone().text().catch(()=>"")}};
const good={name:"Kojo Mensah",login:"kojo",password:"longpass1"};
let t=make(),r;
r=await run(t,req("GET","/api/config"));ok("config returns the 3 public values",r.res.status===200&&r.b.clerkPublishableKey==="pk_test_abc"&&r.b.supabaseUrl&&r.b.supabasePublishableKey);
ok("config NEVER exposes secrets",!/SECRET|service.role|eyJ/.test(r.text));
r=await run(t,req("GET","/api/config"),{...env,CLERK_PUBLISHABLE_KEY:undefined});ok("config says setup is incomplete when keys missing",r.res.status===500&&/not set up/.test(r.b.error));
r=await run(t,req("GET","/index.html"));ok("non-API paths go to static assets",r.text==="asset");
r=await run(t,req("POST","/api/staff",{body:good}));ok("create employee without token -> 401",r.res.status===401);
r=await run(t,req("POST","/api/staff",{tok:"bad",body:good}));ok("invalid token -> 401",r.res.status===401);
r=await run(t,req("POST","/api/staff",{tok:"errs",body:good}));ok("token with errors -> 401",r.res.status===401);
r=await run(t,req("POST","/api/staff",{tok:"emp",body:good}));ok("employee cannot create employees -> 403",r.res.status===403);
r=await run(t,req("POST","/api/staff",{tok:"gone",body:good}));ok("deleted employee's token -> 403",r.res.status===403);
r=await run(t,req("POST","/api/staff",{tok:"ghost",body:good}));ok("signed-in stranger with no profile -> 403",r.res.status===403);
for(const [n,b] of [["short name",{...good,name:"K"}],["login with space",{...good,login:"ko jo"}],["short password",{...good,password:"short"}],["no body fields",{}]]){
  t=make();r=await run(t,req("POST","/api/staff",{tok:"owner",body:b}));ok(`owner + ${n} -> 400, nothing created`,r.res.status===400&&t.clerkCalls.length===0,r.res.status);}
t=make();r=await run(t,req("POST","/api/staff",{tok:"owner",body:good}));
ok("owner creates employee -> 201",r.res.status===201&&r.b.id==="user_new123"&&r.b.login==="kojo",JSON.stringify(r.b));
const cu=t.clerkCalls.find(c=>c[0]==="create");ok("Clerk createUser got username/password/names/role metadata",cu&&cu[1].username==="kojo"&&cu[1].password==="longpass1"&&cu[1].firstName==="Kojo"&&cu[1].lastName==="Mensah"&&cu[1].publicMetadata.role==="employee"&&cu[2]==="sk_test_SECRET");
const pi=t.calls.find(c=>c.init&&c.init.method==="POST"&&c.url.endsWith("/profiles"));ok("profile row written as employee/active",pi&&JSON.parse(pi.init.body).role==="employee"&&JSON.parse(pi.init.body).clerk_user_id==="user_new123");
ok("service key sent to Supabase (legacy JWT style: apikey + Authorization)",pi.init.headers.apikey==="eyJ.service.role"&&pi.init.headers.authorization==="Bearer eyJ.service.role");
ok("token check passes authorizedParties from APP_ORIGIN",t.calls.find(c=>c.verify).verify.authorizedParties[0]==="https://shop.example");
ok("response never contains the password or secrets",!/longpass1|SECRET|service/.test(r.text));
t=make();r=await run(t,req("POST","/api/staff",{tok:"owner",body:{name:"Ama Boateng",login:"Ama.Boateng@Example.com",password:"longpass1"}}));
{const cu2=t.clerkCalls.find(c=>c[0]==="create");ok("email login: Clerk gets emailAddress (lower-cased) and no username",r.res.status===201&&cu2&&cu2[1].emailAddress&&cu2[1].emailAddress[0]==="ama.boateng@example.com"&&cu2[1].username===undefined,JSON.stringify(cu2&&cu2[1]));}
for(const bad of ["a@b","@example.com","two words@example.com","x@y.z"]){t=make();r=await run(t,req("POST","/api/staff",{tok:"owner",body:{name:"Ama Boateng",login:bad,password:"longpass1"}}));ok(`bad email login "${bad}" -> 400, nothing created`,r.res.status===400&&t.clerkCalls.length===0,r.res.status);}
t=make({wrapData:true});r=await run(t,req("POST","/api/staff",{tok:"owner",body:good}));ok("works when verifyToken returns {data:payload}",r.res.status===201);
t=make({clerkFail:true});r=await run(t,req("POST","/api/staff",{tok:"owner",body:good}));ok("Clerk rejection -> 422 with Clerk's message, no profile written",r.res.status===422&&/data breach/.test(r.b.error)&&!t.calls.some(c=>c.url&&c.url.endsWith("/profiles")&&c.init.method==="POST"));
t=make({profileFail:true});r=await run(t,req("POST","/api/staff",{tok:"owner",body:good}));ok("profile insert fails -> Clerk login is rolled back",r.res.status===500&&t.clerkCalls.some(c=>c[0]==="delete"&&c[1]==="user_new123"));
const envNew={...env,SUPABASE_SERVICE_ROLE_KEY:"sb_secret_abc"};t=make();r=await run(t,req("POST","/api/staff",{tok:"owner",body:good}),envNew);
const pi2=t.calls.find(c=>c.init&&c.init.method==="POST"&&c.url.endsWith("/profiles"));ok("new-style sb_secret key: sent in apikey header only",pi2&&pi2.init.headers.apikey==="sb_secret_abc"&&!pi2.init.headers.authorization);
// delete
t=make();r=await run(t,req("DELETE","/api/staff/user_emp",{tok:"emp"}));ok("employee cannot delete -> 403",r.res.status===403&&t.clerkCalls.length===0);
t=make();r=await run(t,req("DELETE","/api/staff/user_owner",{tok:"owner"}));ok("owner cannot delete self -> 400",r.res.status===400&&t.clerkCalls.length===0);
t=make();r=await run(t,req("DELETE","/api/staff/bad%20id",{tok:"owner"}));ok("malformed id -> 400",r.res.status===400);
t=make();r=await run(t,req("DELETE","/api/staff/user_nobody",{tok:"owner"}));ok("unknown employee -> 404",r.res.status===404);
t=make();r=await run(t,req("DELETE","/api/staff/user_emp",{tok:"owner"}));ok("owner deletes employee -> 200",r.res.status===200&&t.clerkCalls.some(c=>c[0]==="delete"&&c[1]==="user_emp"));
const pa=t.calls.find(c=>c.init&&c.init.method==="PATCH");ok("profile kept but marked deleted (receipts keep the name)",pa&&JSON.parse(pa.init.body).status==="deleted"&&pa.url.includes("user_emp"));
t=make({delete404:true});r=await run(t,req("DELETE","/api/staff/user_emp",{tok:"owner"}));ok("Clerk says already gone (404) -> still marks deleted",r.res.status===200);
t=make({deleteFail:true});r=await run(t,req("DELETE","/api/staff/user_emp",{tok:"owner"}));ok("Clerk failure -> 502 and profile NOT marked deleted",r.res.status===502&&!t.calls.some(c=>c.init&&c.init.method==="PATCH"));
// misc
t=make();r=await run(t,req("GET","/api/staff"));ok("unknown API route -> 404",r.res.status===404);
r=await run(t,req("PUT","/api/staff",{tok:"owner"}));ok("wrong method -> 404",r.res.status===404);
t=make();let waited;await t.h.scheduled({},env,{waitUntil:p=>{waited=p}});await waited;ok("scheduled clean-up calls the server-only function",t.calls.some(c=>c.url&&c.url.endsWith("/rpc/_purge_old_receipts")&&JSON.parse(c.init.body).p_actor==="Automatic clean-up"));
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
