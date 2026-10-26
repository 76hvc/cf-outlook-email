import type { GraphTokenResponse, GraphMailMessage } from './types';
import { maskToken } from './utils/validation';

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Graph caps $top at 50. The aggregated (inbox + junk) view merges two folder
// listings client-side, so it can only ever reach the newest 50 of each.
const GRAPH_PAGE_MAX = 50;

export interface GraphError {
  code: string;
  message: string;
}

// Get access token using refresh_token via Graph endpoint
// Returns new_refresh_token when Microsoft issues a rotated token
export async function getAccessToken(
  clientId: string,
  refreshToken: string
): Promise<{ token?: string; newRefreshToken?: string; error?: GraphError }> {
  try {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://graph.microsoft.com/.default',
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, string>;
      return {
        error: {
          code: err.error || 'TOKEN_FAILED',
          message: err.error_description
            ? sanitizeErrorMessage(err.error_description)
            : `Token request failed with status ${res.status}`,
        },
      };
    }

    const data = (await res.json()) as GraphTokenResponse;
    return {
      token: data.access_token,
      newRefreshToken: data.refresh_token,
    };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error during token request: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Fetch email list from inbox
export async function fetchEmails(
  accessToken: string,
  options: { folder?: string; top?: number; skip?: number; keyword?: string; includeBody?: boolean } = {}
): Promise<{ items?: GraphMailMessage[]; hasMore?: boolean; error?: GraphError }> {
  const { folder = 'inbox', top = 20, skip = 0, keyword, includeBody = false } = options;

  // Aggregated view: merge inbox + junk, sorted by date desc.
  //
  // To serve page N of the merged stream we need the newest (skip + top) rows of
  // *each* folder, so that is what we ask Graph for. Two subrequests either way.
  // The old code always asked for `top` with skip=0 and then sliced from index 0,
  // which made every page after the first silently repeat page 1.
  if (folder === 'all') {
    const want = Math.min(skip + top, GRAPH_PAGE_MAX);
    const [inbox, junk] = await Promise.all([
      fetchEmails(accessToken, { folder: 'inbox', top: want, skip: 0, keyword, includeBody }),
      fetchEmails(accessToken, { folder: 'junkemail', top: want, skip: 0, keyword, includeBody }),
    ]);
    // If both fail, surface the error; otherwise show whatever succeeded
    if (inbox.error && junk.error) return { error: inbox.error };

    const merged = [...(inbox.items ?? []), ...(junk.items ?? [])]
      .sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''))
      .slice(skip, skip + top);

    return { items: merged, hasMore: merged.length === top };
  }

  let url = `${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(folder)}/messages`;
  // bodyPreview is hard-capped at 255 chars by Graph; select `body` for the full text.
  // Same single Graph request either way, so the subrequest budget is unaffected.
  const params = new URLSearchParams({
    $top: String(Math.min(top, GRAPH_PAGE_MAX)),
    $skip: String(skip),
    $orderby: 'receivedDateTime desc',
    $select:
      'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments' +
      (includeBody ? ',body' : ''),
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Prefer: 'outlook.body-content-type="text"',
  };

  if (keyword) {
    params.set('$search', `"${keyword}"`);
    headers['ConsistencyLevel'] = 'eventual';
  }

  url += '?' + params.toString();

  try {
    const res = await fetch(url, { headers });

    if (res.status === 429) {
      return { error: { code: 'RATE_LIMITED', message: 'Graph API rate limited, please retry later' } };
    }

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        error: {
          code: 'GRAPH_ERROR',
          message: `Failed to fetch emails: ${res.status}`,
        },
      };
    }

    const data = (await res.json()) as { value: GraphMailMessage[] };
    const items = data.value || [];
    return { items, hasMore: items.length === Math.min(top, GRAPH_PAGE_MAX) };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error fetching emails: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Fetch single email detail
export async function fetchEmailDetail(
  accessToken: string,
  messageId: string
): Promise<{ item?: GraphMailMessage; error?: GraphError }> {
  const url =
    `${GRAPH_BASE}/me/messages/${messageId}?` +
    new URLSearchParams({
      $select:
        'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,isRead,hasAttachments',
    }).toString();

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="html"',
      },
    });

    if (res.status === 404) {
      return { error: { code: 'NOT_FOUND', message: '邮件不存在' } };
    }

    if (!res.ok) {
      return {
        error: { code: 'GRAPH_ERROR', message: `Failed to fetch email detail: ${res.status}` },
      };
    }

    const data = (await res.json()) as GraphMailMessage;
    return { item: data };
  } catch (e) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: `Network error: ${e instanceof Error ? e.message : 'unknown'}`,
      },
    };
  }
}

