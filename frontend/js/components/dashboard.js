/** Dashboard view: stats cards + extract/match controls */

async function renderDashboard(container) {
    const matchOptions = await ensureMatchOptions();
    let data = { total_accounts: 0, total_groups: 0, tier1_count: 0, tier2_count: 0, tier3_count: 0, pending_count: 0, merged_count: 0, dismissed_count: 0, parent_child_count: 0 };
    try {
        data = await Api.getDashboard();
    } catch (e) { /* DB might be empty */ }

    const mergeCount = data.total_groups - data.parent_child_count;
    const processedPct = data.total_groups > 0
        ? Math.round(((data.merged_count + data.dismissed_count) / data.total_groups) * 100)
        : 0;
    const matchTypeCheckboxes = matchOptions.map(option => `
        <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="match-type-cb rounded border-slate-300 text-alarmalade-500 focus:ring-alarmalade-500" value="${option.type}" checked>
            <span class="text-sm text-charcoal">${option.label}</span>
        </label>
    `).join('');

    container.innerHTML = `
        <div class="fade-in">
            <div class="mb-8">
                <h1 class="font-serif text-4xl font-normal tracking-tight text-charcoal" style="letter-spacing: -1.32px;">Duplicate Detector</h1>
                <p class="text-slate-500 mt-1 text-base" style="letter-spacing: -0.16px;">Find and resolve duplicate accounts in Salesforce</p>
            </div>

            <!-- Action buttons -->
            <div class="flex gap-3 mb-8">
                <button id="btn-extract" class="px-5 py-2.5 bg-charcoal text-white rounded-lg hover:bg-slate-800 font-medium text-sm transition-colors">
                    Extract Accounts
                </button>
                <button id="btn-extract-inc" class="px-5 py-2.5 bg-sand text-charcoal rounded-lg hover:bg-sand-dark font-medium text-sm border border-sand-dark transition-colors">
                    Incremental Sync
                </button>
                <button id="btn-match" class="px-5 py-2.5 bg-alarmalade-500 text-white rounded-lg hover:bg-alarmalade-600 font-medium text-sm transition-colors">
                    Run Matching
                </button>
                <div id="status-msg" class="flex items-center text-sm text-slate-500 ml-4"></div>
            </div>

            <!-- Tier cards -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                <div class="bg-cream-card rounded-xl p-5 border border-sand-dark">
                    <div class="text-sm text-slate-500 font-medium">Total Accounts</div>
                    <div class="text-3xl font-serif font-normal text-charcoal mt-1" style="letter-spacing: -0.9px;">${data.total_accounts.toLocaleString()}</div>
                </div>
                <div class="bg-cream-card rounded-xl p-5 border border-sand-dark cursor-pointer hover:border-green-400 transition-colors" onclick="navigate('groups', {tier: 1})">
                    <div class="text-sm text-slate-500 font-medium">Tier 1 &mdash; Definite</div>
                    <div class="text-3xl font-serif font-normal text-green-700 mt-1" style="letter-spacing: -0.9px;">${data.tier1_count}</div>
                    <div class="score-bar mt-2"><div class="score-bar-fill bg-green-500" style="width: 100%"></div></div>
                </div>
                <div class="bg-cream-card rounded-xl p-5 border border-sand-dark cursor-pointer hover:border-amber-400 transition-colors" onclick="navigate('groups', {tier: 2})">
                    <div class="text-sm text-slate-500 font-medium">Tier 2 &mdash; Likely</div>
                    <div class="text-3xl font-serif font-normal text-amber-700 mt-1" style="letter-spacing: -0.9px;">${data.tier2_count}</div>
                    <div class="score-bar mt-2"><div class="score-bar-fill bg-amber-400" style="width: 80%"></div></div>
                </div>
                <div class="bg-cream-card rounded-xl p-5 border border-sand-dark cursor-pointer hover:border-slate-300 transition-colors" onclick="navigate('groups', {tier: 3})">
                    <div class="text-sm text-slate-500 font-medium">Tier 3 &mdash; Possible</div>
                    <div class="text-3xl font-serif font-normal text-slate-600 mt-1" style="letter-spacing: -0.9px;">${data.tier3_count}</div>
                    <div class="score-bar mt-2"><div class="score-bar-fill bg-slate-300" style="width: 60%"></div></div>
                </div>
            </div>

            <!-- Filter panel -->
            <div class="bg-white rounded-xl p-6 mb-8 border border-sand-dark">
                <h2 class="text-lg font-medium text-charcoal mb-4" style="letter-spacing: -0.18px;">Quick Filters</h2>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div>
                        <div class="text-sm font-medium text-slate-600 mb-2">Match Types</div>
                        <div class="space-y-2">
                            ${matchTypeCheckboxes}
                        </div>
                    </div>
                    <div>
                        <label class="text-sm font-medium text-slate-600 mb-2 block">Owner 1</label>
                        <select id="filter-owner1" class="w-full border border-sand-dark rounded-lg px-3 py-2 text-sm bg-white focus:ring-alarmalade-500 focus:border-alarmalade-500">
                            <option value="">All Owners</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-sm font-medium text-slate-600 mb-2 block">Owner 2</label>
                        <select id="filter-owner2" class="w-full border border-sand-dark rounded-lg px-3 py-2 text-sm bg-white focus:ring-alarmalade-500 focus:border-alarmalade-500">
                            <option value="">All Owners</option>
                        </select>
                    </div>
                </div>

                <div class="mt-5 flex gap-3">
                    <button id="btn-apply-filters" class="px-6 py-2.5 bg-alarmalade-500 text-white rounded-lg hover:bg-alarmalade-600 font-medium text-sm transition-colors">
                        Apply Filters
                    </button>
                    <button id="btn-reset-filters" class="px-6 py-2.5 bg-sand text-slate-700 rounded-lg hover:bg-sand-dark font-medium text-sm border border-sand-dark transition-colors">
                        Reset
                    </button>
                </div>
            </div>

            <!-- Progress + Action breakdown -->
            <div class="grid grid-cols-2 md:grid-cols-6 gap-4 mb-8">
                <div class="bg-white rounded-xl p-4 border border-sand-dark">
                    <div class="text-xs text-slate-500 uppercase tracking-wide font-medium">Merge</div>
                    <div class="text-2xl font-serif text-alarmalade-600 mt-1">${mergeCount}</div>
                </div>
                <div class="bg-white rounded-xl p-4 border border-sand-dark">
                    <div class="text-xs text-slate-500 uppercase tracking-wide font-medium">Parent-Child</div>
                    <div class="text-2xl font-serif text-blue-600 mt-1">${data.parent_child_count}</div>
                </div>
                <div class="bg-white rounded-xl p-4 border border-sand-dark">
                    <div class="text-xs text-slate-500 uppercase tracking-wide font-medium">Merged</div>
                    <div class="text-2xl font-serif text-green-600 mt-1">${data.merged_count}</div>
                </div>
                <div class="bg-white rounded-xl p-4 border border-sand-dark">
                    <div class="text-xs text-slate-500 uppercase tracking-wide font-medium">Dismissed</div>
                    <div class="text-2xl font-serif text-slate-400 mt-1">${data.dismissed_count}</div>
                </div>
                <div class="bg-white rounded-xl p-4 border border-sand-dark cursor-pointer hover:border-purple-400 transition-colors" onclick="navigate('groups', {has_service_owner: true, status: 'pending'})">
                    <div class="text-xs text-purple-600 uppercase tracking-wide font-medium">SVC/Admin Owner</div>
                    <div class="text-2xl font-serif text-purple-700 mt-1">${data.service_owner_count}</div>
                </div>
                <div class="bg-white rounded-xl p-4 border border-sand-dark">
                    <div class="text-xs text-slate-500 uppercase tracking-wide font-medium">Progress</div>
                    <div class="text-2xl font-serif text-charcoal mt-1">${processedPct}%</div>
                    <div class="score-bar mt-2"><div class="score-bar-fill bg-alarmalade-500" style="width: ${processedPct}%"></div></div>
                </div>
            </div>
        </div>
    `;

    document.getElementById('btn-extract').addEventListener('click', () => startExtract(false));
    document.getElementById('btn-extract-inc').addEventListener('click', () => startExtract(true));
    document.getElementById('btn-match').addEventListener('click', startMatch);
    document.getElementById('btn-apply-filters').addEventListener('click', applyDashboardFilters);
    document.getElementById('btn-reset-filters').addEventListener('click', resetDashboardFilters);

    loadOwnerDropdowns();
}

