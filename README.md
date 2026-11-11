# swarmfu-connect

`swarmfu-connect` lets your [Swarmfu™](https://www.swarmfu.com) companion follow the game you're playing. It's a small free program that runs on your computer, reads what the game's connector mod writes, and passes it to Swarmfu, so your companion can react to the close calls, the kills and the quiet stretches like a friend watching beside you.

This repo is the open part: the `swarmfu-connect` program, the protocol it speaks, and the **game packs** that teach it new games. Anyone can add a game.

## Use it

1. Download `swarmfu-connect` for your computer from [Releases](https://github.com/Swarmfu/swarmfu-connect/releases) and unpack it.
   - **macOS:** `swarmfu-connect-darwin-arm64.zip` (Apple silicon) or `swarmfu-connect-darwin-x64.zip` (Intel).
   - **Windows:** `swarmfu-connect-windows-x64.zip`.
   - **Linux:** `swarmfu-connect-linux-x64.tar.gz` or `swarmfu-connect-linux-arm64.tar.gz`. Run it from a terminal.
2. Open it: double-click `swarmfu-connect`, or run `./swarmfu-connect` in a terminal.
   - **macOS, the first time:** this beta isn't signed by Apple yet, so macOS says it can't check it and won't open it. Choose Done, then open System Settings → Privacy & Security, scroll down to "swarmfu-connect was blocked", choose **Open Anyway** and confirm. After that it opens normally. (From a terminal, `xattr -d com.apple.quarantine swarmfu-connect` does the same.)
   - **Windows, the first time:** Windows may say it protected your PC; choose More info → Run anyway.
3. When it asks, enter the pairing code from Swarmfu's Game card (the game controller button in chat, or Streamer mode). On a Swarmfu site other than www.swarmfu.com (a preview, say), the card shows a whole line instead, `swarmfu-connect pair <CODE> --site <url>`: copy it and paste it in where `swarmfu-connect` asks for the code.
4. Install your game's connector mod (see [Slay the Spire 2](#slay-the-spire-2) below).
5. Start your game. `swarmfu-connect` finds it and starts following; leave it running while you play.

The next time, `swarmfu-connect` remembers the pairing and goes straight to your game.

| Command | |
| --- | --- |
| `swarmfu-connect` | Pair if needed, find your game, follow it |
| `swarmfu-connect pair <CODE>` | Pair with a code from the app |
| `swarmfu-connect start [game]` | Follow a particular game (`swarmfu-connect games` lists them) |
| `swarmfu-connect status` | What this computer is paired with |
| `swarmfu-connect unpair` | Forget the pairing here |

`--site <url>` pairs through another Swarmfu site than www.swarmfu.com (a staging site, say). Your pairing lives in `~/.swarmfu/`.

Minecraft, where your companion joins as a player of their own, comes as a separate download, `swarmfu-connect-minecraft-<your computer>`, because it carries data for every Minecraft version. Unpack it next to `swarmfu-connect` and `swarmfu-connect start minecraft` uses it.

## Games

| Game | How | Pack |
| --- | --- | --- |
| Project Zomboid (Build 42) | the `swarmfu-connector` mod | [`projectzomboid.ts`](packages/files/src/packs/projectzomboid.ts) |
| Slay the Spire 2 (beta) | the [Swarmfu Connector](https://steamcommunity.com/sharedfiles/filedetails/?id=3838028473) mod (Steam Workshop), including co-op with her in the lobby | [`slaythespire2.ts`](packages/files/src/packs/slaythespire2.ts) |
| Minecraft: Java Edition | she joins as a bot (Mineflayer) | [`packages/minecraft`](packages/minecraft) |

### Slay the Spire 2

1. Subscribe to the [**Swarmfu Connector**](https://steamcommunity.com/sharedfiles/filedetails/?id=3838028473) mod on the Steam Workshop.
2. Start the game and turn the mod on under **Settings → Mod Settings**. Restart the game if it asks.
3. Open `swarmfu-connect` and play. Your companion watches and talks the run through with you. (Letting them take turns takes more setup.)

With a mod on, the game keeps separate save files and turns off Steam achievements; turn the mod off to get both back.

**Adding a game** is usually a mod that writes a few files, plus a pack: a short, declarative description of what each of the mod's events means to her. No Swarmfu code. Start with the [mod guide](docs/mod-guide.md), then [CONTRIBUTING.md](CONTRIBUTING.md). For a game that needs more than files (she plays in it, or it has an API), see [writing an adapter](docs/adapters.md).

## Build it yourself

You need [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test
bun run swarmfu-connect            # run from source
bun scripts/build.ts       # a binary for this computer, in dist/
bun scripts/build.ts --all # every platform
```

## What's here

| Package | |
| --- | --- |
| [`packages/protocol`](packages/protocol) | `@swarmfu/connect-protocol` on JSR: game events, lanes and reactions, adapter manifests, the bridge's wire messages, and the file protocol and packs |
| [`packages/cli`](packages/cli) | `swarmfu-connect`: pairing, the local bridge, running adapters |
| [`packages/files`](packages/files) | The file adapter, and the game packs |
| [`packages/minecraft`](packages/minecraft) | The Minecraft adapter |
| [`packages/simulator`](packages/simulator) | Replays a recorded session; no game needed |

How it fits together: an **adapter** is an MCP server for one game. It sends game events as notifications, and offers tools if she can act in the game. `swarmfu-connect` runs the adapter, checks what it sends against its manifest, and relays it to Swarmfu. It also serves a socket on `127.0.0.1` so her avatar reacts at once, without a round trip.

## License

[MIT](LICENSE). Swarmfu™ is a trademark of Draugr LLC; the MIT license covers this code, not the Swarmfu name or logo.
