/** Merge/parent confirmation modal */

function showMergeConfirm(groupId, masterId, accounts, action, onComplete, victimIds = null) {
    const master = accounts.find(a => a.id === masterId);
    const others = victimIds
        ? accounts.filter(a => victimIds.includes(a.id))
        : accounts.filter(a => a.id !== masterId);
    const excludedCount = accounts.length - others.length - 1;
    const isParentChild = action === 'set_parent';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content p-6">
            <h2 class="font-serif text-xl text-charcoal mb-4" style="letter-spacing: -0.24px;">${isParentChild ? 'Confirm Parent-Child Setup' : 'Confirm Merge'}</h2>
            <div class="${isParentChild ? 'bg-blue-50 border-blue-200' : 'bg-alarmalade-50 border-alarmalade-200'} border rounded-xl p-4 mb-4">
                <div class="${isParentChild ? 'text-blue-800' : 'text-alarmalade-800'} font-medium mb-1">${isParentChild ? 'This will set up a parent-child relationship.' : 'This action is irreversible!'}</div>
                <div class="${isParentChild ? 'text-blue-700' : 'text-alarmalade-700'} text-sm">
                    ${isParentChild
                        ? `<strong>${master.name}</strong> will be set as the parent account. The other accounts will be linked as children.`
                        : `The following accounts will be merged into <strong>${master.name}</strong>. All related records will be reparented.`
                    }
                </div>
            </div>

            <div class="mb-4">
                <div class="text-sm font-medium text-slate-600 mb-2">${isParentChild ? 'Parent account:' : 'Master (survives):'}</div>
                <div class="bg-green-50 border border-green-200 rounded-lg p-3 text-sm flex items-center gap-2">
                    <span class="font-medium">${master.name}</span>
                    <span class="text-slate-500 font-mono text-xs">${masterId}</span>
                    ${master.account_stage === 'Customer' ? '<span class="badge bg-green-100 text-green-800 border border-green-200">Customer</span>' : ''}
                </div>
            </div>

            <div class="mb-6">
                <div class="text-sm font-medium text-slate-600 mb-2">${isParentChild ? 'Child accounts:' : 'Will be merged (deleted):'}</div>
                ${others.map(v => `
                    <div class="${isParentChild ? 'bg-blue-50 border-blue-200' : 'bg-alarmalade-50 border-alarmalade-200'} border rounded-lg p-3 text-sm mb-1.5 flex items-center gap-2">
                        <span class="font-medium">${v.name}</span>
                        <span class="text-slate-500 font-mono text-xs">${v.id}</span>
                        ${v.billing_country ? `<span class="text-xs text-slate-500">${v.billing_country}</span>` : ''}
                    </div>
                `).join('')}
                ${excludedCount > 0 ? `<div class="text-xs text-slate-500 mt-2">${excludedCount} account${excludedCount > 1 ? 's' : ''} excluded.</div>` : ''}
            </div>

            <div class="flex gap-3 justify-end">
                <button id="modal-cancel" class="px-4 py-2.5 border border-sand-dark rounded-lg hover:bg-sand text-slate-700 text-sm font-medium transition-colors">
                    Cancel
                </button>
                <button id="modal-confirm" class="px-4 py-2.5 ${isParentChild ? 'bg-blue-600 hover:bg-blue-700' : 'bg-alarmalade-500 hover:bg-alarmalade-600'} text-white rounded-lg font-medium text-sm transition-colors">
                    ${isParentChild ? 'Confirm Parent Setup' : 'Confirm Merge'}
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('modal-confirm').addEventListener('click', async () => {
        const btn = document.getElementById('modal-confirm');
        btn.disabled = true;
        btn.textContent = isParentChild ? 'Setting up...' : 'Merging...';
        btn.className = 'px-4 py-2.5 bg-slate-400 text-white rounded-lg font-medium text-sm cursor-not-allowed';

        try {
            let result;
            const vIds = victimIds || others.map(a => a.id);
            if (isParentChild) result = await Api.setParent(groupId, masterId, vIds);
            else result = await Api.executeMerge(groupId, masterId, vIds);
            overlay.remove();
            if (result.success) {
                showToast(isParentChild ? 'Parent-child set up!' : 'Merge successful!', 'success');
                if (onComplete) onComplete();
                else navigate('groups');
            } else {
                showToast(`Failed: ${result.message}`, 'error');
            }
        } catch (e) {
            overlay.remove();
            showToast(`Error: ${e.message}`, 'error');
        }
    });
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    const colors = { success: 'bg-green-700', error: 'bg-alarmalade-600', info: 'bg-charcoal' };
    toast.className = `fixed bottom-4 right-4 ${colors[type]} text-white px-6 py-3 rounded-xl shadow-lg z-50 fade-in text-sm font-medium`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}
