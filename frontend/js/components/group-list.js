/** Paginated, filterable duplicate group table with selection & export */

let groupListFilters = { tier: null, match_types: null, status: null, search: null, owner: null, owner_match: null, owner1: null, owner2: null, has_service_owner: null, page: 1 };
let selectedGroupIds = new Set();
let _lastTotal = 0;
let _lastPageIds = [];

function scoreColor(score) {
    if (score >= 95) return 'bg-green-500';
    if (score >= 80) return 'bg-amber-400';
    return 'bg-slate-300';
}

function confidenceLabel(score) {
    if (score >= 95) return '<span class="confidence-high text-xs font-medium">High</span>';
    if (score >= 80) return '<span class="confidence-medium text-xs font-medium">Medium</span>';
    return '<span class="confidence-low text-xs font-medium">Low</span>';
}

async function renderGroupList(container, initialFilters = {}) {
    await ensureMatchOptions();
    groupListFilters = { ...groupListFilters, ...initialFilters };
    selectedGroupIds = new Set();
    container.innerHTML = '<div class="fade-in" id="group-list-root"></div>';
    const root = document.getElementById('group-list-root');

    root.innerHTML = `
        <div class="flex items-center justify-between mb-6">
            <div>
                <h1 class="font-serif text-3xl font-normal tracking-tight text-charcoal" style="letter-spacing: -0.9px;">Duplicate Groups</h1>
                <p class="text-slate-500 text-sm mt-1">Review and resolve duplicate accounts</p>
            </div>
            <button onclick="navigate('dashboard')" class="text-sm text-alarmalade-600 hover:text-alarmalade-700 font-medium">&larr; Dashboard</button>
        </div>
        <div id="filters-container"></div>
        <div id="select-all-banner" class="hidden bg-alarmalade-50 border border-alarmalade-200 rounded-xl px-4 py-2.5 mb-3 text-sm text-alarmalade-800 flex items-center justify-between"></div>
        <div id="export-bar" class="flex items-center gap-3 mb-3 hidden">
            <span id="selection-count" class="text-sm text-slate-600 font-medium"></span>
            <button id="btn-export-selected" class="px-3 py-1.5 bg-charcoal text-white rounded-lg text-sm hover:bg-slate-800 font-medium transition-colors">Export</button>
            <button id="btn-dismiss-selected" class="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-sm hover:bg-slate-300 font-medium transition-colors">Dismiss Selected</button>
            <button id="btn-clear-selection" class="px-3 py-1.5 text-slate-500 border border-sand-dark rounded-lg text-sm hover:bg-sand transition-colors">Clear</button>
        </div>
        <div class="flex gap-2 mb-3">
            <button id="btn-export-all" class="px-3 py-1.5 bg-sand text-slate-700 rounded-lg text-sm hover:bg-sand-dark font-medium border border-sand-dark transition-colors">Export All</button>
        </div>
        <div id="groups-table-container"></div>
        <div id="pagination-container" class="mt-4"></div>
    `;

    renderFilters(document.getElementById('filters-container'), groupListFilters, (newFilters) => {
        groupListFilters = { ...groupListFilters, ...newFilters };
        loadGroupTable();
    });

    document.getElementById('btn-export-all').addEventListener('click', async () => {
        try { await Api.exportGroups(null, groupListFilters.tier || null, groupListFilters.status || null); }
        catch (e) { alert(`Export error: ${e.message}`); }
    });

    document.getElementById('btn-export-selected').addEventListener('click', async () => {
        if (selectedGroupIds.size === 0) return;
        try { await Api.exportGroups(Array.from(selectedGroupIds)); }
        catch (e) { alert(`Export error: ${e.message}`); }
    });

    document.getElementById('btn-clear-selection').addEventListener('click', () => {
        selectedGroupIds = new Set();
        updateSelectionUI();
        document.querySelectorAll('.group-checkbox').forEach(cb => cb.checked = false);
        const selectAll = document.getElementById('select-all-checkbox');
        if (selectAll) selectAll.checked = false;
    });

    document.getElementById('btn-dismiss-selected').addEventListener('click', () => {
        if (selectedGroupIds.size === 0) return;
        showBulkConfirmModal('dismiss', Array.from(selectedGroupIds));
    });

    await loadGroupTable();
}

