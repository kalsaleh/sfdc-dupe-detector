/** Group detail: side-by-side field comparison + related data + pairwise scores */

async function renderGroupDetail(container, groupId, filters = {}) {
    try {
        const [preview, neighbors, detail] = await Promise.all([
            Api.getMergePreview(groupId),
            Api.getGroupNeighbors(groupId, filters),
            Api.getGroupDetail(groupId),
        ]);
        // Attach extra fields from detail endpoint
        preview.pairwise_scores = (detail && detail.pairwise_scores) || [];
        preview.score = (detail && detail.score) || 0;
        preview.tier = (detail && detail.tier) || 3;
        preview.match_types = (detail && detail.match_types) || [];
        container.innerHTML = buildDetailHTML(preview, neighbors);
        wireDetailActions(preview, neighbors, filters);
        wireKeyboardShortcuts(preview, neighbors, filters);
    } catch (e) {
        container.innerHTML = `<div class="text-alarmalade-600 py-4">Error loading group: ${e.message}</div>`;
    }
}

function _advanceToNext(neighbors, filters) {
    if (neighbors.next_group_id) {
        navigate('group-detail', { groupId: neighbors.next_group_id, filters });
    } else {
        // Go back to group list with same filters preserved
        navigate('groups', filters);
    }
}

function isServiceOrAdminOwner(ownerName, explicitFlag = null) {
    if (explicitFlag !== null && explicitFlag !== undefined) return !!explicitFlag;
    if (!ownerName) return false;
    return ownerName.trim().toUpperCase().startsWith('SVC');
}

function svcOwnerBadge(ownerName, explicitFlag = null) {
    if (!isServiceOrAdminOwner(ownerName, explicitFlag)) return '';
    return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-50 text-purple-700 border border-purple-200 ml-1">SVC/Admin</span>';
}

function stageBadge(stage) {
    if (stage === 'Customer') return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">Customer</span>';
    if (stage === 'Churned') return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">Churned</span>';
    if (!stage) return '<span class="text-slate-400 text-xs">&mdash;</span>';
    return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-sand text-slate-700 border border-sand-dark">${stage}</span>`;
}

