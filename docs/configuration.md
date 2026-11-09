# Configuration

`minecraft-agent` reads options from three places, highest priority first:

1. command-line flags
2. environment variables, including a `.env` file in the working directory
3. a JSON file passed with `--config` (keys are the camelCase names below)

```sh
npx minecraft-agent --config examples/agent.json --name Scout
```

## Server

| Flag           | Env          | Config key         | Default     | Notes                                                                    |
| -------------- | ------------ | ------------------ | ----------- | ------------------------------------------------------------------------ |
| `--host`       | `MC_HOST`    | `host`             | `localhost` |                                                                          |
| `--port`       | `MC_PORT`    | `port`             | `25565`     |                                                                          |
| `--auth`       | `MC_AUTH`    | `auth`             | `offline`   | `microsoft` signs in with a Microsoft account (device code on first run) |
| `--mc-version` | `MC_VERSION` | `minecraftVersion` | `1.21.6`    | `auto` negotiates with the server                                        |

The harness is developed and tested against Paper 1.21.6. Any Java Edition version Mineflayer 4.33 supports should
connect; the bundled protocol patches target 1.21.6.

## Agent

| Flag             | Env                      | Config key          | Default        | Notes                                                                              |
| ---------------- | ------------------------ | ------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `--name`         | `AGENT_NAME`             | `name`              | `Agent`        | Minecraft username, 1 to 16 letters, digits or `_`                                 |
| `--objective`    | `AGENT_OBJECTIVE`        | `objective`         | required       | the goal in the system prompt                                                      |
| `--game-mode`    | `AGENT_GAME_MODE`        | `gameMode`          | `survival`     | must match the mode the server assigns                                             |
| `--personality`  | `AGENT_PERSONALITY`      | `personality`       | none           | a private disposition added to the prompt                                          |
| `--soul-file`    |                          | `soulFile` / `soul` | none           | a longer persona; copied to `~/soul.md` in the sandbox                             |
| `--duration`     | `AGENT_DURATION_MINUTES` | `durationMinutes`   | unlimited      | the agent stops itself after this many minutes                                     |
| `--no-respawn`   | `AGENT_RESPAWN=false`    | `respawn`           | respawn on     | with respawn off, death retires the agent for good                                 |
| `--allow-flight` | `AGENT_ALLOW_FLIGHT`     | `allowFlight`       | off            | adds `fly_to` for creative-mode agents                                             |
| `--tick-rate`    | `AGENT_TICK_RATE`        | `tickRate`          | `20`           | set this when the server runs `/tick rate N` below 20 so the bot's physics matches |
| `--state-dir`    | `AGENT_STATE_DIR`        | `stateDir`          | `.agent-state` | sessions, notes, logs                                                              |
| `--quiet`, `-q`  | `AGENT_QUIET`            | `quiet`             | off            | hide the per-tool activity lines on the console                                    |
| `--no-reconnect` | `AGENT_RECONNECT=false`  | `reconnect`         | reconnect on   | exit on the first kick or disconnect instead of reconnecting                       |
| `--tools-module` | `AGENT_TOOLS_MODULE`     | `toolsModule`       | none           | an ES module that adds tools; `toolOptions` in a config file is passed to it       |

A tools module exports a default function. It receives `{ bot, name, team, options, schema }` and returns a list of
tools, each `{ name, description, properties, required, body, run(args, { bot, signal }) }`. `schema` has the same
`text`, `integer`, `number` and `choice` helpers the built-in tools use. Extra tools go through the same argument
validation as built-in ones, `body: true` runs them through the action runner, and a name that clashes with a built-in
tool is refused. [examples/bedwars/tools.mjs](../examples/bedwars/tools.mjs) is a working example.

After a kick or a dropped connection the agent reconnects with backoff (5s, 10s, 20s, 40s, then every 60s, at most 8
tries in a row) and resumes the same session. Kicks for bans, whitelists, duplicate logins, auth failures or a reason containing `game over` stop it instead. Exit codes: 0 finished or stopped, 1 startup, model or connection error, 2 bad flags or config, 3 kicked for
good.

## Model

| Flag            | Env                 | Config key   | Default                |
| --------------- | ------------------- | ------------ | ---------------------- |
| `--model`       | `AGENT_MODEL`       | `model`      | `openai/gpt-6.1-terra` |
| `--thinking`    | `AGENT_THINKING`    | `thinking`   | `medium`               |
| `--base-url`    | `MODEL_BASE_URL`    | `baseUrl`    | none                   |
| `--models-file` | `AGENT_MODELS_FILE` | `modelsFile` | none                   |

`--model` takes `provider/model-id` from pi's model catalog. List what is available with:

```sh
npx minecraft-agent models anthropic
npx minecraft-agent models openai
```

Keys come from the provider's usual environment variable:

| Provider                                         | Variable                                                                                                   | Example model                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Anthropic                                        | `ANTHROPIC_API_KEY`                                                                                        | `anthropic/claude-sonnet-4-6`                |
| OpenAI                                           | `OPENAI_API_KEY`                                                                                           | `openai/gpt-6.1-terra`                       |
| Google                                           | `GEMINI_API_KEY`                                                                                           | `google/gemini-3.1-pro-preview`              |
| OpenRouter                                       | `OPENROUTER_API_KEY`                                                                                       | `openrouter/~anthropic/claude-sonnet-latest` |
| Groq, Mistral, DeepSeek, xAI, Bedrock and others | see [pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) |                                              |

### OpenAI Responses compatible endpoints

For a LiteLLM proxy, vLLM, LM Studio, or an internal gateway that speaks the OpenAI Responses API:

