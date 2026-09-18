# Abingdon School Digital Library — Architecture & Planning

## A. Executive Product Summary

A premium, catalogue-first digital library platform for Abingdon School: a Netflix-style
discovery layer sitting on top of the school's authoritative catalogue (availability, copies,
loans), enriched by Browns Books and VLEbooks, with a guarded, catalogue-only Gemini assistant.
Design language: editorial, academic, information-dense, built on the Abingdon pink/steel-blue/
near-black palette. Architecture separates four concerns — catalogue/data, recommendations, AI,
UI — so any one can be swapped or fail without breaking the others.

## B. Assumptions (stated explicitly — flag any that are wrong)

- No VLEbooks/Browns/Amazon Business API documentation or credentials were supplied → all three
  are built as adapters against mock data, not real endpoints.
- No Abingdon logo/crest asset was supplied → placeholder wordmark used, clearly marked.
- School uses (or will use) Microsoft Entra ID for SSO — the common case for UK independent
  schools on Microsoft 365 — pending confirmation.
- Students are minors; the platform treats all borrowing/reading/AI history as data requiring
  minimisation by default, not just "student data."
- Reviews are enabled but moderated pre-publication, not post-publication.
- "Less negative space" is read as high information density in grids/tables, not as removing
  breathing room around interactive controls (which accessibility still requires).

## C. Open Questions (need school/IT/DPO input before build-out)

1. VLEbooks: which API/EDI variant, auth model, rate limits?
2. Browns Books: EDI (e.g. EDItEUR) or REST, what fields are licensed for reuse (covers/blurbs)?
3. Amazon Business: is procurement automation actually in scope, or just product lookup?
4. SSO provider and tenant details; do staff and students share one tenant?
5. Data retention periods for AI chat, search logs, borrowing history — DPO-approved figures.
6. Age-banding rules (by year group? by librarian tag?) and who owns content-warning policy.
7. Legal review owner for Privacy Policy / T&Cs placeholders.

## D. System Architecture

```
┌─────────────┐   ┌──────────────┐   ┌────────────────────┐
│  Frontend    │──▶│   API layer   │──▶│  Catalogue Service  │──▶ PostgreSQL (source of truth)
│ (Next.js/TS) │   │ (Node/TS,     │   │  (books, copies,    │
│              │◀──│  REST, RBAC)  │◀──│  loans, holds)      │
└─────────────┘   └──────┬───────┘   └────────────────────┘
                          │
        ┌─────────────────┼─────────────────────┐
        ▼                 ▼                      ▼
 ┌───────────────┐ ┌──────────────┐   ┌────────────────────┐
 │ Recommendation │ │  AI Gateway   │   │ Integration Adapters│
 │    Service     │ │ (safety layer │   │  VLEbooks / Browns /│
 │ (rules→CF→     │ │  + tool calls │   │  Amazon Business     │
 │  embeddings)   │ │  + Gemini)    │   │  (mock in dev)       │
 └───────────────┘ └──────────────┘   └────────────────────┘
```

Every arrow is an explicit, typed boundary; nothing downstream is trusted implicitly (this
matters most for the AI Gateway — see section L).

## E. Information Architecture / Sitemap (condensed — full 34-screen list per brief section 107)

Public/Student: Login · Home · Search · Discover · Category · Book Detail · Author · My Library
(Loans/Holds/Favourites/Reading Lists/History) · AI Assistant · Profile/Settings/Privacy · Help

Admin: Dashboard · Catalogue · Book Editor · CSV Import · Metadata Enrichment · Integrations
(VLEbooks/Browns/Amazon) · Recommendations · Reviews Moderation · Users · AI Controls ·
Analytics · Audit Logs · System Settings

## F. User Journeys (see brief §108 — all 12 modelled; three load-bearing ones below)

- **J2 (AI discovery)**: student message → AI Gateway strips PII → policy layer checks intent →
  Gemini calls `find_similar_books()` tool only → results resolved against live catalogue →
  response never contains a book the tool didn't return.
- **J11 (Gemini outage)**: AI Gateway health-checks Gemini; on failure, AI panel shows "AI
  assistant is temporarily unavailable — try Search" and disables the input; catalogue/search
  keep working untouched.
- **J12 (cross-account access)**: every `/me/*` route resolves the acting user from the session,
  never from a client-supplied ID; a request for another student's loan record 403s before it
  reaches the catalogue service.

## G. Design System — see `design-tokens.json` and the prototype artifact

## H. Database Schema — see `schema.sql`

## I. API Architecture — see `api-spec.md`

## J. Integration Architecture — see `adapters.ts`

## K. Recommendation Engine

Phase 1 (ship day one): weighted blend of (a) content similarity on genre/subject/author tags,
(b) popularity within a rolling window, (c) editorial pins/staff picks, (d) availability boost.
Phase 2: collaborative filtering on aggregated, anonymised co-interaction data (no individual
profiles exposed). Phase 3 (optional): embedding-based semantic similarity for "something like X."
Every recommendation carries a `reason` object (`type`, `human_readable`) so "Why am I seeing
this?" is always answerable from data already computed, never invented at render time.

## L. Gemini / AI Safety Architecture

- Client never holds a Gemini key; all calls are server-side through the AI Gateway.
- Gateway enforces: catalogue-only tool set (no raw SQL, no arbitrary URLs), PII minimisation
  (pseudonymous user ID + coarse preference tags only), output scanning before it reaches the
  client, and a hard instruction-vs-data boundary — book descriptions, reviews and CSV-imported
  text are always passed to the model as quoted **data** inside a tool result, never concatenated
  into the instruction context, so "ignore previous instructions" embedded in a book blurb has
  no channel to execute.
- Modes: `AI_ENABLED` / `AI_RESTRICTED` (catalogue-only) / `AI_DISABLED`, settable school-wide or
  per role, with a kill switch.
- Red-team suite (brief §84) run in CI before any AI Gateway change ships.

## M. GDPR / Privacy

Lawful basis: public task / legitimate interests for core library function (school context);
consent only where genuinely optional (e.g. personalised-recommendations opt-in). Data
minimisation is enforced at the schema level — the AI Gateway physically cannot see fields it
isn't passed. Export/deletion requests go through an admin-reviewed workflow, not self-service
deletion of records the school is legally required to retain (loan history for a term, audit
logs). Full retention table is a DPO decision (see Open Questions).

## N. Security

RBAC enforced server-side at every route (Public/Student/Staff/Librarian/Admin/System). Secrets
in environment/secret manager only. CSP restricts script origins; CSRF tokens on state-changing
requests; rate limiting on auth, search, AI, reviews, admin, and integration endpoints.

## O. Admin System — see prototype "Admin" view + `api-spec.md` admin routes

## P. Testing — unit/integration/API/DB/recommendation/AI-guardrail/accessibility/E2E per brief
§83, plus the AI red-team suite (§84) as its own CI gate.

## Q. Implementation Roadmap

**P0**: auth, catalogue, search, book detail, availability, admin catalogue CRUD, CSV import,
VLEbooks adapter skeleton, security/GDPR fundamentals.
**P1**: recommendations (phase 1), reading lists, favourites, metadata enrichment, Browns
adapter, admin dashboard.
**P2**: Gemini assistant + guardrails, AI recommendations, reviews, advanced personalisation.
**P3**: analytics, recommendation phase 2/3, Amazon Business procurement, advanced motion.

---
*This document, the schema, API spec, adapters, and prototype are a blueprint for engineering
and design sign-off — not a production deployment. VLEbooks/Browns/Amazon integrations are mock
implementations pending real provider documentation and credentials (see Open Questions).*