function buildDetailHTML(preview, neighbors) {
    const accounts = preview.accounts;
    const diffs = preview.diffs;
    const related = preview.related_data;
    const recommended = preview.recommended_master;
    const action = preview.recommended_action;
    const isParentChild = action === 'set_parent';
    const pairwise = preview.pairwise_scores || [];

    const actionLabel = isParentChild ? 'Parent-Child' : 'Merge';
    const actionColor = isParentChild ? 'blue' : 'alarmalade';
    const roleLabel = isParentChild ? 'parent' : 'master';

    // Prev / Next navigation
    const prevDisabled = !neighbors.prev_group_id;
    const nextDisabled = !neighbors.next_group_id;
    const navButtons = `
        <div class="flex items-center gap-2">
            <button id="btn-prev-group" ${prevDisabled ? 'disabled' : ''}
                class="px-3 py-1.5 text-sm border rounded-lg transition-colors ${prevDisabled ? 'border-sand-dark text-slate-300 cursor-not-allowed' : 'border-sand-dark text-slate-700 hover:bg-sand'}"
                title="Previous group">
                &larr; Prev
            </button>
            <span class="text-xs text-slate-500 tabular-nums">${neighbors.remaining} pending</span>
            <button id="btn-next-group" ${nextDisabled ? 'disabled' : ''}
                class="px-3 py-1.5 text-sm border rounded-lg transition-colors ${nextDisabled ? 'border-sand-dark text-slate-300 cursor-not-allowed' : 'border-sand-dark text-slate-700 hover:bg-sand'}"
                title="Next group">
                Next &rarr;
            </button>
        </div>
    `;

    // Confidence bar
    const score = preview.score || 0;
    const confidenceClass = score >= 95 ? 'bg-green-500' : score >= 80 ? 'bg-amber-400' : 'bg-slate-300';
    const confidenceText = score >= 95 ? 'High confidence' : score >= 80 ? 'Medium confidence' : 'Low confidence';

    // Build comparison table headers
    const headers = accounts.map(a => {
        const stage = a.account_stage || '';
        const country = a.billing_country || '';
        const isRecommended = a.id === recommended;
        const roleTag = isRecommended
            ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-${actionColor}-50 text-${actionColor}-700 border border-${actionColor}-200 mt-1">Recommended ${roleLabel}</span>`
            : '';
        return `
            <th class="px-3 py-3 text-left min-w-[200px] align-top">
                <div class="font-medium text-charcoal">${a.name}${svcOwnerBadge(a.owner_name, a.is_service_owner)}</div>
                <div class="flex items-center gap-2 mt-1">
                    ${stageBadge(stage)}
                    ${country ? `<span class="text-xs text-slate-500">${country}</span>` : ''}
                </div>
                <div class="text-xs text-slate-400 mt-1 font-mono">${a.id}</div>
                ${roleTag}
            </th>
        `;
    }).join('');

    // Build diff rows
    const diffRows = diffs.map(d => {
        const cells = accounts.map(a => {
            const val = d.values[a.id];
            const cls = d.differs ? 'diff-highlight' : 'diff-match';
            return `<td class="px-3 py-2.5 ${cls} text-sm">${val ?? '<span class="text-slate-300">&mdash;</span>'}</td>`;
        }).join('');
        return `<tr class="border-b border-sand-dark">
            <td class="px-3 py-2.5 font-medium text-slate-600 text-sm whitespace-nowrap">${d.field}</td>
            ${cells}
        </tr>`;
    }).join('');

    // Pairwise scores section
    let pairwiseHTML = '';
    if (pairwise.length > 0) {
        const idToName = {};
        accounts.forEach(a => { idToName[a.id] = a.name; });
        const pairRows = pairwise.map(p => {
            const pScore = (p.score * 100).toFixed(0);
            const pColor = pScore >= 95 ? 'bg-green-500' : pScore >= 85 ? 'bg-amber-400' : 'bg-slate-300';
            return `<tr class="border-b border-sand-dark">
                <td class="px-3 py-2 text-sm">${idToName[p.account_id_a] || p.account_id_a}</td>
                <td class="px-3 py-2 text-sm">${idToName[p.account_id_b] || p.account_id_b}</td>
                <td class="px-3 py-2 text-sm">${p.match_type}</td>
                <td class="px-3 py-2">
                    <div class="flex items-center gap-2">
                        <div class="score-bar w-16"><div class="score-bar-fill ${pColor}" style="width: ${pScore}%"></div></div>
                        <span class="font-mono text-sm">${pScore}</span>
                    </div>
                </td>
            </tr>`;
        }).join('');
        pairwiseHTML = `
            <div class="bg-white rounded-xl border border-sand-dark overflow-hidden mb-6">
                <div class="px-4 py-3 bg-sand font-medium text-slate-600 text-sm">Pairwise Match Scores</div>
                <table class="w-full text-sm">
                    <thead><tr class="border-b border-sand-dark text-xs text-slate-500 uppercase tracking-wide">
                        <th class="px-3 py-2 text-left">Account A</th>
                        <th class="px-3 py-2 text-left">Account B</th>
                        <th class="px-3 py-2 text-left">Type</th>
                        <th class="px-3 py-2 text-left">Score</th>
                    </tr></thead>
                    <tbody>${pairRows}</tbody>
                </table>
            </div>
        `;
    }

    // Build related data section
    const relatedRows = accounts.map(a => {
        const r = related.find(rd => rd.account_id === a.id) || {};
        const total = (r.opportunity_count || 0) + (r.contact_count || 0) + (r.case_count || 0);
        return `<tr class="border-b border-sand-dark">
            <td class="px-3 py-2.5 text-sm font-medium">${a.name} ${stageBadge(a.account_stage)}</td>
            <td class="px-3 py-2.5 text-sm text-center">${r.opportunity_count || 0}</td>
            <td class="px-3 py-2.5 text-sm text-center">${r.contact_count || 0}</td>
            <td class="px-3 py-2.5 text-sm text-center">${r.case_count || 0}</td>
            <td class="px-3 py-2.5 text-sm text-center font-medium">${total}</td>
        </tr>`;
    }).join('');

    // Account selection
    const showCheckboxes = accounts.length > 2;
    const accountRows = accounts.map(a => `
        <div class="flex items-center gap-2 p-2.5 rounded-lg hover:bg-sand account-row transition-colors" data-account-id="${a.id}">
            ${showCheckboxes ? `
                <input type="checkbox" class="account-include-cb rounded border-slate-300 text-alarmalade-500 focus:ring-alarmalade-500" data-id="${a.id}" checked>
            ` : ''}
            <label class="flex items-center gap-2 cursor-pointer flex-1">
                <input type="radio" name="master" value="${a.id}" class="text-alarmalade-500 focus:ring-alarmalade-500" ${a.id === recommended ? 'checked' : ''}>
                <span class="text-sm font-medium text-charcoal">${a.name}</span>
                ${svcOwnerBadge(a.owner_name, a.is_service_owner)}
                ${stageBadge(a.account_stage)}
                ${a.billing_country ? `<span class="text-xs text-slate-500">${a.billing_country}</span>` : ''}
                ${a.id === recommended ? `<span class="text-xs text-alarmalade-600 font-medium">(recommended)</span>` : ''}
            </label>
        </div>
    `).join('');

    // Warnings
    const hasARR = accounts.some(a => a.arr > 0 || a.current_arr > 0);
    const diffOwners = new Set(accounts.map(a => a.owner_name).filter(Boolean)).size > 1;
    const diffCountries = new Set(accounts.map(a => a.billing_country).filter(Boolean)).size > 1;
    let warnings = '';
    if (hasARR) warnings += '<div class="text-amber-800 bg-amber-50 p-3 rounded-lg text-sm mb-2 border border-amber-200">One or more accounts have ARR values. Review carefully.</div>';
    if (diffOwners) warnings += '<div class="text-amber-800 bg-amber-50 p-3 rounded-lg text-sm mb-2 border border-amber-200">Accounts have different owners.</div>';
    if (diffCountries) warnings += '<div class="text-blue-800 bg-blue-50 p-3 rounded-lg text-sm mb-2 border border-blue-200">Accounts are in different countries &mdash; consider parent-child instead of merge.</div>';

    const mergeBtn = `<button id="btn-merge" class="px-6 py-2.5 rounded-lg font-medium text-sm transition-colors ${!isParentChild ? 'bg-alarmalade-500 hover:bg-alarmalade-600 text-white' : 'bg-white border border-alarmalade-500 text-alarmalade-600 hover:bg-alarmalade-50'}">Merge${!isParentChild ? ' (recommended)' : ''}</button>`;
    const parentBtn = `<button id="btn-set-parent" class="px-6 py-2.5 rounded-lg font-medium text-sm transition-colors ${isParentChild ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-white border border-blue-600 text-blue-600 hover:bg-blue-50'}">Set as Parent${isParentChild ? ' (recommended)' : ''}</button>`;

    return `
        <div class="fade-in">
            <div class="flex items-center justify-between mb-6">
                <div>
                    <button id="btn-back-to-groups" class="text-sm text-alarmalade-600 hover:text-alarmalade-700 font-medium">&larr; Back to Groups</button>
                    <div class="flex items-center gap-3 mt-1">
                        <h1 class="font-serif text-3xl font-normal text-charcoal" style="letter-spacing: -0.9px;">Group #${preview.group_id}</h1>
                        <span class="badge bg-${actionColor}-50 text-${actionColor}-700 border border-${actionColor}-200">${actionLabel}</span>
                    </div>
                    <p class="text-sm text-slate-500 mt-1">${preview.explanation}</p>
                    <div class="flex items-center gap-3 mt-2">
                        <div class="score-bar w-24"><div class="score-bar-fill ${confidenceClass}" style="width: ${score}%"></div></div>
                        <span class="text-sm text-slate-600 font-medium">${score.toFixed(0)} &mdash; ${confidenceText}</span>
                    </div>
                </div>
                ${navButtons}
            </div>

            <!-- Field Comparison -->
            <div class="bg-white rounded-xl border border-sand-dark overflow-x-auto mb-6">
                <table class="w-full text-sm">
                    <thead class="bg-sand">
                        <tr>
                            <th class="px-3 py-3 text-left text-slate-600 text-xs uppercase tracking-wide">Field</th>
                            ${headers}
                        </tr>
                    </thead>
                    <tbody>${diffRows}</tbody>
                </table>
            </div>

            <!-- Pairwise Scores -->
            ${pairwiseHTML}

            <!-- Related Data -->
            <div class="bg-white rounded-xl border border-sand-dark overflow-hidden mb-6">
                <div class="px-4 py-3 bg-sand font-medium text-slate-600 text-sm">Related Records</div>
                <table class="w-full text-sm">
                    <thead>
                        <tr class="border-b border-sand-dark text-xs text-slate-500 uppercase tracking-wide">
                            <th class="px-3 py-2 text-left">Account</th>
                            <th class="px-3 py-2 text-center">Opps</th>
                            <th class="px-3 py-2 text-center">Contacts</th>
                            <th class="px-3 py-2 text-center">Cases</th>
                            <th class="px-3 py-2 text-center">Total</th>
                        </tr>
                    </thead>
                    <tbody>${relatedRows}</tbody>
                </table>
            </div>

            <!-- Actions -->
            <div class="bg-white rounded-xl border border-sand-dark p-6 mb-16" id="merge-actions">
                <h3 class="font-medium text-charcoal mb-3">Actions</h3>
                ${warnings}
                <div class="mb-4">
                    <div class="text-sm text-slate-600 mb-2">
                        Select primary account${showCheckboxes ? ' &mdash; uncheck to exclude:' : ':'}
                    </div>
                    <div class="space-y-1" id="master-selection">
                        ${accountRows}
                    </div>
                    ${showCheckboxes ? '<div id="selection-warning" class="text-xs text-amber-600 mt-1 hidden"></div>' : ''}
                </div>
                <div class="flex gap-3">
                    ${mergeBtn}
                    ${parentBtn}
                    <button id="btn-dismiss" class="px-6 py-2.5 bg-sand text-slate-700 rounded-lg hover:bg-sand-dark font-medium text-sm border border-sand-dark transition-colors">
                        Not a Duplicate
                    </button>
                    <button id="btn-skip" class="px-6 py-2.5 border border-sand-dark rounded-lg hover:bg-sand font-medium text-slate-600 text-sm transition-colors">
                        Skip
                    </button>
                </div>
            </div>

            <!-- Keyboard shortcut legend -->
            <div id="shortcut-bar" class="fixed bottom-0 left-0 right-0 bg-charcoal text-slate-400 text-xs py-2.5 px-4 flex items-center justify-center gap-6 z-40">
                <span><kbd class="px-1.5 py-0.5 bg-slate-700 rounded text-white font-mono text-xs">M</kbd> Merge</span>
                <span><kbd class="px-1.5 py-0.5 bg-slate-700 rounded text-white font-mono text-xs">P</kbd> Set Parent</span>
                <span><kbd class="px-1.5 py-0.5 bg-slate-700 rounded text-white font-mono text-xs">D</kbd> Dismiss</span>
                <span class="border-l border-slate-600 pl-6"><kbd class="px-1.5 py-0.5 bg-slate-700 rounded text-white font-mono text-xs">&larr;</kbd> Prev</span>
                <span><kbd class="px-1.5 py-0.5 bg-slate-700 rounded text-white font-mono text-xs">&rarr;</kbd> Next</span>
                <span><kbd class="px-1.5 py-0.5 bg-slate-700 rounded text-white font-mono text-xs">Esc</kbd> Back</span>
            </div>
        </div>
    `;
}

