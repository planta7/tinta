# Write tinta documents with Codex or Claude Code

The `tinta-authoring` skill helps a coding agent create and edit local `.tinta` documents, enrich Markdown, validate source, and produce requested HTML exports. It includes three small examples:

| Example                                                              | What readers can explore                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Platform guide](skills/tinta-authoring/assets/platform-guide.tinta) | Select a platform to show its instructions.                        |
| [Time estimate](skills/tinta-authoring/assets/time-estimate.tinta)   | Change page count and discussion time.                             |
| [Review report](skills/tinta-authoring/assets/review-report.tinta)   | Filter chapters while keeping prose, a chart, and a table aligned. |

The skill runs in your external coding agent. tinta itself does not call a model or provide an AI assistant. Your agent's own file-access and data-handling settings apply when you ask it to read a document.

## Install the skill

Copy the entire [tinta-authoring skill](skills/tinta-authoring/SKILL.md) folder, including its `references` and `assets` subdirectories. No MCP server, API key, or additional tinta dependency is required. The skill does not install the CLI.

Use the [repository setup instructions](../README.md#try-it-locally) to build the CLI if it is not already available. From a built checkout, `pnpm --filter @tinta-lang/cli exec tinta --version` checks the workspace command. An installed CLI can be checked with `tinta --version`.

| Agent       | Project installation              | Personal installation               |
| ----------- | --------------------------------- | ----------------------------------- |
| Codex       | `.agents/skills/tinta-authoring/` | `~/.agents/skills/tinta-authoring/` |
| Claude Code | `.claude/skills/tinta-authoring/` | `~/.claude/skills/tinta-authoring/` |

For example, from this checkout in a POSIX shell, install into another project that does not already have a skill with this name:

```sh
mkdir -p /path/to/your-project/.agents/skills
cp -R docs/skills/tinta-authoring /path/to/your-project/.agents/skills/

mkdir -p /path/to/your-project/.claude/skills
cp -R docs/skills/tinta-authoring /path/to/your-project/.claude/skills/
```

Choose the command for your agent, or both. On Windows, copy the same folder with your file manager into the corresponding project directory. For an existing installation, compare and replace it deliberately instead of merging stale files. Start a new agent session after installation and check that the skill is listed.

Codex can invoke it as `$tinta-authoring`; Claude Code can invoke it as `/tinta-authoring`. You can also describe a suitable task and let the agent select the skill. Automatic selection is not guaranteed for every request. See the [Codex skill documentation](https://learn.chatgpt.com/docs/build-skills) and [Claude Code skill documentation](https://code.claude.com/docs/en/skills) for discovery behavior and settings in your version.

## Ask for a document

For example, ask the agent to use `tinta-authoring` to turn your onboarding notes into a platform-specific guide, preserving the original Markdown and returning the editable source and an interactive HTML copy. Or ask it to update a report's embedded observations and check its empty-filter case.

The skill follows a write, validate, correct, and review workflow. It checks diagnostics with `tinta check --json` and uses the normal CLI for exports. If the CLI is missing, it must identify the source as unvalidated. An initial-state check does not prove that every control setting works; ask for the relevant scenarios when the document contains calculations or conditional branches.

Interactive HTML retains complete source, data, comments, and hidden branches. Use static HTML when you only need the resolved visible presentation. Keep the `.tinta` file to make future edits. See the [CLI reference](06_CLI.md) and [file formats](02_FILES_AND_EXPORTS.md).

## Test the skill and examples

After building the checkout, run:

```sh
pnpm exec vitest run tests/unit/authoring-skill.test.mjs
```

These deterministic tests exercise the copied skill resources, all three examples, their control states, CLI diagnostics and recovery, Markdown enrichment, and both HTML export formats. They use the real local engine and CLI. They do not run Codex or Claude Code, prove automatic skill discovery, or assess prose quality.

The skill uses the common `name` and `description` front matter and relative resource links, without host-specific commands or tool dependencies. Keep its reference and examples aligned with the language contract when updating them.
