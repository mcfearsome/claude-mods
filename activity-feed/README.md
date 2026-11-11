# activity-feed

A Claude Code mod that shows what the agent is doing, live, in a pane beside the chat.

The pane draws a radial graph. The session sits in the center, with a node around it for each place the agent reaches out to. Every event draws a curved edge that grows in, stays lit (with a travelling pulse) while it runs, then fades out. Below the graph is a timed log with status, duration and per-turn token counts.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install activity-feed --marketplace mcfearsome/cc-marketplace
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install activity-feed --marketplace mcfearsome/cc-marketplace
```

The pane opens by itself in interactive sessions whose terminal is wide enough to dock it (about 144 columns), and with `/activity` at any width.

## What it shows

| Node | Events |
| --- | --- |
| prompt, command | what you submit, slash commands |
| model | each model request in a turn, with the model name |
| files, shell, web, tools | tool calls, with their main argument |
| memory | reads and writes of Claude's memory and instruction files, and memory Claude Code loads by itself |
| mcp | MCP tool calls, as `server:tool` |
| agent | subagents: spawn, their own tool calls (tagged with the agent type), and their token use when they end |
| skill | skills loaded |
| permission | permission checks that ask or deny |
| hook, context | context your settings hooks and Claude Code inject |
| compact, delivery | compactions, messages from other sessions and background tasks |

The header line shows session totals: turns, tokens in and out, cached tokens, and events running now.

## Commands

| Command | Does |
| --- | --- |
| `/activity` | Opens the pane |
| `/activity clear` | Empties the log and resets the totals |
| `/activity pixels` | Draws the graph with real pixels |
| `/activity braille` | Draws the graph with braille characters |
| `/activity auto` | Pixels where the terminal shows images, braille elsewhere (the default) |

## Terminals

- **Ghostty, kitty, and iTerm2 3.5 or later**: real pixels via the kitty graphics protocol or iTerm2 inline images, with a transparent background that suits light and dark themes.
- **Inside tmux**: pixels need `tmux set -g allow-passthrough on` and `tmux set -g focus-events on`; the mod tells you when they are off.
- **Every other terminal**: braille, animated at 30fps.
- **Desktop app, VS Code, mobile**: an animated SVG.

## Develop

```
claude --plugin-dir ./activity-feed
claude plugin validate activity-feed
claude plugin test activity-feed
```

## License

MIT
