# CFMS: your project, in your own words

Runs in Claude Code and in Cowork, on a computer. It does not run in the Claude phone app or in chat.

CFMS, the Context Fatigue Management System, keeps track of what Claude changed in your project, asks you now and then in one line why you want it, and puts your own words back in front of you and Claude when you return.

## Before you install
You need Node.js on the computer (any current version; check with `node --version`). Every part of CFMS is a small Node script, and Claude Code's own installer does not include Node.

## Install in Claude Code
In a Claude Code session, type this one line:

```
/plugin install cfms --marketplace PrestoniLCFC/cfms
```

It needs Claude Code v2.1.275 or later; `claude --version` shows yours.

On an older version, type these two lines, one at a time:

```
/plugin marketplace add PrestoniLCFC/cfms
/plugin install cfms@cfms
```

The second line opens CFMS's details. Choose where to install it (for you everywhere, or in this project only) and it installs.

## Install in Cowork
In the Claude desktop app: Customize, Plugins, Add, Add marketplace. Enter `PrestoniLCFC/cfms`, then add CFMS from the list.

## Turn it on in a project
CFMS does nothing in a project until you turn it on there. Open Claude in your project and type:

```
/cfms:on
```

From then on, in that project:
- Every file Claude creates or changes is noted.
- At the end of a turn with three or more changes noted, at most once every 30 minutes, Claude opens a CFMS question box naming them and asks for one line on why you want them.
- When you come back after a break, Claude first asks what the project is for, then shows your last lines and what changed since.
- When you tell Claude something is a decision or a standing rule, it opens the CFMS box for it, and before going against one later it stops and quotes you.

## What it writes, and where
Only a `cfms/` folder inside your project: `state.json` (its own notes, kept out of git), and `CHECKINS.md`, `NOW.md` and `DECISIONS.md` (your lines). Nothing outside your project folder, and nothing over the network.

Only what you type into the CFMS question box is ever saved as your words, exactly as you typed it. What you say to Claude in the chat is never saved by CFMS.

## Skip, Not now, and quiet runs
- **Skip** saves nothing and never asks about those changes again.
- **Not now** saves nothing and asks again later.
- Skip or Not now three times in a row and it asks half as often, and says so.
- For unattended runs (loops, scripts), set `CFMS_QUIET=1` in the environment: the end of turn question is never asked.

## Changes made through the shell
A file Claude changes through a shell command (Bash or PowerShell) is noted only when the project is inside a git repository. Files Claude changes with its own edit tools are noted either way.

## Turn it off, or remove it
- Off for now: `/plugin disable cfms@cfms` (turn it back on with `/plugin enable cfms@cfms`). In Cowork, the plugin's Disable plugin toggle.
- Off in one project: delete that project's `cfms/` folder. This deletes your saved lines too.
- Remove it: `/plugin uninstall cfms@cfms`, then `/plugin marketplace remove cfms`. In Cowork, Remove from the plugin's menu. Your `cfms/` folders stay in your projects until you delete them.

---

Made by Preston at Atrium Spatial Labs ([LinkedIn](https://www.linkedin.com/in/preston-johan-96984b237)), in evenings after work and at weekends.
