import type { LbbClient } from "./client.js";
import type { CallOptions } from "./transport.js";
import type { Schemas } from "./types.js";

export interface CatalogPageOptions extends CallOptions {
  cursor?: string;
  limit?: number;
}

export interface CatalogNamespacePageOptions extends CatalogPageOptions {
  parentId?: string;
}

export interface CatalogGraphPageOptions extends CatalogPageOptions {
  ownerId?: string;
  includeDescendants?: boolean;
}

/** Optional application ownership. Every method requires an environment key. */
export class CatalogNamespace {
  constructor(private readonly client: LbbClient) {}

  root(opts: CallOptions = {}): Promise<Schemas["CatalogNamespaceIdentity"]> {
    return this.client.request("GET", "/v1/catalog/root", opts);
  }

  createNamespace(
    body: Schemas["CatalogNamespaceCreateRequest"],
    opts: CallOptions & { idempotencyKey: string },
  ): Promise<Schemas["CatalogNamespace"]> {
    return this.client.request("POST", "/v1/catalog/namespaces", {
      ...opts,
      body,
    });
  }

  namespace(
    id: string,
    opts: CallOptions = {},
  ): Promise<Schemas["CatalogNamespace"]> {
    return this.client.request("GET", "/v1/catalog/namespace", {
      ...opts,
      query: { id },
    });
  }

  resolve(
    path: string,
    opts: CallOptions = {},
  ): Promise<Schemas["CatalogNamespace"]> {
    return this.client.request("GET", "/v1/catalog/namespaces/resolve", {
      ...opts,
      query: { path },
    });
  }

  namespaces(
    options: CatalogNamespacePageOptions = {},
  ): Promise<Schemas["CatalogNamespacePage"]> {
    const { cursor, limit, parentId, ...opts } = options;
    return this.client.request("GET", "/v1/catalog/namespaces", {
      ...opts,
      query: { cursor, limit, parent_id: parentId },
    });
  }

  /** Adopt the client's existing graph at exactly the supplied epoch. */
  adoptGraph(
    body: Schemas["CatalogGraphAdoptRequest"],
    opts: CallOptions & { idempotencyKey: string },
  ): Promise<Schemas["CatalogGraph"]> {
    return this.client.request("POST", "/v1/catalog/graphs/adopt", {
      ...opts,
      body,
    });
  }

  graph(opts: CallOptions = {}): Promise<Schemas["CatalogGraph"]> {
    return this.client.request("GET", "/v1/catalog/graph", opts);
  }

  /** Continue until next_cursor is null, including through empty pages. */
  graphs(
    options: CatalogGraphPageOptions = {},
  ): Promise<Schemas["CatalogGraphPage"]> {
    const { cursor, limit, ownerId, includeDescendants, ...opts } = options;
    return this.client.request("GET", "/v1/catalog/graphs", {
      ...opts,
      query: {
        cursor,
        limit,
        owner_id: ownerId,
        include_descendants: includeDescendants,
      },
    });
  }
  pendingOperations(
    options: CatalogPageOptions = {},
  ): Promise<Schemas["CatalogOperationPage"]> {
    const { cursor, limit, ...opts } = options;
    return this.client.request("GET", "/v1/catalog/operations", {
      ...opts,
      query: { cursor, limit },
    });
  }

  repairOperation(
    operationId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["CatalogOperationRepairResponse"]> {
    return this.client.request("POST", "/v1/catalog/operations/repair", {
      ...opts,
      body: { operation_id: operationId },
      retry: opts.retry ?? true,
    });
  }

  repairIndexes(
    body: Schemas["CatalogIndexRepairRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["CatalogIndexRepairResponse"]> {
    return this.client.request("POST", "/v1/catalog/indexes/repair", {
      ...opts,
      body,
      retry: opts.retry ?? true,
    });
  }
}

/** Short-lived read credentials; delegated tokens cannot administer access. */
export class AccessNamespace {
  constructor(private readonly client: LbbClient) {}

  createReadToken(
    body: Schemas["ScopedTokenRequest"],
    opts: CallOptions = {},
  ): Promise<Schemas["ScopedTokenResponse"]> {
    return this.client.request("POST", "/v1/access/tokens", { ...opts, body });
  }

  revokeToken(
    credentialId: string,
    opts: CallOptions = {},
  ): Promise<Schemas["ScopedTokenRevokeResponse"]> {
    return this.client.request("POST", "/v1/access/tokens/revoke", {
      ...opts,
      retry: opts.retry ?? true,
      body: { credential_id: credentialId },
    });
  }
}
