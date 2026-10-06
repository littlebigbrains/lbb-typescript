import type { LbbClient, Schemas } from "./client.js";
import type { CallOptions, RequestOptions } from "./transport.js";

/** Experimental, default-off CDC control and worker API. */
export class CdcNamespace {
  constructor(private readonly client: LbbClient) {}

  status(options?: CallOptions): Promise<Schemas["CdcStatus"]> {
    return this.client.request("GET", "/v1/cdc/status", options);
  }
  async metadata(
    graphEpoch: number,
    name: string,
    options?: CallOptions,
  ): Promise<Schemas["CdcMetadataDocument"] | null> {
    const answer = await this.client.request<Schemas["CdcMetadataResponse"]>(
      "GET",
      "/v1/cdc/metadata",
      { ...options, query: { graph_epoch: graphEpoch, name } },
    );
    return answer.document ?? null;
  }
  putMetadata(
    body: Schemas["CdcMetadataPutRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcMetadataDocument"]> {
    return this.post("metadata", body, { ...options, retry: false });
  }
  applyStatus(options?: CallOptions): Promise<Schemas["CdcStatus"]> {
    return this.client.request("GET", "/v1/cdc/apply/status", options);
  }
  captureStatus(options?: CallOptions): Promise<Schemas["CdcStatus"]> {
    return this.client.request("GET", "/v1/cdc/capture/status", options);
  }
  /** Source-scoped setup; the client's graph is not a destination or identity. */
  sourceDiscoveryStatus(
    connectionId: string,
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceDiscoveryStatus"]> {
    return this.client.request("GET", "/v1/cdc/source-discovery", {
      ...options,
      query: { connection_id: connectionId },
    });
  }
  /** Management-only: includes sealed credentials. Never expose as product status. */
  sourceDiscoveryInput(
    connectionId: string,
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceDiscoveryInput"]> {
    return this.client.request("GET", "/v1/cdc/source-discovery/input", {
      ...options,
      query: { connection_id: connectionId },
    });
  }
  createSourceDiscovery(
    connectionId: string,
    body: Schemas["CdcSourceDiscoveryCreateRequest"],
    options?: CallOptions,
  ): Promise<Schemas["SourceDiscoveryHead"]> {
    return this.post("source-discovery", body, {
      ...options,
      query: { connection_id: connectionId },
    });
  }
  claimSourceDiscovery(
    connectionId: string,
    body: Schemas["CdcSourceDiscoveryClaimRequest"],
    options?: CallOptions,
  ): Promise<Schemas["ReaderLease"]> {
    return this.post("source-discovery/claim", body, {
      ...options,
      query: { connection_id: connectionId },
    });
  }
  completeSourceDiscovery(
    connectionId: string,
    body: Schemas["CdcSourceDiscoveryCompleteRequest"],
    options?: CallOptions,
  ): Promise<Schemas["SourceDiscoveryHead"]> {
    return this.post("source-discovery/complete", body, {
      ...options,
      query: { connection_id: connectionId },
    });
  }
  failSourceDiscovery(
    connectionId: string,
    body: Schemas["CdcSourceDiscoveryFailRequest"],
    options?: CallOptions,
  ): Promise<Schemas["SourceDiscoveryHead"]> {
    return this.post("source-discovery/fail", body, {
      ...options,
      query: { connection_id: connectionId },
    });
  }
  cancelSourceDiscovery(
    connectionId: string,
    body: Schemas["CdcSourceDiscoveryCancelRequest"],
    options?: CallOptions,
  ): Promise<Schemas["SourceDiscoveryHead"]> {
    return this.post("source-discovery/cancel", body, {
      ...options,
      query: { connection_id: connectionId },
    });
  }
  /** Customer routing uses one source capture and independent graph deliveries. */
  sourceStatus(
    connectionId: string,
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceRoutingStatus"]> {
    return this.client.request("GET", "/v1/cdc/source/status", {
      ...options,
      query: { connection_id: connectionId },
    });
  }
  /** Management-only sealed source input. Do not expose it in a console response. */
  sourceInput(
    connectionId: string,
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceRoutingInput"]> {
    return this.client.request("GET", "/v1/cdc/source/input", {
      ...options,
      query: { connection_id: connectionId },
    });
  }
  prepareSource(
    connectionId: string,
    body: Schemas["CdcSourceRoutingPrepareRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceRoutingStatus"]> {
    return this.post("source/prepare", body, {
      ...options,
      query: { connection_id: connectionId },
      retry: false,
    });
  }
  startSource(
    connectionId: string,
    body: Schemas["CdcSourceRoutingStartRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceRoutingStatus"]> {
    return this.post("source/start", body, {
      ...options,
      query: { connection_id: connectionId },
      retry: false,
    });
  }
  pauseCustomer(
    connectionId: string,
    body: Schemas["CdcCustomerPauseRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceRoutingStatus"]> {
    return this.post("source/customer/pause", body, {
      ...options,
      query: { connection_id: connectionId },
      retry: false,
    });
  }
  issueSourceCredential(
    connectionId: string,
    body: Schemas["CdcSourceCredentialIssueRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceCredential"]> {
    return this.post("source/credentials", body, {
      ...options,
      query: { connection_id: connectionId },
      retry: false,
    });
  }
  revokeSourceCredential(
    connectionId: string,
    body: Schemas["CdcSourceCredentialRevokeRequest"],
    options?: CallOptions,
  ): Promise<{ ok: boolean }> {
    return this.post("source/credentials/revoke", body, {
      ...options,
      query: { connection_id: connectionId },
      retry: false,
    });
  }
  releaseSourceCapture(
    connectionId: string,
    body: Schemas["CdcSourceCaptureLeaseRequest"],
    options?: CallOptions,
  ): Promise<{ ok: boolean }> {
    return this.post("source/capture/release", body, {
      ...options,
      query: { connection_id: connectionId },
      retry: false,
    });
  }
  setSourceCaptureMode(
    connectionId: string,
    body: Schemas["CdcSourceCaptureModeRequest"],
    options?: CallOptions,
  ): Promise<{ ok: boolean }> {
    return this.post("source/capture/mode", body, {
      ...options,
      query: { connection_id: connectionId },
      retry: false,
    });
  }
  reconcileSource(
    connectionId: string,
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceRoutingStatus"]> {
    return this.post(
      "source/reconcile",
      {},
      { ...options, query: { connection_id: connectionId }, retry: false },
    );
  }
  discoveryStatus(
    options?: CallOptions,
  ): Promise<Schemas["CdcDiscoveryStatus"]> {
    return this.client.request("GET", "/v1/cdc/discovery", options);
  }
  /** Management-only input: includes encrypted credentials, never expose as product status. */
  discoveryInput(options?: CallOptions): Promise<Schemas["CdcDiscoveryInput"]> {
    return this.client.request("GET", "/v1/cdc/discovery/input", options);
  }
  createDiscovery(
    body: Schemas["CdcDiscoveryCreateRequest"],
    options?: CallOptions,
  ): Promise<Schemas["DiscoveryHead"]> {
    return this.post("discovery", body, options);
  }
  claimDiscovery(
    body: Schemas["CdcDiscoveryClaimRequest"],
    options?: CallOptions,
  ): Promise<Schemas["ReaderLease"]> {
    return this.post("discovery/claim", body, options);
  }
  completeDiscovery(
    body: Schemas["CdcDiscoveryCompleteRequest"],
    options?: CallOptions,
  ): Promise<Schemas["DiscoveryHead"]> {
    return this.post("discovery/complete", body, options);
  }
  failDiscovery(
    body: Schemas["CdcDiscoveryFailRequest"],
    options?: CallOptions,
  ): Promise<Schemas["DiscoveryHead"]> {
    return this.post("discovery/fail", body, options);
  }
  cancelDiscovery(
    body: Schemas["CdcDiscoveryCancelRequest"],
    options?: CallOptions,
  ): Promise<Schemas["DiscoveryHead"]> {
    return this.post("discovery/cancel", body, options);
  }
  reviewDiscovery(
    body: Schemas["DiscoveryApprovalRequest"],
    options?: CallOptions,
  ): Promise<Schemas["DiscoveryApproval"]> {
    return this.post("discovery/review", body, options);
  }
  approveDiscovery(
    body: Schemas["DiscoveryApprovalRequest"],
    options?: CallOptions,
  ): Promise<Schemas["DiscoveryHead"]> {
    return this.post("discovery/approve", body, options);
  }
  prepareDiscovery(
    body: Schemas["CdcDiscoveryPrepareRequest"],
    options?: CallOptions,
  ): Promise<Schemas["DiscoveryHead"]> {
    return this.post("discovery/prepare", body, options);
  }
  activateDiscovery(
    body: Schemas["CdcDiscoveryActivateRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcStatus"]> {
    return this.post("discovery/activate", body, options);
  }
  sourceConfiguration(
    options?: CallOptions,
  ): Promise<Schemas["CdcSourceConfiguration"]> {
    return this.client.request("GET", "/v1/cdc/source", options);
  }
  configureSource(
    body: Schemas["CdcSourceConfigureRequest"],
    options?: CallOptions,
  ): Promise<Schemas["Digest"]> {
    return this.post("source", body, options);
  }
  activate(
    body: Schemas["CdcActivateRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcStatus"]> {
    return this.post("activate", body, options);
  }
  claimApply(
    body: Schemas["CdcApplyClaimRequest"],
    options?: CallOptions,
  ): Promise<Schemas["ReaderLease"]> {
    return this.post("apply/claim", body, options);
  }
  renewApply(
    body: Schemas["CdcApplyRenewRequest"],
    options?: CallOptions,
  ): Promise<Schemas["ReaderLease"]> {
    return this.post("apply/renew", body, options);
  }
  releaseApply(
    body: Schemas["CdcApplyReleaseRequest"],
    options?: CallOptions,
  ): Promise<{ ok: boolean }> {
    return this.post("apply/release", body, options);
  }
  reconcile(
    body: Schemas["CdcReconcileRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcStatus"]> {
    return this.post("apply/reconcile", body, options);
  }
  next(
    body: Schemas["CdcApplyNextRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcApplyNext"]> {
    return this.post("apply/next", body, options);
  }
  apply(
    body: Schemas["ApplyRequest"],
    options?: CallOptions,
  ): Promise<Schemas["ApplyReceipt"]> {
    return this.post("apply/commit", body, options);
  }
  setApplyMode(
    body: Schemas["CdcApplyModeRequest"],
    options?: CallOptions,
  ): Promise<{ ok: boolean }> {
    // A successful mode change increments the generation; a lost response is
    // resolved by status, not a blind retry of the old generation.
    return this.post("apply/mode", body, { ...options, retry: false });
  }
  issueCredential(
    body: Schemas["CdcCredentialIssueRequest"],
    options?: CallOptions,
  ): Promise<Schemas["IssuedWorkerCredential"]> {
    // The bearer value exists only in this response. Lost responses leave a
    // short-lived orphan grant, never a reason to expose it in workflow state.
    return this.post("credentials", body, { ...options, retry: false });
  }
  revokeCredential(
    body: Schemas["CdcCredentialRevokeRequest"],
    options?: CallOptions,
  ): Promise<{ ok: boolean }> {
    return this.post("credentials/revoke", body, options);
  }
  claimCapture(
    body: Schemas["CdcCaptureClaimRequest"],
    options?: CallOptions,
  ): Promise<Schemas["ReaderLease"]> {
    return this.post("capture/claim", body, options);
  }
  renewCapture(
    body: Schemas["CdcCaptureRenewRequest"],
    options?: CallOptions,
  ): Promise<Schemas["ReaderLease"]> {
    return this.post("capture/renew", body, options);
  }
  restoreCapture(
    body: Schemas["CdcCaptureLeaseRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CdcCaptureRestore"]> {
    return this.post("capture/restore", body, options);
  }
  releaseCapture(
    body: Schemas["CdcCaptureLeaseRequest"],
    options?: CallOptions,
  ): Promise<{ ok: boolean }> {
    return this.post("capture/release", body, options);
  }
  setCaptureMode(
    body: Schemas["CdcCaptureModeRequest"],
    options?: CallOptions,
  ): Promise<{ ok: boolean }> {
    return this.post("capture/mode", body, { ...options, retry: false });
  }
  uploadSchema(
    body: Schemas["CdcCaptureSchemaRequest"],
    options?: CallOptions,
  ): Promise<Schemas["Digest"]> {
    return this.post("capture/schema", body, options);
  }
  append(
    body: Schemas["CdcCaptureAppendRequest"],
    options?: CallOptions,
  ): Promise<Schemas["CaptureReceipt"]> {
    return this.post("capture/append", body, options);
  }
  private post<T>(
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return this.client.request("POST", `/v1/cdc/${path}`, {
      retry: true,
      ...options,
      body,
    });
  }
}
