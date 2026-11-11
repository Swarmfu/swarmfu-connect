# Writing an adapter

Most games only need a mod and a pack (see the [mod guide](mod-guide.md)). Write an adapter when the game needs more than files:
- She plays in it herself, like Minecraft, where she's a bot with tools.
- It has an API or a socket worth talking to directly.

An adapter is an **MCP server** on stdio. `swarmfu-connect` starts it, reads its manifest, and from then on:
- **Events** come from the adapter as `notifications/game/event` notifications, each a `GameEvent` (`@swarmfu/connect-protocol`). Anything that doesn't fit the manifest is dropped.
- **Tools** are MCP tools. She calls them through Swarmfu, and `swarmfu-connect` forwards each call if the manifest declares the tool. A tool marked destructive only goes through if the user allowed it.
- **Resources:** `game://<id>/manifest` is required. `game://<id>/self` says who she and the user are and which world it is. Add any other state she can read.

`createAdapterServer()` from `@swarmfu/connect-protocol/adapter` does the MCP side: you give it the manifest, your tools' inputs, a tool handler and a resource reader, and it checks every event before sending it.

## The manifest

```ts
const manifest: AdapterManifest = {
  id: "mygame",
  game: "My Game",
  version: "1",
  role: "player",             // or "spectator" if she only watches
  events: {
    took_damage: { lane: "reflex", reaction: "flinch", description: "She was hit." },
    boss_killed: { lane: "respond", description: "The user beat a boss." },
    status:      { lane: "silent", description: "Health and where she is." },
  },
  tools: {
    follow_player: { description: "Follow the user." },
    break_block:   { description: "Break a block.", destructive: true },
  },
  resources: { self: { description: "Who she and the user are." } },
};
```

Each event goes in one of three lanes:
- **reflex:** her avatar reacts at once, with no model involved.
- **respond:** she might say something.
- **silent:** she just knows it.

A `tally` kind shows her how often it's happening, which is good for kills and hits.

Each tool's description and input schema go to Swarmfu when the session starts. That's how she knows what she can do, so describe each tool the way you'd tell a person.

## Running it

During development, add it to `~/.swarmfu/config.json`:

```json
{ "adapters": { "mygame": { "command": "bun", "args": ["/path/to/main.ts"], "description": "My Game" } } }
```

Then `swarmfu-connect start mygame`. To ship it with `swarmfu-connect`, add it as a package here and to `builtinAdapters()` in `packages/cli/src/adapter.ts`. `packages/minecraft` and `packages/simulator` are working examples.
