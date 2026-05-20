/**
 * RENDER.JS - Table Rendering
 * Handles all rendering of the matrix table
 */

const Renderer = {
    /**
     * Render the entire matrix
     */
    render() {
        // Save scroll position and focused element before DOM rebuild
        const scrollEl = document.getElementById('tableScroll');
        const savedScrollLeft = scrollEl ? scrollEl.scrollLeft : 0;
        const savedScrollTop = scrollEl ? scrollEl.scrollTop : 0;

        // Save which input was focused (by section + row + column class)
        let focusInfo = null;
        const activeEl = document.activeElement;
        if (activeEl && activeEl.tagName === 'INPUT' && activeEl.closest('#matrixTable')) {
            const td = activeEl.closest('td');
            const tr = activeEl.closest('tr.data-row');
            if (td && tr) {
                focusInfo = {
                    section: tr.dataset.section,
                    row: tr.dataset.rowIndex,
                    colClass: td.className.split(' ').find(c => c.startsWith('col-') || c === 'test-column'),
                    testId: null,
                    selStart: activeEl.selectionStart,
                    selEnd: activeEl.selectionEnd
                };
                // For test columns, find which test ID
                if (td.classList.contains('test-column')) {
                    const allTds = Array.from(tr.querySelectorAll('td'));
                    const tdIdx = allTds.indexOf(td);
                    focusInfo.colIdx = tdIdx;
                }
            }
        }

        this.renderHeader();
        this.renderBody();
        
        // Clear clipboard selection (DOM was rebuilt)
        if (typeof ClipboardManager !== 'undefined' && ClipboardManager._selectedCells) {
            ClipboardManager._selectedCells = [];
            ClipboardManager._anchorCell = null;
        }

        // Restore scroll position
        if (scrollEl) {
            scrollEl.scrollLeft = savedScrollLeft;
            scrollEl.scrollTop = savedScrollTop;
        }

        // Restore focus
        if (focusInfo) {
            setTimeout(() => {
                const rows = document.querySelectorAll(`tr.data-row[data-section="${focusInfo.section}"][data-row-index="${focusInfo.row}"]`);
                const tr = rows[0];
                if (!tr) return;
                let targetTd = null;
                if (focusInfo.colIdx !== undefined) {
                    const allTds = Array.from(tr.querySelectorAll('td'));
                    targetTd = allTds[focusInfo.colIdx];
                } else if (focusInfo.colClass) {
                    targetTd = tr.querySelector('td.' + focusInfo.colClass.replace(/ /g, '.'));
                }
                if (targetTd) {
                    const input = targetTd.querySelector('input');
                    if (input) {
                        input.focus();
                        try {
                            input.setSelectionRange(focusInfo.selStart || 0, focusInfo.selEnd || input.value.length);
                        } catch(e) {}
                    }
                }
            }, 10);
        }

        // Refresh resize handles after render (if ResizeManager exists)
        if (typeof ResizeManager !== 'undefined') {
            setTimeout(() => ResizeManager.refresh(), 50);
        }
        
        // Re-apply filters and highlights after render
        if (typeof FilterManager !== 'undefined') {
            FilterManager.refresh();
        }
    },

    /**
     * Render table header
     */
    renderHeader() {
        const thead = document.getElementById('tableHead');
        thead.innerHTML = '';

        // Create header row
        const tr = document.createElement('tr');
        tr.className = 'column-header-row';

        // Fixed columns
        const freezeClass = DataModel.freezeEnabled ? 'col-freeze' : '';
        
        tr.innerHTML = `
            <th class="col-delete ${freezeClass} col-freeze-0"></th>
            <th class="col-item ${freezeClass} col-freeze-1">Item #</th>
            <th class="col-desc ${freezeClass} col-freeze-2">Description</th>
            <th class="col-partno ${freezeClass} col-freeze-3">Part No.</th>
            <th class="col-melqty ${freezeClass} col-freeze-4">MEL QTY</th>
            <th class="col-qty ${freezeClass} col-freeze-5">QTY</th>
            <th class="col-workpack ${freezeClass} col-freeze-6">Workpack</th>
            <th class="col-stakeholder ${freezeClass} col-freeze-7">Stakeholder</th>
        `;

        // Test columns — add data-type and group boundary markers
        const visibleColumns = DataModel.getVisibleColumns();
        visibleColumns.forEach((test, index) => {
            const th = document.createElement('th');
            th.className = 'test-column test-header';
            if (test.parentId) th.classList.add('sub-activity-col');
            th.dataset.testId = test.id;
            th.dataset.type = test.type;

            // Mark the first column of each activity-type group
            const prevType = index > 0 ? visibleColumns[index - 1].type : null;
            if (prevType && prevType !== test.type) {
                th.classList.add('type-group-first');
            }

            th.innerHTML = this.getTestHeaderHTML(test);
            
            // Add drag events (only for main tests, not sub-activities)
            if (!test.parentId) DragDropManager.attachEvents(th);
            
            tr.appendChild(th);
        });

        // Add test column button
        tr.innerHTML += `
            <th class="add-test-col">
                <div class="add-buttons-container">
                    <button class="add-test-btn" onclick="TestManager.openAddModal()" title="Add new test">+</button>
                    <button class="import-table-btn" onclick="ActivityImport.open()" title="Import activities">
                        <span class="line"></span>
                        <span class="line"></span>
                        <span class="line"></span>
                    </button>
                </div>
            </th>
        `;

        // Activity search row — search by name and Doc Nr
        // (Appended FIRST so it sits above the column headers; col-freeze-1 on
        //  the input cell makes it stick to the left edge after the delete col
        //  when horizontal freeze is on, so it doesn't scroll off to the right.)
        const activitySearchTr = document.createElement('tr');
        activitySearchTr.className = 'activity-search-row';
        activitySearchTr.id = 'activitySearchRow';

        const freezeClassA = DataModel.freezeEnabled ? 'col-freeze' : '';
        activitySearchTr.innerHTML = `
            <th class="col-delete search-cell ${freezeClassA} col-freeze-0"></th>
            <th colspan="7" class="col-search-combined ${freezeClassA} ${freezeClassA ? 'col-freeze-1' : ''}">
                <input class="activity-search-input"
                       id="activitySearchInput"
                       type="text"
                       placeholder="🔍 Search by Activity Name or Doc Nr..."
                       oninput="FilterManager.onActivitySearch(this)">
            </th>
        `;

        // Add empty cells for test columns and add button
        const searchVisible = DataModel.getVisibleColumns();
        searchVisible.forEach(() => {
            activitySearchTr.innerHTML += '<th class="test-column search-cell"></th>';
        });
        activitySearchTr.innerHTML += '<th class="add-test-col search-cell"></th>';

        thead.appendChild(activitySearchTr);

        // Main column-header row (Item #, Description, … + test columns)
        thead.appendChild(tr);

        // Filter row — column-aligned search inputs
        const filterTr = document.createElement('tr');
        filterTr.className = 'filter-header-row';
        filterTr.id = 'filterHeaderRow';

        const freezeClassF = DataModel.freezeEnabled ? 'col-freeze' : '';
        filterTr.innerHTML = `
            <th class="col-delete filter-cell ${freezeClassF} col-freeze-0"></th>
            <th class="col-item filter-cell ${freezeClassF} col-freeze-1">
                <input class="col-filter-input" placeholder="⌕" data-field="itemNo"
                    value="${FilterManager._esc(FilterManager.searchValues.itemNo)}"
                    oninput="FilterManager.onSearch(this)">
            </th>
            <th class="col-desc filter-cell ${freezeClassF} col-freeze-2">
                <input class="col-filter-input" placeholder="⌕" data-field="description"
                    value="${FilterManager._esc(FilterManager.searchValues.description)}"
                    oninput="FilterManager.onSearch(this)">
            </th>
            <th class="col-partno filter-cell ${freezeClassF} col-freeze-3">
                <input class="col-filter-input" placeholder="⌕" data-field="partNo"
                    value="${FilterManager._esc(FilterManager.searchValues.partNo)}"
                    oninput="FilterManager.onSearch(this)">
            </th>
            <th class="col-melqty filter-cell ${freezeClassF} col-freeze-4">
                <input class="col-filter-input" placeholder="⌕" data-field="melQty"
                    value="${FilterManager._esc(FilterManager.searchValues.melQty || '')}"
                    oninput="FilterManager.onSearch(this)">
            </th>
            <th class="col-qty filter-cell ${freezeClassF} col-freeze-5">
                <input class="col-filter-input" placeholder="⌕" data-field="qty"
                    value="${FilterManager._esc(FilterManager.searchValues.qty)}"
                    oninput="FilterManager.onSearch(this)">
            </th>
            <th class="col-workpack filter-cell ${freezeClassF} col-freeze-6">
                <input class="col-filter-input" placeholder="⌕" data-field="workpack"
                    value="${FilterManager._esc(FilterManager.searchValues.workpack)}"
                    oninput="FilterManager.onSearch(this)">
            </th>
            <th class="col-stakeholder filter-cell ${freezeClassF} col-freeze-7">
                <input class="col-filter-input" placeholder="⌕" data-field="stakeholder"
                    value="${FilterManager._esc(FilterManager.searchValues.stakeholder)}"
                    oninput="FilterManager.onSearch(this)">
            </th>
        `;

        // Test column filter cells — show total qty sum
        const filterVisible = DataModel.getVisibleColumns();
        filterVisible.forEach((test, index) => {
            const th = document.createElement('th');
            th.className = 'test-column filter-cell';
            if (test.parentId) th.classList.add('sub-activity-col');
            th.dataset.testId = test.id;

            const prevType = index > 0 ? filterVisible[index - 1].type : null;
            if (prevType && prevType !== test.type) th.classList.add('type-group-first');

            // Sum all quantities in this test column
            let totalQty = 0;
            DataModel.sections.forEach(s => s.rows.forEach(r => {
                const v = parseFloat(r.testQty[test.id]);
                if (!isNaN(v)) totalQty += v;
            }));

            const display = totalQty > 0 ? totalQty : '·';
            th.innerHTML = `<span class="col-total-qty" title="Total qty: ${totalQty}">${display}</span>`;
            filterTr.appendChild(th);
        });

        filterTr.innerHTML += `<th class="add-test-col filter-cell"></th>`;
        thead.appendChild(filterTr);
    },

    /**
     * Get HTML for test column header
     */
    getTestHeaderHTML(test) {
        const isSub = !!test.parentId;
        const typeOptions = DataModel.testTypes.map(t => 
            `<option value="${t}" ${test.type === t ? 'selected' : ''}>${t}</option>`
        ).join('');

        const locationOptions = DataModel.getLocationNames().map(l => 
            `<option value="${l}" ${test.location === l ? 'selected' : ''}>${l}</option>`
        ).join('');

        const wpOptions = ['', ...DataModel.workpacks].map(w =>
            `<option value="${w}" ${test.workpack === w ? 'selected' : ''}>${w || '—'}</option>`
        ).join('');

        const uid = test.uid || '';

        // --- Sub-activity header ---
        if (isSub) {
            return `
                <div class="sub-activity-connector"></div>
                <div class="test-toolbar">
                    <div class="col-arrows">
                        <button class="col-arrow-btn" onclick="event.stopPropagation(); TestManager.moveSubLeft(${test.parentId}, ${test.id})" title="Move left">◀</button>
                        <button class="col-arrow-btn" onclick="event.stopPropagation(); TestManager.moveSubRight(${test.parentId}, ${test.id})" title="Move right">▶</button>
                    </div>
                    <div class="test-toolbar-right">
                        <button class="test-action-btn info-btn" data-test-id="${test.id}"
                                onclick="event.stopPropagation(); ActivityDetails.open(${test.id})"
                                title="Activity details">📝</button>
                        <button class="test-action-btn col-filter-btn" data-test-id="${test.id}"
                                onclick="event.stopPropagation(); FilterManager.toggleColumnFilter(${test.id})"
                                title="Filter rows with data in this column">⧫</button>
                        <div class="test-settings-wrapper">
                            <button class="test-action-btn settings-btn" data-test-id="${test.id}"
                                    onclick="event.stopPropagation(); TestManager.toggleSettingsPopup(${test.id})"
                                    title="Settings">☰</button>
                            <div class="test-settings-popup" id="settings-popup-${test.id}">
                                <button class="test-action-btn uid-btn" data-test-id="${test.id}"
                                        onclick="event.stopPropagation(); TestManager.showUidPopup(${test.id})"
                                        title="${uid}">#</button>
                                <button class="test-action-btn save-test" onclick="event.stopPropagation(); ExportManager.quickSaveTest(${test.id})" title="Quick save this sub-test">💾</button>
                                <button class="test-action-btn export" onclick="event.stopPropagation(); ExportManager.openTestModal(${test.id})" title="Export this sub-test">↓</button>
                                <button class="test-action-btn delete" onclick="event.stopPropagation(); TestManager.deleteSubActivity(${test.parentId}, ${test.id})" title="Delete sub-activity">×</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="test-name sub-activity-name" title="${uid} (sub of ${test.parentId})">
                    <input type="text" value="${test.name}" onchange="TestManager.updateSubField(${test.parentId}, ${test.id}, 'name', this.value)" onpaste="return true;">
                </div>
                <div class="test-subtitle">
                    <input type="text" value="${test.subtitle || ''}" onchange="TestManager.updateSubField(${test.parentId}, ${test.id}, 'subtitle', this.value)" placeholder="Doc Nr." onpaste="return true;">
                </div>
                <div class="test-info">
                    <label>Type</label>
                    <select onchange="TestManager.updateSubField(${test.parentId}, ${test.id}, 'type', this.value)">
                        ${typeOptions}
                    </select>
                    <label>Location</label>
                    <select onchange="TestManager.updateSubField(${test.parentId}, ${test.id}, 'location', this.value)">
                        ${locationOptions}
                    </select>
                    <label>Workpack</label>
                    <select onchange="TestManager.updateSubField(${test.parentId}, ${test.id}, 'workpack', this.value)">
                        ${wpOptions}
                    </select>
                    <label>Start</label>
                    <input type="date" value="${test.startDate}" onchange="TestManager.updateSubField(${test.parentId}, ${test.id}, 'startDate', this.value)">
                    <label>End</label>
                    <input type="date" value="${test.endDate}" onchange="TestManager.updateSubField(${test.parentId}, ${test.id}, 'endDate', this.value)">
                </div>
            `;
        }

        // --- Main activity header ---
        const subCount = (test.subActivities && test.subActivities.length) || 0;
        const isExpanded = DataModel.isSubExpanded(test.id);
        const subToggleBtn = subCount > 0
            ? `<button class="test-action-btn sub-toggle-btn ${isExpanded ? 'expanded' : ''}" data-test-id="${test.id}"
                    onclick="event.stopPropagation(); TestManager.toggleSubActivities(${test.id})"
                    title="${isExpanded ? 'Hide' : 'Show'} ${subCount} sub-activit${subCount === 1 ? 'y' : 'ies'}">
                    <span class="sub-toggle-icon">${isExpanded ? '◂' : '▸'}</span>
                    <span class="sub-toggle-count">${subCount}</span>
               </button>`
            : '';

        return `
            <div class="test-toolbar">
                <div class="col-arrows">
                    <button class="col-arrow-btn" onclick="event.stopPropagation(); DragDropManager.moveLeft(${test.id})" title="Move left">◀</button>
                    <button class="col-arrow-btn" onclick="event.stopPropagation(); DragDropManager.moveRight(${test.id})" title="Move right">▶</button>
                </div>
                <div class="test-toolbar-right">
                    <button class="test-action-btn info-btn" data-test-id="${test.id}"
                            onclick="event.stopPropagation(); ActivityDetails.open(${test.id})"
                            title="Activity details">📝</button>
                    <button class="test-action-btn col-filter-btn" data-test-id="${test.id}"
                            onclick="event.stopPropagation(); FilterManager.toggleColumnFilter(${test.id})"
                            title="Filter rows with data in this column">⧫</button>
                    ${subToggleBtn}
                    <div class="test-settings-wrapper">
                        <button class="test-action-btn settings-btn" data-test-id="${test.id}"
                                onclick="event.stopPropagation(); TestManager.toggleSettingsPopup(${test.id})"
                                title="Settings">☰</button>
                        <div class="test-settings-popup" id="settings-popup-${test.id}">
                            <button class="test-action-btn uid-btn" data-test-id="${test.id}"
                                    onclick="event.stopPropagation(); TestManager.showUidPopup(${test.id})"
                                    title="${uid}">#</button>
                            <button class="test-action-btn save-test" onclick="event.stopPropagation(); ExportManager.quickSaveTest(${test.id})" title="Quick save this test">💾</button>
                            <button class="test-action-btn export" onclick="event.stopPropagation(); ExportManager.openTestModal(${test.id})" title="Export this test">↓</button>
                            <button class="test-action-btn delete" onclick="event.stopPropagation(); TestManager.delete(${test.id})" title="Delete test">×</button>
                            <button class="test-action-btn add-btn" data-test-id="${test.id}"
                                    onclick="event.stopPropagation(); TestManager.addSubActivity(${test.id})"
                                    title="Add sub-activity">+</button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="test-name" title="${uid}">
                <input type="text" value="${test.name}" onchange="TestManager.updateName(${test.id}, this.value)" onpaste="return true;">
            </div>
            <div class="test-subtitle">
                <input type="text" value="${test.subtitle || ''}" onchange="TestManager.updateSubtitle(${test.id}, this.value)" placeholder="Doc Nr." onpaste="return true;">
            </div>
            <div class="test-info">
                <label>Type</label>
                <select onchange="TestManager.updateType(${test.id}, this.value)">
                    ${typeOptions}
                </select>
                <label>Location</label>
                <select onchange="TestManager.updateLocation(${test.id}, this.value)">
                    ${locationOptions}
                </select>
                <label>Workpack</label>
                <select onchange="TestManager.updateWorkpack(${test.id}, this.value)">
                    ${wpOptions}
                </select>
                <label>Start</label>
                <input type="date" value="${test.startDate}" onchange="TestManager.updateDate(${test.id}, 'startDate', this.value)">
                <label>End</label>
                <input type="date" value="${test.endDate}" onchange="TestManager.updateDate(${test.id}, 'endDate', this.value)">
            </div>
        `;
    },

    /**
     * Render table body
     */
    renderBody() {
        const tbody = document.getElementById('tableBody');
        tbody.innerHTML = '';

        // Check if any search filter is active — if so, show all rows regardless of WP collapse
        const hasActiveSearch = typeof FilterManager !== 'undefined' &&
            Object.values(FilterManager.searchValues).some(v => v.trim());

        DataModel.sections.forEach(section => {
            // Section header
            tbody.appendChild(this.createSectionHeader(section));

            // Group rows by workpack
            const wpGroups = {};
            const ungrouped = [];
            section.rows.forEach((row, rowIndex) => {
                const wp = (row.workpack || '').trim();
                if (wp) {
                    if (!wpGroups[wp]) wpGroups[wp] = [];
                    wpGroups[wp].push({ row, rowIndex });
                } else {
                    ungrouped.push({ row, rowIndex });
                }
            });

            const wpKeys = Object.keys(wpGroups).sort();

            // Render WP sub-groups first
            wpKeys.forEach(wp => {
                const wpId = section.id + '::' + wp;
                const collapsed = !hasActiveSearch && DataModel._collapsedWps && DataModel._collapsedWps[wpId];

                tbody.appendChild(this.createWpSubHeader(section, wp, wpGroups[wp].length, collapsed));

                if (!collapsed) {
                    wpGroups[wp].forEach(({ row, rowIndex }) => {
                        const tr = this.createDataRow(section, row, rowIndex);
                        tr.dataset.wpGroup = wpId;
                        tbody.appendChild(tr);
                    });
                }
            });

            // Render ungrouped rows at the bottom with a "—" sub-header
            if (ungrouped.length > 0) {
                const unWpId = section.id + '::_unassigned';
                const unCollapsed = !hasActiveSearch && DataModel._collapsedWps && DataModel._collapsedWps[unWpId];

                tbody.appendChild(this.createWpSubHeader(section, '—', ungrouped.length, unCollapsed, true));

                if (!unCollapsed) {
                    ungrouped.forEach(({ row, rowIndex }) => {
                        const tr = this.createDataRow(section, row, rowIndex);
                        tr.dataset.wpGroup = unWpId;
                        tbody.appendChild(tr);
                    });
                }
            }

            // Add row button
            tbody.appendChild(this.createAddRowButton(section));
        });
    },

    /**
     * Get the column index positions where a type-group boundary exists
     * Returns a Set of column indices (0-based within testColumns)
     */
    getGroupBoundaries() {
        const boundaries = new Set();
        const visible = DataModel.getVisibleColumns();
        visible.forEach((test, index) => {
            if (index > 0 && visible[index - 1].type !== test.type) {
                boundaries.add(index);
            }
        });
        return boundaries;
    },

    /**
     * Create section header row
     */
    createSectionHeader(section) {
        const tr = document.createElement('tr');
        tr.className = `section-header ${section.collapsed ? 'collapsed' : ''}`;
        tr.onclick = () => SectionManager.toggle(section.id);

        // Add freeze classes to section headers so they stay visible when scrolling
        const freezeClass = DataModel.freezeEnabled ? 'col-freeze col-freeze-0' : '';
        const boundaries = this.getGroupBoundaries();
        const visible = DataModel.getVisibleColumns();

        // Use colspan=7 to merge all frozen columns into one cell
        let html = `
            <td class="section-name-cell ${freezeClass}" colspan="8">
                <span class="section-toggle">
                    <span class="toggle-icon">▼</span>
                    ${section.name}
                </span>
            </td>
        `;

        // Add empty cells for each VISIBLE test column
        visible.forEach((test, index) => {
            const groupClass = boundaries.has(index) ? 'type-group-first' : '';
            html += `<td class="test-column section-test-cell ${groupClass}" data-test-id="${test.id}"></td>`;
        });

        // Empty cell for add button column
        html += `<td class="add-test-col"></td>`;

        tr.innerHTML = html;
        return tr;
    },

    /**
     * Create WP sub-header row (collapsible group within a section)
     */
    createWpSubHeader(section, wp, count, collapsed, isUnassigned) {
        const tr = document.createElement('tr');
        const wpId = isUnassigned ? section.id + '::_unassigned' : section.id + '::' + wp;
        tr.className = `wp-subheader ${section.collapsed ? 'hidden' : ''} ${collapsed ? 'wp-collapsed' : ''}`;
        tr.onclick = (e) => { e.stopPropagation(); SectionManager.toggleWp(wpId); };

        const freezeClass = DataModel.freezeEnabled ? 'col-freeze col-freeze-0' : '';
        const boundaries = this.getGroupBoundaries();
        const visible = DataModel.getVisibleColumns();

        const wpColors = {
            'WP03':'#06b6d4','WP04':'#8b5cf6','WP05':'#10b981',
            'WP06':'#f59e0b','WP07':'#ef4444','WP09':'#ec4899','WP10':'#6366f1','WP11':'#14b8a6'
        };
        const wpColor = wpColors[wp] || '#667';

        let html = `
            <td class="wp-sub-name-cell ${freezeClass}" colspan="8">
                <span class="wp-sub-toggle">
                    <span class="wp-toggle-icon">${collapsed ? '▶' : '▼'}</span>
                    <span class="wp-sub-dot" style="background:${wpColor}"></span>
                    ${wp}
                    <span class="wp-sub-count">(${count})</span>
                </span>
            </td>
        `;

        visible.forEach((test, index) => {
            const groupClass = boundaries.has(index) ? 'type-group-first' : '';
            html += `<td class="test-column wp-sub-test-cell ${groupClass}" data-test-id="${test.id}"></td>`;
        });

        html += `<td class="add-test-col"></td>`;
        tr.innerHTML = html;
        return tr;
    },

    /**
     * Create data row
     */
    createDataRow(section, row, rowIndex) {
        const tr = document.createElement('tr');
        tr.className = `data-row ${section.collapsed ? 'hidden' : ''}`;
        tr.dataset.section = section.id;
        tr.dataset.rowIndex = rowIndex;

        const freezeClass = DataModel.freezeEnabled ? 'col-freeze' : '';

        // Auto-calculate QTY sum from main test quantities only (exclude sub-activities)
        let qtySum = 0;
        if (row.testQty) {
            DataModel.testColumns.forEach(t => {
                const n = parseFloat(row.testQty[t.id]);
                if (!isNaN(n)) qtySum += n;
            });
        }
        const qtySumDisplay = qtySum > 0 ? qtySum : '';

        // Build workpack dropdown options
        const wpOptions = DataModel.workpacks.map(wp =>
            `<option value="${wp}"${row.workpack === wp ? ' selected' : ''}>${wp}</option>`
        ).join('');

        let html = `
            <td class="col-delete ${freezeClass} col-freeze-0">
                <button class="delete-row-btn" onclick="SectionManager.deleteRow('${section.id}', ${rowIndex})" title="Delete row">🗑</button>
            </td>
            <td class="col-item ${freezeClass} col-freeze-1">
                <input type="text" value="${row.itemNo}" placeholder="—" maxlength="10"
                    onchange="SectionManager.updateRow('${section.id}', ${rowIndex}, 'itemNo', this.value)">
            </td>
            <td class="col-desc ${freezeClass} col-freeze-2">
                <input type="text" value="${row.description}" placeholder="Enter description..." 
                    onchange="SectionManager.updateRow('${section.id}', ${rowIndex}, 'description', this.value)">
            </td>
            <td class="col-partno ${freezeClass} col-freeze-3">
                <input type="text" value="${row.partNo}" placeholder="—" maxlength="10"
                    onchange="SectionManager.updateRow('${section.id}', ${rowIndex}, 'partNo', this.value)">
            </td>
            <td class="col-melqty ${freezeClass} col-freeze-4">
                <input type="text" value="${row.melQty || ''}" placeholder="—" maxlength="10" style="text-align:center;"
                    onchange="SectionManager.updateRow('${section.id}', ${rowIndex}, 'melQty', this.value)">
            </td>
            <td class="col-qty ${freezeClass} col-freeze-5">
                <span class="qty-sum" title="Auto-sum of test quantities">${qtySumDisplay || '—'}</span>
            </td>
            <td class="col-workpack ${freezeClass} col-freeze-6">
                <select class="wp-select" onchange="SectionManager.updateRow('${section.id}', ${rowIndex}, 'workpack', this.value)">
                    <option value="">—</option>
                    ${wpOptions}
                </select>
            </td>
            <td class="col-stakeholder ${freezeClass} col-freeze-7">
                <input type="text" value="${row.stakeholder}" placeholder="—" maxlength="10"
                    onchange="SectionManager.updateRow('${section.id}', ${rowIndex}, 'stakeholder', this.value)">
            </td>
        `;

        // Test quantity cells — only visible columns (includes expanded sub-activities)
        const boundaries = this.getGroupBoundaries();
        DataModel.getVisibleColumns().forEach((test, index) => {
            const testQty = row.testQty[test.id] || '';
            const groupClass = boundaries.has(index) ? 'type-group-first' : '';
            const subClass = test.parentId ? 'sub-activity-col' : '';
            html += `
                <td class="test-column ${groupClass} ${subClass}" data-test-id="${test.id}">
                    <input type="text" class="qty-input" value="${testQty}" placeholder="0" 
                        onchange="SectionManager.updateTestQty('${section.id}', ${rowIndex}, ${test.id}, this.value)">
                </td>
            `;
        });

        // Empty cell for add button column
        html += `<td class="add-test-col"></td>`;

        tr.innerHTML = html;
        return tr;
    },

    /**
     * Create add row button
     */
    createAddRowButton(section) {
        const tr = document.createElement('tr');
        tr.className = `add-row-row ${section.collapsed ? 'hidden' : ''}`;
        tr.dataset.section = section.id;

        const freezeClass = DataModel.freezeEnabled ? 'col-freeze col-freeze-0' : '';

        // Use colspan=7 to merge all frozen columns into one cell
        let html = `
            <td class="add-row-cell ${freezeClass}" colspan="8">
                <button class="add-row-btn" onclick="SectionManager.addRow('${section.id}')">
                    <span>+</span> Add Item
                </button>
            </td>
        `;

        // Add empty cells for each test column
        const boundaries = this.getGroupBoundaries();
        DataModel.getVisibleColumns().forEach((test, index) => {
            const groupClass = boundaries.has(index) ? 'type-group-first' : '';
            html += `<td class="test-column add-row-cell ${groupClass}" data-test-id="${test.id}"></td>`;
        });

        // Empty cell for add button column
        html += `<td class="add-test-col"></td>`;

        tr.innerHTML = html;
        return tr;
    }
};
