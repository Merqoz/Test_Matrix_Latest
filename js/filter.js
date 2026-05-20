/**
 * FILTER.JS - Unified Filter & Highlight Manager
 *
 * Three filter layers (all combine with AND logic):
 *  1. Activity type chips  — show/hide + highlight test columns by type
 *  2. Column search        — filter rows by content in fixed-column inputs (in thead)
 *  3. Activity column filter — show only rows with data in a test column
 */

const FilterManager = {
    activeFilters: new Set(),
    activeWpFilters: new Set(),
    _lockedTypes: new Set(),   // persisted across navigation
    _lockedWps: new Set(),     // persisted across navigation

    searchValues: {
        itemNo: '', description: '', partNo: '', qty: '', melQty: '', workpack: '', stakeholder: ''
    },

    activeColumnFilter: null,

    colors: {
        'FAT':   { bg: 'rgba(0, 212, 255, 0.12)',   border: '#00d4ff', text: '#00d4ff', headerBg: 'rgba(0, 212, 255, 0.18)',   badge: '#00d4ff' },
        'FIT':   { bg: 'rgba(139, 92, 246, 0.12)',   border: '#8b5cf6', text: '#8b5cf6', headerBg: 'rgba(139, 92, 246, 0.18)',   badge: '#8b5cf6' },
        'EFAT':  { bg: 'rgba(16, 185, 129, 0.12)',   border: '#10b981', text: '#10b981', headerBg: 'rgba(16, 185, 129, 0.18)',   badge: '#10b981' },
        'SIT':   { bg: 'rgba(245, 158, 11, 0.12)',   border: '#f59e0b', text: '#f59e0b', headerBg: 'rgba(245, 158, 11, 0.18)',   badge: '#f59e0b' },
        'M-SIT': { bg: 'rgba(239, 68, 68, 0.12)',    border: '#ef4444', text: '#ef4444', headerBg: 'rgba(239, 68, 68, 0.18)',    badge: '#ef4444' },
        'SRT':   { bg: 'rgba(236, 72, 153, 0.12)',   border: '#ec4899', text: '#ec4899', headerBg: 'rgba(236, 72, 153, 0.18)',   badge: '#ec4899' }
    },

    /**
     * Return theme-appropriate background tints for a type-colour highlight.
     * The default `bg`/`headerBg` use very low opacity tuned for the dark
     * canvas; over a white (light-theme) background those wash out, so we
     * derive denser tints from the solid border hex instead.
     */
    _tintFor(color) {
        const isLight = document.body.classList.contains('light-theme');
        if (!isLight) {
            return { cellBg: color.bg, headerBg: color.headerBg };
        }
        // Build stronger rgba tints from the solid border hex for light mode
        const hex = (color.border || '#2563eb').replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return {
            cellBg:   `rgba(${r}, ${g}, ${b}, 0.10)`,
            headerBg: `rgba(${r}, ${g}, ${b}, 0.20)`
        };
    },

    init() {
        this.renderFilterBar();
        // Right-click listener for chips
        document.addEventListener('contextmenu', (e) => {
            const chip = e.target.closest('.filter-chip[data-type], .filter-chip.wp-chip');
            if (!chip) return;
            e.preventDefault();
            const type = chip.dataset.type;
            const wp = chip.dataset.wp;
            if (type) this._showChipCtx(e.clientX, e.clientY, 'type', type);
            else if (wp) this._showChipCtx(e.clientX, e.clientY, 'wp', wp);
        });
        document.addEventListener('click', () => this._hideChipCtx());

        // Initialize activity search field
        setTimeout(() => {
            const searchInput = document.getElementById('activitySearchInput');
            if (searchInput) {
                searchInput.addEventListener('input', (e) => this.onActivitySearch(e.target));
            }
        }, 100);
    },

    /* ══════════════════════════════════════════════════════
       FILTER BAR (type chips only — search inputs are in table)
       ══════════════════════════════════════════════════════ */

    renderFilterBar() {
        const existing = document.getElementById('filterBar');
        if (existing) existing.remove();

        const bar = document.createElement('div');
        bar.id = 'filterBar';
        bar.className = 'filter-bar';

        const anyActive = this.activeFilters.size > 0;
        const allActive = this.activeFilters.size === DataModel.testTypes.length;
        const anyWp = this.activeWpFilters.size > 0;
        const hasSearch  = Object.values(this.searchValues).some(v => v.trim());
        const hasColFilter = this.activeColumnFilter !== null;
        const showClear = anyActive || anyWp || hasSearch || hasColFilter;

        // Row 1: type chips
        let html = `<div class="filter-row">
            <div class="filter-label">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
                Activity
            </div>
            <div class="filter-chips">`;

        DataModel.testTypes.forEach(type => {
            const color = this.colors[type] || this.colors['FAT'];
            const isActive = this.activeFilters.has(type);
            const isLocked = this._lockedTypes.has(type);
            html += `<button class="filter-chip ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}"
                        data-type="${type}"
                        style="--chip-color: ${color.badge}; --chip-bg: ${color.bg}; --chip-border: ${color.border}"
                        onclick="FilterManager.toggle('${type}')">
                    <span class="chip-dot"></span>${type}${isLocked ? ' 🔒' : ''}</button>`;
        });

        html += `</div>
            <button class="filter-chip highlight-all-btn ${allActive ? 'active' : ''}"
                    onclick="FilterManager.highlightAll()" title="Highlight all activity types">
                ✦ All
            </button>`;

        // Column filter indicator
        if (hasColFilter) {
            const test = DataModel.getTest(this.activeColumnFilter);
            if (test) {
                const c = this.colors[test.type] || this.colors['FAT'];
                html += `<span class="filter-col-indicator" style="color:${c.badge}">
                    Rows: <strong>${test.name}</strong>
                    <button class="filter-col-x" onclick="FilterManager.clearColumnFilter()">×</button>
                </span>`;
            }
        }

        html += `<button class="filter-clear ${showClear ? '' : 'hidden'}"
                    id="filterClearBtn"
                    onclick="FilterManager.clearAll()">Clear All</button>
        </div>`;

        // Row 2: workpack chips
        html += `<div class="filter-row">
            <div class="filter-label" style="opacity:0.6">Workpack</div>
            <div class="filter-chips">`;

        const wpColors = {
            'WP03':'#06b6d4','WP04':'#8b5cf6','WP05':'#10b981',
            'WP06':'#f59e0b','WP07':'#ef4444','WP09':'#ec4899','WP10':'#6366f1','WP11':'#14b8a6'
        };

        DataModel.workpacks.forEach(wp => {
            const c = wpColors[wp] || '#888';
            const isActive = this.activeWpFilters.has(wp);
            const isLocked = this._lockedWps.has(wp);
            html += `<button class="filter-chip wp-chip ${isActive ? 'active' : ''} ${isLocked ? 'locked' : ''}"
                        data-wp="${wp}"
                        style="--chip-color: ${c}; --chip-bg: ${c}18; --chip-border: ${c}"
                        onclick="FilterManager.toggleWp('${wp}')">
                    <span class="chip-dot"></span>${wp}${isLocked ? ' 🔒' : ''}</button>`;
        });

        html += `</div></div>`;

        bar.innerHTML = html;

        const mainTitle = document.querySelector('.main-title');
        if (mainTitle) mainTitle.insertAdjacentElement('afterend', bar);
    },

    /* ══════════════════════════════════════════════════════
       TYPE CHIP ACTIONS
       ══════════════════════════════════════════════════════ */

    toggle(type) {
        if (this.activeFilters.has(type)) this.activeFilters.delete(type);
        else this.activeFilters.add(type);
        this.apply();
        this.renderFilterBar();
    },

    toggleWp(wp) {
        if (this.activeWpFilters.has(wp)) this.activeWpFilters.delete(wp);
        else this.activeWpFilters.add(wp);
        this.apply();
        this.renderFilterBar();
    },

    highlightAll() {
        if (this.activeFilters.size === DataModel.testTypes.length) {
            this.activeFilters.clear();
        } else {
            DataModel.testTypes.forEach(t => this.activeFilters.add(t));
        }
        this.apply();
        this.renderFilterBar();
    },

    clearAll() {
        // Keep locked filters active
        this.activeFilters = new Set(this._lockedTypes);
        this.activeWpFilters = new Set(this._lockedWps);
        this.searchValues = { itemNo:'', description:'', partNo:'', qty:'', melQty:'', workpack:'', stakeholder:'' };
        this.activitySearchValue = '';
        this.activeColumnFilter = null;
        document.querySelectorAll('.col-filter-input').forEach(el => { el.value = ''; });
        const searchInput = document.getElementById('activitySearchInput');
        if (searchInput) searchInput.value = '';
        this.apply();
        this.applyActivityFilter();
        this.renderFilterBar();
    },

    /* ── Lock / Unlock ─────────────────────────────────── */

    lockFilter(kind, value) {
        if (kind === 'type') {
            this._lockedTypes.add(value);
            this.activeFilters.add(value);
        } else if (kind === 'wp') {
            this._lockedWps.add(value);
            this.activeWpFilters.add(value);
        }
        this._saveLockedFilters();
        this.apply();
        this.renderFilterBar();
    },

    unlockFilter(kind, value) {
        if (kind === 'type') this._lockedTypes.delete(value);
        else if (kind === 'wp') this._lockedWps.delete(value);
        this._saveLockedFilters();
        this.renderFilterBar();
    },

    _saveLockedFilters() {
        if (typeof StorageManager !== 'undefined') {
            StorageManager.save({
                prefs: {
                    matrixLockedTypeFilters: Array.from(this._lockedTypes),
                    matrixLockedWpFilters: Array.from(this._lockedWps)
                }
            });
        }
    },

    /* ── Chip right-click context menu ─────────────────── */

    _showChipCtx(x, y, kind, value) {
        let menu = document.getElementById('filterChipCtx');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'filterChipCtx';
            menu.className = 'header-ctx-menu';
            document.body.appendChild(menu);
        }

        const isLocked = kind === 'type' ? this._lockedTypes.has(value) : this._lockedWps.has(value);
        const isActive = kind === 'type' ? this.activeFilters.has(value) : this.activeWpFilters.has(value);

        menu.innerHTML = `
            <div class="ctx-header">${value}</div>
            ${isActive
                ? '<div class="ctx-item" data-action="deactivate">👁‍🗨 Deactivate Filter</div>'
                : '<div class="ctx-item" data-action="activate">👁 Activate Filter</div>'}
            <div class="ctx-divider"></div>
            ${isLocked
                ? '<div class="ctx-item" data-action="unlock">🔓 Unlock Filter</div>'
                : '<div class="ctx-item" data-action="lock">🔒 Lock Filter (keep on refresh)</div>'}
        `;

        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        menu.classList.add('visible');

        setTimeout(() => {
            const r = menu.getBoundingClientRect();
            if (r.right > window.innerWidth) menu.style.left = (x - r.width) + 'px';
            if (r.bottom > window.innerHeight) menu.style.top = (y - r.height) + 'px';
        }, 0);

        const self = this;
        setTimeout(() => {
            menu.querySelectorAll('.ctx-item').forEach(el => {
                el.onclick = (ev) => {
                    ev.stopPropagation();
                    const action = el.dataset.action;
                    if (action === 'activate') {
                        if (kind === 'type') self.activeFilters.add(value);
                        else self.activeWpFilters.add(value);
                        self.apply(); self.renderFilterBar();
                    } else if (action === 'deactivate') {
                        if (kind === 'type') self.activeFilters.delete(value);
                        else self.activeWpFilters.delete(value);
                        self.apply(); self.renderFilterBar();
                    } else if (action === 'lock') {
                        self.lockFilter(kind, value);
                    } else if (action === 'unlock') {
                        self.unlockFilter(kind, value);
                    }
                    self._hideChipCtx();
                };
            });
        }, 0);
    },

    _hideChipCtx() {
        const m = document.getElementById('filterChipCtx');
        if (m) m.classList.remove('visible');
    },

    /* ══════════════════════════════════════════════════════
       COLUMN SEARCH (inputs live in table header filter row)
       ══════════════════════════════════════════════════════ */

    onSearch(input) {
        const field = input.dataset.field;
        if (field) this.searchValues[field] = input.value;

        // If search state changed (active ↔ empty), re-render body to expand/collapse WP groups
        const hasSearch = Object.values(this.searchValues).some(v => v.trim());
        if (hasSearch !== this._wasSearchActive) {
            this._wasSearchActive = hasSearch;
            if (typeof Renderer !== 'undefined') Renderer.renderBody();
        }

        this.applyRowFilters();

        // Update clear button visibility
        const btn = document.getElementById('filterClearBtn');
        if (btn) btn.classList.toggle('hidden', !hasSearch && this.activeFilters.size === 0 && this.activeColumnFilter === null);
    },

    _wasSearchActive: false,
    activitySearchValue: '',

    /**
     * Search activities by name or Doc Nr (subtitle)
     */
    onActivitySearch(input) {
        this.activitySearchValue = (input.value || '').toLowerCase().trim();
        this.applyActivityFilter();
    },

    /**
     * Apply activity name/doc nr filter to test columns.
     * Dims the entire column (header + body cells), not just the header,
     * so the visual highlight follows the column down the table.
     */
    applyActivityFilter() {
        const searchTerm = this.activitySearchValue;

        // Build a Set of test IDs that match the current search term
        const matchingIds = new Set();
        const visibleTests = (typeof DataModel !== 'undefined' && DataModel.getVisibleColumns)
            ? DataModel.getVisibleColumns()
            : [];

        visibleTests.forEach(test => {
            const nameMatch = (test.name || '').toLowerCase().includes(searchTerm);
            const subtitleMatch = test.subtitle && test.subtitle.toLowerCase().includes(searchTerm);
            if (!searchTerm || nameMatch || subtitleMatch) {
                matchingIds.add(String(test.id));
            }
        });

        // Apply styles to every cell that carries a data-test-id (headers + body)
        const allCells = document.querySelectorAll('.matrix-table [data-test-id]');
        allCells.forEach(cell => {
            const id = cell.dataset.testId;
            if (!searchTerm || matchingIds.has(id)) {
                cell.classList.remove('activity-search-dim');
                // Clear any inline styles left over from earlier (header-only) version
                cell.style.opacity = '';
                cell.style.borderColor = '';
            } else {
                cell.classList.add('activity-search-dim');
                cell.style.opacity = '';
                cell.style.borderColor = '';
            }
        });
    },

    _wasSearchActive: false,

    /* ══════════════════════════════════════════════════════
       PER-COLUMN ACTIVITY FILTER
       ══════════════════════════════════════════════════════ */

    toggleColumnFilter(testId) {
        if (this.activeColumnFilter === testId) {
            this.activeColumnFilter = null;
        } else {
            this.activeColumnFilter = testId;
        }
        this._computeSharedColumns();
        this.applyRowFilters();
        this.applyColumnHighlights();
        this._updateColFilterButtons();
        this.renderFilterBar();
    },

    clearColumnFilter() {
        this.activeColumnFilter = null;
        this._sharedColumnIds = null;
        this.applyRowFilters();
        this.applyColumnHighlights();
        this._updateColFilterButtons();
        this.renderFilterBar();
    },

    /**
     * Compute which other activity columns share at least one row item
     * with the currently filtered column. A "shared item" = both columns
     * have a non-empty, non-zero value in the same row.
     */
    _sharedColumnIds: null,

    _computeSharedColumns() {
        if (this.activeColumnFilter === null) {
            this._sharedColumnIds = null;
            return;
        }

        var filterId = this.activeColumnFilter;
        var sharedIds = new Set();
        sharedIds.add(filterId); // always include the filtered column itself

        // Collect all row keys that have data in the filtered column
        var filteredRowKeys = new Set();
        DataModel.sections.forEach(function(section) {
            section.rows.forEach(function(row, ri) {
                var val = row.testQty ? row.testQty[filterId] : '';
                if (val && val !== '0' && String(val).trim() !== '') {
                    filteredRowKeys.add(section.id + '-' + ri);
                }
            });
        });

        // For each other column, check if any of those rows also have data
        DataModel.testColumns.forEach(function(test) {
            if (test.id === filterId) return;
            var hasShared = false;
            DataModel.sections.forEach(function(section) {
                if (hasShared) return;
                section.rows.forEach(function(row, ri) {
                    if (hasShared) return;
                    var key = section.id + '-' + ri;
                    if (!filteredRowKeys.has(key)) return;
                    var val = row.testQty ? row.testQty[test.id] : '';
                    if (val && val !== '0' && String(val).trim() !== '') {
                        hasShared = true;
                    }
                });
            });
            if (hasShared) sharedIds.add(test.id);
        });

        this._sharedColumnIds = sharedIds;
    },

    _updateColFilterButtons() {
        document.querySelectorAll('.col-filter-btn').forEach(btn => {
            const tid = parseInt(btn.dataset.testId);
            btn.classList.toggle('active', tid === this.activeColumnFilter);
        });
    },

    /* ══════════════════════════════════════════════════════
       APPLY — COLUMN VISIBILITY + HIGHLIGHTS
       ══════════════════════════════════════════════════════ */

    apply() {
        this.applyColumnHighlights();
        this.applyRowFilters();
    },

    applyColumnHighlights() {
        const table = document.getElementById('matrixTable');
        if (!table) return;

        const hasTypeFilters = this.activeFilters.size > 0;
        const hasWpFilters = this.activeWpFilters.size > 0;
        const hasAnyFilter = hasTypeFilters || hasWpFilters;
        const hasColFilter = this.activeColumnFilter !== null;
        const sharedIds = this._sharedColumnIds;

        DataModel.getVisibleColumns().forEach((test, index) => {
            const type = test.type;
            const color = this.colors[type] || this.colors['FAT'];
            const tint = this._tintFor(color);
            const typeMatch = !hasTypeFilters || this.activeFilters.has(type);
            const wpMatch = !hasWpFilters || this.activeWpFilters.has(test.workpack);
            // When column filter is active, also hide columns that share no items
            const sharedMatch = !hasColFilter || !sharedIds || sharedIds.has(test.id);
            const isVisible = typeMatch && wpMatch && sharedMatch;
            const colIndex = 8 + index;

            // All header rows
            table.querySelectorAll(`th[data-test-id="${test.id}"]`).forEach(th => {
                th.style.display = isVisible ? '' : 'none';
                if (hasAnyFilter && isVisible) {
                    th.style.borderTop = `3px solid ${color.border}`;
                    th.style.background = tint.headerBg;
                } else {
                    th.style.borderTop = `3px solid ${color.border}`;
                    th.style.background = '';
                }
            });

            // Body cells
            const tbody = document.getElementById('tableBody');
            const allRows = tbody ? tbody.querySelectorAll('tr') : [];

            allRows.forEach(row => {
                if (row.classList.contains('section-header')) {
                    const cells = row.querySelectorAll('td.test-column');
                    if (cells[index]) cells[index].style.display = isVisible ? '' : 'none';
                } else if (row.classList.contains('data-row')) {
                    const cells = row.querySelectorAll('td');
                    const cell = cells[colIndex];
                    if (cell) {
                        cell.style.display = isVisible ? '' : 'none';
                        if (hasAnyFilter && isVisible) {
                            cell.style.background = tint.cellBg;
                            cell.style.borderLeft = `1px solid ${color.border}40`;
                            cell.style.borderRight = `1px solid ${color.border}40`;
                        } else {
                            cell.style.background = '';
                            cell.style.borderLeft = '';
                            cell.style.borderRight = '';
                        }
                    }
                } else if (row.classList.contains('add-row-row')) {
                    const cells = row.querySelectorAll('td.test-column');
                    if (cells[index]) cells[index].style.display = isVisible ? '' : 'none';
                }
            });
        });

        this.applyTypeIndicators();
    },

    /* ══════════════════════════════════════════════════════
       APPLY — ROW FILTERS (search + column filter)
       ══════════════════════════════════════════════════════ */

    applyRowFilters() {
        const tbody = document.getElementById('tableBody');
        if (!tbody) return;

        const hasSearch = Object.values(this.searchValues).some(v => v.trim());
        const colFilter = this.activeColumnFilter;
        const fieldIdx = { itemNo: 1, description: 2, partNo: 3, melQty: 4, qty: 5, workpack: 6, stakeholder: 7 };

        tbody.querySelectorAll('tr.data-row').forEach(row => {
            // Skip rows already hidden by section collapse
            if (row.classList.contains('hidden')) return;

            let visible = true;

            if (hasSearch) {
                const cells = row.querySelectorAll('td');
                for (const [field, idx] of Object.entries(fieldIdx)) {
                    const sv = this.searchValues[field]?.trim().toLowerCase();
                    if (!sv) continue;
                    const cell = cells[idx];
                    if (!cell) { visible = false; break; }
                    const input = cell.querySelector('input');
                    const select = cell.querySelector('select');
                    const span = cell.querySelector('.qty-sum');
                    const val = (input?.value || select?.value || span?.textContent || '').toLowerCase().replace('—', '');
                    if (!val.includes(sv)) { visible = false; break; }
                }
            }

            if (visible && colFilter !== null) {
                const testIdx = DataModel.getVisibleColumns().findIndex(t => t.id === colFilter);
                if (testIdx !== -1) {
                    const cells = row.querySelectorAll('td');
                    const testCell = cells[8 + testIdx];
                    const input = testCell?.querySelector('input');
                    const val = (input?.value || '').trim();
                    if (!val || val === '0') visible = false;
                }
            }

            row.style.display = visible ? '' : 'none';
        });

        // Auto-hide WP sub-headers when all their visible child rows are filtered out.
        // SKIP collapsed sub-headers — they should remain visible.
        tbody.querySelectorAll('tr.wp-subheader').forEach(subHeader => {
            if (subHeader.classList.contains('hidden')) return;
            // Collapsed groups: always show the sub-header
            if (subHeader.classList.contains('wp-collapsed')) {
                subHeader.style.display = '';
                return;
            }
            // Expanded groups: hide if no child rows are visible
            let hasVisibleChild = false;
            let next = subHeader.nextElementSibling;
            while (next) {
                if (next.classList.contains('wp-subheader') || next.classList.contains('section-header') || next.classList.contains('add-row-row')) break;
                if (next.classList.contains('data-row') && next.style.display !== 'none') {
                    hasVisibleChild = true;
                    break;
                }
                next = next.nextElementSibling;
            }
            subHeader.style.display = hasVisibleChild ? '' : 'none';
        });
    },

    /* ══════════════════════════════════════════════════════
       TYPE INDICATORS
       ══════════════════════════════════════════════════════ */

    applyTypeIndicators() {
        DataModel.testColumns.forEach(test => {
            const color = this.colors[test.type] || this.colors['FAT'];
            document.querySelectorAll(`th[data-test-id="${test.id}"]`).forEach(th => {
                th.style.borderTop = `3px solid ${color.border}`;
            });
        });
    },

    refresh() {
        this.renderFilterBar();
        this.apply();
        this.applyActivityFilter();
    },

    _esc(s) { return (s || '').replace(/"/g, '&quot;'); }
};