// Delete a message (Graph soft-deletes it to Deleted Items)
export async function deleteEmail(
  accessToken: string,
  messageId: string
): Promise<{ ok: boolean; error?: GraphError }> {
  try {
    const res = await fetch(`${GRAPH_BASE}/me/messages/${messageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 204 || res.ok) return { ok: true };
    if (res.status === 404) return { ok: false, error: { code: 'NOT_FOUND', message: '邮件不存在' } };
    if (res.status === 403) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: '无删除权限：该账号是只读授权。请在「编辑账号 → 重新授权」重新授权以获取读写权限',
        },
      };
    }
    return { ok: false, error: { code: 'GRAPH_ERROR', message: `删除失败: ${res.status}` } };
  } catch (e) {
    return {
      ok: false,
      error: { code: 'NETWORK_ERROR', message: `Network error: ${e instanceof Error ? e.message : 'unknown'}` },
    };
  }
}

export interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  parentFolderId?: string;
  childFolderCount?: number;
  // Well-known slug ('inbox', 'drafts', ...) when this folder is a standard one.
  // Graph returns displayName localised per-mailbox, so one account reports
  // "Archive" and another "存档"; the slug lets the UI use its own language.
  wellKnown?: string;
}

// Graph has no wellKnownName field, so the ids are resolved once per request
// through a single $batch call (1 subrequest for all of them).
const WELL_KNOWN_FOLDERS = [
  'inbox',
  'drafts',
  'sentitems',
  'deleteditems',
  'junkemail',
  'archive',
  'outbox',
  'conversationhistory',
];

async function fetchWellKnownIds(accessToken: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  try {
    const res = await fetch(`${GRAPH_BASE}/$batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: WELL_KNOWN_FOLDERS.map((name, i) => ({
          id: String(i),
          method: 'GET',
          url: `/me/mailFolders/${name}?$select=id`,
        })),
      }),
    });
    if (!res.ok) return ids;
    const data = (await res.json()) as {
      responses?: { id: string; status: number; body?: { id?: string } }[];
    };
    for (const r of data.responses ?? []) {
      const name = WELL_KNOWN_FOLDERS[Number(r.id)];
      const id = r.body?.id;
      if (name && id && r.status === 200) ids.set(id, name);
    }
  } catch {
    // Non-fatal: the UI falls back to Graph's displayName
  }
  return ids;
}


// List the mailbox's folders so the UI is not limited to the three well-known
// ones. Mail does land in subfolders (Outlook rules, Focused/Other splits), and
// a folder the panel cannot name is a folder the user cannot open.
// One request for the top level plus at most MAX_CHILD_REQUESTS for children,
// to stay well inside the free tier's subrequest budget.
const MAX_CHILD_REQUESTS = 3;

export async function listMailFolders(
  accessToken: string
): Promise<{ items?: GraphFolder[]; error?: GraphError }> {
  const select = 'id,displayName,totalItemCount,unreadItemCount,parentFolderId,childFolderCount';
  const headers = { Authorization: `Bearer ${accessToken}` };

  const fetchFolders = async (path: string): Promise<GraphFolder[] | GraphError> => {
    const res = await fetch(`${GRAPH_BASE}${path}`, { headers });
    if (!res.ok) {
      return { code: 'GRAPH_ERROR', message: `Failed to list folders: ${res.status}` };
    }
    const data = (await res.json()) as { value: GraphFolder[] };
    return data.value ?? [];
  };

  try {
    const [root, wellKnown] = await Promise.all([
      fetchFolders(`/me/mailFolders?$top=100&$select=${select}`),
      fetchWellKnownIds(accessToken),
    ]);
    if (!Array.isArray(root)) return { error: root };

    const children: GraphFolder[] = [];
    const parents = root.filter((f) => (f.childFolderCount ?? 0) > 0).slice(0, MAX_CHILD_REQUESTS);
    for (const parent of parents) {
      const sub = await fetchFolders(
        `/me/mailFolders/${encodeURIComponent(parent.id)}/childFolders?$top=100&$select=${select}`
      );
      if (Array.isArray(sub)) children.push(...sub);
    }

    const all = [...root, ...children].map((f) => {
      const slug = wellKnown.get(f.id);
      return slug ? { ...f, wellKnown: slug } : f;
    });
    return { items: all };
  } catch (e) {
    return {
      error: { code: 'NETWORK_ERROR', message: e instanceof Error ? e.message : 'unknown' },
    };
  }
}

export interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes?: string; // base64, present when fetching a single fileAttachment
}

// List attachments metadata for a message
export async function listAttachments(
  accessToken: string,
  messageId: string
): Promise<{ items?: GraphAttachment[]; error?: GraphError }> {
  const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments?$select=id,name,contentType,size`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return { error: { code: 'GRAPH_ERROR', message: `获取附件列表失败: ${res.status}` } };
    const data = (await res.json()) as { value: GraphAttachment[] };
    return { items: data.value ?? [] };
  } catch (e) {
    return { error: { code: 'NETWORK_ERROR', message: e instanceof Error ? e.message : 'unknown' } };
  }
}

// Fetch a single attachment (includes base64 contentBytes for fileAttachment)
export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string
): Promise<{ attachment?: GraphAttachment; error?: GraphError }> {
  const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments/${attachmentId}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 404) return { error: { code: 'NOT_FOUND', message: '附件不存在' } };
    if (!res.ok) return { error: { code: 'GRAPH_ERROR', message: `获取附件失败: ${res.status}` } };
    const data = (await res.json()) as GraphAttachment;
    return { attachment: data };
  } catch (e) {
    return { error: { code: 'NETWORK_ERROR', message: e instanceof Error ? e.message : 'unknown' } };
  }
}

// Remove any token-like strings from error messages
function sanitizeErrorMessage(msg: string): string {
  // Redact anything that looks like a token (long base64/alphanumeric strings)
  return msg.replace(/[A-Za-z0-9_-]{40,}/g, (match) => maskToken(match));
}
