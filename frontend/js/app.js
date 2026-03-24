/** Main app: routing and initialization */

let currentView = 'dashboard';
let currentGroupId = null;

function navigate(view, params = {}) {
    currentView = view;
    document.querySelectorAll('.nav-link').forEach(el => {
        const isActive = el.dataset.view === view || (view === 'group-detail' && el.dataset.view === 'groups');
        el.classList.toggle('nav-pill-active', isActive);
        el.classList.toggle('text-slate-500', !isActive);
        el.classList.toggle('hover:text-charcoal', !isActive);
        el.classList.toggle('hover:bg-sand', !isActive);
    });

    // Update URL hash for filter persistence
    if (view === 'groups' && Object.keys(params).length > 0) {
        const hashParams = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v === null || v === undefined || v === '') continue;
            if (Array.isArray(v)) v.forEach(item => hashParams.append(k, item));
            else hashParams.set(k, v);
        }
        history.replaceState(null, '', `#groups?${hashParams}`);
    } else if (view === 'group-detail') {
        history.replaceState(null, '', `#group/${params.groupId}`);
    } else if (view === 'dashboard') {
        history.replaceState(null, '', '#');
    }

    const main = document.getElementById('main-content');
    main.innerHTML = '<div class="flex justify-center py-12"><div class="spinner"></div></div>';

    switch (view) {
        case 'dashboard':
            renderDashboard(main);
            break;
        case 'groups':
            renderGroupList(main, params);
            break;
        case 'group-detail':
            currentGroupId = params.groupId;
            renderGroupDetail(main, params.groupId, params.filters || {});
            break;
    }
}

function parseHashRoute() {
    const hash = window.location.hash.slice(1);
    if (hash.startsWith('group/')) {
        const groupId = parseInt(hash.split('/')[1]);
        if (groupId) return { view: 'group-detail', params: { groupId } };
    }
    if (hash.startsWith('groups')) {
        const qIndex = hash.indexOf('?');
        if (qIndex > -1) {
            const qs = new URLSearchParams(hash.slice(qIndex + 1));
            const params = {};
            for (const key of qs.keys()) {
                const values = qs.getAll(key);
                params[key] = (key === 'match_types' || values.length > 1) ? values : values[0];
            }
            return { view: 'groups', params };
        }
        return { view: 'groups', params: {} };
    }
    return { view: 'dashboard', params: {} };
}

function init() {
    ensureMatchOptions().catch((e) => console.error('Failed to load match options:', e));

    // Nav click handlers
    document.querySelectorAll('.nav-link').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            navigate(el.dataset.view);
        });
    });

    // Restore state from URL hash
    const route = parseHashRoute();
    navigate(route.view, route.params);
}

document.addEventListener('DOMContentLoaded', init);
