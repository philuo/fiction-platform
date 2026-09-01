<div align="center">

# 🎴 Moshi

**Write novels like playing a game — an LLM-directed story creation engine**

An LLM "Director" continuously maintains the world state, characters, timeline and
foreshadowing. Each turn: observe → decide → generate prose → update state → save.
An independent "Critic" battles the Director to keep quality honest, and AnySearch
provides real-time research lookup.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg?style=for-the-badge)](../../releases)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.4-FBF0DF.svg?style=for-the-badge&logo=bun&logoColor=black)](https://bun.sh)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-75%20files-2EA043.svg?style=for-the-badge)](#-development)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff6c60.svg?style=for-the-badge)](#-contributing)

[Quick Start](#-quick-start) · [Features](#-features) · [How It Plays](#-how-it-plays) · [API](#api) · [Roadmap](#-roadmap) · [中文](./README.md)

</div>

---

## ✨ Features

- 🎴 **Gacha-style creation** — the LLM generates candidate cards from the current world state (characters / events / items / scenes / foreshadowing cards, rarity N/R/SR/SSR); pick manually or auto-draw. Foreshadowing cards register straight into the foreshadowing ledger
- ⚔️ **AI writes, AI reviews (adversarial review)** — Director and Critic are separate agents; cooperation breeds sycophancy, so they must duel. Reviews must cite evidence from the text, score 5 dimensions (coherence / tension / prose / pacing / dialogue), and anything below 6 on coherence or tension forces a rewrite (≤ 2 attempts)
- 🧵 **Foreshadowing never goes stale** — a foreshadowing state machine (planted → echoed → paid off) is injected into the Director's context every turn; context compression (setting digest + character state + timeline + active foreshadowing + last ending) keeps long stories consistent
- 🧠 **The Brain** — a resident "Eye of the Brain" indicator in the masthead, driven by four deterministic (zero-LLM) state dimensions: presence / activity / governance / vitals
- 💬 **Conversational control** — chat with the Brain to trigger all 16 operation categories (advance / serialize / gacha / edit / delete chapters / export…); supervised semi-automation: L0/L1 execute directly, L2/L3 return a confirmation card
- 🔍 **Real-time research** — AnySearch powered lookup woven into writing
- 🖼 **Illustrations & video** — Agnes multimodal generation on the same free-tier key, with automatic rate-limit queueing
- 📰 **Japanese newspaper × game HUD UI** — paper tones / serif type / masthead rules / vermilion seals / vertical labels, with a left table of contents, center prose pane, right status panel and bottom control bar
- ⚡ **Bun all the way down** — zero Node scripts, zero Vite: React 19 SSR (`renderToString` + `hydrateRoot`), `bun --hot` for dev, `bun build` + `Bun.serve` for prod

## 🎮 How It Plays

Human interaction is intentionally minimal: **one-line premise → advance the plot → filter gacha cards → read review reports**. Everything else is AI-driven.

```text
[gacha] → [director writes a chapter] → [independent critic reviews] → [ledger/state update] → [save]
                ↑                              │
                └── failed → rewrite with critique (≤2 attempts) ──┘
```

Each turn runs like a game session:

| Phase | What happens |
|---|---|
| 🎴 Gacha | Candidate cards feed the next chapter's writing prompt; foreshadowing cards enter the ledger |
| ✍️ Write | The Director generates prose from world state + active foreshadowing + last ending |
| 🛡 Review | The independent Critic scores 5 dimensions with cited evidence; a floor mechanism forces rewrites |
| 📖 Ledger | Foreshadowing state machine advances, character states and timeline update, context compresses |
| 💾 Save | `data/<title>/state.json` written to disk — resume and export anytime |

## 🚀 Quick Start

```bash
git clone https://github.com/philuo/fiction-platform.git
cd fiction-platform
cp .env.example .env    # fill in your API key(s); AGNES_API_KEY is required
bun install
bun run dev             # dev server at http://localhost:3000 (bun --hot)
```

Production mode:

```bash
bun run build           # emits dist/client + dist/server
bun run start           # production server at http://localhost:3000 (Bun.serve)
```

> Requires [Bun](https://bun.sh) ≥ 1.4. `.env` and `data/` are gitignored; keys never enter code or git. The `data/` directory is created automatically at runtime.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `AGNES_API_KEY` | ✅ | [Agnes AI](https://agnes-ai.cn) key (OpenAI-compatible, free tier); shared by text / image / video |
| `AGNES_BASE_URL` | — | Defaults to `https://api.agnes-ai.cn/v1` |
| `AGNES_MODEL` | — | Defaults to `agnes-2.5-flash` |
| `TEXT_BASE_URL` / `TEXT_API_KEY` / `TEXT_MODEL` | optional | Route all text tasks (brain / writer / critic / bookkeeping) to any OpenAI-compatible endpoint; image / video stay on Agnes |
| `ANYSEARCH_API_KEY` | optional | [AnySearch](https://anysearch.com) real-time search (research enhancement); anonymous access supported |
| `AGNES_*_CONCURRENCY` / `AGNES_*_RPM` | optional | Per-modality rate limits for text / image / video; the limiter queues instead of triggering 429s |

Resume a saved story: `http://localhost:3000/?title=断梦录` · Export the full book: `GET /api/novel/export?title=`

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Service health + key readiness |
| `POST /api/chat` / `POST /api/chat/stream` | Agnes generation / SSE streaming |
| `POST /api/search` | AnySearch real-time search |
| `POST /api/novel/new` | Start a novel: one-line premise → world setting + characters (LLM) |
| `POST /api/novel/step` | One turn: write → review → rewrite → save (SSE phase events) |
| `POST /api/novel/gacha` | Gacha: generate card pool / auto-draw / draw specific cards |
| `POST /api/novel/state` | World state (response carries `brainState`, the Brain's 4-dimension status) |
| `POST /api/brain/state` | Brain's 4-dimension status (presence / activity / governance / vitals) |
| `POST /api/brain/chat` | Brain chat orchestration (SSE): intent → reply + cards |
| `GET /api/novel/export?title=` | Export the whole book as Markdown |

## 🗂 Project Layout

```
server/                dev / prod servers + SSR entry + HTML template assembly
src/api/               director, writer, critic, gacha, world state, LLM clients
src/contracts/         cross-boundary contracts (commands, world, sync, auth)
src/application/       use cases and ports
src/infrastructure/    SQLite, persistence and provider adapters
src/transport/         HTTP, SSE, WS transports
src/components/        masthead / status panel / prose / review report / gacha / Brain cabin
src/frontend/          frontend feature migration area
data/                  novel saves (gitignored, generated at runtime)
docs/                  development specs, Brain protocol, command registry
```

## 🛠 Development

```bash
bun run check          # architecture check + typecheck + tests + build, all in one
bun test               # 75 test files covering the narrative engine, Brain and transports
bun run check:architecture   # layering check only
```

Further reading:

- **[docs/INSTRUCTION.md](docs/INSTRUCTION.md)** — development spec, module boundaries, state ownership and acceptance checklist
- **[docs/BRAIN.md](docs/BRAIN.md)** — the Brain and sync protocol
- **[docs/HARNESS.md](docs/HARNESS.md)** — command registry, governance levels and recovery semantics

> `src/api/routes.ts`, `src/pages/Home.tsx` and `src/components/` remain compatibility entry points and legacy code mid-migration; new code should live in the target layer per `docs/INSTRUCTION.md`.

## 🗺 Roadmap

- ✅ **Phase 0** — stack + SSR skeleton + dev/prod + API wiring
- ✅ **Phase 1** — narrative engine (turn loop / world state / saves)
- ✅ **Phase 2** — Japanese newspaper game UI (gacha / adversarial review / foreshadowing ledger)
- ✅ **Phase 3** — enhancements (parameter system / worldbook / arcs / images / versions / threads / genre templates)
- 🔜 Next phase in planning — open an [issue](../../issues) to discuss

## 🤝 Contributing

Issues and PRs are welcome! Please run `bun run check` (architecture + typecheck + tests + build) before submitting.

## 📄 License

[MIT](./LICENSE) © 2025 Perfumere (philuo)
