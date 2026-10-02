# Multi-Device / Multi-SIM — installation units

Implements the approved design: a close installs **N units**; each unit is one
terminal (one device, at most one SIM, optional TID). The unit *is* the
Device↔SIM pairing and is written only inside the close transaction.

## Data model (migration `0060_courier_execution_units_add`, additive)

`courier_execution_units(id, request_id, execution_id, unit_no, device_item_id, device_serial,
sim_item_id, sim_serial, sim_waived, tid, pairing_source, created_at)`

| Rule | Enforced by |
|---|---|
| one device per unit, SIM optional or explicitly waived | `sim_consistency` CHECK |
| a SIM is never its own device | `device_ne_sim` CHECK |
| a device appears once per request; a SIM appears once per request | `UNIQUE(request_id, device_item_id)`, partial `UNIQUE(request_id, sim_item_id)` |
| unit numbers 1..N per request | `UNIQUE(request_id, unit_no)`, `unit_no >= 1` CHECK |
| `pairing_source` ∈ EXPLICIT, LEGACY_INFERRED, LEGACY_BACKFILL | CHECK |
| items are real inventory items | FK to `items(id)`, ON DELETE RESTRICT |

`courier_request_items` gains `execution_unit_id` (the unit an INSTALLED item belongs to), `item_id`
(replaces the dead integer `inventory_item_id`, kept untouched) and an index on `request_id`.

Rollback: `DROP TABLE courier_execution_units CASCADE;` and drop the three added request-item
objects. Nothing existing is altered or backfilled by this migration.

Not applied yet (separate governed migrations): `courier_request_items.status` CHECK, the
active-serial uniqueness index, the `INSTALLED ⇒ execution_unit_id` constraint, the legacy backfill.

## Close contract

`POST /api/courier/executions/:requestId` (portal), `POST /api/courier/requests/:requestId/execution-attempts`
(mobile, status SUCCESS) and `POST /api/courier/pdf/:id/apply` accept:

```json
{ "installationStatus": "Installation Completed - NL",
  "units": [ { "deviceSerial": "A1", "simSerial": "S1", "tid": "T1" },
             { "deviceSerial": "A2", "simWaived": true } ],
  "paperRollQty": 2, "version": 3 }
```

`POST /api/courier/pdf/:id/complete` (Telegram bot / PDF approval) keeps `devices[]`; each card becomes
an explicit unit: `{ sn, sim_serial, tid, sim_waived? }`.

Precedence: `units[]` → explicit `pairs[]` → legacy fields (`sn`, `simSerial`, `deviceSerials[]`,
`simSerials[]`). One device + one SIM in legacy fields is unambiguous (`EXPLICIT`). Several are paired
by order and recorded `LEGACY_INFERRED` (audit action `UNIT_PAIRING_INFERRED`). When the transition
period ends (`COURIER_REQUIRE_EXPLICIT_PAIRING=true`) they are refused with `PAIRING_REQUIRED`.

Responses are unchanged, plus `execution.units[]`; `execution.sn` / `simSerial` still hold unit 1.

### Validation and errors (all 422)

| Code | Meaning |
|---|---|
| `UNIT_DEVICE_REQUIRED` | no device / empty units |
| `UNIT_SIM_WITHOUT_DEVICE` | a SIM with no device (also: more SIMs than devices in legacy lists) |
| `UNIT_SIM_MISSING_NOT_WAIVED` | device without SIM and without `simWaived` |
| `UNIT_SIM_WAIVER_CONFLICT` | a SIM serial together with `simWaived` |
| `UNIT_DUPLICATE_DEVICE` / `UNIT_DUPLICATE_SIM` | repeated serial (any spelling) or repeated physical item |
| `UNIT_ROLE_MISMATCH` | item category does not match its role (`devices` / `sim`) |
| `UNIT_LIMIT_EXCEEDED` | more than 20 units |
| `UNIT_INVALID_PAYLOAD` | `units` is not a list of objects |
| `PAIRING_REQUIRED` | unpaired lists after the transition period |
| `GUARD_VALIDATION_FAILED`, `INVENTORY_DEDUCTION_REJECTED` (422) / `_TRANSIENT` (503), `REQUEST_ITEM_TRANSITION_INVALID`, `CONSUMABLE_QUANTITY_INVALID` | unchanged |

A unit count different from the request's assigned devices is **not** an error: the close succeeds and
`UNIT_COUNT_MISMATCH` is audited.

## Transaction boundary

Before: parse/normalize units → structural checks → guards (read-only; custody, category, one owner,
no repeated item) → engine prepare. Transaction: save execution → insert units → bind/INSTALL request
items (linked to their unit) → lock every device and SIM `FOR UPDATE` in item-id order, re-check
custody, scan out → consumables → completion row → `CLOSED_SUCCESS` → audit → outbox. Any failure
rolls everything back; a request deducts once (`UNIQUE(request_id)` on the completion row).

## Telegram bot

The bot is a client only: it validates (serial-lookup per device and SIM), then calls
`POST /api/courier/pdf/{id}/update-extracted` and `/complete` with its `devices[]` cards. The backend
validates again and owns deduction and closing. To declare a device without a SIM the bot must send
`"sim_waived": true` on that card (one line in `push_session_to_rassco`; see the PR). The end-to-end
test (`__integration__/telegram-bot-e2e.test.ts`) runs the real bot module against a real backend and
PostgreSQL; it is skipped unless `BOT_E2E_MODULE` / `BOT_E2E_PYTHON` are set because the bot lives
outside this repository.

## Support limits

Proven: 1, 2, 3, 5 and 20 (the maximum) devices with SIMs through HTTP; 2 and 5 through the real bot.
Not proven: more than 20 (refused by design), production data volume, the Flutter app's behaviour.
