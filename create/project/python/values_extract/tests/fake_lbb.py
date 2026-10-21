"""A fake LBB for the test of the workflow, in memory: the workflow engine,
the model activities with the mock rules the test gives, the SPARQL rows of
the samples, commits and review items. The real ``WorkflowWorker`` and
``lbb_activities`` of the SDK run against it, so the test needs no server."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable
from typing import Any

import httpx
from lbb import AsyncLbbClient
from lbb.workflows import WorkflowWorker, lbb_activities

from values_extract.workflow import DEFAULTS, Settings, create_workflow

BASE = "/v1/workflows/turns"
TIME = "2026-10-21T10:00:00Z"

# The rows of a SPARQL query: `s` (the IRI), `label` and `text`.
Rows = Callable[[str], list[dict[str, str]]]
# The value of the reasoning model for a `reason` request.
Reason = Callable[[dict[str, Any]], dict[str, Any]]
# The answers of the decision model for a `decide` request, by question id.
Decide = Callable[[dict[str, Any]], dict[str, Any]]


def iri_of(name: str, class_name: str = DEFAULTS.class_name) -> str:
    """The IRI of the instance ``name`` in the fake graph."""
    digest = hashlib.sha256(f"{class_name}:{name}".encode()).hexdigest()[:32]
    return f"https://littlebigbrain.com/e/{digest}"


def message(iris: list[str]) -> dict[str, Any]:
    """The message the triggered workflow sends for new or changed instances."""
    return {
        "type": "instances",
        "workflow": "values-extract",
        "graph": "main",
        "as_of_commit_seq": 1,
        "reason": "changed",
        "instances": iris,
        "removed": [],
    }


class FakeLbb:
    """The routes the workflow calls. Each queued message is one turn,
    claimed in order."""

    def __init__(self, rows: Rows, *, reason: Reason, decide: Decide) -> None:
        self.rows = rows
        self.reason = reason
        self.decide = decide
        self.turns = 0
        self.pending: list[dict[str, Any]] = []
        self.model_calls: list[str] = []
        self.commits: dict[str, dict[str, Any]] = {}
        # The review items the workflow filed, by key.
        self.reviews: dict[str, dict[str, Any]] = {}
        self.requeued: list[str] = []
        self.completed: list[dict[str, Any]] = []

    def queue(self, message: dict[str, Any]) -> None:
        """A turn for ``message``, claimed next."""
        self.turns += 1
        number = self.turns
        workflow_id = f"starter.{message['workflow']}"
        self.pending.append(
            {
                "workflow_type": "values-extract",
                "state": {},
                "token": f"token-{number}",
                "lease_ms": 60_000,
                "effect_prefix": f"e{number}",
                "turn": {
                    "workflow_id": workflow_id,
                    "number": number,
                    "message_id": f"{workflow_id}-{number}",
                    "message": message,
                    "version": "v1",
                    "status": "running",
                    "attempt": 1,
                    "created_at_ms": 1,
                    "updated_at_ms": 1,
                    "ready_at_ms": 1,
                    "steps": [],
                    "result": None,
                    "state_after": None,
                    "sequence": 1,
                    "run": {"id": f"run-{number}", "started_at_ms": 1, "queue_before": 1},
                },
            }
        )

    def sparql(self, query: str) -> dict[str, Any]:
        bindings = []
        for row in self.rows(query):
            binding = {"s": {"type": "uri", "value": row["s"]}}
            for name, value in row.items():
                if name != "s":
                    binding[name] = {"type": "literal", "value": value}
            bindings.append(binding)
        doc = {"head": {"vars": ["s", "label", "text"]}, "results": {"bindings": bindings}}
        return {"results": json.dumps(doc)}

    def model(self, kind: str, body: dict[str, Any]) -> httpx.Response:
        self.model_calls.append(body.get("effect_id", ""))
        usage = {"model": "mock", "tokens_in": 10, "tokens_out": 5, "cost_micro_usd": 1}
        if kind == "reason":
            answer = {"value": self.reason(body), **usage, "cached": False}
        else:
            answer = {"answers": self.decide(body), **usage, "cached": False}
        return httpx.Response(200, json=answer)

    def item_of(self, request: dict[str, Any]) -> dict[str, Any]:
        """A review item as the server keeps it: open, with no answer yet."""
        key = request["key"]
        return {
            "id": f"rev_{key[-8:]}",
            "object": "review_item",
            "created": TIME,
            "updated": TIME,
            "kind": request["kind"],
            "scope": "live",
            "status": "open",
            "key": key,
            "title": request["title"],
            "rationale": request.get("rationale"),
            "origin": request["origin"],
            "workflow": request.get("workflow"),
            "subject": request.get("subject"),
            "question": request["question"],
            "evidence": request.get("evidence", []),
            "evidence_hash": request.get("evidence_hash"),
            "facts": request.get("facts"),
            "revision": 1,
        }

    async def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body: Any = json.loads(request.content) if request.content else None
        if path == f"{BASE}/claim":
            task = self.pending.pop(0) if self.pending else None
            return httpx.Response(200, json={"task": task})
        if path == f"{BASE}/complete":
            self.completed.append(body)
            return httpx.Response(200, json={})
        if path.startswith(BASE):
            # Checkpoints and heartbeats: one attempt per turn needs no saved steps.
            return httpx.Response(200, json={})
        if path == "/v1/workflows/activities/reason":
            return self.model("reason", body)
        if path == "/v1/workflows/activities/decide":
            return self.model("decide", body)
        if path == "/v1/query/sparql-text":
            return httpx.Response(200, json=self.sparql(body["query"]))
        if path == "/v1/graph/commit":
            key = request.headers["idempotency-key"]
            replayed = key in self.commits
            self.commits.setdefault(key, body)
            return httpx.Response(
                200,
                json={
                    "commit_seq": list(self.commits).index(key) + 1,
                    "idempotency_key": key,
                    "replayed": replayed,
                    "entities_written": len(body.get("entity_properties", [])),
                    "edges_written": len(body.get("triplets", [])),
                },
            )
        if path == "/v1/reviews" and request.method == "POST":
            self.reviews[body["key"]] = body
            return httpx.Response(200, json=self.item_of(body))
        if path == "/v1/reviews":
            keys = [key for key in request.url.params.get("key", "").split(",") if key]
            data = [
                self.item_of(self.reviews[key])
                for key in dict.fromkeys(keys)
                if key in self.reviews
            ]
            return httpx.Response(
                200, json={"object": "list", "data": data, "has_more": False, "next_cursor": None}
            )
        if path == "/v1/workflows/named/requeue":
            self.requeued += [item["instance"] for item in body["items"]]
            return httpx.Response(
                200,
                json={
                    "attempt": 1,
                    "requeued": [item["instance"] for item in body["items"]],
                    "exhausted": [],
                    "not_before": TIME,
                },
            )
        raise AssertionError(f"the fake LBB has no route {request.method} {path}")

    def written(self, name: str, class_name: str = DEFAULTS.class_name) -> dict[str, Any]:
        """The values written on the instance ``name``, over every commit."""
        values: dict[str, Any] = {}
        for commit in self.commits.values():
            for row in commit.get("entity_properties", []):
                if row["type"] == class_name and row["name"] == name:
                    values.update(row["properties"])
        return values


def serve(fake: FakeLbb, settings: Settings = DEFAULTS) -> None:
    """Run the workflow with the SDK's worker on each queued turn."""

    async def main() -> None:
        async with AsyncLbbClient(
            "http://localhost:7400",
            graph="main",
            retry_delay=0,
            transport=httpx.MockTransport(fake.handle),
        ) as client:
            workflow = create_workflow(lbb_activities(client), settings)
            worker = WorkflowWorker(client, [workflow], worker="test-1")
            while fake.pending:
                await worker.run_once()

    asyncio.run(main())
