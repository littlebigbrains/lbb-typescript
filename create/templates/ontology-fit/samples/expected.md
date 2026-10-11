# Fit from text samples: what a good run proposes

The five texts in `texts.json` are invented site reports and meeting minutes
of one project, Neubau Grundschule Musterstadt. They follow the defects found
on site over four weeks: in which room, which company must fix each one, by
when, and whether it is fixed. The graph has no class for a defect, so a fit
run over these texts should propose one, with the facts the texts give about
each defect. Texts are numbered 1 to 5 in the order of `texts.json`.

## The graph before the run

Each text is an instance of `Baustellenbericht`: its name is the label, its
text is the property `text`. The ontology holds:

| Class | Properties |
| --- | --- |
| `Baustellenbericht` | `text` (text), `datum` (datetime) |
| `Raum` | `nummer` (keyword), `bezeichnung` (text) |
| `Firma` | `name` (text), `gewerk` (keyword) |

| Relation | From | To |
| --- | --- | --- |
| `betrifft_raum` | `Baustellenbericht` | `Raum` |
| `anwesend` | `Baustellenbericht` | `Firma` |

The fit source:

```json
{
  "class": "Baustellenbericht",
  "name": "berichte",
  "from": ["text"],
  "context": "Site reports and meeting minutes of a school building project, in German"
}
```

## Proposals a good run makes

The names follow the ontology: lower snake_case in ASCII (`zustaendig` for
"zuständig"). A run can spell a name another way with the same meaning. The
keys hold for the names in this table (a suggestion key keeps lowercase ASCII
letters and digits, and writes every other run of characters as one dash; a
missing class in a widen key is `x`).

| Change | Key | Texts | Quote (one of them) |
| --- | --- | --- | --- |
| Add class `Mangel` | `fit:berichte/add_class/mangel` | 1 to 5 | "Der Mangel wurde der Fliesenbau Muster GmbH gemeldet" |
| Add property `frist` (datetime) to `Mangel` | `fit:berichte/add_property/mangel/frist` | 1 to 4 | "die Frist zur Beseitigung endet am 16.09.2026" |
| Add property `status` (keyword: `offen`, `behoben`) to `Mangel` | `fit:berichte/add_property/mangel/status` | 3 to 5 | "Frist 23.09.2026, Status offen" |
| Add relation `zustaendig` from `Mangel` to `Firma` | `fit:berichte/add_relation/mangel/zustaendig/firma` | 1 to 4 | "Zuständig ist die Trockenbau Probe GmbH" |
| Let `betrifft_raum` start at `Mangel` | `fit:berichte/widen_relation/betrifft-raum/mangel/x` | 1 to 5 | "In Raum 0.12 fehlt der Spiegel über dem Waschtisch" |

The last row tests reuse. Every defect names its room, and the ontology
already has a relation to `Raum`, so a good run widens `betrifft_raum`. A new
relation from `Mangel` to `Raum` with another name (`liegt_in`,
`befindet_sich_in`) is a synonym of it.

## Proposals a good run may make

- Add property `einstufung` (keyword: `wesentlich`, `unwesentlich`) to
  `Mangel`. Only text 5 gives it: "die Bauleitung stuft diesen Mangel als
  unwesentlich ein".
- Add property `beschreibung` (text) to `Mangel`.
- Add relation `stellt_fest` from `Baustellenbericht` to `Mangel`, for the
  report that records a defect.
- Add class `Bauteil`, for the part a defect concerns (Bodenfliesen, Spiegel,
  Trennwand).
- Add class `Abnahme` with a date. Only text 5 names it.
- Add class `Lieferung` with a `liefertermin` (datetime). Texts 2 and 4 give
  the delivery date of the ceiling lights.

## Proposals a good run does not make

- A relation from `Baustellenbericht` to `Firma` for the companies present
  ("Anwesend: …", "Teilnehmer: …"). `anwesend` holds it; the check drops
  such a change as `already_covered`.
- A property for the date of a report. `datum` holds it.
- A class for one company, one room or one defect (`Fliesenbau Muster GmbH`,
  `Flur 0.10`, `Trennwand Kabine 2`). These are instances.
- A second name for a change the run proposes: `Maengel` or `Defect` beside
  `Mangel`, `deadline` beside `frist`, `verantwortlich` beside `zustaendig`.

## How to check a run

1. Every change in "Proposals a good run makes" is filed.
2. No change in "Proposals a good run does not make" is filed.
3. Every filed quote is in its text, with whitespace runs as one space, and
   holds at least three words.
