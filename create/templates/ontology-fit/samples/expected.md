# Fit from text samples: what a good run proposes

The five texts in `texts.json` are invented field notes and meeting minutes
of the facilities team of an office building. They follow the issues found
in the building over four weeks: in which room, which vendor must fix each
one, by when, and whether it is fixed. The graph has no class for an issue,
so a fit run over these texts should propose one, with the facts the texts
give about each issue. Texts are numbered 1 to 5 in the order of
`texts.json`.

## The graph before the run

Each text is an instance of `FieldNote`: its name is the label, its text is
the property `text`. The ontology holds:

| Class | Properties |
| --- | --- |
| `FieldNote` | `text` (text), `date` (datetime) |
| `Room` | `number` (keyword), `purpose` (text) |
| `Vendor` | `name` (text), `trade` (keyword) |

| Relation | From | To |
| --- | --- | --- |
| `concerns_room` | `FieldNote` | `Room` |
| `attended_by` | `FieldNote` | `Vendor` |

The fit source:

```json
{
  "class": "FieldNote",
  "name": "field-notes",
  "from": ["text"],
  "context": "Field notes and meeting minutes of the facilities team of an office building"
}
```

## Proposals a good run makes

The names follow the ontology: lower snake_case in ASCII (`assigned_to` for
"Assigned to"). A run can spell a name another way with the same meaning.
The keys hold for the names in this table (a suggestion key keeps lowercase
ASCII letters and digits, and writes every other run of characters as one
dash; a missing class in a widen key is `x`).

| Change | Key | Texts | Quote (one of them) |
| --- | --- | --- | --- |
| Add class `Issue` | `fit:field-notes/add_class/issue` | 1 to 5 | "The issue was reported to Example Tiling Ltd" |
| Add property `due_date` (datetime) to `Issue` | `fit:field-notes/add_property/issue/due-date` | 1 to 4 | "the repair is due on 2026-09-16" |
| Add property `status` (keyword: `open`, `resolved`) to `Issue` | `fit:field-notes/add_property/issue/status` | 3 to 5 | "due 2026-09-23, status open" |
| Add relation `assigned_to` from `Issue` to `Vendor` | `fit:field-notes/add_relation/issue/assigned-to/vendor` | 1 to 4 | "Assigned to Demo Partitions Ltd" |
| Let `concerns_room` start at `Issue` | `fit:field-notes/widen_relation/concerns-room/issue/x` | 1 to 5 | "in room 0.12 the mirror above the washbasin is missing" |

The last row tests reuse. Every issue names its room, and the ontology
already has a relation to `Room`, so a good run widens `concerns_room`. A
new relation from `Issue` to `Room` with another name (`located_in`,
`found_in`) is a synonym of it.

## Proposals a good run may make

- Add property `severity` (keyword: `major`, `minor`) to `Issue`. Only
  text 5 gives it: "the facilities manager rates this issue as minor".
- Add property `description` (text) to `Issue`.
- Add relation `records` from `FieldNote` to `Issue`, for the note that
  records an issue.
- Add class `Asset`, for the part an issue concerns (floor tiles, mirror,
  partition).
- Add class `Inspection` with a date. Only text 5 names it.
- Add class `Delivery` with a `delivery_date` (datetime). Texts 2 and 4
  follow the delivery of the ceiling lights.

## Proposals a good run does not make

- A relation from `FieldNote` to `Vendor` for the vendors present
  ("Present: …", "Attendees: …"). `attended_by` holds it; the check drops
  such a change as `already_covered`.
- A property for the date of a note. `date` holds it.
- A class for one vendor, one room or one issue (`Example Tiling Ltd`,
  `Corridor 0.10`, `Partition of stall 2`). These are instances.
- A second name for a change the run proposes: `Issues` or `Defect` beside
  `Issue`, `deadline` beside `due_date`, `responsible` beside
  `assigned_to`.

## How to check a run

1. Every change in "Proposals a good run makes" is filed.
2. No change in "Proposals a good run does not make" is filed.
3. Every filed quote is in its text, with whitespace runs as one space, and
   holds at least three words.
