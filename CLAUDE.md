# protohype

Prototype repo for the nanohype ecosystem. Each subdirectory is a standalone project composed from nanohype templates.

## Project Structure

```
protohype/
  sigint/          ← competitive intelligence radar
  {new-project}/   ← each project is a subdirectory
```

## Starting a New Project

1. Pick a creative project name — evocative, not literal (see naming below)
2. Create a subdirectory: `protohype/{project-name}/`
3. Scaffold from nanohype templates: `npx nanohype scaffold <template> --output ./{project-name}`
4. Every project gets its own `CLAUDE.md`, `README.md`, `package.json`, and `tsconfig.json`
5. Work on a feature branch: `feat/{project-name}`
6. Never push directly to main

## Project Naming

Names should be creative and memorable — single words or short compounds that evoke purpose without being literal:
- "lighthouse" not "doc-search"
- "harvest" not "lead-scraper"
- "switchboard" not "api-gateway"
- "sentinel" not "monitoring-service"

Check existing subdirectories before naming. Never reuse a name.

## Conventions (all projects)

- TypeScript, ESM (`"type": "module"`, `.js` extensions in imports)
- Node >= 22
- Strict TypeScript (`strict: true` in tsconfig)
- 2-space indent for TypeScript, JSON, YAML, Markdown
- Zod for input validation
- Structured logging (JSON to stderr, stdout reserved for CLI output)
- Provider registry pattern from nanohype for pluggable services
- Vitest for testing
- ESLint + Prettier

## Per-Project CLAUDE.md

Every project must have its own `CLAUDE.md` following this structure:

1. **Title** — project name + one-line description
2. **What This Is** — what it does, which nanohype templates it composes
3. **How It Works** — architecture diagram (text), core insight
4. **Architecture** — module-by-module breakdown with file paths
5. **Commands** — npm scripts to run, build, test
6. **Configuration** — environment variables, config files
7. **Conventions** — project-specific patterns
8. **Testing** — test files, test count, how to add tests
9. **Dependencies** — key packages and why

See `sigint/CLAUDE.md` for reference.

## README Updates

When adding a new project, update the root `README.md` table:

```markdown
| [project-name](project-name/) | What it does | Templates used |
```

## Dependencies

- Use latest stable versions
- No heavy frameworks when raw patterns work (no LangChain — direct SDK calls via provider interface)
- Prefer nanohype module patterns over third-party abstractions
- Pin versions in package-lock.json

## Deploy

Each project manages its own deployment. Use nanohype infra templates:
- `infra-aws` for Lambda/ECS
- `infra-fly` for Fly.io
- `infra-vercel` for frontend-heavy

Infrastructure as code lives in the project subdirectory.
