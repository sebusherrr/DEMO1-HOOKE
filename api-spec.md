# API Specification (condensed)

All routes require a valid session except `/health`. RBAC is enforced server-side per route —
the frontend hiding a button is never the security boundary. All request/response bodies are
validated against typed schemas (e.g. zod); pagination, filters and IDs are always
server-validated, never trusted from the client.

## Public / Student

```
GET  /books                         list + filter (genre, subject, author, year, availability…)
GET  /books/:id
GET  /books/:id/recommendations
GET  /search?q=                     full-text + autocomplete (books, authors, genres, lists)
GET  /categories
GET  /reading-lists                 visible to the caller (private/class/school per role)
POST /reading-lists
POST /reading-lists/:id/items
POST /favourites
DELETE /favourites/:id
POST /reservations
DELETE /reservations/:id
POST /reviews                       goes to moderation queue, not published directly
GET  /me
GET  /me/loans
GET  /me/reservations
GET  /me/recommendations
GET  /me/reading-history
POST /ai/chat                       server-side only; see AI Gateway
POST /privacy/export-request
POST /privacy/deletion-request
```

## Admin (librarian / library_admin / system_admin only — 403 for all other roles)

```
GET  /admin/books
POST /admin/books
PATCH /admin/books/:id
POST /admin/books/import              CSV → validate → preview → commit (never silent overwrite)
POST /admin/books/:id/enrich          trigger metadata enrichment pipeline for one ISBN
POST /admin/books/bulk                bulk edit/categorise/hide/staff-pick/exclude
GET  /admin/integrations
POST /admin/integrations/:id/sync
POST /admin/integrations/:id/test-connection
GET  /admin/recommendations/config
PATCH /admin/recommendations/config
GET  /admin/reviews/queue
POST /admin/reviews/:id/moderate
GET  /admin/ai/settings
PATCH /admin/ai/settings              enable/disable, mode, retention, allowed roles
GET  /admin/ai/events                 safety events, not full transcripts by default
GET  /admin/users
GET  /admin/audit
```

## Error contract

Student-facing errors are always a generic, friendly message (`"Something went wrong. Please
try again."`) — never a stack trace, SQL fragment, internal service name, or key. Admin-facing
errors may include a correlation ID for support, never secrets.

## Rate limits (indicative — tune per environment)

auth: 10/min · search: 60/min · AI: 20/min · reviews: 5/min · admin writes: 30/min ·
integration syncs: manual-trigger only, debounced 5 min.
