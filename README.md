# Curie — chat with a document

Backend that prepares a Markdown or plain-text document for search, holds a multi-turn conversation about it, and answers only from that document with verified, offset-located quotations.

> Work in progress — full setup, example flow and recording link are added later.

## Setup

```sh
pnpm install
cp .env.example .env          # then set ANTHROPIC_API_KEY, or MODEL_PROVIDER=fake for offline mode
docker compose up -d postgres redis
```

## Tests

```sh
pnpm test:unit     # no services needed
pnpm test          # unit + integration (needs postgres + redis from compose)
pnpm typecheck
```

See [DESIGN.md](DESIGN.md) for design decisions.