function _getSelectedAccounts(preview) {
    const checkboxes = document.querySelectorAll('.account-include-cb');
    if (checkboxes.length === 0) return preview.accounts.map(a => a.id);
    return Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.dataset.id);
}

function _validateSelection(preview) {
    const included = _getSelectedAccounts(preview);
    const master = document.querySelector('input[name="master"]:checked');
    const warning = document.getElementById('selection-warning');

    if (included.length < 2) {
        if (warning) { warning.textContent = 'Select at least 2 accounts.'; warning.classList.remove('hidden'); }
        return null;
    }
    if (!master) {
        if (warning) { warning.textContent = ''; warning.classList.add('hidden'); }
        return null;
    }
    if (!included.includes(master.value)) {
        if (warning) { warning.textContent = 'Primary account must be included (checked).'; warning.classList.remove('hidden'); }
        return null;
    }
    if (warning) { warning.textContent = ''; warning.classList.add('hidden'); }
    return { masterId: master.value, victimIds: included.filter(id => id !== master.value) };
}

function wireDetailActions(preview, neighbors, filters) {
    const onComplete = () => _advanceToNext(neighbors, filters);

    document.querySelectorAll('.account-include-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            const row = cb.closest('.account-row');
            const radio = row.querySelector('input[name="master"]');
            if (!cb.checked) {
                row.classList.add('opacity-40');
                radio.disabled = true;
                if (radio.checked) radio.checked = false;
            } else {
                row.classList.remove('opacity-40');
                radio.disabled = false;
            }
            _validateSelection(preview);
        });
    });

    const mergeBtn = document.getElementById('btn-merge');
    const parentBtn = document.getElementById('btn-set-parent');

    if (mergeBtn) {
        mergeBtn.addEventListener('click', () => {
            const selected = document.querySelector('input[name="master"]:checked');
            if (!selected) return alert('Select a primary account first');
            const sel = _validateSelection(preview);
            if (!sel) return;
            showMergeConfirm(preview.group_id, sel.masterId, preview.accounts, 'merge', onComplete, sel.victimIds);
        });
    }

    if (parentBtn) {
        parentBtn.addEventListener('click', () => {
            const selected = document.querySelector('input[name="master"]:checked');
            if (!selected) return alert('Select a primary account first');
            const sel = _validateSelection(preview);
            if (!sel) return;
            showMergeConfirm(preview.group_id, sel.masterId, preview.accounts, 'set_parent', onComplete, sel.victimIds);
        });
    }

    document.getElementById('btn-dismiss').addEventListener('click', async () => {
        if (!confirm('Mark this group as not a duplicate?')) return;
        try {
            await Api.dismissGroup(preview.group_id);
            showToast('Dismissed!', 'success');
            _advanceToNext(neighbors, filters);
        } catch (e) {
            alert(`Error: ${e.message}`);
        }
    });

    document.getElementById('btn-back-to-groups').addEventListener('click', () => navigate('groups', filters));
    document.getElementById('btn-skip').addEventListener('click', () => _advanceToNext(neighbors, filters));

    const prevBtn = document.getElementById('btn-prev-group');
    const nextBtn = document.getElementById('btn-next-group');
    if (prevBtn && neighbors.prev_group_id) {
        prevBtn.addEventListener('click', () => navigate('group-detail', { groupId: neighbors.prev_group_id, filters }));
    }
    if (nextBtn && neighbors.next_group_id) {
        nextBtn.addEventListener('click', () => navigate('group-detail', { groupId: neighbors.next_group_id, filters }));
    }
}

function wireKeyboardShortcuts(preview, neighbors, filters) {
    function handler(e) {
        if (document.querySelector('.modal-overlay')) return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

        switch (e.key) {
            case 'm': case 'M': { const btn = document.getElementById('btn-merge'); if (btn) btn.click(); break; }
            case 'p': case 'P': { const btn = document.getElementById('btn-set-parent'); if (btn) btn.click(); break; }
            case 'd': case 'D': { const btn = document.getElementById('btn-dismiss'); if (btn) btn.click(); break; }
            case 'ArrowLeft': case 'k': case 'K':
                if (neighbors.prev_group_id) navigate('group-detail', { groupId: neighbors.prev_group_id, filters });
                break;
            case 'ArrowRight': case 'j': case 'J':
                if (neighbors.next_group_id) navigate('group-detail', { groupId: neighbors.next_group_id, filters });
                break;
            case 'Escape': navigate('groups', filters); break;
            default: return;
        }
        e.preventDefault();
    }

    document.addEventListener('keydown', handler);

    const bar = document.getElementById('shortcut-bar');
    if (bar) {
        const observer = new MutationObserver(() => {
            if (!document.getElementById('shortcut-bar')) {
                document.removeEventListener('keydown', handler);
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
}
