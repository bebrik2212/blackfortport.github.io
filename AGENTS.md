# Project Guide

## Architecture

This is a framework-free Netlify application. The browser UI lives in `public/`, the API is implemented by one routed Netlify Function, structured state is stored in Netlify Database, and binary uploads are stored in Netlify Blobs.

## Key Directories

- `public/`: static HTML, CSS, and browser JavaScript
- `netlify/functions/`: server-side API handlers
- `db/`: Drizzle database client and schema
- `netlify/database/migrations/`: generated Postgres migrations applied by Netlify

## Conventions

- Keep the existing element IDs and three-tab layout stable unless a UI redesign is explicitly requested.
- Validate authorization, ownership, limits, and nickname uniqueness in the server function rather than trusting browser state.
- Store relational records in Netlify Database and file bytes in Netlify Blobs.
- Upload files in chunks smaller than the Netlify Function request limit.
- Escape all user-generated strings before rendering HTML.
- Pause background refresh while the document is hidden and avoid aggressive polling.
- Every schema change requires a generated migration in `netlify/database/migrations/`.

## Non-Obvious Decisions

The browser keeps a random profile identifier in local storage so a returning browser retains its profile without adding a separate login screen. Media is reconstructed as Blob URLs only when it approaches the viewport, avoiding base64 expansion and unnecessary initial downloads. The API returns deletion permission per post without exposing role labels in the UI.
