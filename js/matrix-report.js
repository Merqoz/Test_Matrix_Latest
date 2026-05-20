/**
 * MATRIX-REPORT.JS — PDF / PPTX Report of All Test Activities
 *
 * Exports a polished report containing every test activity (and its
 * sub-activities), their description (overview + scope/notes bullets),
 * type, location, work pack, dates, and UID. Includes a Table of Contents.
 *
 * Theme/build approach mirrors flow-export.js so PDF and PPTX share the
 * same look (light/dark theme detection, type colour palette, table
 * formatting). Libraries (loaded as <script> tags from /js/lib/):
 *     html2canvas.min.js   → window.html2canvas (not used here, kept for parity)
 *     jspdf.umd.js         → window.jspdf
 *     pptxgen.bundle.js    → window.PptxGenJS
 */

const MatrixReport = {

    // ─────────────────────────────────────────────────────────────
    //  Public entry points
    // ─────────────────────────────────────────────────────────────

    async exportPDF() {
        if (!window.jspdf || !window.jspdf.jsPDF) {
            this._toast('PDF library not loaded — refresh the page and try again.', 'error');
            return;
        }
        try {
            this._showLoading(true, 'Building PDF report…');
            const data = this._collectData();
            if (data.activities.length === 0) {
                this._toast('No test activities to export.', 'warn');
                return;
            }
            await this._buildPDF(data);
            this._toast(`PDF report exported (${data.activities.length} activities)`, 'success');
        } catch (err) {
            console.error('PDF report export failed:', err);
            this._toast('PDF export failed: ' + err.message, 'error');
        } finally {
            this._showLoading(false);
        }
    },

    async exportPPTX() {
        if (!window.PptxGenJS) {
            this._toast('PowerPoint library not loaded — refresh the page and try again.', 'error');
            return;
        }
        try {
            this._showLoading(true, 'Building PowerPoint report…');
            const data = this._collectData();
            if (data.activities.length === 0) {
                this._toast('No test activities to export.', 'warn');
                return;
            }
            await this._buildPPTX(data);
            this._toast(`PowerPoint report exported (${data.activities.length} activities)`, 'success');
        } catch (err) {
            console.error('PPTX report export failed:', err);
            this._toast('PPTX export failed: ' + err.message, 'error');
        } finally {
            this._showLoading(false);
        }
    },

    // ─────────────────────────────────────────────────────────────
    //  Data collection
    // ─────────────────────────────────────────────────────────────

    _collectData() {
        const projectName = (DataModel.docNo || 'Test Matrix') + '';
        const docNo = DataModel.docNo || '';
        const projTitle = DataModel.projectName || projectName || 'Test Equipment Matrix';

        // Pull descriptions from flow storage (same source as activity-details.js)
        let descriptions = {};
        if (typeof StorageManager !== 'undefined' && StorageManager.loadFlow) {
            const f = StorageManager.loadFlow();
            descriptions = (f && f.descriptions) ? f.descriptions : {};
        }
        const getDesc = (id) => {
            const d = descriptions[id];
            if (!d) return { overview: '', bullets: '' };
            if (typeof d === 'string') return { overview: d, bullets: '' };
            return { overview: d.overview || '', bullets: d.bullets || '' };
        };

        // Collect equipment items used by a given test activity by walking all
        // sections/rows and keeping rows with a non-empty/non-zero testQty.
        // Returns an object keyed by section name so callers can pick out
        // "Main Equipment" only, or render the full set grouped by section.
        const getEquipmentBySection = (testId) => {
            const buckets = {};   // sectionName → [items]
            const order = [];     // preserve section order from DataModel
            (DataModel.sections || []).forEach(sec => {
                const matchingRows = (sec.rows || []).filter(row => {
                    const q = row.testQty ? row.testQty[testId] : '';
                    return !(q == null || q === '' || Number(q) === 0);
                });
                if (matchingRows.length === 0) return;
                const items = matchingRows.map(row => ({
                    section: sec.name || '',
                    itemNo:  row.itemNo || '',
                    partNo:  row.partNo || '',
                    description: row.description || '',
                    qty:     row.testQty[testId]
                }));
                buckets[sec.name] = items;
                order.push(sec.name);
            });
            return { order, buckets };
        };

        // Build a flat list — main activities; sub-activities are kept on
        // each main activity for the meta badge, but no longer rendered as
        // their own pages.
        const buildActivity = (t) => {
            const eq = getEquipmentBySection(t.id);
            // "Main Equipment" is the canonical first-page list; fall back to
            // the first available section if a project renamed it.
            const mainKey = eq.order.find(n => /main/i.test(n)) || eq.order[0] || null;
            return {
                id:        t.id,
                uid:       t.uid || '',
                name:      t.name || '(unnamed)',
                subtitle:  t.subtitle || '',     // Doc Nr.
                type:      t.type || '',
                location:  t.location || '',
                workpack:  t.workpack || '',
                startDate: t.startDate || '',
                endDate:   t.endDate || '',
                description: getDesc(t.id),
                equipmentBySection: eq,                          // { order, buckets }
                mainEquipment: mainKey ? eq.buckets[mainKey] : [],// items in "Main Equipment"
                mainSectionName: mainKey || 'Main Equipment'
            };
        };

        // ── Filter source list by FilterManager state ──
        // Honour:
        //   • DataModel.hiddenActivities (eye toggle)
        //   • FilterManager.activeFilters     (type chips: FAT/SIT/…)
        //   • FilterManager.activeWpFilters   (Work Pack chips)
        //   • FilterManager.activitySearchValue (name / Doc Nr search)
        // If FilterManager isn't loaded (e.g. tests / standalone), fall back
        // to everything.
        const fm = (typeof FilterManager !== 'undefined') ? FilterManager : null;
        const typeFilter = (fm && fm.activeFilters && fm.activeFilters.size) ? fm.activeFilters : null;
        const wpFilter   = (fm && fm.activeWpFilters && fm.activeWpFilters.size) ? fm.activeWpFilters : null;
        const search     = (fm && fm.activitySearchValue) ? fm.activitySearchValue.toLowerCase().trim() : '';

        const matchesFilters = (t) => {
            if (DataModel.hiddenActivities && DataModel.hiddenActivities.includes(t.id)) return false;
            if (typeFilter && !typeFilter.has(t.type)) return false;
            if (wpFilter && !wpFilter.has(t.workpack || '')) return false;
            if (search) {
                const nameOk  = (t.name || '').toLowerCase().includes(search);
                const docOk   = (t.subtitle || '').toLowerCase().includes(search);
                if (!nameOk && !docOk) return false;
            }
            return true;
        };

        const sourceColumns = (DataModel.testColumns || []).filter(matchesFilters);

        const activities = sourceColumns.map(t => {
            const main = buildActivity(t);
            // Filter sub-activities by the same rules — keeps the sub-count
            // badge in sync with what the user actually wants printed.
            const visibleSubs = (t.subActivities || []).filter(matchesFilters);
            main.subActivities = visibleSubs.map(s => buildActivity(s));
            return main;
        });

        return { projectName: projTitle, docNo, activities };
    },

    // ─────────────────────────────────────────────────────────────
    //  Theme — mirrors flow-export.js
    // ─────────────────────────────────────────────────────────────

    _getTheme() {
        const isLight = document.body.classList.contains('light-theme');
        return isLight ? {
            isLight: true,
            pageBg:       [255, 255, 255],
            tableBg:      [255, 255, 255],
            titleColor:   [15, 23, 42],
            subtitleColor:[37, 99, 235],
            accentColor:  [37, 99, 235],
            metaColor:    [100, 116, 139],
            dateColor:    [148, 163, 184],
            headingColor: [15, 23, 42],
            tableHdrBg:   [37, 99, 235],
            tableHdrTxt:  [255, 255, 255],
            rowAltBg:     [241, 245, 249],
            rowBorder:    [226, 232, 240],
            cellText:     [30, 41, 59],
            ruleColor:    [203, 213, 225],
            accentBar:    [37, 99, 235],
            bodyText:     [30, 41, 59],
            mutedText:    [100, 116, 139]
        } : {
            isLight: false,
            pageBg:       [10, 10, 18],
            tableBg:      [16, 16, 28],
            titleColor:   [255, 255, 255],
            subtitleColor:[0, 212, 255],
            accentColor:  [0, 212, 255],
            metaColor:    [136, 136, 136],
            dateColor:    [102, 102, 102],
            headingColor: [224, 228, 235],
            tableHdrBg:   [0, 212, 255],
            tableHdrTxt:  [10, 10, 18],
            rowAltBg:     [22, 22, 38],
            rowBorder:    [40, 40, 60],
            cellText:     [200, 205, 215],
            ruleColor:    [50, 50, 70],
            accentBar:    [0, 212, 255],
            bodyText:     [200, 205, 215],
            mutedText:    [136, 136, 136]
        };
    },

    // RGB tuples for activity-type accent — keep in sync with flow-export.js
    _typeColors: {
        'FAT':   [0, 212, 255],
        'EFAT':  [16, 185, 129],
        'FIT':   [139, 92, 246],
        'SIT':   [245, 158, 11],
        'M-SIT': [239, 68, 68],
        'SRT':   [236, 72, 153]
    },

    // ─────────────────────────────────────────────────────────────
    //  String safety / bullet parsing
    // ─────────────────────────────────────────────────────────────

    /**
     * Sanitize for jsPDF Helvetica (which can't render smart quotes,
     * en/em-dashes, or anything outside Latin-1).
     */
    _pdfSafe(str) {
        if (!str) return '';
        return String(str)
            .replace(/[\u2013\u2014]/g, '-')   // en-dash, em-dash → hyphen
            .replace(/[\u2018\u2019]/g, "'")    // smart single quotes
            .replace(/[\u201C\u201D]/g, '"')    // smart double quotes
            .replace(/\u2026/g, '...')          // ellipsis
            .replace(/[\u2022\u25AA\u25CF]/g, '\u00B7') // bullet, small/black square → middle dot (Latin-1, renders fine)
            .replace(/[\u2192\u279C\u27A1]/g, '->')      // right arrows → ASCII arrow
            .replace(/[\u2190]/g, '<-')                  // left arrow
            .replace(/[\u2194]/g, '<->')                 // double arrow
            .replace(/\uD83D[\uDCCD\uDCCC]/g, '')        // 📍 📌 — drop emoji marker, label text remains
            .replace(/\uD83D\uDD27/g, '')                // 🔧 wrench — drop, "WP" prefix is enough context
            .replace(/\uD83D\uDCC5/g, '')                // 📅 calendar — drop, "DATES" label is enough
            .replace(/\u2705/g, 'OK')                    // ✅
            .replace(/\u26A0/g, '!')                     // ⚠
            .replace(/\s{2,}/g, ' ')                     // collapse double spaces left by stripped emoji
            .trim()
            .replace(/[^\x00-\x7F]/g, ch => {
                const code = ch.charCodeAt(0);
                // Allow the full Latin-1 supplement (0xA0-0xFF) — Helvetica
                // renders all of it: middle dot ·, accented letters,
                // currency symbols, etc.
                return (code >= 0x00A0 && code <= 0x00FF) ? ch : '?';
            });
    },

    /**
     * Strip HTML tags (description editor stores rich-text), preserve line breaks.
     */
    _stripHTML(html) {
        if (!html) return '';
        return String(html)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|h\d)>/gi, '\n')
            .replace(/<li[^>]*>/gi, '• ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    },

    /**
     * Split the bullets field (may contain newlines or HTML) into a clean array.
     */
    _toBullets(str) {
        const text = this._stripHTML(str);
        if (!text) return [];
        return text.split(/\n+/)
            .map(line => line.replace(/^[•\-\*\u2022\s]+/, '').trim())
            .filter(line => line.length > 0);
    },

    // ─────────────────────────────────────────────────────────────
    //  Loading overlay + toast (re-uses overlay from flow-export style)
    // ─────────────────────────────────────────────────────────────

    _showLoading(show, message) {
        let overlay = document.getElementById('exportLoadingOverlay');
        if (show) {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'exportLoadingOverlay';
                overlay.innerHTML = `
                    <div class="export-loading-box">
                        <div class="export-spinner"></div>
                        <div class="export-loading-text">${message || 'Exporting…'}</div>
                    </div>`;
                document.body.appendChild(overlay);
            } else {
                const t = overlay.querySelector('.export-loading-text');
                if (t) t.textContent = message || 'Exporting…';
                overlay.style.display = '';
            }
        } else if (overlay) {
            overlay.style.display = 'none';
        }
    },

    _toast(msg, kind) {
        // Reuse ExportManager's toast if available
        if (typeof ExportManager !== 'undefined' && ExportManager._toast) {
            ExportManager._toast(msg, kind);
            return;
        }
        console.log('[Report]', msg);
    },

    _filename(ext) {
        const proj = (DataModel.projectName || DataModel.docNo || 'TestMatrix')
            .replace(/[^a-zA-Z0-9_-]/g, '_');
        const date = new Date().toISOString().slice(0, 10);
        return `${proj}_Activity_Report_${date}.${ext}`;
    },

    // ─────────────────────────────────────────────────────────────
    //  PDF builder — A4 landscape with two-column activity layout
    // ─────────────────────────────────────────────────────────────

    async _buildPDF(data) {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const T = this._getTheme();
        const safe = this._pdfSafe.bind(this);

        const pageW = pdf.internal.pageSize.getWidth();   // 297 (landscape A4)
        const pageH = pdf.internal.pageSize.getHeight();  // 210
        const margin = 14;
        const contentW = pageW - 2 * margin;

        // Helpers
        const fillBg  = (rgb) => { pdf.setFillColor(...rgb); pdf.rect(0, 0, pageW, pageH, 'F'); };
        const setText = (rgb) => pdf.setTextColor(...rgb);
        const setFill = (rgb) => pdf.setFillColor(...rgb);
        const setDraw = (rgb) => pdf.setDrawColor(...rgb);

        // ═══════════════════════════════════════════════════════
        //  PAGE 1 — Title (landscape)
        // ═══════════════════════════════════════════════════════
        fillBg(T.pageBg);

        // Accent bar — taller because page is shorter in landscape
        setFill(T.accentBar);
        pdf.rect(margin, 50, 4, 60, 'F');

        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(36);
        setText(T.titleColor);
        pdf.text(safe(data.projectName), margin + 12, 72);

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(20);
        setText(T.subtitleColor);
        pdf.text('Test Activity Report', margin + 12, 86);

        if (data.docNo) {
            pdf.setFontSize(13);
            setText(T.metaColor);
            pdf.text(`Document No.: ${safe(data.docNo)}`, margin + 12, 100);
        }

        pdf.setFontSize(11);
        setText(T.dateColor);
        pdf.text('Generated: ' + new Date().toLocaleString(), margin + 12, 108);

        const subTotal = data.activities.reduce((n, a) => n + a.subActivities.length, 0);
        pdf.setFontSize(12);
        setText(T.bodyText);
        pdf.text(
            `${data.activities.length} test activity(ies) — ${subTotal} sub-activity(ies)`,
            margin + 12, 120
        );

        // ═══════════════════════════════════════════════════════
        //  PAGE 2+ — Table of Contents (clickable)
        // ═══════════════════════════════════════════════════════
        // Plan: lay out activity pages first into a *position map*, THEN
        // render the TOC, so each TOC entry can call pdf.link() to jump
        // directly to the right page. We do this by deferring real page
        // rendering until after we've reserved the TOC pages.
        //
        // Approach: render the TOC text first (without page numbers), record
        // each entry's page+y for later, then render activity pages, then
        // do a final pass that overwrites the right-aligned page-number text
        // and creates clickable rectangles.

        pdf.addPage('a4', 'landscape');
        fillBg(T.pageBg);

        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(22);
        setText(T.headingColor);
        pdf.text('Table of Contents', margin, 22);

        setDraw(T.ruleColor);
        pdf.setLineWidth(0.3);
        pdf.line(margin, 26, pageW - margin, 26);

        const tocStartPage = pdf.internal.getNumberOfPages();
        let tocY = 36;
        const lineH = 7;
        const subLineH = 5.5;
        const tocEntries = []; // { kind, targetActivityId|null, page, y, leftX, rightX, label }

        const ensureTocSpace = (need = lineH) => {
            if (tocY + need > pageH - margin - 6) {
                pdf.addPage('a4', 'landscape');
                fillBg(T.pageBg);
                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(16);
                setText(T.headingColor);
                pdf.text('Table of Contents (cont.)', margin, 18);
                tocY = 28;
            }
        };

        // Entry 0 — link back to the title page
        ensureTocSpace(lineH);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(12);
        setText(T.bodyText);
        pdf.text('—', margin, tocY);
        pdf.text('Title Page', margin + 8, tocY);
        tocEntries.push({
            kind: 'title', targetActivityId: '__title__',
            page: pdf.internal.getNumberOfPages(), y: tocY,
            leftX: margin, rightX: pageW - margin
        });
        tocY += lineH;

        // Spacer + section heading
        ensureTocSpace(lineH);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(10);
        setText(T.metaColor);
        pdf.text('TEST ACTIVITIES', margin, tocY);
        tocY += lineH;

        // Activity entries
        data.activities.forEach((act, i) => {
            ensureTocSpace(lineH);
            const num = `${i + 1}.`;
            const typeColor = this._typeColors[act.type] || T.metaColor;

            // Number
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(11);
            setText(T.bodyText);
            pdf.text(num, margin, tocY);

            // Activity name (clickable line)
            pdf.text(safe(act.name), margin + 10, tocY);

            // Type chip
            if (act.type) {
                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(9);
                setText(typeColor);
                pdf.text(act.type, pageW - margin - 50, tocY);
            }

            // Doc Nr (right of type, left of page-number column)
            if (act.subtitle) {
                pdf.setFont('helvetica', 'italic');
                pdf.setFontSize(9);
                setText(T.metaColor);
                const docTxt = safe(act.subtitle);
                const dw = pdf.getTextWidth(docTxt);
                pdf.text(docTxt, pageW - margin - 18 - dw, tocY);
            }

            tocEntries.push({
                kind: 'main', targetActivityId: act.id,
                page: pdf.internal.getNumberOfPages(), y: tocY,
                leftX: margin, rightX: pageW - margin
            });
            tocY += lineH;

            // Sub-activity count hint (dim, not clickable — they no longer
            // have their own pages, just a badge on the parent's info page)
            if (act.subActivities && act.subActivities.length) {
                ensureTocSpace(subLineH);
                pdf.setFont('helvetica', 'italic');
                pdf.setFontSize(8.5);
                setText(T.mutedText);
                const n = act.subActivities.length;
                pdf.text(
                    `   includes ${n} sub-activit${n === 1 ? 'y' : 'ies'}`,
                    margin + 22, tocY
                );
                tocY += subLineH;
            }

            tocY += 2;
        });

        // ═══════════════════════════════════════════════════════
        //  Activity pages (landscape, 2-column layout)
        //  Each main activity gets:
        //    1. Info page (left: details / Overview / Scope ; right: Image + Main Equipment)
        //    2. Full equipment page (Main + Tooling + Auxiliary, grouped)
        //  Sub-activities are NOT rendered as their own pages — they appear
        //  as a count badge on the info page instead.
        // ═══════════════════════════════════════════════════════
        const pageNumberFor = { '__title__': 1 };

        data.activities.forEach((act, i) => {
            this._renderPdfActivityPage(pdf, act, `${i + 1}`, T, safe, margin, pageW, pageH);
            pageNumberFor[act.id] = pdf.internal.getNumberOfPages();

            // Full equipment page (every section)
            this._renderPdfEquipmentPage(pdf, act, `${i + 1}`, T, safe, margin, pageW, pageH);
        });

        // ═══════════════════════════════════════════════════════
        //  Second pass — write page numbers + clickable rectangles
        // ═══════════════════════════════════════════════════════
        tocEntries.forEach(entry => {
            const targetPage = pageNumberFor[entry.targetActivityId];
            if (targetPage == null) return;

            pdf.setPage(entry.page);

            // Page number, right-aligned
            const label = String(targetPage);
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(entry.kind === 'sub' ? 9 : 10);
            setText(entry.kind === 'main' ? T.accentColor :
                    entry.kind === 'title' ? T.subtitleColor : T.metaColor);
            const w = pdf.getTextWidth(label);
            pdf.text(label, entry.rightX - w, entry.y);

            // Clickable rectangle covering the full row
            const rowH = entry.kind === 'sub' ? 5 : 6.5;
            pdf.link(
                entry.leftX, entry.y - rowH + 1,
                entry.rightX - entry.leftX, rowH,
                { pageNumber: targetPage }
            );
        });

        // ═══════════════════════════════════════════════════════
        //  Footer (page x/y) — skip cover
        // ═══════════════════════════════════════════════════════
        const total = pdf.internal.getNumberOfPages();
        for (let p = 2; p <= total; p++) {
            pdf.setPage(p);
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            setText(T.mutedText);
            pdf.text(`${p} / ${total}`, pageW - margin, pageH - 6, { align: 'right' });
            pdf.text(safe(data.projectName), margin, pageH - 6);
        }

        pdf.save(this._filename('pdf'));
    },

    /**
     * Render a single test activity onto a new landscape page using the
     * two-column layout from the user's mockup:
     *
     *   ┌─────────────────────────────────┬───────────────────┐
     *   │  Title  [type chip]             │  Image            │
     *   │  [Doc Nr field]                 │  placeholder      │
     *   │  meta line • • •                ├───────────────────┤
     *   │                                 │  EQUIPMENT        │
     *   │  OVERVIEW                       │  N items          │
     *   │  …prose…                        │  ┌─────────────┐  │
     *   │                                 │  │ table       │  │
     *   │  SCOPE & NOTES                  │  └─────────────┘  │
     *   │  • bullets                      │                   │
     *   └─────────────────────────────────┴───────────────────┘
     */
    _renderPdfActivityPage(pdf, act, numberLabel, T, safe, margin, pageW, pageH) {
        const fillBg  = (rgb) => { pdf.setFillColor(...rgb); pdf.rect(0, 0, pageW, pageH, 'F'); };
        const setText = (rgb) => pdf.setTextColor(...rgb);
        const setFill = (rgb) => pdf.setFillColor(...rgb);
        const setDraw = (rgb) => pdf.setDrawColor(...rgb);

        pdf.addPage('a4', 'landscape');
        fillBg(T.pageBg);

        const typeColor = this._typeColors[act.type] || T.metaColor;
        const contentW  = pageW - 2 * margin;
        const gutter    = 8;
        const leftW     = Math.round(contentW * 0.60);
        const rightW    = contentW - leftW - gutter;
        const leftX     = margin;
        const rightX    = margin + leftW + gutter;
        const topY      = margin;
        const bottomY   = pageH - margin - 6;       // leave room for footer

        // ═══════════════════════════════════════════════════════
        //  HEADER BAND — runs the full page width
        // ═══════════════════════════════════════════════════════
        // Soft tinted card containing title, type chip, Doc Nr, meta line,
        // and the sub-activity badge. Establishes a clear visual block at
        // the top before the body splits into two columns.
        const subCount = (act.subActivities || []).length;
        const headerH = subCount > 0 ? 38 : 32;

        // Header background card
        setFill(T.rowAltBg);
        setDraw(T.rowBorder); pdf.setLineWidth(0.4);
        pdf.roundedRect(leftX, topY, contentW, headerH, 2, 2, 'FD');

        // Type-coloured accent strip on the left edge of the header
        setFill(typeColor);
        pdf.rect(leftX, topY, 4, headerH, 'F');

        const innerX = leftX + 10;
        const innerW = contentW - 14;
        const chipW  = 28;   // reserved width for type chip on the right

        // Type chip — top-right of the header band
        if (act.type) {
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(11);
            const w = pdf.getTextWidth(act.type) + 10;
            setFill(typeColor);
            pdf.roundedRect(leftX + contentW - w - 6, topY + 5, w, 8, 2, 2, 'F');
            setText(T.pageBg);
            pdf.text(act.type, leftX + contentW - w / 2 - 6, topY + 10.5, { align: 'center' });
        }

        // Activity number + name (truncated to leave space for chip)
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(20);
        setText(T.titleColor);
        const titleMaxW = innerW - chipW - 6;
        const titleLines = pdf.splitTextToSize(safe(act.name), titleMaxW);
        let title = titleLines[0] || '';
        if (titleLines.length > 1) title = title.replace(/\s*\S*$/, '') + ' …';
        pdf.text(`${numberLabel}  ${title}`, innerX, topY + 11);

        // Doc Nr inline pill — directly under the title
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(9);
        setText(T.subtitleColor);
        pdf.text('DOC NR.', innerX, topY + 19);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(11);
        setText(T.bodyText);
        pdf.text(safe(act.subtitle || '(none)'), innerX + 16, topY + 19);

        // Dates — to the right of Doc Nr on the same line
        if (act.startDate || act.endDate) {
            const dates = [act.startDate, act.endDate].filter(Boolean).join(' → ');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9);
            setText(T.subtitleColor);
            const docNrLabel = safe(act.subtitle || '(none)');
            const offset = innerX + 16 + pdf.getTextWidth(docNrLabel) + 12;
            pdf.text('DATES', offset, topY + 19);
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(11);
            setText(T.bodyText);
            pdf.text(safe(dates), offset + 14, topY + 19);
        }

        // Meta line — Location · Workpack · UID
        const metaParts = [];
        if (act.location) metaParts.push('📍 ' + act.location);
        if (act.workpack) metaParts.push('🔧 ' + act.workpack);
        if (act.uid)      metaParts.push('UID: ' + act.uid);
        if (metaParts.length) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(9.5);
            setText(T.metaColor);
            // _pdfSafe strips the leading emoji + space, leaving clean
            // labels separated by middle-dots. Result:
            //   "Norway, Sandnessjøen · WP03 · UID: test-08"
            const metaLine = metaParts.join('   •   ');
            pdf.text(safe(metaLine), innerX, topY + 26);
        }

        // Sub-activity badge — bottom of header
        if (subCount > 0) {
            const badgeY = topY + 30;
            const badgeText = `${subCount} sub-activit${subCount === 1 ? 'y' : 'ies'}`;
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9);
            const bw = pdf.getTextWidth(badgeText) + 8;
            const bh = 5.5;
            setFill(typeColor);
            pdf.roundedRect(innerX, badgeY, bw, bh, 1.5, 1.5, 'F');
            setText(T.pageBg);
            pdf.text(badgeText, innerX + bw / 2, badgeY + 4, { align: 'center' });

            // Names of the sub-activities, italic, truncated
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(9);
            setText(T.metaColor);
            const names = act.subActivities.map(s => safe(s.name)).join(' • ');
            const fitted = pdf.splitTextToSize(names, innerW - bw - 8)[0] || '';
            const trimmed = fitted.length < names.length;
            pdf.text(fitted + (trimmed ? ' …' : ''), innerX + bw + 4, badgeY + 4);
        }

        // ═══════════════════════════════════════════════════════
        //  BODY — two columns sharing the same Y baselines
        // ═══════════════════════════════════════════════════════
        const bodyTop    = topY + headerH + 6;
        const bodyBottom = bottomY;
        const bodyH      = bodyBottom - bodyTop;

        // Section labels (small uppercase headers above each box)
        const labelH = 6;
        const sectionLabel = (label, x, y, width) => {
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(9);
            setText(T.metaColor);
            pdf.text(label.toUpperCase(), x, y);
            setDraw(T.ruleColor); pdf.setLineWidth(0.3);
            pdf.line(x, y + 1.5, x + width, y + 1.5);
        };

        // Allocate vertical space:
        //  Row 1 (top): Overview ↔ Image  — same Y, same height
        //  Row 2 (bot): Scope & Notes ↔ Main Equipment — same Y, same height
        // Image keeps a fixed aspect ratio (square-ish) and the Overview
        // matches its height for clean alignment.
        const interRowGap = 8;
        const imgH = Math.min(rightW, Math.round(bodyH * 0.45));
        const topBoxH = imgH;
        const bottomBoxH = bodyH - topBoxH - interRowGap - 2 * labelH;

        // ── Row 1 left: Overview ──
        const ovLabelY = bodyTop;
        sectionLabel('Overview', leftX, ovLabelY + 4, leftW);
        const ovBoxY = ovLabelY + labelH;
        setFill(T.rowAltBg);
        setDraw(T.rowBorder); pdf.setLineWidth(0.3);
        pdf.roundedRect(leftX, ovBoxY, leftW, topBoxH, 1.5, 1.5, 'FD');

        const overview = this._stripHTML(act.description.overview);
        if (overview) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10.5);
            setText(T.bodyText);
            const lines = pdf.splitTextToSize(safe(overview), leftW - 6);
            const maxLines = Math.floor((topBoxH - 4) / 5);
            const shown = lines.slice(0, maxLines);
            const trimmedOv = lines.length > shown.length;
            shown.forEach((ln, idx) => {
                let txt = ln;
                if (trimmedOv && idx === shown.length - 1) txt = txt.replace(/\s*\S*$/, '') + ' …';
                pdf.text(txt, leftX + 3, ovBoxY + 6 + idx * 5);
            });
        } else {
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(10);
            setText(T.mutedText);
            pdf.text('(no overview)', leftX + 3, ovBoxY + 7);
        }

        // ── Row 1 right: Image placeholder (top-aligned with Overview box) ──
        const imgY = ovBoxY;     // align top with overview body, not its label
        setFill(T.tableBg);
        setDraw(T.rowBorder); pdf.setLineWidth(0.4);
        pdf.roundedRect(rightX, imgY, rightW, imgH, 2, 2, 'FD');

        // "Image" label centred
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(20);
        setText(T.mutedText);
        pdf.text('Image', rightX + rightW / 2, imgY + imgH / 2 + 3, { align: 'center' });
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7);
        pdf.text('(no image attached)', rightX + rightW / 2, imgY + imgH / 2 + 11, { align: 'center' });

        // ── Row 2 left: Scope & Notes ──
        const scLabelY = ovBoxY + topBoxH + interRowGap;
        sectionLabel('Scope & Notes', leftX, scLabelY + 4, leftW);
        const scBoxY = scLabelY + labelH;
        const scBoxH = bottomBoxH;
        setFill(T.rowAltBg);
        setDraw(T.rowBorder); pdf.setLineWidth(0.3);
        pdf.roundedRect(leftX, scBoxY, leftW, scBoxH, 1.5, 1.5, 'FD');

        const bullets = this._toBullets(act.description.bullets);
        if (bullets.length) {
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10);
            let by = scBoxY + 6;
            const maxY = scBoxY + scBoxH - 3;
            for (const b of bullets) {
                if (by > maxY - 4) break;
                const lines = pdf.splitTextToSize(safe(b), leftW - 10);
                lines.forEach((ln, li) => {
                    if (by > maxY) return;
                    if (li === 0) {
                        setText(T.accentColor);
                        pdf.text('•', leftX + 3, by);
                    }
                    setText(T.bodyText);
                    pdf.text(ln, leftX + 8, by);
                    by += 5;
                });
                by += 1;
            }
        } else {
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(10);
            setText(T.mutedText);
            pdf.text('(no scope or notes)', leftX + 3, scBoxY + 7);
        }

        // ── Row 2 right: Main Equipment (top-aligned with Scope label) ──
        const eqLabelY = scLabelY;
        const eqBoxTop = scBoxY;       // exact same Y as scope box
        const eqBoxH   = scBoxH;       // exact same height as scope box

        // Header label + count, on the same baseline as "SCOPE & NOTES"
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(9);
        setText(T.metaColor);
        pdf.text('MAIN EQUIPMENT', rightX, eqLabelY + 4);
        const mainEq = act.mainEquipment || [];
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8);
        setText(T.metaColor);
        const cnt = `${mainEq.length} item${mainEq.length === 1 ? '' : 's'} • full list overleaf`;
        const cntW = pdf.getTextWidth(cnt);
        pdf.text(cnt, rightX + rightW - cntW, eqLabelY + 4);
        setDraw(T.ruleColor); pdf.setLineWidth(0.3);
        pdf.line(rightX, eqLabelY + 5.5, rightX + rightW, eqLabelY + 5.5);

        // Equipment table — fits inside eqBoxH
        const colW = [
            Math.round(rightW * 0.20),
            Math.round(rightW * 0.20),
            Math.round(rightW * 0.48),
            rightW - Math.round(rightW * 0.20) - Math.round(rightW * 0.20) - Math.round(rightW * 0.48)
        ];
        const headers = ['ITEM #', 'PART NO.', 'DESCRIPTION', 'QTY'];

        let rY = eqBoxTop;
        const hdrH = 7;
        setFill(T.tableHdrBg);
        pdf.rect(rightX, rY, rightW, hdrH, 'F');
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        setText(T.tableHdrTxt);
        let cx = rightX + 2;
        headers.forEach((h, i) => {
            const align = i === 3 ? 'right' : 'left';
            const tx = align === 'right' ? cx + colW[i] - 4 : cx;
            pdf.text(h, tx, rY + 4.8, { align });
            cx += colW[i];
        });
        rY += hdrH;

        const rowH = 6.5;
        const maxRowY = eqBoxTop + eqBoxH - 2;
        const fittingRows = Math.max(0, Math.floor((maxRowY - rY) / rowH));
        const visibleEq = mainEq.slice(0, fittingRows);
        const hidden = mainEq.length - visibleEq.length;

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8);
        visibleEq.forEach((row, idx) => {
            if (idx % 2 === 1) {
                setFill(T.rowAltBg);
                pdf.rect(rightX, rY, rightW, rowH, 'F');
            }
            const cells = [
                { text: safe(row.itemNo) || '-', color: T.mutedText },
                { text: safe(row.partNo) || '-', color: T.bodyText },
                { text: safe(row.description), color: T.bodyText, wrap: true },
                { text: String(row.qty), color: T.bodyText, align: 'right' }
            ];
            let x = rightX + 2;
            cells.forEach((c, i) => {
                pdf.setFont('helvetica', 'normal');
                setText(c.color);
                let txt = c.text;
                if (c.wrap) {
                    const fitted = pdf.splitTextToSize(txt, colW[i] - 4);
                    txt = fitted[0] + (fitted.length > 1 ? '…' : '');
                }
                const align = c.align || 'left';
                const tx = align === 'right' ? x + colW[i] - 4 : x;
                pdf.text(txt, tx, rY + 4.4, { align });
                x += colW[i];
            });
            rY += rowH;
        });

        if (mainEq.length === 0) {
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(9);
            setText(T.mutedText);
            pdf.text('No main equipment assigned', rightX + 4, rY + 5);
        } else if (hidden > 0) {
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(8);
            setText(T.mutedText);
            pdf.text(`+ ${hidden} more on full equipment list`, rightX + 4, rY + 5);
        }
    },

    /**
     * Render a full equipment list page for one main activity, broken
     * out by section (Main Equipment, Tooling Items, Auxiliary, …).
     * Lands immediately after the activity's info page.
     */
    _renderPdfEquipmentPage(pdf, act, numberLabel, T, safe, margin, pageW, pageH) {
        const fillBg  = (rgb) => { pdf.setFillColor(...rgb); pdf.rect(0, 0, pageW, pageH, 'F'); };
        const setText = (rgb) => pdf.setTextColor(...rgb);
        const setFill = (rgb) => pdf.setFillColor(...rgb);
        const setDraw = (rgb) => pdf.setDrawColor(...rgb);

        pdf.addPage('a4', 'landscape');
        fillBg(T.pageBg);

        const typeColor = this._typeColors[act.type] || T.metaColor;
        const contentW  = pageW - 2 * margin;
        const topY      = margin;
        const bottomY   = pageH - margin - 6;

        // ═══════════════════════════════════════════════════════
        //  HEADER BAND — matches the info page exactly
        // ═══════════════════════════════════════════════════════
        const headerH = 24;     // shorter than info page (no sub-activity row)

        // Header background card
        setFill(T.rowAltBg);
        setDraw(T.rowBorder); pdf.setLineWidth(0.4);
        pdf.roundedRect(margin, topY, contentW, headerH, 2, 2, 'FD');

        // Type-coloured accent strip on the left edge
        setFill(typeColor);
        pdf.rect(margin, topY, 4, headerH, 'F');

        const innerX = margin + 10;
        const chipW  = 28;

        // Type chip — top-right of header band
        if (act.type) {
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(11);
            const w = pdf.getTextWidth(act.type) + 10;
            setFill(typeColor);
            pdf.roundedRect(margin + contentW - w - 6, topY + 5, w, 8, 2, 2, 'F');
            setText(T.pageBg);
            pdf.text(act.type, margin + contentW - w / 2 - 6, topY + 10.5, { align: 'center' });
        }

        // Activity number + name — same typographic rhythm as info page
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(18);
        setText(T.titleColor);
        const titleMaxW = contentW - chipW - 30;
        const titleLines = pdf.splitTextToSize(safe(act.name), titleMaxW);
        let title = titleLines[0] || '';
        if (titleLines.length > 1) title = title.replace(/\s*\S*$/, '') + ' …';
        pdf.text(`${numberLabel}  ${title} — Equipment List`, innerX, topY + 11);

        // Sub-line — Doc Nr + counts, matching the info page label/value style
        let totalItems = 0;
        act.equipmentBySection.order.forEach(name => {
            totalItems += (act.equipmentBySection.buckets[name] || []).length;
        });
        const subParts = [];
        if (act.subtitle) subParts.push(`DOC NR. ${act.subtitle}`);
        subParts.push(`${totalItems} item${totalItems === 1 ? '' : 's'}`);
        subParts.push(`${act.equipmentBySection.order.length} section${act.equipmentBySection.order.length === 1 ? '' : 's'}`);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10);
        setText(T.metaColor);
        pdf.text(safe(subParts.join('   •   ')), innerX, topY + 19);

        // ── If no equipment at all ──
        if (totalItems === 0) {
            pdf.setFont('helvetica', 'italic');
            pdf.setFontSize(12);
            setText(T.mutedText);
            pdf.text(
                'No equipment assigned to this activity in any section.',
                pageW / 2, topY + 70,
                { align: 'center' }
            );
            return;
        }

        // ═══════════════════════════════════════════════════════
        //  BODY — column count adapts to actual content height
        //
        //  Decide between 1 centered column vs 2 columns based on
        //  whether everything *fits* in one column on this page:
        //
        //   • Total content height ≤ one-column-height → 1 column, centered.
        //     (Avoids leaving the right half of the page blank when 2 short
        //     sections both fit on the left.)
        //   • Otherwise → 2 columns, column-major flow.
        // ═══════════════════════════════════════════════════════
        const tableStartY = topY + headerH + 6;
        const availH = bottomY - tableStartY;

        // Pre-measure: each section needs banner (8mm) + header (6.5mm)
        // + N rows (6mm each) + 5mm gap between sections.
        const SECTION_BANNER_H = 8;
        const TABLE_HEADER_H   = 6.5;
        const ROW_H            = 6;
        const SECTION_GAP      = 5;
        let estimatedTotalH = 0;
        act.equipmentBySection.order.forEach((name, idx) => {
            const items = act.equipmentBySection.buckets[name] || [];
            estimatedTotalH += SECTION_BANNER_H + TABLE_HEADER_H + items.length * ROW_H;
            if (idx < act.equipmentBySection.order.length - 1) estimatedTotalH += SECTION_GAP;
        });

        const fitsInOneColumn = estimatedTotalH <= availH;
        const colCount = fitsInOneColumn ? 1 : 2;
        const colGutter = 8;
        let colW, leftEdge;
        if (colCount === 1) {
            // Center a comfortably-wide single column on the page.
            colW = Math.round(contentW * 0.60);
            leftEdge = margin + (contentW - colW) / 2;
        } else {
            colW = (contentW - colGutter * (colCount - 1)) / colCount;
            leftEdge = margin;
        }
        let curCol = 0;
        let curY = tableStartY;

        const colXFor = (idx) => leftEdge + idx * (colW + colGutter);

        // Helper to draw a continuation page header (same band style)
        const drawContinuationHeader = () => {
            setFill(T.rowAltBg);
            setDraw(T.rowBorder); pdf.setLineWidth(0.4);
            const contH = 14;
            pdf.roundedRect(margin, topY, contentW, contH, 2, 2, 'FD');
            setFill(typeColor);
            pdf.rect(margin, topY, 4, contH, 'F');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(13);
            setText(T.titleColor);
            pdf.text(
                `${numberLabel}  ${safe(act.name)} — Equipment List (cont.)`,
                innerX, topY + 9
            );
        };

        const ensureSpace = (need) => {
            if (curY + need > bottomY) {
                if (curCol < colCount - 1) {
                    curCol++;
                    curY = tableStartY;
                } else {
                    pdf.addPage('a4', 'landscape');
                    fillBg(T.pageBg);
                    drawContinuationHeader();
                    curCol = 0;
                    curY = topY + 22;
                }
            }
        };

        const drawSection = (sectionName, items) => {
            ensureSpace(14);
            const xCol = colXFor(curCol);

            // Section banner — full column width, tinted by section type
            setFill(this._sectionTint(sectionName, T));
            pdf.roundedRect(xCol, curY, colW, 8, 1.5, 1.5, 'F');
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(10);
            setText(T.tableHdrTxt);
            pdf.text(safe(sectionName.toUpperCase()), xCol + 4, curY + 5.5);
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            const cnt = `${items.length} item${items.length === 1 ? '' : 's'}`;
            const cw = pdf.getTextWidth(cnt);
            pdf.text(cnt, xCol + colW - cw - 4, curY + 5.5);
            curY += 9;

            // Column widths — narrower QTY, wider description
            const cw1 = Math.round(colW * 0.16);
            const cw2 = Math.round(colW * 0.18);
            const cw4 = Math.round(colW * 0.10);
            const cw3 = colW - cw1 - cw2 - cw4;
            const headers = ['ITEM #', 'PART NO.', 'DESCRIPTION', 'QTY'];
            const widths  = [cw1, cw2, cw3, cw4];

            const drawHeaderRow = () => {
                const x = colXFor(curCol);
                setFill(T.tableHdrBg);
                pdf.rect(x, curY, colW, 6.5, 'F');
                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(7.5);
                setText(T.tableHdrTxt);
                let hx = x + 2;
                headers.forEach((h, i) => {
                    const align = i === 3 ? 'right' : 'left';
                    const tx = align === 'right' ? hx + widths[i] - 4 : hx;
                    pdf.text(h, tx, curY + 4.5, { align });
                    hx += widths[i];
                });
                curY += 6.5;
            };
            drawHeaderRow();

            const rowH = 6;
            for (let idx = 0; idx < items.length; idx++) {
                if (curY + rowH > bottomY) {
                    if (curCol < colCount - 1) {
                        curCol++;
                        curY = tableStartY;
                    } else {
                        pdf.addPage('a4', 'landscape');
                        fillBg(T.pageBg);
                        drawContinuationHeader();
                        curCol = 0;
                        curY = topY + 22;
                    }
                    pdf.setFont('helvetica', 'italic');
                    pdf.setFontSize(8);
                    setText(T.mutedText);
                    pdf.text(
                        `${safe(sectionName)} (continued)`,
                        colXFor(curCol), curY + 4
                    );
                    curY += 6;
                    drawHeaderRow();
                }
                const row = items[idx];
                if (idx % 2 === 1) {
                    setFill(T.rowAltBg);
                    pdf.rect(colXFor(curCol), curY, colW, rowH, 'F');
                }
                pdf.setFont('helvetica', 'normal');
                pdf.setFontSize(7.5);
                const cells = [
                    { text: safe(row.itemNo) || '-', color: T.mutedText, align: 'left' },
                    { text: safe(row.partNo) || '-', color: T.bodyText,  align: 'left' },
                    { text: safe(row.description),   color: T.bodyText,  align: 'left', wrap: true },
                    { text: String(row.qty),         color: T.bodyText,  align: 'right' }
                ];
                let x = colXFor(curCol) + 2;
                cells.forEach((c, i) => {
                    setText(c.color);
                    let txt = c.text;
                    if (c.wrap) {
                        const fitted = pdf.splitTextToSize(txt, widths[i] - 3);
                        txt = fitted[0] + (fitted.length > 1 ? '…' : '');
                    }
                    const tx = c.align === 'right' ? x + widths[i] - 4 : x;
                    pdf.text(txt, tx, curY + 4, { align: c.align });
                    x += widths[i];
                });
                curY += rowH;
            }
            curY += 5; // gap between sections
        };

        // Walk every section in original DataModel order
        act.equipmentBySection.order.forEach(name => {
            drawSection(name, act.equipmentBySection.buckets[name] || []);
        });
    },

    /** Pick a tinted fill colour for an equipment-section label bar. */
    _sectionTint(sectionName, T) {
        const n = (sectionName || '').toLowerCase();
        if (n.includes('main'))                       return [37, 99, 235];   // blue
        if (n.includes('tool'))                       return [16, 185, 129];  // green
        if (n.includes('aux') || n.includes('misc'))  return [245, 158, 11];  // amber
        return T.accentBar;
    },
    // ─────────────────────────────────────────────────────────────
    //  PPTX builder
    // ─────────────────────────────────────────────────────────────

    async _buildPPTX(data) {
        const pptx = new PptxGenJS();
        pptx.layout = 'LAYOUT_WIDE';   // 13.33 × 7.5 in
        pptx.author = 'Test Equipment Matrix';
        pptx.title  = `${data.projectName} — Activity Report`;

        const T = this._getTheme();
        const hex = (rgb) => rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
        const bg = hex(T.pageBg);

        // Master slide w/ background + footer
        pptx.defineSlideMaster({
            title: 'REPORT_MASTER',
            background: { color: bg },
            objects: [
                { line: {
                    x: 0.4, y: 7.1, w: 12.5, h: 0,
                    line: { color: hex(T.ruleColor), width: 0.5 }
                }},
                { text: {
                    text: data.projectName,
                    options: { x: 0.4, y: 7.15, w: 8, h: 0.3,
                               fontSize: 9, color: hex(T.mutedText), fontFace: 'Calibri' }
                }}
            ],
            slideNumber: { x: 12.7, y: 7.15, w: 0.5, h: 0.3,
                           color: hex(T.mutedText), fontSize: 9, align: 'right' }
        });

        // ═══════════════════ SLIDE 1 — Title ═══════════════════
        const s1 = pptx.addSlide({ masterName: 'REPORT_MASTER' });
        s1.addShape(pptx.ShapeType.rect, {
            x: 0.5, y: 2.5, w: 0.08, h: 2.5,
            fill: { color: hex(T.accentBar) }, line: { color: hex(T.accentBar) }
        });
        s1.addText(data.projectName, {
            x: 0.8, y: 2.5, w: 11.5, h: 1.0,
            fontSize: 44, bold: true, color: hex(T.titleColor), fontFace: 'Calibri'
        });
        s1.addText('Test Activity Report', {
            x: 0.8, y: 3.6, w: 11.5, h: 0.6,
            fontSize: 24, color: hex(T.subtitleColor), fontFace: 'Calibri'
        });
        if (data.docNo) {
            s1.addText(`Document No.: ${data.docNo}`, {
                x: 0.8, y: 4.3, w: 11.5, h: 0.4,
                fontSize: 14, color: hex(T.metaColor), fontFace: 'Calibri'
            });
        }
        s1.addText('Generated: ' + new Date().toLocaleString(), {
            x: 0.8, y: 4.7, w: 11.5, h: 0.4,
            fontSize: 11, color: hex(T.dateColor), fontFace: 'Calibri'
        });
        const subTotal = data.activities.reduce((n, a) => n + a.subActivities.length, 0);
        s1.addText(`${data.activities.length} test activity(ies) — ${subTotal} sub-activity(ies)`, {
            x: 0.8, y: 5.1, w: 11.5, h: 0.4,
            fontSize: 13, color: hex(T.bodyText), fontFace: 'Calibri'
        });

        // ═══════════════════ SLIDE 2 — Table of Contents ═══════════════════
        // Split TOC across multiple slides if long. Sub-activities are summarized
        // as a count next to the parent (no own row).
        const tocRows = [];
        data.activities.forEach((act, i) => {
            const subN = (act.subActivities || []).length;
            const subBadge = subN > 0
                ? `  +${subN} sub`
                : '';
            tocRows.push({
                kind: 'main', num: `${i + 1}.`, name: act.name + subBadge,
                type: act.type, subtitle: act.subtitle
            });
        });

        const TOC_PER_SLIDE = 22;
        for (let off = 0; off < tocRows.length; off += TOC_PER_SLIDE) {
            const chunk = tocRows.slice(off, off + TOC_PER_SLIDE);
            const sToc = pptx.addSlide({ masterName: 'REPORT_MASTER' });
            sToc.addText(off === 0 ? 'Table of Contents' : 'Table of Contents (cont.)', {
                x: 0.5, y: 0.4, w: 12.3, h: 0.7,
                fontSize: 28, bold: true, color: hex(T.headingColor), fontFace: 'Calibri'
            });
            sToc.addShape(pptx.ShapeType.line, {
                x: 0.5, y: 1.05, w: 12.3, h: 0,
                line: { color: hex(T.ruleColor), width: 1 }
            });

            const rowsForTable = chunk.map(r => {
                const tColor = this._typeColors[r.type] || T.metaColor;
                const isSub = r.kind === 'sub';
                return [
                    { text: r.num, options: { color: hex(T.bodyText),
                          fontSize: isSub ? 10 : 12, bold: !isSub } },
                    { text: r.name, options: { color: isSub ? hex(T.mutedText) : hex(T.bodyText),
                          fontSize: isSub ? 11 : 13, bold: !isSub, fontFace: 'Calibri' } },
                    { text: r.type || '', options: { color: hex(tColor),
                          fontSize: isSub ? 9 : 11, bold: true, align: 'center' } },
                    { text: r.subtitle || '', options: { color: hex(T.mutedText),
                          fontSize: 10, italic: true, align: 'right' } }
                ];
            });
            sToc.addTable(rowsForTable, {
                x: 0.5, y: 1.2, w: 12.3,
                colW: [0.7, 8.0, 1.3, 2.3],
                border: { type: 'none' },
                rowH: 0.27
            });
        }

        // ═══════════════════ SLIDES 3+ — Per main activity ═══════════════════
        // Each main activity contributes:
        //   1. Info slide (title, Doc Nr, meta, sub-count badge, Overview,
        //      Scope, Image placeholder, MAIN equipment only)
        //   2. Full equipment slide (every section)
        data.activities.forEach((act, i) => {
            this._renderPptxActivitySlide(pptx, act, `${i + 1}`, T, hex);
            this._renderPptxEquipmentSlide(pptx, act, `${i + 1}`, T, hex);
        });

        await pptx.writeFile({ fileName: this._filename('pptx') });
    },

    /**
     * Render a single activity slide using the same restructured layout as
     * the PDF: a full-width header band (title, type chip, Doc Nr, dates,
     * meta, sub-activity badge) followed by a body whose two columns share
     * the same Y baselines (Overview ↔ Image, Scope & Notes ↔ Main Eq.).
     */
    _renderPptxActivitySlide(pptx, act, numberLabel, T, hex) {
        const slide = pptx.addSlide({ masterName: 'REPORT_MASTER' });
        const typeColor = this._typeColors[act.type] || T.metaColor;

        // Layout (LAYOUT_WIDE = 13.33 × 7.5 in)
        const SLIDE_W = 13.33;
        const margin  = 0.5;
        const contentW = SLIDE_W - 2 * margin;     // 12.33
        const gutter   = 0.25;
        const leftW    = 7.6;
        const rightW   = contentW - leftW - gutter;
        const leftX    = margin;
        const rightX   = margin + leftW + gutter;

        const subCount = (act.subActivities || []).length;

        // ═══════════════════════════════════════════════════════
        //  HEADER BAND — runs the full slide width
        // ═══════════════════════════════════════════════════════
        const headerY = 0.4;
        const headerH = subCount > 0 ? 1.5 : 1.25;

        // Header background card
        slide.addShape(pptx.ShapeType.roundRect, {
            x: leftX, y: headerY, w: contentW, h: headerH,
            fill: { color: hex(T.rowAltBg) },
            line: { color: hex(T.rowBorder), width: 0.5 },
            rectRadius: 0.06
        });
        // Type-coloured accent strip on the left edge
        slide.addShape(pptx.ShapeType.rect, {
            x: leftX, y: headerY, w: 0.08, h: headerH,
            fill: { color: hex(typeColor) }, line: { color: hex(typeColor) }
        });

        const innerX = leftX + 0.25;
        const chipW  = 1.1;

        // Type chip — top-right of the header band
        if (act.type) {
            slide.addShape(pptx.ShapeType.roundRect, {
                x: leftX + contentW - chipW - 0.2, y: headerY + 0.18, w: chipW, h: 0.45,
                fill: { color: hex(typeColor) }, line: { color: hex(typeColor) },
                rectRadius: 0.08
            });
            slide.addText(act.type, {
                x: leftX + contentW - chipW - 0.2, y: headerY + 0.18, w: chipW, h: 0.45,
                fontSize: 14, bold: true, color: hex(T.pageBg),
                align: 'center', valign: 'middle', fontFace: 'Calibri'
            });
        }

        // Title — number + name (truncates safely thanks to text-box clipping)
        slide.addText(`${numberLabel}  ${act.name}`, {
            x: innerX, y: headerY + 0.1, w: contentW - chipW - 0.5, h: 0.55,
            fontSize: 22, bold: true, color: hex(T.titleColor), fontFace: 'Calibri',
            valign: 'middle'
        });

        // Doc Nr + Dates row
        slide.addText([
            { text: 'DOC NR. ', options: { bold: true, color: hex(T.subtitleColor), fontSize: 11 } },
            { text: act.subtitle || '(none)', options: { color: hex(T.bodyText), fontSize: 12 } },
            ...((act.startDate || act.endDate) ? [
                { text: '     DATES ', options: { bold: true, color: hex(T.subtitleColor), fontSize: 11 } },
                { text: [act.startDate, act.endDate].filter(Boolean).join(' → '),
                  options: { color: hex(T.bodyText), fontSize: 12 } }
            ] : [])
        ], {
            x: innerX, y: headerY + 0.65, w: contentW - 0.5, h: 0.32,
            fontFace: 'Calibri', valign: 'middle'
        });

        // Meta line — Location · Workpack · UID
        const metaParts = [];
        if (act.location) metaParts.push(act.location);
        if (act.workpack) metaParts.push(act.workpack);
        if (act.uid)      metaParts.push('UID: ' + act.uid);
        if (metaParts.length) {
            slide.addText(metaParts.join('   •   '), {
                x: innerX, y: headerY + 0.95, w: contentW - 0.5, h: 0.3,
                fontSize: 11, color: hex(T.metaColor), fontFace: 'Calibri'
            });
        }

        // Sub-activity badge — bottom of header
        if (subCount > 0) {
            const badgeText = `${subCount} sub-activit${subCount === 1 ? 'y' : 'ies'}`;
            slide.addShape(pptx.ShapeType.roundRect, {
                x: innerX, y: headerY + 1.25, w: 1.5, h: 0.32,
                fill: { color: hex(typeColor) }, line: { color: hex(typeColor) },
                rectRadius: 0.05
            });
            slide.addText(badgeText, {
                x: innerX, y: headerY + 1.25, w: 1.5, h: 0.32,
                fontSize: 10, bold: true, color: hex(T.pageBg),
                align: 'center', valign: 'middle', fontFace: 'Calibri'
            });
            const names = act.subActivities.map(s => s.name).join('   •   ');
            slide.addText(names, {
                x: innerX + 1.65, y: headerY + 1.25, w: contentW - 2.0, h: 0.32,
                fontSize: 10, italic: true, color: hex(T.metaColor),
                fontFace: 'Calibri', valign: 'middle'
            });
        }

        // ═══════════════════════════════════════════════════════
        //  BODY — two columns sharing the same Y baselines
        // ═══════════════════════════════════════════════════════
        const bodyTop    = headerY + headerH + 0.25;
        const bodyBottom = 7.0;
        const bodyH      = bodyBottom - bodyTop;
        const labelH     = 0.35;
        const interRowGap = 0.25;

        // Image is square-ish; Overview matches its height for clean alignment
        const imgH = Math.min(rightW, bodyH * 0.45);
        const topBoxH    = imgH;
        const bottomBoxH = bodyH - topBoxH - interRowGap - 2 * labelH;

        // ── Row 1 left: Overview ──
        const ovLabelY = bodyTop;
        slide.addText('OVERVIEW', {
            x: leftX, y: ovLabelY, w: leftW, h: labelH,
            fontSize: 10, bold: true, color: hex(T.metaColor),
            fontFace: 'Calibri', charSpacing: 1
        });
        slide.addShape(pptx.ShapeType.line, {
            x: leftX, y: ovLabelY + labelH - 0.03, w: leftW, h: 0,
            line: { color: hex(T.ruleColor), width: 0.5 }
        });

        const ovBoxY = ovLabelY + labelH;
        slide.addShape(pptx.ShapeType.roundRect, {
            x: leftX, y: ovBoxY, w: leftW, h: topBoxH,
            fill: { color: hex(T.rowAltBg) },
            line: { color: hex(T.rowBorder), width: 0.5 },
            rectRadius: 0.04
        });
        const overview = this._stripHTML(act.description.overview);
        slide.addText(overview || '(no overview)', {
            x: leftX + 0.1, y: ovBoxY + 0.05, w: leftW - 0.2, h: topBoxH - 0.1,
            fontSize: 11, color: hex(overview ? T.bodyText : T.mutedText),
            italic: !overview, fontFace: 'Calibri', valign: 'top', wrap: true
        });

        // ── Row 1 right: Image (top-aligned with Overview body) ──
        const imgY = ovBoxY;
        slide.addShape(pptx.ShapeType.roundRect, {
            x: rightX, y: imgY, w: rightW, h: imgH,
            fill: { color: hex(T.tableBg) },
            line: { color: hex(T.rowBorder), width: 0.5 },
            rectRadius: 0.05
        });
        slide.addText('Image', {
            x: rightX, y: imgY, w: rightW, h: imgH,
            fontSize: 28, bold: true, color: hex(T.mutedText),
            align: 'center', valign: 'middle', fontFace: 'Calibri'
        });
        slide.addText('(no image attached)', {
            x: rightX, y: imgY + imgH * 0.65, w: rightW, h: 0.3,
            fontSize: 9, color: hex(T.mutedText), align: 'center', fontFace: 'Calibri'
        });

        // ── Row 2 left: Scope & Notes ──
        const scLabelY = ovBoxY + topBoxH + interRowGap;
        slide.addText('SCOPE & NOTES', {
            x: leftX, y: scLabelY, w: leftW, h: labelH,
            fontSize: 10, bold: true, color: hex(T.metaColor),
            fontFace: 'Calibri', charSpacing: 1
        });
        slide.addShape(pptx.ShapeType.line, {
            x: leftX, y: scLabelY + labelH - 0.03, w: leftW, h: 0,
            line: { color: hex(T.ruleColor), width: 0.5 }
        });
        const scBoxY = scLabelY + labelH;
        slide.addShape(pptx.ShapeType.roundRect, {
            x: leftX, y: scBoxY, w: leftW, h: bottomBoxH,
            fill: { color: hex(T.rowAltBg) },
            line: { color: hex(T.rowBorder), width: 0.5 },
            rectRadius: 0.04
        });
        const bullets = this._toBullets(act.description.bullets);
        if (bullets.length) {
            slide.addText(bullets.map(b => ({
                text: b,
                options: { bullet: { type: 'bullet' }, color: hex(T.bodyText),
                           fontSize: 11, fontFace: 'Calibri' }
            })), {
                x: leftX + 0.1, y: scBoxY + 0.05, w: leftW - 0.2, h: bottomBoxH - 0.1,
                valign: 'top'
            });
        } else {
            slide.addText('(no scope or notes)', {
                x: leftX + 0.1, y: scBoxY + 0.05, w: leftW - 0.2, h: bottomBoxH - 0.1,
                fontSize: 11, italic: true, color: hex(T.mutedText), fontFace: 'Calibri',
                valign: 'top'
            });
        }

        // ── Row 2 right: Main Equipment (header on same baseline as Scope label) ──
        const eqLabelY = scLabelY;
        const mainEq = act.mainEquipment || [];
        slide.addText('MAIN EQUIPMENT', {
            x: rightX, y: eqLabelY, w: rightW * 0.55, h: labelH,
            fontSize: 10, bold: true, color: hex(T.metaColor),
            fontFace: 'Calibri', charSpacing: 1
        });
        slide.addText(
            `${mainEq.length} item${mainEq.length === 1 ? '' : 's'} • full list overleaf`,
            {
                x: rightX + rightW * 0.55, y: eqLabelY, w: rightW * 0.45, h: labelH,
                fontSize: 9, color: hex(T.metaColor), fontFace: 'Calibri',
                align: 'right', valign: 'middle'
            }
        );
        slide.addShape(pptx.ShapeType.line, {
            x: rightX, y: eqLabelY + labelH - 0.03, w: rightW, h: 0,
            line: { color: hex(T.ruleColor), width: 0.5 }
        });

        // Equipment table — bottom-aligned with Scope box
        const tblY = scBoxY;
        const rowH = 0.27;
        const tblMaxH = bottomBoxH;
        const rowsAvailable = Math.max(0, Math.floor(tblMaxH / rowH) - 1);
        const visibleEq = mainEq.slice(0, rowsAvailable);
        const hiddenCount = mainEq.length - visibleEq.length;

        const tblRows = [
            [
                { text: 'ITEM #',      options: { bold: true, fontSize: 9, color: hex(T.tableHdrTxt),
                                                   fill: { color: hex(T.tableHdrBg) } } },
                { text: 'PART NO.',    options: { bold: true, fontSize: 9, color: hex(T.tableHdrTxt),
                                                   fill: { color: hex(T.tableHdrBg) } } },
                { text: 'DESCRIPTION', options: { bold: true, fontSize: 9, color: hex(T.tableHdrTxt),
                                                   fill: { color: hex(T.tableHdrBg) } } },
                { text: 'QTY',         options: { bold: true, fontSize: 9, color: hex(T.tableHdrTxt),
                                                   fill: { color: hex(T.tableHdrBg) }, align: 'right' } }
            ]
        ];
        visibleEq.forEach(row => {
            tblRows.push([
                { text: row.itemNo || '-', options: { fontSize: 9, color: hex(T.mutedText) } },
                { text: row.partNo || '-', options: { fontSize: 9, color: hex(T.bodyText) } },
                { text: row.description,   options: { fontSize: 9, color: hex(T.bodyText) } },
                { text: String(row.qty),   options: { fontSize: 9, color: hex(T.bodyText), align: 'right' } }
            ]);
        });

        if (mainEq.length === 0) {
            slide.addText('No main equipment assigned to this activity', {
                x: rightX, y: tblY + 0.05, w: rightW, h: 0.3,
                fontSize: 10, italic: true, color: hex(T.mutedText), fontFace: 'Calibri'
            });
        } else {
            slide.addTable(tblRows, {
                x: rightX, y: tblY, w: rightW,
                colW: [
                    rightW * 0.20,
                    rightW * 0.20,
                    rightW * 0.48,
                    rightW * 0.12
                ],
                rowH: rowH,
                border: { type: 'solid', pt: 0.4, color: hex(T.rowBorder) }
            });
            if (hiddenCount > 0) {
                const tblEnd = tblY + (visibleEq.length + 1) * rowH + 0.05;
                slide.addText(`+ ${hiddenCount} more on full equipment list`, {
                    x: rightX, y: tblEnd, w: rightW, h: 0.25,
                    fontSize: 9, italic: true, color: hex(T.mutedText), fontFace: 'Calibri'
                });
            }
        }
    },

    /**
     * Render the full equipment list as a dedicated slide right after each
     * activity's info slide. Sections are stacked top-to-bottom (Main,
     * Tooling, Auxiliary). One slide per activity unless the lists overflow,
     * in which case extra slides are appended automatically.
     */
    _renderPptxEquipmentSlide(pptx, act, numberLabel, T, hex) {
        const SLIDE_W = 13.33, SLIDE_H = 7.5;
        const margin = 0.4;
        const contentW = SLIDE_W - 2 * margin;
        const typeColor = this._typeColors[act.type] || T.metaColor;

        let totalItems = 0;
        act.equipmentBySection.order.forEach(name => {
            totalItems += (act.equipmentBySection.buckets[name] || []).length;
        });

        const newSlide = (continued) => {
            const s = pptx.addSlide({ masterName: 'REPORT_MASTER' });
            const headerY = 0.4;
            const headerH = continued ? 0.7 : 1.1;
            const chipW = 1.1;

            // Header background card — same as info page
            s.addShape(pptx.ShapeType.roundRect, {
                x: margin, y: headerY, w: contentW, h: headerH,
                fill: { color: hex(T.rowAltBg) },
                line: { color: hex(T.rowBorder), width: 0.5 },
                rectRadius: 0.06
            });
            // Type-coloured accent strip on the left
            s.addShape(pptx.ShapeType.rect, {
                x: margin, y: headerY, w: 0.08, h: headerH,
                fill: { color: hex(typeColor) }, line: { color: hex(typeColor) }
            });
            // Type chip top-right (only on first slide)
            if (!continued && act.type) {
                s.addShape(pptx.ShapeType.roundRect, {
                    x: margin + contentW - chipW - 0.2, y: headerY + 0.18, w: chipW, h: 0.45,
                    fill: { color: hex(typeColor) }, line: { color: hex(typeColor) },
                    rectRadius: 0.08
                });
                s.addText(act.type, {
                    x: margin + contentW - chipW - 0.2, y: headerY + 0.18, w: chipW, h: 0.45,
                    fontSize: 14, bold: true, color: hex(T.pageBg),
                    align: 'center', valign: 'middle', fontFace: 'Calibri'
                });
            }
            // Title
            s.addText(
                `${numberLabel}  ${act.name} — Equipment List${continued ? ' (cont.)' : ''}`,
                {
                    x: margin + 0.25, y: headerY + 0.1, w: contentW - chipW - 0.5, h: 0.55,
                    fontSize: 20, bold: true, color: hex(T.titleColor), fontFace: 'Calibri',
                    valign: 'middle'
                }
            );
            // Sub-line on first slide only
            if (!continued) {
                const subParts = [];
                if (act.subtitle) subParts.push(`DOC NR. ${act.subtitle}`);
                subParts.push(`${totalItems} item${totalItems === 1 ? '' : 's'}`);
                subParts.push(`${act.equipmentBySection.order.length} section${act.equipmentBySection.order.length === 1 ? '' : 's'}`);
                s.addText(subParts.join('   •   '), {
                    x: margin + 0.25, y: headerY + 0.65, w: contentW - 0.5, h: 0.32,
                    fontSize: 11, color: hex(T.metaColor), fontFace: 'Calibri',
                    valign: 'middle'
                });
            }
            return s;
        };

        let slide = newSlide(false);
        let curY = 1.7;     // sits 0.2 below the 1.1-high header band
        const bottomY = SLIDE_H - 0.4;

        if (totalItems === 0) {
            slide.addText('No equipment assigned to this activity in any section.', {
                x: margin, y: 3.2, w: contentW, h: 0.5,
                fontSize: 14, italic: true, color: hex(T.mutedText),
                align: 'center', fontFace: 'Calibri'
            });
            return;
        }

        const renderSection = (sectionName, items) => {
            // Approximate height needed for header + items table
            const tint = this._sectionTint(sectionName, T);
            const rowH = 0.32;
            const headerLabelH = 0.4;
            const tableHeaderH = 0.32;

            // If we don't have at least the label + 2 rows worth, push to next slide
            const minNeeded = headerLabelH + tableHeaderH + 2 * rowH;
            if (curY + minNeeded > bottomY) {
                slide = newSlide(true);
                curY = 1.3;     // shorter continuation header (0.7 high)
            }

            // Section banner
            slide.addShape(pptx.ShapeType.rect, {
                x: margin, y: curY, w: contentW, h: headerLabelH,
                fill: { color: hex(tint) }, line: { color: hex(tint) }
            });
            slide.addText(sectionName.toUpperCase(), {
                x: margin + 0.15, y: curY, w: contentW - 0.3, h: headerLabelH,
                fontSize: 13, bold: true, color: hex(T.tableHdrTxt),
                fontFace: 'Calibri', valign: 'middle'
            });
            slide.addText(
                `${items.length} item${items.length === 1 ? '' : 's'}`,
                {
                    x: margin, y: curY, w: contentW - 0.15, h: headerLabelH,
                    fontSize: 11, color: hex(T.tableHdrTxt), align: 'right',
                    fontFace: 'Calibri', valign: 'middle'
                }
            );
            curY += headerLabelH + 0.05;

            // Build the table — column widths sized for landscape
            const cw = [contentW * 0.10, contentW * 0.14, contentW * 0.68, contentW * 0.08];
            const headers = [
                { text: 'ITEM #',      options: { bold: true, fontSize: 10, color: hex(T.tableHdrTxt),
                                                   fill: { color: hex(T.tableHdrBg) } } },
                { text: 'PART NO.',    options: { bold: true, fontSize: 10, color: hex(T.tableHdrTxt),
                                                   fill: { color: hex(T.tableHdrBg) } } },
                { text: 'DESCRIPTION', options: { bold: true, fontSize: 10, color: hex(T.tableHdrTxt),
                                                   fill: { color: hex(T.tableHdrBg) } } },
                { text: 'QTY',         options: { bold: true, fontSize: 10, color: hex(T.tableHdrTxt),
                                                   fill: { color: hex(T.tableHdrBg) }, align: 'right' } }
            ];

            // Slice rows so they fit on the current slide; if more remain,
            // continue on a fresh slide.
            let i = 0;
            while (i < items.length) {
                const fits = Math.max(0, Math.floor((bottomY - curY - tableHeaderH) / rowH));
                const chunk = items.slice(i, i + fits);
                const tableRows = [headers].concat(chunk.map(row => ([
                    { text: row.itemNo || '-', options: { fontSize: 9.5, color: hex(T.mutedText) } },
                    { text: row.partNo || '-', options: { fontSize: 9.5, color: hex(T.bodyText) } },
                    { text: row.description,   options: { fontSize: 9.5, color: hex(T.bodyText) } },
                    { text: String(row.qty),   options: { fontSize: 9.5, color: hex(T.bodyText), align: 'right' } }
                ])));
                slide.addTable(tableRows, {
                    x: margin, y: curY, w: contentW, colW: cw, rowH: rowH,
                    border: { type: 'solid', pt: 0.4, color: hex(T.rowBorder) }
                });
                curY += tableHeaderH + chunk.length * rowH + 0.2;
                i += chunk.length;

                if (i < items.length) {
                    // Spill onto a continuation slide
                    slide = newSlide(true);
                    curY = 1.3;     // shorter continuation header (0.7 high)
                    // Section continuation label
                    slide.addText(`${sectionName} (continued)`, {
                        x: margin, y: curY, w: contentW, h: 0.3,
                        fontSize: 11, italic: true, color: hex(T.mutedText), fontFace: 'Calibri'
                    });
                    curY += 0.35;
                }
            }
            curY += 0.2;
        };

        act.equipmentBySection.order.forEach(name => {
            renderSection(name, act.equipmentBySection.buckets[name] || []);
        });
    }
};

