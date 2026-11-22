---
name: on
description: Turn CFMS on in this project. Creates the cfms/ folder so every file Claude edits here is noted.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/on.js" "${CLAUDE_PROJECT_DIR}"`

Tell the user the first line above in one sentence. Then, at once, follow the text above that begins "CFMS recall": ask its question in the question dialog as it says, wait for the answer, and do what it says next. If there is no such text, stop after the sentence. Do not edit any file.
