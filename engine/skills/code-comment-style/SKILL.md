---
name: code-comment-style
description:
  Use this skill when writing, adding, or reviewing code comments in any
  language. Invoke before leaving a comment, and when reviewing a diff or file
  that contains comments. The rule is binary: never write comments, and delete
  every comment an LLM wrote.
---

# Code Comment Style

Two rules. That is the whole skill.

## Rule 1: You never write comments

Do not add a comment. Not a "why" note, not a docblock, not a section header,
not a `# TODO`. Ever. If a line seems to need a comment, the line is wrong:
rename it, extract it, or split it until it reads on its own.

## Rule 2: Delete every comment an LLM wrote; never touch a human's

When you review a diff or a file:

- **A comment an LLM generated → delete it.** The whole comment. Do not trim it,
  do not rewrite it, do not "keep the good part." Delete it.
- **A comment a human wrote → leave it exactly as is.** Do not edit it, move it,
  shorten it, or reword it. Do not touch it at all.

If you cannot tell who wrote a comment, LLM prose is verbose, explains the
obvious, restates the code, or reads like a paragraph. Human comments are
usually short and terse. When still unsure, ask — do not edit.

## When Invoked On Its Own

Find the scope yourself, in this order, and act on the first that applies:

1. A comment you are about to write → do not write it (Rule 1).
2. An uncommitted or unpushed diff (`git diff`, `git diff origin/main...`) that
   touches comments → that diff is the scope. Delete every LLM comment in it.
3. Otherwise the file most recently read or edited this session.

Report each deletion in one line, then apply it. Never propose a rewrite.
