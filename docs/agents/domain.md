# Domain docs

This repository uses a single-context domain documentation layout:

- `GLOSSARY.md` at the repository root defines domain vocabulary.
- `docs/adr/` contains architecture decision records.

## Before exploring

Read `GLOSSARY.md` and the ADRs relevant to the area being explored.

If these files do not exist, proceed silently. The `domain-modeling`
skill creates them when terms or decisions are resolved.

## Use the glossary's vocabulary

Use the glossary's terms in issue titles, proposals, code, and tests.
Respect any synonyms the glossary explicitly avoids.

If a needed concept is missing, reconsider whether it belongs to the
domain or note the gap for `domain-modeling`.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, name the ADR and explain
why the decision should be reconsidered.
