/** Filter bar component for group list */

let _ownersCache = null;

async function _loadOwners() {
    if (_ownersCache) return _ownersCache;
    try {
        const data = await Api.getOwners();
        _ownersCache = data.owners || [];
    } catch (e) {
        _ownersCache = [];
    }
    return _ownersCache;
}

function renderFilters(container, currentFilters, onChange) {
    const selectedMatchTypes = Array.isArray(currentFilters.match_types)
        ? currentFilters.match_types
        : (currentFilters.match_types ? [currentFilters.match_types] : []);
    const div = document.createElement('div');
    div.className = 'flex flex-wrap gap-3 mb-4 items-center';
    div.innerHTML = `
        <select id="filter-tier" class="rounded-lg border-sand-dark text-sm px-3 py-2 border bg-white focus:ring-alarmalade-500 focus:border-alarmalade-500">
            <option value="">All Tiers</option>
            <option value="1" ${currentFilters.tier == 1 ? 'selected' : ''}>Tier 1 &mdash; Definite</option>
            <option value="2" ${currentFilters.tier == 2 ? 'selected' : ''}>Tier 2 &mdash; Likely</option>
            <option value="3" ${currentFilters.tier == 3 ? 'selected' : ''}>Tier 3 &mdash; Possible</option>
        </select>
        <select id="filter-match-type" class="rounded-lg border-sand-dark text-sm px-3 py-2 border bg-white focus:ring-alarmalade-500 focus:border-alarmalade-500">
            <option value="">All Match Types</option>
        </select>
        <select id="filter-status" class="rounded-lg border-sand-dark text-sm px-3 py-2 border bg-white focus:ring-alarmalade-500 focus:border-alarmalade-500">
            <option value="">All Statuses</option>
            <option value="pending" ${currentFilters.status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="merged" ${currentFilters.status === 'merged' ? 'selected' : ''}>Merged</option>
            <option value="dismissed" ${currentFilters.status === 'dismissed' ? 'selected' : ''}>Dismissed</option>
        </select>
        <select id="filter-owner" class="rounded-lg border-sand-dark text-sm px-3 py-2 border bg-white focus:ring-alarmalade-500 focus:border-alarmalade-500">
            <option value="">All Owners</option>
        </select>
        <div id="owner-match-toggle" class="flex items-center gap-2 text-sm ${currentFilters.owner ? '' : 'hidden'}">
            <label class="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="owner-match" value="all" class="text-alarmalade-500 focus:ring-alarmalade-500" ${currentFilters.owner_match !== 'any' ? 'checked' : ''}>
                <span>All accounts</span>
            </label>
            <label class="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="owner-match" value="any" class="text-alarmalade-500 focus:ring-alarmalade-500" ${currentFilters.owner_match === 'any' ? 'checked' : ''}>
                <span>Any account</span>
            </label>
        </div>
        <label class="flex items-center gap-1.5 cursor-pointer text-sm">
            <input type="checkbox" id="filter-svc" class="rounded border-slate-300 text-purple-500 focus:ring-purple-500"
                ${currentFilters.has_service_owner ? 'checked' : ''}>
            <span class="text-purple-700 font-medium">SVC/Admin</span>
        </label>
        <input id="filter-search" type="text" placeholder="Search account name..."
            value="${currentFilters.search || ''}"
            class="rounded-lg border-sand-dark text-sm px-3 py-2 border flex-1 min-w-[200px] bg-white focus:ring-alarmalade-500 focus:border-alarmalade-500">
    `;

    container.appendChild(div);

    ensureMatchOptions().then(options => {
        const sel = document.getElementById('filter-match-type');
        if (!sel) return;
        const currentValue = selectedMatchTypes[0];
        sel.innerHTML = `
            <option value="">All Match Types</option>
            ${options.map(option => `
                <option value="${option.type}" ${currentValue === option.type ? 'selected' : ''}>${option.label}</option>
            `).join('')}
        `;
    });

    _loadOwners().then(owners => {
        const sel = document.getElementById('filter-owner');
        if (!sel) return;
        owners.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (currentFilters.owner === name) opt.selected = true;
            sel.appendChild(opt);
        });
    });

    let debounceTimer;
    const update = () => {
        const ownerVal = document.getElementById('filter-owner').value || null;
        const matchRadio = document.querySelector('input[name="owner-match"]:checked');
        const ownerMatchVal = matchRadio ? matchRadio.value : 'all';
        const toggle = document.getElementById('owner-match-toggle');
        if (ownerVal) toggle.classList.remove('hidden');
        else toggle.classList.add('hidden');

        const matchTypeVal = document.getElementById('filter-match-type').value;
        const svcChecked = document.getElementById('filter-svc').checked;
        onChange({
            tier: document.getElementById('filter-tier').value || null,
            match_types: matchTypeVal ? [matchTypeVal] : null,
            status: document.getElementById('filter-status').value || null,
            search: document.getElementById('filter-search').value || null,
            owner: ownerVal,
            owner_match: ownerVal ? ownerMatchVal : null,
            has_service_owner: svcChecked || null,
            page: 1,
        });
    };

    div.querySelectorAll('select').forEach(el => el.addEventListener('change', update));
    div.querySelectorAll('input[name="owner-match"]').forEach(el => el.addEventListener('change', update));
    document.getElementById('filter-svc').addEventListener('change', update);
    document.getElementById('filter-search').addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(update, 300);
    });
}
