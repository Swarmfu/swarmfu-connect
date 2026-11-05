# swarmfu-connect

`swarmfu` lets your [Swarmfu](https://www.swarmfu.com) co-host follow the game you're playing. It runs on your computer, reads what the game's connector mod writes, and passes it to her, so she can react to the close calls, the kills and the quiet stretches like a friend watching beside you.

This repo is the open part: the `swarmfu` program, the protocol it speaks, and the **game packs** that teach it new games. Anyone can add a game.

## Use it

1. Download `swarmfu` for your computer from [Releases](https://github.com/Swarmfu/swarmfu-connect/releases).
   - **macOS:** `swarmfu-darwin-arm64` (Apple silicon) or `swarmfu-darwin-x64` (Intel).
   - **Windows:** `swarmfu-windows-x64.exe`. Windows may warn that it doesn't recognize the app; choose More info → Run anyway.
   - **Linux:** `swarmfu-linux-x64` or `swarmfu-linux-arm64`. Run it from a terminal.
2. Open it: double-click it, or run `./swarmfu` in a terminal.
3. When it asks, enter the pairing code from Swarmfu's Game card (Streamer mode, under Her window).
4. Start your game. `swarmfu` finds it and starts following; leave it running while you play.

The next time, `swarmfu` remembers the pairing and goes straight to your game.

| Command | |
| --- | --- |
| `swarmfu` | Pair if needed, find your game, follow it |
| `swarmfu pair <CODE>` | Pair with a code from the app |
| `swarmfu start [game]` | Follow a particular game (`swarmfu games` lists them) |
| `swarmfu status` | What this computer is paired with |
| `swarmfu unpair` | Forget the pairing here |

`--site <url>` pairs through another Swarmfu site than www.swarmfu.com (a staging site, say). Your pairing lives in `~/.swarmfu/`.

Minecraft, where she joins as a player of her own, comes as a separate download, `swarmfu-minecraft`, because it carries data for every Minecraft version. Put it next to `swarmfu` and `swarmfu start minecraft` uses it.

## Games

| Game | How | Pack |
| --- | --- | --- |
| Project Zomboid (Build 42) | the `swarmfu-connector` mod | [`projectzomboid.ts`](packages/files/src/packs/projectzomboid.ts) |
| Minecraft: Java Edition | she joins as a bot (Mineflayer) | [`packages/minecraft`](packages/minecraft) |

**Adding a game** is usually a mod that writes a few files, plus a pack: a short, declarative description of what each of the mod's events means to her. No Swarmfu code. Start with the [mod guide](docs/mod-guide.md), then [CONTRIBUTING.md](CONTRIBUTING.md). For a game that needs more than files (she plays in it, or it has an API), see [writing an adapter](docs/adapters.md).

## Build it yourself

You need [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test
bun run swarmfu            # run from source
bun scripts/build.ts       # a binary for this computer, in dist/
bun scripts/build.ts --all # every platform
```

## What's here

| Package | |
| --- | --- |
| [`packages/protocol`](packages/protocol) | `@swarmfu/connect-protocol` on JSR: game events, lanes and reactions, adapter manifests, the bridge's wire messages, and the file protocol and packs |
| [`packages/cli`](packages/cli) | `swarmfu`: pairing, the local bridge, running adapters |
| [`packages/files`](packages/files) | The file adapter, and the game packs |
| [`packages/minecraft`](packages/minecraft) | The Minecraft adapter |
| [`packages/simulator`](packages/simulator) | Replays a recorded session; no game needed |

How it fits together: an **adapter** is an MCP server for one game. It sends game events as notifications, and offers tools if she can act in the game. `swarmfu` runs the adapter, checks what it sends against its manifest, and relays it to Swarmfu. It also serves a socket on `127.0.0.1` so her avatar reacts at once, without a round trip.

## License

[MIT](LICENSE)
