---
name: decisions
description: Use only where a CFMS session start line names the cfms:decisions skill. Before doing anything that goes against one of the user's CFMS decisions or standing rules, stop and quote it; when the user says something is a decision or a standing rule, record it in their words through the CFMS dialog.
user-invocable: false
---

## The catch

The CFMS decisions text in your context holds the user's standing rules and decisions in their own words, each with its date. Before you do anything that goes against one, stop before doing it and say exactly:

On <date> you said: '<his words>'. This goes against it. Does it still hold?

<date> is the entry's date as shown, and <his words> is the entry exactly as shown, never shortened or reworded. Then end your turn and wait for the answer.

- If it still holds, do not do the thing that goes against it.
- If it no longer holds, open the record dialog below so the user can record the new decision or rule in their words, saying which one it replaces; then go on.

## The record

When the user says something is a decision or a standing rule, or agrees when you ask "Is that a decision?", open the question dialog (the AskUserQuestion tool) once, with exactly one question:

- header: "CFMS"; multiSelect: false.
- for a decision, the question "In one line, in your own words: the decision and your reason. Type or dictate it in the box; it is saved exactly as you write it, and Claude reads it at every session start." and exactly two options: "Not a decision" (description "Save nothing") and "Not now" (description "Save nothing and go on").
- for a standing rule, the question "In one line, in your own words: the standing rule and your reason. Type or dictate it in the box; it is saved exactly as you write it, and Claude reads it at every session start." and exactly two options: "Not a standing rule" (description "Save nothing") and "Not now" (description "Save nothing and go on").
- if it changes an earlier decision or rule, the question also asks the user to say which one it replaces.

Never write the line for the user, never offer a suggested answer as an option, and never add to it. Never edit cfms/DECISIONS.md yourself: the dialog is the only way in. After the dialog closes, say nothing more about it.
