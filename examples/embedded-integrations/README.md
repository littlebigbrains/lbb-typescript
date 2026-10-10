# Embedded integrations example

A small local product with Connect, connection status and Disconnect. Its Node
backend keeps the stack API key and chooses one fixed demo customer graph. The
browser never receives stack keys or provider credentials.

## Set up

1. Use a test stack with developer integrations enabled. Developer-owned
   Notion, GitHub and Slack apps also require the operator's
   `LBB_PROVIDER_APPS_ENABLED=1` opt-in and a shared explicit
   `LBB_CREDENTIALS_KEY` on the SaaS API and worker. This is a beta flow;
   provider approval and live app acceptance are separate from local tests.
2. In the console, select that stack and open **Integrations → Provider apps**.
   Register an app that your company owns. Copy its callback and events URLs
   into the provider's app settings. Those URLs point to LBB's externally
   reachable API, not this demo server. Complete the provider's distribution,
   permissions and webhook setup. Slack history must have the appropriate
   provider agreement before you enable it.
3. Add `http://localhost:8080` to the app's allowed return origins. For a
   different `PORT`, allow that exact origin instead. Use `localhost` in your
   browser, not `127.0.0.1`: mutation requests check the exact origin.
4. From the repository root, install dependencies and build the SDK:

   ```sh
   npm ci
   npm run build -w @littlebigbrain/client
   ```

5. Put these values in your shell environment or secret manager, then start:

   ```sh
   export LBB_STACK_URL='https://YOUR-STACK.db.eu.littlebigbrain.com'
   export LBB_STACK_API_KEY='YOUR_TEST_STACK_KEY'
   export DEMO_CUSTOMER_GRAPH='demo_customer'
   node sdk/typescript/examples/embedded-integrations/server.mjs
   ```

Open [http://localhost:8080](http://localhost:8080), choose an active app and
select **Connect**. LBB's customer consent page requires no LBB account. After
provider consent, explicitly select resources and return to this product.
The backend verifies the returned session id and its graph. Refresh the list
to see connection status; a completed consent session does not mean its first
sync has finished.

`LBB_INTEGRATIONS_URL` optionally overrides `https://api.littlebigbrain.com`.
For a local control plane, its operator must also configure
`LBB_SAAS_PUBLIC_URL` for the reachable callback/events origin and
`LBB_SAAS_WEB_URL` for the console's connect page. The demo's `PORT` changes
only this product's return origin. It does not change either LBB URL.

## Scope and limits

- This server binds to loopback and has no customer login. Before using this
  pattern in a product, authenticate each request and derive the graph from
  that customer's server-side record. Stack keys can access all stack graphs.
- Connect-session links are short-lived bearer capabilities. Do not log,
  cache or send them to analytics. Creation is not automatically retried;
  request a fresh link after an unknown outcome or expiry.
- The demo reuses `app-<app id>` as its connection id. Reauthorization must
  keep the same selected resources. For a different selection, use a new
  graph and rebuild; changing only the connection id retains old graph data.
- Disconnect calls the SDK's graph-scoped `integrations.delete`. It clears
  the local connection and grant. It does not erase imported data, uninstall
  the provider app, or promise to revoke authorization at the provider.
- Source deletions and visibility changes have bounded handling. Full
  removal of a source's contributions, including every old property and
  relationship, is not complete. Stored source ACLs are not automatic query
  filters; enforce customer access in your backend.

See [Developer-owned integrations](https://docs.littlebigbrain.com/guides/developer-owned-integrations/)
for provider setup and the TypeScript/Python APIs.