```sh
MODEL_API_KEY=... npx minecraft-agent --base-url https://gateway.example.com/v1 --model gateway/my-model -o "..."
```

The part before the slash names the provider; the rest is sent as the model id. The key in `MODEL_API_KEY` is sent as a
bearer token. In a config file you can also set `apiKeyHeader` (for gateways that expect a header such as `api-key`),
`serviceTier`, and `requestTimeoutMs`. `thinking: "off"` sends `reasoning.effort: "none"`; set `offEffort` (for example `"low"`) for a gateway that rejects `none`. Some local models, such as Qwen3.5 in LM Studio, only support thinking on or off, so `minimal`, `low`, `medium` and `high` all behave as on. For a hard cap on thinking, set `thinkingBudgetTokens` (LM Studio's `thinking_budget_tokens`); the agent then talks to the endpoint over chat completions instead of the Responses API, and `thinking: "off"` sends a budget of 0. For local endpoints, set `contextWindow` to the context size actually loaded in
 the server and `maxTokens` to the desired output limit. The harness uses `contextWindow` to trigger Pi's automatic
 conversation compaction; if it is larger than the server's real limit, requests can fail before compaction runs. The
 quick-swarm example uses 60,000 context tokens and a 2,048-token output limit; adjust those to match the model loaded
 in LM Studio. The first team prompt is already about 10,000 tokens, so an 8,192-token context cannot fit it even with
 a fresh session.

### Custom providers

Anything pi can describe in a `models.json` (Ollama, LM Studio, other local servers) works through `--models-file`. See
pi's [custom provider docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md).

## Sandbox

| Flag             | Env                   | Config key     | Default                                                          |
| ---------------- | --------------------- | -------------- | ---------------------------------------------------------------- |
| `--sandbox`      | `AGENT_SANDBOX`       | `sandbox`      | `e2b` with `E2B_API_KEY`, else `docker` if running, else `local` |
| `--docker-image` | `AGENT_DOCKER_IMAGE`  | `dockerImage`  | `node:22-bookworm`                                               |
|                  | `AGENT_DOCKER_MEMORY` | `dockerMemory` | `2g`                                                             |
|                  | `AGENT_DOCKER_CPUS`   | `dockerCpus`   | `2`                                                              |
|                  | `E2B_TEMPLATE`        | `e2bTemplate`  | E2B base image                                                   |

The startup line prints which sandbox was picked, for example `(sandbox: docker)`.

- `docker` gives each agent its own long-lived container named `minecraft-agent-<name>-<hash>`. The agent's
  `.agent-state/<name>/workspace/shell-home` is mounted as its home (`/home/agent`), so notes and scripts survive
  restarts and stay readable on the host. The container is stopped, not removed, when the agent exits, and restarted
  on the next run. Commands run as your host user, with memory, CPU and process limits, and network access. The tool
  relay listens inside the container and is published on a random `127.0.0.1` port only. Any image with `bash`,
  `node`, `python3` and `curl` works; build your own on top of `node:22-bookworm` to preinstall packages. Remove a
  container with `docker rm -f minecraft-agent-<name>-<hash>` (list them with
  `docker ps -a --filter label=minecraft-agent-harness`).
- `e2b` gives each agent its own cloud VM (needs `E2B_API_KEY`). It pauses after a few idle minutes and resumes on the
  next command with files and processes intact. When the agent stops, the VM is paused rather than deleted, and its id
  is saved in `.agent-state/<name>/e2b-sandbox.json`; the next run resumes the same VM, so files and installed packages
  survive restarts. The VM is also created to pause (not die) when its timeout passes. If the saved VM is gone the agent
  logs it and starts a new one. Delete `e2b-sandbox.json` to start fresh, and remove old paused VMs from the E2B
  dashboard or CLI.
- `local` runs commands with `bash` in `.agent-state/<name>/workspace/shell-home` on the machine running the agent.
  It is not isolated; it is the fallback when neither E2B nor Docker is available. Inside the Compose setup the agent
  itself runs in a container, so `local` is contained there.
- `none` removes `run_shell`. The agent still has its private workspace and `compute_js`.

## Vision

`--vision` (or `AGENT_VISION=1`) attaches a first-person render to every observation. The renderer needs extra native
packages that are not installed by default:

```sh
npm run vision:install
```

On a headless Linux host, run the agent under a virtual display, for example
`xvfb-run -a -s "-screen 0 1024x768x24" npx minecraft-agent --vision ...`. Pick a model that accepts images.

Vision is experimental. `node-canvas-webgl` pulls in `gl@6`, which builds from source and needs Python, a C++
toolchain and the GL and Cairo development headers. With recent GCC releases the build can fail on Node 24; text
perception works without it.

## Files written

Everything lives under `--state-dir` (default `.agent-state/`):

```
.agent-state/
  <name>/
    pi-sessions/          the persisted pi session (resumed on restart)
    workspace/            private notes, shell home for the local sandbox
    telemetry.jsonl       one line per observation, tool call, hit, death and lifecycle event
    diagnostics.jsonl     provider errors, tool errors and dropped images
    status.json           running state
    runtime-status.json   position, health and current action, refreshed every 3 seconds
    mailbox.sqlite        whispers and public chat this agent saw (single-agent mode)
    plan.md               the agent's noticeboard (single-agent mode)
    e2b-sandbox.json      id of the agent's E2B VM, resumed on the next run
  shared/
    mailbox.sqlite        DMs between team members (team mode)
```

Telemetry tool events include the call's arguments (clipped to 500 characters) and a short result. Delete an agent's
directory to start it from scratch.