function updateSelectionUI() {
    const bar = document.getElementById('export-bar');
    const count = document.getElementById('selection-count');
    const banner = document.getElementById('select-all-banner');

    if (selectedGroupIds.size > 0) {
        bar.classList.remove('hidden');
        count.textContent = `${selectedGroupIds.size} group${selectedGroupIds.size > 1 ? 's' : ''} selected`;

        const allPageSelected = _lastPageIds.length > 0 && _lastPageIds.every(id => selectedGroupIds.has(id));
        if (allPageSelected && _lastTotal > _lastPageIds.length && selectedGroupIds.size < _lastTotal) {
            banner.classList.remove('hidden');
            banner.innerHTML = `
                <span>All ${_lastPageIds.length} groups on this page are selected.</span>
                <button id="btn-select-all-matching" class="ml-2 font-medium text-alarmalade-600 underline hover:text-alarmalade-800">
                    Select all ${_lastTotal.toLocaleString()} matching groups
                </button>
            `;
            document.getElementById('btn-select-all-matching').addEventListener('click', selectAllMatching);
        } else {
            banner.classList.add('hidden');
        }
    } else {
        bar.classList.add('hidden');
        banner.classList.add('hidden');
    }
}

async function selectAllMatching() {
    const banner = document.getElementById('select-all-banner');
    banner.innerHTML = '<span><div class="spinner mr-2" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle;"></div>Loading all group IDs...</span>';
    try {
        const { tier, match_types, status, search, owner, owner_match, owner1, owner2, has_service_owner } = groupListFilters;
        const data = await Api.getGroupIds({ tier, match_types, status, search, owner, owner_match, owner1, owner2, has_service_owner });
        data.group_ids.forEach(id => selectedGroupIds.add(id));
        updateSelectionUI();
        document.querySelectorAll('.group-checkbox').forEach(cb => {
            const id = parseInt(cb.dataset.id);
            if (selectedGroupIds.has(id)) cb.checked = true;
        });
        const selectAll = document.getElementById('select-all-checkbox');
        if (selectAll) selectAll.checked = true;
        banner.innerHTML = `<span>All ${selectedGroupIds.size.toLocaleString()} matching groups selected.</span>`;
    } catch (e) {
        banner.innerHTML = `<span class="text-alarmalade-600">Failed to load IDs: ${e.message}</span>`;
    }
}

async function loadGroupTable() {
    const tableContainer = document.getElementById('groups-table-container');
    tableContainer.innerHTML = '<div class="flex justify-center py-8"><div class="spinner"></div></div>';

    try {
        const data = await Api.getGroups(groupListFilters);
        _lastTotal = data.total;
        _lastPageIds = data.groups.map(g => g.group_id);
        renderGroupTable(tableContainer, data);
        renderPagination(document.getElementById('pagination-container'), data);
    } catch (e) {
        tableContainer.innerHTML = `<div class="text-alarmalade-600 py-4">Error: ${e.message}</div>`;
    }
}

function actionBadge(action) {
    if (action === 'set_parent') {
        return '<span class="badge bg-blue-50 text-blue-700 border border-blue-200">Parent-Child</span>';
    }
    return '<span class="badge bg-alarmalade-50 text-alarmalade-700 border border-alarmalade-200">Merge</span>';
}

function svcBadge(hasServiceOwner) {
    if (!hasServiceOwner) return '';
    return '<span class="badge bg-purple-50 text-purple-700 border border-purple-200 ml-1">SVC</span>';
}

