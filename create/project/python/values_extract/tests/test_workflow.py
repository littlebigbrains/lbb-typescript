"""The workflow on its samples, with mock models and no server: the SDK's
``WorkflowWorker`` runs it against a fake LBB (``fake_lbb.py``).

The mock reasoning model reads the first size (``60x40 cm`` or ``Breite 60
cm``) with its unit, the first material and the water supply of each text.
The mock decision model says a quote from a sentence about an accessory
(``Zubehör``) or a conditional variant (``Bei Einsatz``) does not support its
value. The values the workflow must write, and the values it must leave out,
come from the answer key ``samples/expected.json``.
"""

from __future__ import annotations

import json
import re
from typing import Any

from fake_lbb import FakeLbb, iri_of, message, serve

from values_extract.samples import SAMPLES
from values_extract.workflow import DEFAULTS

RECORDS: list[dict[str, str]] = json.loads((SAMPLES / "records.json").read_text(encoding="utf-8"))
EXPECTED: dict[str, Any] = json.loads((SAMPLES / "expected.json").read_text(encoding="utf-8"))
MATERIALS = [
    "Sanitärkeramik",
    "Stahl emailliert",
    "Mineralguss",
    "Edelstahl",
    "Kristallglas",
    "Keramik",
    "Glas",
]


def read_values(text: str) -> list[dict[str, str]]:
    """The mock reasoning model: the first size, material and water supply of a text."""
    values: list[dict[str, str]] = []
    size = re.search(r"(?:ca\. )?(\d+)x(\d+) cm", text)
    width = re.search(r"Breite (\d+) cm", text)
    if size:
        values += [
            {"property": "width_cm", "value": size[1], "unit": "cm", "quote": size[0]},
            {"property": "depth_cm", "value": size[2], "unit": "cm", "quote": size[0]},
        ]
    elif width:
        values.append({"property": "width_cm", "value": width[1], "unit": "cm", "quote": width[0]})
    found = [
        (m.start(), name)
        for name in MATERIALS
        if (m := re.search(rf"(?<![^\W\d_]){re.escape(name)}(?![^\W\d_])", text))
    ]
    if found:
        material = min(found)[1]
        values.append({"property": "material", "value": material, "unit": "", "quote": material})
    water = re.search(r"Anschluss[^.]*?(Kalt- und Warmwasser|Kaltwasser)", text)
    if water:
        values.append(
            {
                "property": "water_supply",
                "value": "kalt" if water[1] == "Kaltwasser" else "kalt und warm",
                "unit": "",
                "quote": water[0],
            }
        )
    return values


def support(text: str, instructions: str, options: list[str]) -> dict[str, Any]:
    """The mock decision model: the support of each quote, from the sentence that holds it."""
    found = re.search(r'Quote: "(.*)"$', instructions, re.S)
    assert found, instructions
    quote = found[1]
    sentence = next((s for s in re.split(r"(?<=\.)\s+", text) if quote in s), "")
    p = 0.05 if re.search("Zubehör|Bei Einsatz", sentence) else 0.6 if "etwa" in sentence else 0.92
    return {
        "choice": "supported" if p >= 0.5 else "not_supported",
        "confidence": max(p, 1 - p),
        "probabilities": {o: p if o == "supported" else (1 - p) / 2 for o in options},
    }


def fake_for(records: list[dict[str, str]]) -> FakeLbb:
    """A fake LBB over ``records``, with the mock models."""

    def rows(query: str) -> list[dict[str, str]]:
        return [
            {"s": iri_of(r["name"]), "label": r["name"], "text": r["text"]}
            for r in records
            if iri_of(r["name"]) in query
        ]

    def reason(body: dict[str, Any]) -> dict[str, Any]:
        return {"values": read_values(json.loads(body["prompt"])["text"])}

    def decide(body: dict[str, Any]) -> dict[str, Any]:
        text = body["state"]["text"]
        return {
            qid: support(text, q["instructions"], list(q["criteria"]))
            for qid, q in body["questions"].items()
        }

    return FakeLbb(rows, reason=reason, decide=decide)


def run_samples() -> FakeLbb:
    """The workflow on one message with every sample record."""
    fake = fake_for(RECORDS)
    fake.queue(message([iri_of(r["name"]) for r in RECORDS]))
    serve(fake)
    return fake


def matches(got: Any, want: dict[str, Any]) -> bool:
    """A number compares as a number; a text in lower case, trimmed, against ``accept``."""
    if isinstance(want["value"], (int, float)):
        return bool(got == want["value"])
    accepted = want.get("accept") or [str(want["value"]).lower()]
    return str(got).strip().lower() in accepted


def test_the_samples_give_the_values_of_the_answer_key() -> None:
    fake = run_samples()
    for record in EXPECTED["records"]:
        values = fake.written(record["name"])
        for want in record["values"]:
            assert matches(values.get(want["property"]), want), (record["name"], want)
        for out in record["leave_out"]:
            if out["value"] is None:
                assert out["property"] not in values, (record["name"], out)
            else:
                assert not matches(values.get(out["property"]), out), (record["name"], out)
        assert sorted(values) == sorted(v["property"] for v in record["values"]), record["name"]
    (done,) = fake.completed
    state = done["state"]
    assert state["instances"] == len(RECORDS)
    assert state["written"] == sum(len(r["values"]) for r in EXPECTED["records"])
    assert state["failed"] == 0


def test_each_value_has_a_source_whose_evidence_is_a_quote_of_the_text() -> None:
    fake = run_samples()
    texts = {r["name"]: r["text"] for r in RECORDS}
    edges = [edge for commit in fake.commits.values() for edge in commit.get("triplets", [])]
    assert len(edges) == sum(len(r["values"]) for r in EXPECTED["records"])
    for edge in edges:
        assert edge["relation"] == "HAS_VALUE_SOURCE"
        assert edge["target"]["type"] == "ValueSource"
        assert edge["evidence"]["text"] in texts[edge["source"]["name"]]
        assert edge["confidence"] >= DEFAULTS.gate
