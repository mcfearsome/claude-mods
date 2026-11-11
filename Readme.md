# Claude Mods

Mods for [Claude Code](https://claude.com/claude-code): plugins built on its function-hooks API that change Claude Code's own interface and behaviour, such as panes beside the chat, status lines and hooks on tool calls. Each mod lives in its own folder and installs on its own from the [cc-marketplace](https://github.com/mcfearsome/cc-marketplace).

| Mod | What it does |
| --- | --- |
| [activity-feed](./activity-feed) | A live pane that shows everything the agent does as a radial graph (prompts, model requests, tool calls, memory, subagents, skills, MCP, hooks) with per-turn token counts. |

## Install a mod

At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace mcfearsome/cc-marketplace
```

From a shell:

```
claude plugin install <mod> --marketplace mcfearsome/cc-marketplace
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `mcfearsome/cc-marketplace`, then Add plugin.

## Developing

Run a mod from its folder without installing it:

```
claude --plugin-dir ./activity-feed
```

Check and test it:

```
claude plugin validate activity-feed
claude plugin test activity-feed
```

## License

MIT
