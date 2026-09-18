/**
 * Integration adapters — VLEbooks, Browns Books, Amazon Business.
 *
 * IMPORTANT: No provider API/EDI documentation or credentials were supplied for any of these
 * three integrations. Nothing here invents endpoints, auth flows or payload shapes. Each
 * adapter is a clean interface with a MockAdapter implementation for development, and a
 * `// TODO: requires provider documentation/credentials` marker everywhere a real
 * implementation would need it. Swap the mock for a real class once docs/creds exist — nothing
 * else in the app should need to change, because callers only ever depend on the interface.
 */

export interface CatalogueEntry {
  isbn13: string;
  title: string;
  authors: string[];
  publisher?: string;
  publicationDate?: string;
  coverUrl?: string;
  description?: string;
  categories?: string[];
}

export interface AvailabilityRecord {
  isbn13: string;
  availableCopies: number;
  totalCopies: number;
}

/** Common shape every catalogue/EDI-style provider adapter implements. */
export interface ProviderAdapter {
  authenticate(): Promise<void>;
  getCatalogue(params: { since?: Date; page?: number }): Promise<CatalogueEntry[]>;
  getBook(isbn13: string): Promise<CatalogueEntry | null>;
  healthCheck(): Promise<'connected' | 'degraded' | 'failed'>;
}

/** VLEbooks — likely EDI/API hybrid; exact auth + endpoint shape unknown. */
export interface VLEbooksAdapter extends ProviderAdapter {
  getAvailability(isbn13: string): Promise<AvailabilityRecord | null>;
  getTransactions(since: Date): Promise<unknown[]>; // TODO: requires provider documentation/credentials
  sync(): Promise<{ added: number; updated: number; failed: number }>;
}

export class MockVLEbooksAdapter implements VLEbooksAdapter {
  async authenticate() {/* no-op in mock */}
  async getCatalogue() { return []; }
  async getBook(isbn13: string) { return null; }
  async getAvailability(isbn13: string): Promise<AvailabilityRecord> {
    return { isbn13, availableCopies: 1, totalCopies: 2 };
  }
  async getTransactions() { return []; }
  async sync() { return { added: 0, updated: 0, failed: 0 }; }
  async healthCheck(): Promise<'connected'> { return 'connected'; } // mock always healthy
}

/** Browns Books — metadata enrichment source; exact field set is provider-licensed. */
export interface BrownsAdapter extends ProviderAdapter {} // TODO: requires provider documentation/credentials

export class MockBrownsAdapter implements BrownsAdapter {
  async authenticate() {}
  async getCatalogue() { return []; }
  async getBook(isbn13: string) { return null; }
  async healthCheck(): Promise<'connected'> { return 'connected'; }
}

/** Amazon Business — scope (lookup vs. procurement) needs confirming before real build. */
export interface AmazonBusinessAdapter {
  lookupProduct(isbn13: string): Promise<{ title: string; price?: string } | null>;
  // Procurement/ordering intentionally NOT modelled until scope is confirmed — see Open
  // Questions in architecture.md. Admin-only; students must never reach this adapter.
}

export class MockAmazonBusinessAdapter implements AmazonBusinessAdapter {
  async lookupProduct(isbn13: string) { return null; }
}

/**
 * AI Gateway — the boundary between the frontend and Gemini.
 * Key rule: book descriptions/reviews/CSV text are always DATA passed inside tool results,
 * never concatenated into the instruction/system context. This is what stops a book blurb
 * that reads "ignore previous instructions" from having any channel to execute.
 */
export interface CatalogueToolResult<T> {
  source: 'catalogue';
  data: T; // treated as untrusted content by the model — never as instructions
}

export interface AIGatewayTools {
  search_books(query: string): Promise<CatalogueToolResult<CatalogueEntry[]>>;
  get_book(isbn13: string): Promise<CatalogueToolResult<CatalogueEntry | null>>;
  find_similar_books(isbn13: string): Promise<CatalogueToolResult<CatalogueEntry[]>>;
  find_books_by_author(name: string): Promise<CatalogueToolResult<CatalogueEntry[]>>;
  find_books_by_topic(topic: string): Promise<CatalogueToolResult<CatalogueEntry[]>>;
  get_available_books(): Promise<CatalogueToolResult<CatalogueEntry[]>>;
  get_reading_lists(): Promise<CatalogueToolResult<unknown[]>>;
  get_staff_picks(): Promise<CatalogueToolResult<CatalogueEntry[]>>;
  // No raw SQL tool exists. No arbitrary-URL tool exists. This is enforced by omission —
  // the model is never given a capability it could misuse this way.
}

export type AIMode = 'AI_ENABLED' | 'AI_RESTRICTED' | 'AI_DISABLED';

export interface AIGatewayRequest {
  pseudonymousUserId: string;   // never the real name/email
  preferenceTags: string[];     // e.g. ["fantasy","short-reads"] — not a full profile
  message: string;
  mode: AIMode;
}
