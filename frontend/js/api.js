/** Fetch wrapper for API calls */
const API_BASE = '/api';

async function api(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const config = {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    };
    if (config.body && typeof config.body === 'object') {
        config.body = JSON.stringify(config.body);
    }
    const res = await fetch(url, config);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text}`);
    }
    return res.json();
}

const Api = {
    // Extraction
    startExtract: (incremental = false) =>
        api('/extract/start', { method: 'POST', body: { incremental } }),
    getExtractStatus: () => api('/extract/status'),

    // Matching
    runMatch: (matchTypes = null) =>
        api('/match/run', { method: 'POST', body: matchTypes ? { match_types: matchTypes } : {} }),
    getMatchStatus: () => api('/match/status'),
    getMatchOptions: () => api('/match/options'),
    getGroups: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v === null || v === undefined || v === '') continue;
            // Handle arrays (e.g., match_types)
            if (Array.isArray(v)) {
                v.forEach(item => qs.append(k, item));
            } else {
                qs.set(k, v);
            }
        }
        return api(`/match/groups?${qs}`);
    },
    getGroupDetail: (id) => api(`/match/groups/${id}`),
    getGroupNeighbors: (id, params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v === null || v === undefined || v === '') continue;
            if (Array.isArray(v)) {
                v.forEach(item => qs.append(k, item));
            } else {
                qs.set(k, v);
            }
        }
        return api(`/match/groups/${id}/neighbors?${qs}`);
    },
    getOwners: () => api('/match/owners'),
    getGroupIds: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v === null || v === undefined || v === '') continue;
            if (Array.isArray(v)) {
                v.forEach(item => qs.append(k, item));
            } else {
                qs.set(k, v);
            }
        }
        return api(`/match/group-ids?${qs}`);
    },

    // Merge writes are hard-disabled. Dismiss stays on the local database.
    getMergePreview: (groupId) => api(`/merge/preview/${groupId}`),
    executeMerge() {
        throw new Error('Read-only mode: Salesforce merge is disabled.');
    },
    setParent() {
        throw new Error('Read-only mode: Salesforce parent updates are disabled.');
    },
    dismissGroup: (groupId) =>
        api(`/merge/dismiss/${groupId}`, { method: 'POST' }),
    bulkMerge(groupIds, action = 'merge') {
        if (action !== 'dismiss') {
            throw new Error('Read-only mode: Salesforce writes are disabled.');
        }
        return api('/merge/bulk', { method: 'POST', body: { group_ids: groupIds, action } });
    },

    // Export
    exportGroups: async (groupIds = null, tier = null, status = null) => {
        const params = {};
        if (tier) params.tier = tier;
        if (status) params.status = status;
        const qs = new URLSearchParams(params).toString();
        const url = `${API_BASE}/match/export${qs ? '?' + qs : ''}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(groupIds),
        });
        if (!res.ok) throw new Error(`Export failed: ${res.status}`);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'duplicate_groups.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },

    // Dashboard
    getDashboard: () => api('/dashboard'),
};

const MatchOptionsStore = {
    items: [],
    byType: {},
    loadingPromise: null,
};

async function ensureMatchOptions() {
    if (MatchOptionsStore.items.length > 0) return MatchOptionsStore.items;
    if (!MatchOptionsStore.loadingPromise) {
        MatchOptionsStore.loadingPromise = Api.getMatchOptions()
            .then((data) => {
                MatchOptionsStore.items = data.match_types || [];
                MatchOptionsStore.byType = Object.fromEntries(
                    MatchOptionsStore.items.map((item) => [item.type, item])
                );
                return MatchOptionsStore.items;
            })
            .finally(() => {
                MatchOptionsStore.loadingPromise = null;
            });
    }
    return MatchOptionsStore.loadingPromise;
}

function getMatchTypeLabel(type) {
    return MatchOptionsStore.byType[type]?.label || type.replace(/_/g, ' ');
}

function getMatchTypeBadgeClass(type) {
    const classes = {
        website: 'badge-website',
        website_verified: 'badge-website-verified',
        sumble: 'badge-sumble',
        linkedin: 'badge-linkedin',
        name: 'badge-name',
    };
    return classes[type] || 'badge-generic';
}
