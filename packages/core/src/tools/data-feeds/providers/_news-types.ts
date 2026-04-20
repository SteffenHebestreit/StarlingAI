/** Shared types for `news` category providers. */

export interface NewsQuery {
  /** Free-text topic / category hint (interpreted per provider). */
  topic?: string;
  /** Maximum items to return (default 10, max 50). */
  limit?: number;
  /** Optional language hint (BCP-47, e.g. "en", "de"). Honoured by some providers. */
  language?: string;
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  author?: string;
  summary?: string;
  /** Provider-specific score (HN points, Reddit upvotes, etc.). */
  score?: number;
  commentCount?: number;
}
