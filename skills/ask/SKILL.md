---
name: ask
description: Use only when a CFMS Stop hook line says "Use the cfms:ask skill". Opens the CFMS question dialog once, asking the user for one line in their own words about the changes that line names.
user-invocable: false
---

The CFMS line in your context names the changes to ask about, newest first. Before you finish, open the question dialog (the AskUserQuestion tool) once, with exactly one question:

- header: "CFMS"; multiSelect: false.
- options, exactly these two and nothing else: "Skip" (description "Save nothing and never ask about these again") and "Not now" (description "Save nothing now and ask again later").
- the question, short: it names those changes, newest first; it asks for one line in the user's own words on why they want them, typed or dictated into the dialog's own free text box; and it says Claude reads the answer next session. If the CFMS line begins with a sentence saying the user skipped, the question begins with that same sentence.

Never write the line for the user and never offer a suggested answer as an option. After the dialog closes, say nothing more about it.
