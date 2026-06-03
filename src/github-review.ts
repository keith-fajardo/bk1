// Thin GitHub REST layer for bk1-review: fetch a PR's diff and post one batched review.
// Uses fetch + GITHUB_TOKEN (built into Bun, no `gh` dependency on the runner).

import type { ReviewPayload } from './review-mapping';

const API = 'https://api.github.com';

export interface GhContext {
  repo: string;   // owner/name
  pr: number;
  commit: string; // head SHA the comments attach to
  token: string;
}

function headers(token: string, accept = 'application/vnd.github+json'): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'bk1-review',
  };
}

export async function fetchPrDiff(ctx: GhContext): Promise<string> {
  const res = await fetch(`${API}/repos/${ctx.repo}/pulls/${ctx.pr}`, {
    headers: headers(ctx.token, 'application/vnd.github.v3.diff'),
  });
  if (!res.ok) throw new Error(`GitHub diff fetch failed: ${res.status} ${await res.text()}`);
  return res.text();
}

// Post one review with the summary body + inline comments. event:"COMMENT" keeps the
// human gate on the job's exit code rather than a blocking GitHub review.
//
// The Reviews API rejects the WHOLE review (422) if any single comment line isn't valid
// for the commit's diff. We pre-validate against the parsed diff before calling this, but
// on a 422 the caller retries with comments collapsed into the body so the run never
// silently produces nothing.
export async function postReview(ctx: GhContext, payload: ReviewPayload): Promise<void> {
  const res = await fetch(`${API}/repos/${ctx.repo}/pulls/${ctx.pr}/reviews`, {
    method: 'POST',
    headers: { ...headers(ctx.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commit_id: ctx.commit,
      event: 'COMMENT',
      body: payload.body,
      comments: payload.comments,
    }),
  });
  if (res.status === 422 && payload.comments.length > 0) {
    const collapsed = `${payload.body}\n\n_(inline placement failed — ${payload.comments.length} comment(s) folded into this summary)_`;
    const retry = await fetch(`${API}/repos/${ctx.repo}/pulls/${ctx.pr}/reviews`, {
      method: 'POST',
      headers: { ...headers(ctx.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit_id: ctx.commit, event: 'COMMENT', body: collapsed, comments: [] }),
    });
    if (!retry.ok) throw new Error(`GitHub review post failed (after 422 fallback): ${retry.status} ${await retry.text()}`);
    return;
  }
  if (!res.ok) throw new Error(`GitHub review post failed: ${res.status} ${await res.text()}`);
}
