export const azureProject = {
  organization: 'BPCL-Retail',
  project: 'BPCL_CGDCNG_GASHOS',
};

const orgUrl = `https://dev.azure.com/${encodeURIComponent(azureProject.organization)}`;
const projectUrl = `${orgUrl}/${encodeURIComponent(azureProject.project)}`;

export async function fetchMyPullRequests(accessToken, { signal, fetcher = fetch } = {}) {
  const get = async (url) => {
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Azure DevOps authorization expired. Connect again.');
      if (response.status === 403) throw new Error('Your Microsoft account does not have access to this Azure DevOps project.');
      throw new Error(`Azure DevOps could not load your PRs (${response.status}). Try again.`);
    }
    return response.json();
  };
  // Azure DevOps identity IDs differ from Firebase UIDs and Entra object IDs.
  const connection = await get(`${orgUrl}/_apis/connectionData?api-version=7.1-preview.1`);
  const identity = connection.authenticatedUser;
  if (!identity?.id || !/^[a-f0-9-]{36}$/i.test(identity.id)) {
    throw new Error('Could not identify the connected Azure DevOps account.');
  }
  const prs = new Map();
  for (let skip = 0; ; skip += 100) {
    const url = new URL(`${projectUrl}/_apis/git/pullrequests`);
    url.search = new URLSearchParams({
      'searchCriteria.creatorId': identity.id,
      'searchCriteria.status': 'all',
      '$top': '100',
      '$skip': String(skip),
      'api-version': '7.1',
    });
    const page = await get(url.href);
    if (!Array.isArray(page.value)) throw new Error('Azure DevOps returned an unexpected PR response.');
    for (const pr of page.value) {
      if (pr.createdBy?.id?.toLowerCase() !== identity.id.toLowerCase()) continue;
      if (!Number.isInteger(pr.pullRequestId) || !pr.repository?.id || !pr.repository?.name) continue;
      const key = `${pr.repository.id}:${pr.pullRequestId}`;
      prs.set(key, {
        key, id: pr.pullRequestId, title: pr.title || '', status: pr.status || '',
        repository: pr.repository.name, createdAt: pr.creationDate || '',
        url: `${projectUrl}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`,
      });
    }
    if (page.value.length < 100) break;
  }
  return { account: identity.providerDisplayName || identity.customDisplayName || 'Connected Microsoft account',
    prs: [...prs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}
