# Contributing

Thanks for helping her follow more games.

## Adding a game with a pack

1. Build the mod, following the [mod guide](docs/mod-guide.md). Play a session with it and keep the folder it wrote: that's your fixture.
2. Add the pack: `packages/files/src/packs/<game>.ts`, and add it to `PACKS` in `packages/files/src/packs/index.ts`.
3. Add the fixture as `packages/files/fixtures/<game>-<milestone>/` (the manifest, the heartbeat, the state file if there is one, and an events file), and a test in `packages/files/src/adapter.test.ts` that replays it. The Project Zomboid tests are the model: they check the number of events, the lanes that matter, and a few of her sentences word for word.
4. Run the fixture through the adapter and read every line she'd get:
   ```sh
   bun packages/files/src/main.ts --pack <game> --dir packages/files/fixtures/<game>-<milestone> --from-start
   ```
   Every sentence should read naturally out loud: she speaks them. No ids or underscores, no "level 3 of 4" where words would do.
5. `bun test` and `bun run typecheck`, then open a PR with a line or two about the mod and where to get it.

Keep packs to data: rules, conditions and templates. A pack never runs code.

## Changing the protocol

`packages/protocol` is published as `@swarmfu/connect-protocol` and Swarmfu's backend depends on it, so a change there needs a version bump and care:

- **Adding** an optional field or a kind is fine.
- **Removing or renaming** something, or changing what a field means, also needs `BRIDGE_PROTOCOL` bumped. Old `swarmfu`s then stop with "update swarmfu" instead of misbehaving.

## Code

TypeScript under Bun, tests with `bun test` next to the code. Comments say what something is for, in plain words.
