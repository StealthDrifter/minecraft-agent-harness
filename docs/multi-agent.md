# Running a team

```sh
npx minecraft-agent team examples/team.json
```

A team needs at least two agents. A team file has shared defaults at the top level and one entry per agent. Any option from
[configuration.md](configuration.md) can appear at either level; per-agent values win.

```json
{
  "host": "localhost",
  "port": 25565,
  "model": "openai/gpt-6.1-terra",
  "objective": "Build a small village together: at least three houses, a farm and a path between them.",
  "sharedMachine": "local",
  "agents": [
    { "name": "Ada" },
    { "name": "Bram", "model": "openai/gpt-5.5" },
    { "name": "Cleo", "personality": "Careful planner who writes everything down." }
  ]
}
```

What changes in team mode:

- Every agent knows the others' names and gets `directory` and `directory_search`.
- Agents message each other with `send_dm` and `read_dms`. Unread counts show up in every observation.
- With `sharedMachine: "none"` and `sandbox: "none"`, team agents have no shell, shared machine, or general workspace file tools.
- Team mode provides only `read_shared_notes` and `append_shared_note` for shared written coordination. Notes are timestamped, limited to 2,000 characters each, and stored in `<state-dir>/shared/shared-notes.jsonl`.
- Agents cannot read or post public chat. A human can issue a command in Minecraft chat with `@all <command>` or `@AgentName <command>`; only the addressed agent(s) receive it.
- Each agent's `<state-dir>/<agent>/telemetry.jsonl` contains timestamped observations, emitted model messages (including reasoning text when the provider exposes it), tool arguments and results, messages, and game events. Hidden model computation is not available to the harness.

`sharedMachine` can be:

| Value   | Machine                                                                              |
| ------- | ------------------------------------------------------------------------------------ |
| `local` | a directory under the state dir on the host, commands run with `bash` (not isolated) |
| `e2b`   | one E2B VM for the team with root and internet access (needs `E2B_API_KEY`)          |
| `none`  | no `shared_exec`                                                                     |

Each agent still gets its own private sandbox according to `sandbox`. Agents start a few seconds apart
(`staggerSeconds`, default 3). `Ctrl+C` stops all of them.

## Quick local swarm

For a local OpenAI Responses-compatible server such as LM Studio, load a model, start its API server on port 1234,
then run:

```sh
npm start -- team examples/quick-swarm.json
```

The example connects to `http://127.0.0.1:1234/v1` and starts three 0.8B agents. Change the model IDs to the exact IDs
shown by your local server if needed. `examples/dictator-swarm.json` adds a 9B Overseer with a contrasting personality.
Both examples disable shell and shared-machine access. Human commands use `@all clear the trees to the north` or
`@Worker02 gather the logs near spawn` in Minecraft chat.

The complete experiment trace is written under `.agent-state/`. To share a run for analysis, provide the agents'
`telemetry.jsonl` files; each record is one timestamped JSON object. The persistent Pi session files are also kept in
`.agent-state/<agent>/pi-sessions/` if a deeper transcript is useful.
