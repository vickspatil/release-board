import { describe, expect, test, vi } from 'vitest';
import { fetchMyPullRequests } from '../src/azure-devops.js';

const id = '12345678-1234-1234-1234-123456789abc';
const pr = (n, overrides = {}) => ({
  pullRequestId: n, title: `Fix ${n}`, status: 'completed', createdBy: { id },
  creationDate: `2026-11-${String(n % 20 + 1).padStart(2, '0')}`,
  repository: { id: 'repo-1', name: 'Repo with spaces' },
  url: 'https://dev.azure.com/REST-URL-DO-NOT-USE', ...overrides,
});
const ok = (body) => ({ ok: true, json: async () => body });

describe('Azure DevOps PR discovery', () => {
  test('resolves Azure identity and paginates all repositories/statuses with browser URLs', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ authenticatedUser: { id, providerDisplayName: 'Work Dev' } }))
      .mockResolvedValueOnce(ok({ value: Array.from({ length: 100 }, (_, n) => pr(n + 1)) }))
      .mockResolvedValueOnce(ok({ value: [pr(101, { repository: { id: 'repo-2', name: 'Another Repo' }, status: 'active' })] }));
    const controller = new AbortController();
    const result = await fetchMyPullRequests('test-token', { fetcher, signal: controller.signal });
    expect(result.account).toBe('Work Dev');
    expect(result.prs).toHaveLength(101);
    expect(fetcher.mock.calls[0][0]).toContain('/BPCL-Retail/_apis/connectionData');
    const firstPage = new URL(fetcher.mock.calls[1][0]);
    expect(firstPage.pathname).toBe('/BPCL-Retail/BPCL_CGDCNG_GASHOS/_apis/git/pullrequests');
    expect(firstPage.searchParams.get('searchCriteria.creatorId')).toBe(id);
    expect(firstPage.searchParams.get('searchCriteria.status')).toBe('all');
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('$skip')).toBe('100');
    expect(result.prs.find((p) => p.id === 1).url).toBe('https://dev.azure.com/BPCL-Retail/BPCL_CGDCNG_GASHOS/_git/Repo%20with%20spaces/pullrequest/1');
    expect(result.prs.find((p) => p.id === 101).status).toBe('active');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ headers: { Authorization: 'Bearer test-token' }, signal: controller.signal, redirect: 'error' });
  });

  test('deduplicates results and rejects other creators and malformed records', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ authenticatedUser: { id } }))
      .mockResolvedValueOnce(ok({ value: [pr(1), pr(1), pr(2, { createdBy: { id: 'another-dev' } }), pr(3, { repository: null })] }));
    expect((await fetchMyPullRequests('test', { fetcher })).prs.map((p) => p.id)).toEqual([1]);
  });

  test('empty projects finish with an empty list', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(ok({ authenticatedUser: { id } })).mockResolvedValueOnce(ok({ value: [] }));
    expect((await fetchMyPullRequests('test', { fetcher })).prs).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test.each([[401, 'expired'], [403, 'does not have access'], [500, '(500)']])('HTTP %i reports a useful error', async (status, message) => {
    await expect(fetchMyPullRequests('test', { fetcher: async () => ({ ok: false, status }) })).rejects.toThrow(message);
  });

  test('missing identity never sends a broad project PR query', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ authenticatedUser: {} }));
    await expect(fetchMyPullRequests('test', { fetcher })).rejects.toThrow('identify');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('malformed pages are errors rather than a misleading empty result', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(ok({ authenticatedUser: { id } })).mockResolvedValueOnce(ok({ count: 0 }));
    await expect(fetchMyPullRequests('test', { fetcher })).rejects.toThrow('unexpected');
  });

  test('cancelled requests propagate without returning partial results', async () => {
    const error = new DOMException('Cancelled', 'AbortError');
    await expect(fetchMyPullRequests('test', { fetcher: async () => { throw error; } })).rejects.toBe(error);
  });
});
