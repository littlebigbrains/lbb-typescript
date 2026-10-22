"""The workflow on its samples, with mock models and no server: the SDK's
``WorkflowWorker`` runs it against a fake LBB (``fake_lbb.py``).

The mock reasoning model reads the first size (``120 x 80 cm``, else
``width 1.6 m`` and ``depth 800 mm``, or ``Breite 43``) with the unit the text
states, the first material and the color of each text. The mock decision
model says a quote from a sentence about an accessory (``Accessory:``) or a
variant under a condition (``For two screens:``) does not support its value,
and gives a quote that says ``about`` 0.6, below the gate. The values the
workflow must write, and the values it must leave out, come from the answer
key ``samples/expected.json``. Four values go to review instead: two sizes in
another unit, one without a unit, and one below the gate.
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
    "beech veneer",
    "oak veneer",
    "aluminium",
    "brushed stainless steel",
    "stainless steel",
    "bamboo",
    "Stahlblech",
    "plastic",
    "steel",
]


def sized(words: str) -> re.Pattern[str]:
    """A size with the unit the text states it in, if any: ``width 1.6 m``, ``Breite 43``."""
    return re.compile(rf"(?:{words}) (?:about )?(\d+(?:\.\d+)?)(?: (mm|cm|m)\b)?", re.I)


def read_values(text: str) -> list[dict[str, str]]:
    """The mock reasoning model: the first size, material and color of a text."""
    values: list[dict[str, str]] = []
    size = re.search(r"(\d+) x (\d+) cm", text)
    if size:
        values += [
            {"property": "width_cm", "value": size[1], "unit": "cm", "quote": size[0]},
            {"property": "depth_cm", "value": size[2], "unit": "cm", "quote": size[0]},
        ]
    else:
        for prop, words in (("width_cm", "width|Breite"), ("depth_cm", "depth|Tiefe")):
            if found := sized(words).search(text):
                values.append(
                    {"property": prop, "value": found[1], "unit": found[2] or "", "quote": found[0]}
                )
    found = [
        (m.start(), name)
        for name in MATERIALS
        if (m := re.search(rf"(?<![^\W\d_]){re.escape(name)}(?![^\W\d_])", text))
    ]
    if found:
        material = min(found)[1]
        values.append({"property": "material", "value": material, "unit": "", "quote": material})
    color = re.search(r"(?:Color|Farbe): ([^\W\d_]+)", text)
    if color:
        values.append({"property": "color", "value": color[1], "unit": "", "quote": color[0]})
    return values


def support(text: str, instructions: str, options: list[str]) -> dict[str, Any]:
    """The mock decision model: the support of each quote, from the quote and the sentence
    that holds it."""
    found = re.search(r'Quote: "(.*)"$', instructions, re.S)
    assert found, instructions
    quote = found[1]
    sentence = next((s for s in re.split(r"(?<=\.)\s+", text) if quote in s), "")
    if re.match(r"(?:Accessory|For [^:]+):", sentence):
        p = 0.05
    else:
        p = 0.6 if re.search(r"\babout\b", quote, re.I) else 0.92
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


# The values of the answer key that go to a person for review: two sizes the
# text states in another unit (the key's ``stated``), one whose quote states
# no unit, and one whose quote says ``about``.
REVIEWED = {("T-160", "width_cm"), ("T-160", "depth_cm"), ("R-3", "width_cm"), ("K-17", "width_cm")}
KEY_VALUES = sum(len(r["values"]) for r in EXPECTED["records"])


def test_the_samples_give_the_values_of_the_answer_key() -> None:
    fake = run_samples()
    for record in EXPECTED["records"]:
        values = fake.written(record["name"])
        written = [v for v in record["values"] if (record["name"], v["property"]) not in REVIEWED]
        for want in written:
            assert matches(values.get(want["property"]), want), (record["name"], want)
        for out in record["leave_out"]:
            if out["value"] is None:
                assert out["property"] not in values, (record["name"], out)
            else:
                assert not matches(values.get(out["property"]), out), (record["name"], out)
        assert sorted(values) == sorted(v["property"] for v in written), record["name"]
    asked = {(q["subject"]["name"], q["question"]["property"]) for q in fake.reviews.values()}
    assert asked == REVIEWED
    (done,) = fake.completed
    state = done["state"]
    assert state["instances"] == len(RECORDS)
    assert state["written"] == KEY_VALUES - len(REVIEWED)
    assert state["review"] == len(REVIEWED)
    assert state["failed"] == 0


def test_each_value_has_a_source_whose_evidence_is_a_quote_of_the_text() -> None:
    fake = run_samples()
    texts = {r["name"]: r["text"] for r in RECORDS}
    edges = [edge for commit in fake.commits.values() for edge in commit.get("triplets", [])]
    assert len(edges) == KEY_VALUES - len(REVIEWED)
    for edge in edges:
        assert edge["relation"] == "HAS_VALUE_SOURCE"
        assert edge["target"]["type"] == "ValueSource"
        assert edge["evidence"]["text"] in texts[edge["source"]["name"]]
        assert edge["confidence"] >= DEFAULTS.gate
