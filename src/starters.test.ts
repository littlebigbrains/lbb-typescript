import { test } from "node:test";
import assert from "node:assert/strict";
import { starters, type StarterTerms } from "./index.js";

test("starter terms carry the IRIs the RDF projection mints", () => {
  const { crm, documents, work } = starters;
  assert.equal(crm.id, "crm");
  assert.equal(
    crm.classes.Organization.iri,
    "https://littlebigbrain.com/class/organization",
  );
  assert.deepEqual(crm.classes.User.superTypes, ["Person"]);
  assert.equal(
    crm.classes.LineItem.iri,
    "https://littlebigbrain.com/class/lineitem",
  );
  assert.equal(
    crm.properties.domain.iri,
    "https://littlebigbrain.com/p/domain",
  );
  assert.equal(crm.properties.close_date.valueType, "date_time");
  assert.equal(
    crm.relations.WORKS_AT.iri,
    "https://littlebigbrain.com/r/works_at",
  );
  assert.equal(crm.relations.WORKS_AT.inverse, "EMPLOYS");
  assert.equal(
    crm.relations.WORKS_AT.inverseIri,
    "https://littlebigbrain.com/r/employs",
  );
  assert.equal(work.relations.RELATED_TO.inverse, null);
  assert.equal(work.relations.RELATED_TO.inverseIri, null);
  assert.equal(documents.classes.Page.superTypes[0], "Document");
});

test("every starter lists its competency questions in order", () => {
  const all: readonly StarterTerms[] = [
    starters.crm,
    starters.documents,
    starters.work,
  ];
  for (const starter of all) {
    assert.ok(starter.questions.length > 0, starter.id);
    for (const [index, question] of starter.questions.entries()) {
      assert.equal(
        question.id,
        `${starter.id === "documents" ? "doc" : starter.id}-${String(index + 1).padStart(2, "0")}`,
      );
      assert.ok(question.text.length > 0);
    }
  }
  assert.equal(starters.crm.questions.length, 30);
});
