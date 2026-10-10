// Local example product. Its backend owns the stack key and customer graph.
// Real products must replace the fixed demo customer with their authenticated user.
import { createServer } from "node:http";
import { LbbClient } from "@littlebigbrain/client";

const port = Number(process.env.PORT ?? 8080);
const origin = `http://localhost:${port}`;
const graph = process.env.DEMO_CUSTOMER_GRAPH ?? "demo_customer";
if (!process.env.LBB_STACK_API_KEY || !process.env.LBB_STACK_URL) {
  throw new Error("Set LBB_STACK_API_KEY and LBB_STACK_URL on the backend");
}
const client = new LbbClient({ baseUrl: process.env.LBB_STACK_URL, apiKey: process.env.LBB_STACK_API_KEY,
  integrationsUrl: process.env.LBB_INTEGRATIONS_URL });
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Example product · Connections</title><style>body{font:16px system-ui;max-width:680px;margin:60px auto;padding:16px}button,select{font:inherit;padding:10px;margin:8px 8px 8px 0}pre{white-space:pre-wrap}</style>
<h1>Your product’s connections</h1><p>This local example uses one backend-selected demo customer. Provider credentials stay with LBB; the stack key stays on this server.</p>
<label>App <select id="apps"></select></label><button id="connect">Connect</button>
<button id="refresh">Refresh connections</button><pre id="status" role="status"></pre><ul id="connections"></ul>
<p>Disconnect stops this connection and clears its stored grant. Imported data stays in the graph, and the provider app stays installed. Reconnecting with different resources requires a new graph.</p>
<script>
const status = document.getElementById('status');
async function api(path,body){const res=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await res.json();if(!res.ok)throw Error(value.error);return value}
async function refresh(){
  const value=await api('/api/connections');
  const list=document.getElementById('connections');list.replaceChildren();
  for(const connection of value.connections){
    const item=document.createElement('li');
    const label=document.createElement('span');label.textContent=connection.id+' ('+connection.kind+') · '+connection.status.kind+': '+connection.status.detail+' ';
    const button=document.createElement('button');button.textContent='Disconnect';
    button.onclick=async()=>{button.disabled=true;try{await api('/api/disconnect',{connection_id:connection.id});await refresh();status.textContent='Disconnected. Imported graph data and provider installation remain.'}catch(e){status.textContent=e.message;button.disabled=false}};
    item.append(label,button);list.append(item);
  }
  status.textContent=value.connections.length?'Connections loaded.':'No connections yet.';
}
(async()=>{try{const {apps}=await api('/api/apps');for(const app of apps.filter(a=>a.active)){const o=document.createElement('option');o.value=app.id;o.textContent=app.label+' ('+app.kind+')';document.getElementById('apps').append(o)}
const session=new URL(location.href).searchParams.get('lbb_session');if(session){history.replaceState(null,'','/');const value=await api('/api/session?id='+encodeURIComponent(session));await refresh();status.textContent='Verified by backend: '+value.status+' (sync progress is separate).'}else await refresh();}catch(e){status.textContent=e.message}})();
document.getElementById('connect').onclick=async()=>{try{const value=await api('/api/connect',{app_id:document.getElementById('apps').value});location.assign(value.url)}catch(e){status.textContent=e.message}};
document.getElementById('refresh').onclick=()=>refresh().catch(e=>status.textContent=e.message);
</script></html>`;
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", "referrer-policy": "no-referrer" }); res.end(page); return;
    }
    if (req.method === "GET" && url.pathname === "/api/apps") return json(res, 200, await client.integrations.providerApps());
    if (req.method === "GET" && url.pathname === "/api/connections") return json(res, 200, await client.integrations.list({ graph }));
    if (req.method === "GET" && url.pathname === "/api/session") {
      const session = await client.integrations.getConnectSession(url.searchParams.get("id") ?? "");
      if (session.graph !== graph) return json(res, 404, { error: "Session not found" });
      return json(res, 200, session);
    }
    if (req.method === "POST" && ["/api/connect", "/api/disconnect"].includes(url.pathname)) {
      // Local example has no cross-origin mutation endpoint.
      if (req.headers.origin !== origin || req.headers["content-type"] !== "application/json") return json(res, 403, { error: "Invalid origin" });
      let body = ""; for await (const part of req) { body += part; if (body.length > 2048) return json(res, 413, { error: "Request too large" }); }
      let input;
      try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      const field = url.pathname === "/api/connect" ? "app_id" : "connection_id";
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 ||
          typeof input[field] !== "string" || !input[field].trim() || input[field].length > 128) {
        return json(res, 400, { error: `Supply only ${field}` });
      }
      if (url.pathname === "/api/disconnect") {
        // Scope always comes from this backend, never from the browser body or query.
        return json(res, 200, await client.integrations.delete(input.connection_id, { graph }));
      }
      const session = await client.integrations.createConnectSession({ graph, appId: input.app_id, returnUrl: origin + "/", connectionId: `app-${input.app_id}` });
      return json(res, 200, session);
    }
    json(res, 404, { error: "Not found" });
  } catch { json(res, 502, { error: "Connection service unavailable. Check backend configuration and retry." }); }
}).listen(port, "127.0.0.1", () => console.log(`Example product: ${origin}`));
