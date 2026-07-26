# 0020. The identity chip shows the key, not a name

Status: Accepted — 2026-07-26

## Context

The approved design page draws the sidebar footer as an avatar disc with the initials `dr`, the username `daniel`, and the masked key `bb_9f2c…6b54`, above a `change key` control. `ui-spec.md` §3.14 calls that footer chip "the entire account surface" — there is deliberately no Account nav and no profile screen, because there is no account system.

The SPA cannot source the name. Authentication is a bare API key: the client sends `Authorization: Bearer bb_…`, and the server stores only the key's SHA-256 digest. There is no `/me` endpoint, no user object on any response, and no claim embedded in the key — `api-contract.md` §1 lists ten routes and none of them describes the caller. The `daniel` in the design is sample data from the seed script, which happens to name its two users, and it was mistaken for a field.

That leaves three options: invent the name, fetch it from somewhere, or drop it.

## Decision

The identity chip renders the masked key alone — `bb_9f2ce4a1…6b54`, mono, `--text-dim` — with the `change key` control beneath it. No name, no avatar disc, no initials.

The masking is first nine characters, an ellipsis, last four. That is enough for an operator to tell two keys apart when switching between them, which is the only job the chip has, without putting a full credential on screen where a screenshot or a shoulder would capture it.

## Alternatives considered

- **Add a `GET /me` endpoint returning the user's name.** The honest way to keep the design as drawn. Rejected on scope and on value: it means a new route, an api-contract entry, a serializer, an auth test and a supplemental suite, to render a word that changes nothing about what the operator can do. `users` is the api package's private table and nothing else in the product reads from it; opening a route onto it to satisfy one decorative line is a poor trade, and it would be the first endpoint outside `/tasks*`, `/events`, `/health` — which `api-contract.md` §9 defines as a **breaking change to the route-ownership contract**. Not worth it for a label.
- **Derive a display name from the key** (a hash-to-name, or the key prefix styled as an identity). Rejected: it manufactures an identity the system does not have. A name that looks like a name but is a hash of a credential is worse than no name, because it invites the operator to believe the system knows who they are.
- **Keep `daniel` as a static placeholder.** Rejected without much thought. It would be correct on exactly one machine — the one whose seed script wrote that user — and a lie everywhere else. This is the failure mode the product's whole pitch is against.

## Consequences

- The sidebar footer is shorter than the design draws, and the avatar disc is gone. This is a visible departure from a frozen design page and is recorded as one in `docs/ui-spec.md` §7.
- Nothing else changes: `change key` still clears the stored key and returns to the gate, and the chip is still the entire account surface.
- The rule generalises, and is worth stating once here rather than re-deciding per screen: **where the design shows a value no endpoint can supply, the value is dropped, not approximated.** The same reasoning removed "queued behind 3 tasks" from the queued state note — queue position is not derivable from any endpoint either — while `attempt budget 3`, which is just `max_attempts`, stayed.
- If an account system ever exists, this is a one-line change in one component, because the chip was never given a name-shaped prop to fill.