function renderGroupTable(container, data) {
    if (data.groups.length === 0) {
        container.innerHTML = '<div class="text-slate-500 py-8 text-center bg-white rounded-xl border border-sand-dark">No duplicate groups found. Run matching first.</div>';
        return;
    }

    const pageIds = data.groups.map(g => g.group_id);
    const allPageSelected = pageIds.every(id => selectedGroupIds.has(id));

    const rows = data.groups.map(g => `
        <tr class="table-row border-b border-sand-dark transition-colors" id="row-${g.group_id}">
            <td class="px-3 py-3.5 w-8">
                <input type="checkbox" class="group-checkbox rounded border-slate-300 text-alarmalade-500 focus:ring-alarmalade-500" data-id="${g.group_id}"
                    ${selectedGroupIds.has(g.group_id) ? 'checked' : ''}>
            </td>
            <td class="px-4 py-3.5 cursor-pointer" onclick="navigateToDetail(${g.group_id})">
                <div class="font-medium text-charcoal">${g.names.slice(0, 2).join(', ')}</div>
                ${g.names.length > 2 ? `<div class="text-xs text-slate-400 mt-0.5">+${g.names.length - 2} more</div>` : ''}
            </td>
            <td class="px-4 py-3.5">
                ${g.match_types.map(t => `<span class="badge ${getMatchTypeBadgeClass(t)} mr-1">${getMatchTypeLabel(t)}</span>`).join('')}
            </td>
            <td class="px-4 py-3.5">${actionBadge(g.recommended_action)}${svcBadge(g.has_service_owner)}</td>
            <td class="px-4 py-3.5">
                <div class="flex items-center gap-2">
                    <div class="score-bar w-16"><div class="score-bar-fill ${scoreColor(g.score)}" style="width: ${g.score}%"></div></div>
                    <span class="font-mono text-sm text-charcoal">${g.score.toFixed(0)}</span>
                </div>
            </td>
            <td class="px-4 py-3.5">
                <span class="badge tier-${g.tier}">Tier ${g.tier}</span>
            </td>
            <td class="px-4 py-3.5 text-center text-slate-600">${g.size}</td>
            <td class="px-4 py-3.5">
                <span class="text-xs font-medium ${g.status === 'merged' ? 'text-green-600' : g.status === 'dismissed' ? 'text-slate-400' : 'text-alarmalade-600'}">${g.status}</span>
            </td>
            <td class="px-4 py-3.5">
                <div class="flex items-center gap-2 row-actions" data-group-id="${g.group_id}">
                    ${g.status === 'pending' ? `
                        <button class="quick-dismiss-btn px-2.5 py-1 text-xs font-medium rounded-lg bg-sand text-slate-600 hover:bg-sand-dark border border-sand-dark transition-colors"
                            data-group-id="${g.group_id}">
                            Dismiss
                        </button>
                    ` : ''}
                    <button class="text-alarmalade-600 hover:text-alarmalade-700 text-sm font-medium"
                        onclick="navigateToDetail(${g.group_id})">Review</button>
                </div>
            </td>
        </tr>
    `).join('');

    container.innerHTML = `
        <div class="bg-white rounded-xl border border-sand-dark overflow-hidden">
            <table class="w-full text-sm">
                <thead class="bg-sand text-slate-500 text-xs uppercase tracking-wide">
                    <tr>
                        <th class="px-3 py-3 w-8">
                            <input type="checkbox" id="select-all-checkbox" class="rounded border-slate-300 text-alarmalade-500 focus:ring-alarmalade-500"
                                ${allPageSelected && pageIds.length > 0 ? 'checked' : ''}>
                        </th>
                        <th class="px-4 py-3 text-left">Accounts</th>
                        <th class="px-4 py-3 text-left">Match</th>
                        <th class="px-4 py-3 text-left">Action</th>
                        <th class="px-4 py-3 text-left">Confidence</th>
                        <th class="px-4 py-3 text-left">Tier</th>
                        <th class="px-4 py-3 text-center">Size</th>
                        <th class="px-4 py-3 text-left">Status</th>
                        <th class="px-4 py-3"></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;

    // Wire checkboxes
    container.querySelectorAll('.group-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            e.stopPropagation();
            const id = parseInt(cb.dataset.id);
            if (cb.checked) selectedGroupIds.add(id);
            else selectedGroupIds.delete(id);
            updateSelectionUI();
        });
    });

    document.getElementById('select-all-checkbox').addEventListener('change', (e) => {
        const checked = e.target.checked;
        container.querySelectorAll('.group-checkbox').forEach(cb => {
            const id = parseInt(cb.dataset.id);
            cb.checked = checked;
            if (checked) selectedGroupIds.add(id);
            else selectedGroupIds.delete(id);
        });
        updateSelectionUI();
    });

    // Quick dismiss buttons. Merge and set-parent are not offered.
    container.querySelectorAll('.quick-dismiss-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const groupId = parseInt(btn.dataset.groupId);
            _setRowProcessing(groupId, 'Dismissing...');
            try {
                await Api.dismissGroup(groupId);
                _setRowDone(groupId, 'Dismissed');
                setTimeout(() => loadGroupTable(), 600);
            } catch (err) {
                _setRowError(groupId, err.message);
            }
        });
    });
}

function _setRowProcessing(groupId, label) {
    const row = document.getElementById(`row-${groupId}`);
    if (row) row.style.backgroundColor = '#fef3f0';
    const actions = document.querySelector(`.row-actions[data-group-id="${groupId}"]`);
    if (actions) {
        actions.innerHTML = `
            <span class="flex items-center gap-2 text-xs text-alarmalade-600 font-medium">
                <div class="spinner" style="width:12px;height:12px;border-width:2px;"></div>
                ${label}
            </span>
        `;
    }
}

function _setRowDone(groupId, label) {
    const row = document.getElementById(`row-${groupId}`);
    if (row) row.style.backgroundColor = '#dcfce7';
    const actions = document.querySelector(`.row-actions[data-group-id="${groupId}"]`);
    if (actions) {
        actions.innerHTML = `<span class="text-xs text-green-700 font-medium">${label}</span>`;
    }
}

function _setRowError(groupId, message) {
    const row = document.getElementById(`row-${groupId}`);
    if (row) row.style.backgroundColor = '#fef2f2';
    const actions = document.querySelector(`.row-actions[data-group-id="${groupId}"]`);
    if (actions) {
        actions.innerHTML = `<span class="text-xs text-alarmalade-600 font-medium" title="${message}">Failed</span>`;
    }
    showToast(`Error: ${message}`, 'error');
}

function renderPagination(container, data) {
    const totalPages = Math.ceil(data.total / data.page_size);
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    let buttons = '';
    const page = data.page;
    for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) {
        buttons += `<button onclick="goToPage(${i})"
            class="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${i === page ? 'bg-charcoal text-white' : 'bg-white text-slate-700 hover:bg-sand border border-sand-dark'}">${i}</button>`;
    }

    container.innerHTML = `
        <div class="flex items-center justify-between">
            <span class="text-sm text-slate-500">${data.total} groups total</span>
            <div class="flex gap-1">${buttons}</div>
        </div>
    `;
}

function goToPage(page) {
    groupListFilters.page = page;
    loadGroupTable();
}

function navigateToDetail(groupId) {
    const { tier, match_types, status, search, owner, owner_match, owner1, owner2, has_service_owner } = groupListFilters;
    navigate('group-detail', {
        groupId,
        filters: { tier, match_types, status, search, owner, owner_match, owner1, owner2, has_service_owner }
    });
}

function showBulkConfirmModal(action, groupIds) {
    if (action === 'merge' || action === 'set_parent') return;
    const count = groupIds.length;
    const actionLabel = action === 'merge' ? 'Merge' : action === 'set_parent' ? 'Set Parent' : 'Dismiss';
    const actionDesc = action === 'merge'
        ? 'merge using recommended master for each'
        : action === 'set_parent'
        ? 'set parent-child relationships using recommended master for each'
        : 'dismiss (mark as not duplicates)';

    const existing = document.getElementById('bulk-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'bulk-modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content p-6">
            <h3 class="font-serif text-xl text-charcoal mb-2" style="letter-spacing: -0.24px;">${actionLabel} ${count.toLocaleString()} Group${count > 1 ? 's' : ''}?</h3>
            <p class="text-sm text-slate-600 mb-5">
                This will ${actionDesc} for <strong>${count.toLocaleString()}</strong> selected group${count > 1 ? 's' : ''}.
                ${action === 'merge' ? '<br><span class="text-alarmalade-600 font-medium">This action is irreversible.</span>' : ''}
            </p>
            <div class="flex justify-end gap-3">
                <button id="bulk-modal-cancel" class="px-4 py-2 text-sm text-slate-700 border border-sand-dark rounded-lg hover:bg-sand transition-colors">Cancel</button>
                <button id="bulk-modal-confirm" class="px-4 py-2 text-sm text-white rounded-lg font-medium transition-colors
                    ${action === 'merge' ? 'bg-alarmalade-500 hover:bg-alarmalade-600' : action === 'set_parent' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-slate-600 hover:bg-slate-700'}">
                    ${actionLabel} ${count.toLocaleString()} Group${count > 1 ? 's' : ''}
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById('bulk-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('bulk-modal-confirm').addEventListener('click', async () => {
        overlay.remove();
        await executeBulkAction(action, groupIds);
    });
}

async function executeBulkAction(action, groupIds) {
    if (action !== 'dismiss') return;
    const btn = document.getElementById('btn-dismiss-selected');
    const originalText = btn.textContent;
    const actionLabel = 'Dismissing';

    btn.disabled = true;
    btn.textContent = `${actionLabel} ${groupIds.length.toLocaleString()}...`;
    btn.classList.add('opacity-75', 'cursor-not-allowed');

    try {
        const result = await Api.bulkMerge(groupIds, action);
        showBulkResultToast(action, result);
        selectedGroupIds = new Set();
        updateSelectionUI();
        await loadGroupTable();
    } catch (e) {
        showBulkResultToast(action, { succeeded: 0, failed: groupIds.length, total: groupIds.length, errors: [{ message: e.message }] });
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
        btn.classList.remove('opacity-75', 'cursor-not-allowed');
    }
}

function showBulkResultToast(action, result) {
    const existing = document.getElementById('bulk-toast');
    if (existing) existing.remove();

    const actionPast = action === 'merge' ? 'Merged' : 'Dismissed';
    const isSuccess = result.failed === 0;
    const bgClass = isSuccess ? 'bg-green-700' : 'bg-amber-600';

    let message = `${actionPast} ${result.succeeded} of ${result.total} group${result.total > 1 ? 's' : ''}`;
    if (result.failed > 0) message += ` (${result.failed} failed)`;

    const toast = document.createElement('div');
    toast.id = 'bulk-toast';
    toast.className = `fixed bottom-6 right-6 ${bgClass} text-white px-5 py-3 rounded-xl shadow-lg z-50 text-sm font-medium max-w-md fade-in`;
    toast.innerHTML = `
        <div>${message}</div>
        ${result.errors && result.errors.length > 0 ? `
            <div class="mt-1 text-xs opacity-90 max-h-24 overflow-y-auto">
                ${result.errors.slice(0, 5).map(e => `<div>Group ${e.group_id || '?'}: ${e.message}</div>`).join('')}
                ${result.errors.length > 5 ? `<div>...and ${result.errors.length - 5} more</div>` : ''}
            </div>
        ` : ''}
    `;

    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 8000);
}