async function loadOwnerDropdowns() {
    try {
        const data = await Api.getOwners();
        const owners = data.owners || [];
        const owner1Select = document.getElementById('filter-owner1');
        const owner2Select = document.getElementById('filter-owner2');
        owners.forEach(owner => {
            [owner1Select, owner2Select].forEach(sel => {
                const opt = document.createElement('option');
                opt.value = owner;
                opt.textContent = owner;
                sel.appendChild(opt);
            });
        });
    } catch (e) {
        console.error('Failed to load owners:', e);
    }
}

function applyDashboardFilters() {
    const matchTypeCbs = document.querySelectorAll('.match-type-cb:checked');
    const matchTypes = Array.from(matchTypeCbs).map(cb => cb.value);
    const owner1 = document.getElementById('filter-owner1').value;
    const owner2 = document.getElementById('filter-owner2').value;
    const filters = {};
    if (matchTypes.length > 0 && matchTypes.length < MatchOptionsStore.items.length) {
        filters.match_types = matchTypes;
    }
    if (owner1) filters.owner1 = owner1;
    if (owner2) filters.owner2 = owner2;
    navigate('groups', filters);
}

function resetDashboardFilters() {
    document.querySelectorAll('.match-type-cb').forEach(cb => cb.checked = true);
    document.getElementById('filter-owner1').value = '';
    document.getElementById('filter-owner2').value = '';
}

async function startExtract(incremental) {
    const msg = document.getElementById('status-msg');
    msg.innerHTML = '<div class="spinner mr-2"></div> Starting export...';
    try {
        await Api.startExtract(incremental);
        pollExtractStatus(msg);
    } catch (e) {
        msg.textContent = `Error: ${e.message}`;
    }
}

function pollExtractStatus(msgEl) {
    const interval = setInterval(async () => {
        try {
            const s = await Api.getExtractStatus();
            msgEl.innerHTML = s.status === 'exporting' || s.status === 'loading'
                ? `<div class="spinner mr-2"></div> ${s.message}`
                : s.message;
            if (s.status === 'done' || s.status === 'error' || s.status === 'idle') {
                clearInterval(interval);
                if (s.status === 'done') navigate('dashboard');
            }
        } catch { clearInterval(interval); }
    }, 2000);
}

async function startMatch() {
    const msg = document.getElementById('status-msg');
    msg.innerHTML = '<div class="spinner mr-2"></div> Running matchers...';
    try {
        await Api.runMatch();
        const interval = setInterval(async () => {
            const s = await Api.getMatchStatus();
            msg.innerHTML = s.status === 'running'
                ? `<div class="spinner mr-2"></div> ${s.message}`
                : s.message;
            if (s.status !== 'running') {
                clearInterval(interval);
                if (s.status === 'done') navigate('dashboard');
            }
        }, 2000);
    } catch (e) {
        msg.textContent = `Error: ${e.message}`;
    }
}
