/**
 * FLOW-EXPORT.JS - Export Flow View
 * Exports the current canvas view as PPTX, PDF, PNG, SVG, or JSON.
 *
 * Libraries loaded via script tags in flow.html (offline-ready):
 *   js/lib/html2canvas.min.js  → window.html2canvas
 *   js/lib/jspdf.umd.js        → window.jspdf
 *   js/lib/pptxgen.bundle.js   → window.PptxGenJS
 */

const FlowExport = {

    /** Get the target element to capture */
    _getTarget() {
        return document.getElementById('flowCanvasWrapper');
    },

    /** Build a filename from page title or project name + date */
    _getFilename(ext) {
        var title = (document.getElementById('flowPageTitle') || {}).value || '';
        var name = (title || FlowData.projectName || 'activity-flow').replace(/[^a-zA-Z0-9_-]/g, '_');
        const date = new Date().toISOString().slice(0, 10);
        return `${name}_flow_${date}.${ext}`;
    },

    /** Show / hide the loading spinner overlay */
    _showLoading(show, message) {
        let overlay = document.getElementById('exportLoadingOverlay');
        if (show) {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'exportLoadingOverlay';
                overlay.innerHTML = `
                    <div class="export-loading-box">
                        <div class="export-spinner"></div>
                        <div class="export-loading-text">${message || 'Exporting...'}</div>
                    </div>`;
                document.body.appendChild(overlay);
            } else {
                overlay.querySelector('.export-loading-text').textContent = message || 'Exporting...';
                overlay.style.display = '';
            }
        } else if (overlay) {
            overlay.style.display = 'none';
        }
    },

    /**
     * Capture the flow canvas at 2× resolution.
     *
     * Edge alignment fix:  The SVG edge layer uses CSS `width:100%;height:100%`
     * but edge coordinates are absolute pixels from getBoundingClientRect().
     * When the wrapper expands for capture (scrollbar vanishes → extra width),
     * the CSS 100% no longer matches the SVG coordinate space.
     * Single-pass capture with SVG coordinate fix.
     *
     * Root cause: FlowEdges.render() sets SVG attributes to canvas.scrollWidth,
     * but edge coordinates use getBoundingClientRect() which returns positions in
     * the canvas's rendered pixel space (offsetWidth). When min-width:100% makes
     * offsetWidth > scrollWidth, the SVG coordinate system is smaller than the
     * edge coordinates, causing a horizontal shift.
     *
     * Fix: after re-rendering edges, override the SVG's width/height (both
     * attributes AND CSS) to canvas.offsetWidth so the coordinate system matches
     * what getBoundingClientRect() produced.
     */
    /**
     * PAGE 2 CAPTURE — Nodes-only flowchart.
     * Completely independent render: hides the timeline strip,
     * captures only the flowCanvas element (lanes + nodes + edges).
     * No timeline logic involved at all.
     */
    async _captureNodesOnly() {
        var wrapper  = document.getElementById('flowCanvasWrapper');
        var canvas   = document.getElementById('flowCanvas');
        var svg      = document.getElementById('edgeLayer');
        var tlStrip  = document.getElementById('timelineStrip');
        if (!wrapper || !canvas) throw new Error('Canvas not found');

        // Save state
        var orig = {
            wrapOverflow:  wrapper.style.overflow,
            wrapHeight:    wrapper.style.height,
            wrapMaxHeight: wrapper.style.maxHeight,
            scrollTop:     wrapper.scrollTop,
            scrollLeft:    wrapper.scrollLeft,
            svgW:          svg ? svg.style.width  : '',
            svgH:          svg ? svg.style.height : '',
            tlDisplay:     tlStrip ? tlStrip.style.display : ''
        };

        // ── Completely hide timeline — this capture has nothing to do with it ──
        if (tlStrip) tlStrip.style.display = 'none';

        // ── Hide collapsed lanes ──
        var collapsedLanes = canvas.querySelectorAll('.lane-collapsed');
        collapsedLanes.forEach(function(cl) { cl.style.display = 'none'; });

        // ── Hide wp-dimmed nodes ──
        var dimmedNodes = canvas.querySelectorAll('.flow-node.wp-dimmed');
        dimmedNodes.forEach(function(n) { n.style.display = 'none'; });

        // ── Expand wrapper so full canvas is visible ──
        wrapper.scrollTop  = 0;
        wrapper.scrollLeft = 0;
        wrapper.style.overflow  = 'visible';
        wrapper.style.height    = 'auto';
        wrapper.style.maxHeight = 'none';

        // Reflow
        await new Promise(function(r) { requestAnimationFrame(r); });

        // Re-render edges only (no timeline)
        if (typeof FlowEdges !== 'undefined') FlowEdges.render();
        await new Promise(function(r) { requestAnimationFrame(r); });

        // Pin SVG dimensions to canvas
        var captureW = canvas.offsetWidth;
        var captureH = canvas.offsetHeight;
        if (svg) {
            svg.setAttribute('width',  captureW);
            svg.setAttribute('height', captureH);
            svg.style.width  = captureW + 'px';
            svg.style.height = captureH + 'px';
        }

        await new Promise(function(r) { requestAnimationFrame(r); });

        var isLight = document.body.classList.contains('light-theme');
        var bgColor = isLight ? '#ffffff' : '#080812';

        try {
            // Capture ONLY the flowCanvas — no wrapper, no timeline
            return await html2canvas(canvas, {
                scale: 2,
                useCORS: true,
                backgroundColor: bgColor,
                logging: false,
                allowTaint: true,
                scrollX: 0, scrollY: 0,
                width:  captureW,
                height: captureH,
                windowWidth:  captureW + 50,
                windowHeight: captureH + 50
            });
        } finally {
            // Restore everything
            if (svg) {
                svg.style.width  = orig.svgW;
                svg.style.height = orig.svgH;
            }
            if (tlStrip) tlStrip.style.display = orig.tlDisplay;
            collapsedLanes.forEach(function(cl) { cl.style.display = ''; });
            dimmedNodes.forEach(function(n) { n.style.display = ''; });
            wrapper.style.overflow  = orig.wrapOverflow;
            wrapper.style.height    = orig.wrapHeight;
            wrapper.style.maxHeight = orig.wrapMaxHeight;
            wrapper.scrollTop  = orig.scrollTop;
            wrapper.scrollLeft = orig.scrollLeft;
            if (typeof FlowEdges !== 'undefined') FlowEdges.render();
        }
    },

    /**
     * PAGE 3 CAPTURE — Timeline + Flowchart combined.
     * Completely independent render: forces timeline visible,
     * captures the full flowCanvasWrapper (timeline strip + canvas).
     * Re-renders both timeline and edges for this capture.
     */
    async _captureWithTimeline() {
        var wrapper  = document.getElementById('flowCanvasWrapper');
        var canvas   = document.getElementById('flowCanvas');
        var svg      = document.getElementById('edgeLayer');
        var tlStrip  = document.getElementById('timelineStrip');
        if (!wrapper || !canvas) throw new Error('Canvas not found');

        // Save state
        var orig = {
            wrapOverflow:  wrapper.style.overflow,
            wrapHeight:    wrapper.style.height,
            wrapMaxHeight: wrapper.style.maxHeight,
            scrollTop:     wrapper.scrollTop,
            scrollLeft:    wrapper.scrollLeft,
            svgW:          svg ? svg.style.width  : '',
            svgH:          svg ? svg.style.height : '',
            tlDisplay:     tlStrip ? tlStrip.style.display : ''
        };

        // ── Force timeline visible for this capture ──
        if (tlStrip) tlStrip.style.display = '';

        // ── Hide collapsed lanes ──
        var collapsedLanes = canvas.querySelectorAll('.lane-collapsed');
        collapsedLanes.forEach(function(cl) { cl.style.display = 'none'; });

        // ── Hide wp-dimmed nodes ──
        var dimmedNodes = canvas.querySelectorAll('.flow-node.wp-dimmed');
        dimmedNodes.forEach(function(n) { n.style.display = 'none'; });

        // ── Expand wrapper ──
        wrapper.scrollTop  = 0;
        wrapper.scrollLeft = 0;
        wrapper.style.overflow  = 'visible';
        wrapper.style.height    = 'auto';
        wrapper.style.maxHeight = 'none';

        // Reflow
        await new Promise(function(r) { requestAnimationFrame(r); });

        // Re-render both edges AND timeline
        if (typeof FlowEdges !== 'undefined') FlowEdges.render();
        if (typeof FlowTimeline !== 'undefined') FlowTimeline.render();
        await new Promise(function(r) { requestAnimationFrame(r); });

        // Pin SVG to canvas dimensions
        var captureW = canvas.offsetWidth;
        var captureH = canvas.offsetHeight;
        if (svg) {
            svg.setAttribute('width',  captureW);
            svg.setAttribute('height', captureH);
            svg.style.width  = captureW + 'px';
            svg.style.height = captureH + 'px';
        }

        await new Promise(function(r) { requestAnimationFrame(r); });

        // Capture the full WRAPPER (timeline + canvas together)
        var fullW = wrapper.offsetWidth;
        var fullH = wrapper.offsetHeight;

        var isLight = document.body.classList.contains('light-theme');
        var bgColor = isLight ? '#ffffff' : '#080812';

        try {
            return await html2canvas(wrapper, {
                scale: 2,
                useCORS: true,
                backgroundColor: bgColor,
                logging: false,
                allowTaint: true,
                scrollX: 0, scrollY: 0,
                width:  fullW,
                height: fullH,
                windowWidth:  fullW + 50,
                windowHeight: fullH + 50
            });
        } finally {
            // Restore everything
            if (svg) {
                svg.style.width  = orig.svgW;
                svg.style.height = orig.svgH;
            }
            if (tlStrip) tlStrip.style.display = orig.tlDisplay;
            collapsedLanes.forEach(function(cl) { cl.style.display = ''; });
            dimmedNodes.forEach(function(n) { n.style.display = ''; });
            wrapper.style.overflow  = orig.wrapOverflow;
            wrapper.style.height    = orig.wrapHeight;
            wrapper.style.maxHeight = orig.wrapMaxHeight;
            wrapper.scrollTop  = orig.scrollTop;
            wrapper.scrollLeft = orig.scrollLeft;
            if (typeof FlowEdges !== 'undefined') FlowEdges.render();
        }
    },

    /**
     * Draw location legend at the bottom of a PDF page.
     */
    _drawLegendOnPdf(pdf, pageW, pageH, m, T) {
        var isLight = document.body.classList.contains('light-theme');
        if (typeof DataModel === 'undefined') return;

        var usedLocations = {};
        FlowData.nodes.forEach(function(n) {
            if (n.location) usedLocations[n.location] = true;
        });

        var names = DataModel.getLocationNames().filter(function(n) { return usedLocations[n]; });
        if (names.length === 0) return;

        var legendY = pageH - 8;
        var dotSize = 3;
        var gap = 4;
        var xPos = m;

        // Legend background bar
        var barColor = isLight ? [241, 245, 249] : [16, 16, 28];
        pdf.setFillColor(barColor[0], barColor[1], barColor[2]);
        pdf.rect(0, legendY - 4, pageW, 12, 'F');

        // "Locations:" label
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        var labelColor = isLight ? [100, 116, 139] : [119, 119, 136];
        pdf.setTextColor(labelColor[0], labelColor[1], labelColor[2]);
        pdf.text('LOCATIONS:', xPos, legendY + 2);
        xPos += 30;

        names.forEach(function(name) {
            var loc = DataModel.locations[name];
            if (!loc) return;

            // Parse hex color
            var hex = (loc.color || '#888').replace('#', '');
            var r = parseInt(hex.substring(0, 2), 16) || 128;
            var g = parseInt(hex.substring(2, 4), 16) || 128;
            var b = parseInt(hex.substring(4, 6), 16) || 128;

            // Dot
            pdf.setFillColor(r, g, b);
            pdf.circle(xPos + dotSize / 2, legendY + 1, dotSize / 2, 'F');
            xPos += dotSize + gap;

            // Name
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8);
            var txtColor = isLight ? [71, 85, 105] : [153, 153, 170];
            pdf.setTextColor(txtColor[0], txtColor[1], txtColor[2]);
            pdf.text(name, xPos, legendY + 2);
            xPos += pdf.getTextWidth(name) + 12;
        });
    },

    // ══════════════════════════════════════════
    //  PNG Export
    // ══════════════════════════════════════════
    async exportPNG() {
        this._closeDropdown();
        this._showLoading(true, 'Capturing as PNG\u2026');
        try {
            const canvas = await this._captureNodesOnly();
            const link = document.createElement('a');
            link.download = this._getFilename('png');
            link.href = canvas.toDataURL('image/png');
            link.click();
        } catch (err) {
            console.error('PNG export error:', err);
            alert('PNG export failed: ' + err.message);
        }
        this._showLoading(false);
    },

    // ══════════════════════════════════════════
    //  PDF Export (multi-page, theme-aware)
    // ══════════════════════════════════════════
    async exportPDF() {
        this._closeDropdown();
        this._showLoading(true, 'Generating PDF\u2026');
        try {
            // Capture nodes-only view
            this._showLoading(true, 'Capturing flow diagram\u2026');
            var capturedCanvas = await this._captureNodesOnly();
            var imgData = capturedCanvas.toDataURL('image/png');

            // Capture timeline + nodes view
            this._showLoading(true, 'Capturing timeline view\u2026');
            var tlCanvas = await this._captureWithTimeline();
            var tlImgData = tlCanvas.toDataURL('image/png');

            this._showLoading(true, 'Building PDF pages\u2026');

            var pdf = new jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
            var pageW = pdf.internal.pageSize.getWidth();
            var pageH = pdf.internal.pageSize.getHeight();
            var m = 15;
            var self = this;

            var projectName = FlowData.projectName || 'Activity Flow';
            var flowPageTitle = (document.getElementById('flowPageTitle') || {}).value || 'Activity Flow';
            var isLight = document.body.classList.contains('light-theme');

            // ── Theme palette ──
            var T = isLight ? {
                pageBg:      [255, 255, 255],
                diagramBg:   [255, 255, 255],
                tableBg:     [255, 255, 255],
                titleColor:  [15, 23, 42],
                subtitleColor: [37, 99, 235],
                accentColor: [37, 99, 235],
                metaColor:   [100, 116, 139],
                dateColor:   [148, 163, 184],
                headingColor:[15, 23, 42],
                tableHdrBg:  [37, 99, 235],
                tableHdrTxt: [255, 255, 255],
                rowAltBg:    [241, 245, 249],
                rowBorder:   [226, 232, 240],
                cellText:    [30, 41, 59],
                ruleColor:   [203, 213, 225],
                accentBar:   [37, 99, 235]
            } : {
                pageBg:      [10, 10, 18],
                diagramBg:   [10, 10, 18],
                tableBg:     [16, 16, 28],
                titleColor:  [255, 255, 255],
                subtitleColor:[0, 212, 255],
                accentColor: [0, 212, 255],
                metaColor:   [136, 136, 136],
                dateColor:   [102, 102, 102],
                headingColor:[224, 228, 235],
                tableHdrBg:  [0, 212, 255],
                tableHdrTxt: [10, 10, 18],
                rowAltBg:    [22, 22, 38],
                rowBorder:   [40, 40, 60],
                cellText:    [200, 205, 215],
                ruleColor:   [50, 50, 70],
                accentBar:   [0, 212, 255]
            };

            function fillBg(rgb) { pdf.setFillColor(rgb[0], rgb[1], rgb[2]); pdf.rect(0, 0, pageW, pageH, 'F'); }
            function setColor(rgb) { pdf.setTextColor(rgb[0], rgb[1], rgb[2]); }
            function setFill(rgb) { pdf.setFillColor(rgb[0], rgb[1], rgb[2]); }
            function setDraw(rgb) { pdf.setDrawColor(rgb[0], rgb[1], rgb[2]); }

            // Helper to draw a table header row
            function drawTableHeader(x, y, cols, titles, rh) {
                setFill(T.tableHdrBg);
                pdf.rect(x, y, cols.reduce(function(a,b){return a+b;},0), rh, 'F');
                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(10);
                setColor(T.tableHdrTxt);
                var hx = x;
                titles.forEach(function(t, i) { pdf.text(t, hx + 3, y + 6.5); hx += cols[i]; });
            }

            // ══════════════════════════════════
            // PAGE 1 — Title
            // ══════════════════════════════════
            fillBg(T.pageBg);

            setFill(T.accentBar);
            pdf.rect(m, 80, 80, 1.5, 'F');

            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(42);
            setColor(T.titleColor);
            pdf.text(flowPageTitle, m, 105);

            pdf.setFontSize(22);
            setColor(T.subtitleColor);
            pdf.text(projectName, m, 120);

            if (FlowData.docNo) {
                pdf.setFontSize(13);
                setColor(T.metaColor);
                pdf.text('Doc: ' + FlowData.docNo, m, 140);
            }

            var dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
            pdf.setFontSize(11);
            setColor(T.dateColor);
            pdf.text('Exported: ' + dateStr, m, pageH - 20);

            // ══════════════════════════════════
            // PAGE 2 — Flow Diagram (nodes only)
            // ══════════════════════════════════
            pdf.addPage('a3', 'landscape');
            fillBg(T.diagramBg);

            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(11);
            setColor(T.accentColor);
            pdf.text(flowPageTitle + ' \u2014 Node Flowchart', 8, 8);

            var imgW = capturedCanvas.width;
            var imgH = capturedCanvas.height;
            var legendH = 10;
            var imgMargin = 6;
            var availW = pageW - imgMargin * 2;
            var availH = pageH - 12 - imgMargin - legendH;
            var ratio = Math.min(availW / imgW, availH / imgH);
            var drawW = imgW * ratio;
            var drawH = imgH * ratio;
            var cx = imgMargin + (availW - drawW) / 2;
            var cy = 12;

            pdf.addImage(imgData, 'PNG', cx, cy, drawW, drawH);

            // Location legend at bottom
            self._drawLegendOnPdf(pdf, pageW, pageH, 8, T);

            // ══════════════════════════════════
            // PAGE 3 — Timeline + Flowchart
            // ══════════════════════════════════
            pdf.addPage('a3', 'landscape');
            fillBg(T.diagramBg);

            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(11);
            setColor(T.accentColor);
            pdf.text(flowPageTitle + ' \u2014 Timeline & Flowchart', 8, 8);

            var tlImgW = tlCanvas.width;
            var tlImgH = tlCanvas.height;
            var tlRatio = Math.min(availW / tlImgW, availH / tlImgH);
            var tlDrawW = tlImgW * tlRatio;
            var tlDrawH = tlImgH * tlRatio;
            var tlCx = imgMargin + (availW - tlDrawW) / 2;
            var tlCy = 12;

            pdf.addImage(tlImgData, 'PNG', tlCx, tlCy, tlDrawW, tlDrawH);

            // Location legend at bottom
            self._drawLegendOnPdf(pdf, pageW, pageH, 8, T);

            // ══════════════════════════════════
            // PAGE 4 — Activity Summary Table
            // ══════════════════════════════════

            // Sanitize strings for jsPDF (Helvetica can't render en-dash, em-dash, smart quotes, etc.)
            function pdfSafe(str) {
                if (!str) return '';
                return str
                    .replace(/[\u2013\u2014]/g, '-')   // en-dash, em-dash → hyphen
                    .replace(/[\u2018\u2019]/g, "'")    // smart single quotes
                    .replace(/[\u201C\u201D]/g, '"')    // smart double quotes
                    .replace(/\u2026/g, '...')           // ellipsis
                    .replace(/[^\x00-\x7F]/g, function(ch) {
                        // Keep common accented chars (Latin-1 Supplement), replace others
                        var code = ch.charCodeAt(0);
                        return (code >= 0x00C0 && code <= 0x00FF) ? ch : '?';
                    });
            }

            // Filter: only show activities whose lane (type) is open in the flow chart
            var visibleNodes = FlowData.nodes.filter(function(n) {
                if (typeof DataModel !== 'undefined' && !DataModel.isActivityVisible(n.id)) return false;
                // Respect lane visibility — if a lane is hidden, exclude its activities
                if (FlowData.hiddenLanes && FlowData.hiddenLanes[n.type]) return false;
                return true;
            });

            pdf.addPage('a3', 'landscape');
            fillBg(T.tableBg);

            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(22);
            setColor(T.headingColor);
            pdf.text('Activity Summary', m, 18);

            setDraw(T.ruleColor);
            pdf.setLineWidth(0.3);
            pdf.line(m, 22, pageW - m, 22);

            var colWidths = [85, 40, 28, 70, 38, 50, 50, 28];
            var tableX = m;
            var rowH = 9;
            var headerY = 28;
            var headers = ['Activity', 'Doc Nr.', 'Type', 'Location', 'Work Pack', 'Start', 'End', 'Days'];
            var totalW = colWidths.reduce(function(a,b){return a+b;},0);

            drawTableHeader(tableX, headerY, colWidths, headers, rowH);

            var curY = headerY + rowH;
            var typeColors = {
                'FAT':   [0, 212, 255],
                'EFAT':  [16, 185, 129],
                'FIT':   [139, 92, 246],
                'SIT':   [245, 158, 11],
                'M-SIT': [239, 68, 68],
                'SRT':   [236, 72, 153]
            };

            // Build flat list of activities + sub-activities for PDF rendering
            var flatActivities = [];
            var subCount = 0;
            for (var fi = 0; fi < visibleNodes.length; fi++) {
                var node = visibleNodes[fi];
                flatActivities.push({ data: node, isSub: false });
                // Check if this node has sub-activities in DataModel
                if (typeof DataModel !== 'undefined') {
                    var mainTest = DataModel.testColumns.find(function(t) { return t.id === node.id; });
                    if (mainTest && mainTest.subActivities && mainTest.subActivities.length > 0) {
                        mainTest.subActivities.forEach(function(sub) {
                            flatActivities.push({ data: sub, isSub: true, parentName: node.name });
                            subCount++;
                        });
                    }
                }
            }

            var rowCounter = 0;
            var totalDays = 0;
            var totalDaysMain = 0;  // sum only of top-level activities (so subs don't double-count)

            // Helper: return number of days between two ISO date strings, or null if unknown
            function daysBetween(s, e) {
                if (!s || !e) return null;
                var a = new Date(s), b = new Date(e);
                if (isNaN(a) || isNaN(b)) return null;
                return Math.max(0, Math.round((b - a) / 86400000));
            }

            for (var ri = 0; ri < flatActivities.length; ri++) {
                var entry = flatActivities[ri];
                var n = entry.data;

                if (curY + rowH > pageH - 15) {
                    pdf.addPage('a3', 'landscape');
                    fillBg(T.tableBg);

                    // Continuation header
                    pdf.setFont('helvetica', 'bold');
                    pdf.setFontSize(14);
                    setColor(T.headingColor);
                    pdf.text('Activity Summary (continued)', m, 12);
                    setDraw(T.ruleColor);
                    pdf.setLineWidth(0.2);
                    pdf.line(m, 14.5, pageW - m, 14.5);

                    curY = 18;
                    drawTableHeader(tableX, curY, colWidths, headers, rowH);
                    curY += rowH;
                    rowCounter = 0;
                }

                // Alternating row background
                if (rowCounter % 2 === 0) {
                    setFill(T.rowAltBg);
                    pdf.rect(tableX, curY, totalW, rowH, 'F');
                }

                setDraw(T.rowBorder);
                pdf.setLineWidth(0.15);
                pdf.line(tableX, curY + rowH, tableX + totalW, curY + rowH);

                var actName = pdfSafe(n.name || '');
                if (entry.isSub) actName = '       ' + actName;

                // Days for this row
                var dayCount = daysBetween(n.startDate, n.endDate);
                var daysStr  = (dayCount == null) ? '\u2014' : (dayCount + 'd');
                if (dayCount != null) {
                    totalDays += dayCount;
                    if (!entry.isSub) totalDaysMain += dayCount;
                }

                var cells = [actName, pdfSafe(n.subtitle || ''), n.type || '', pdfSafe(n.location || ''), pdfSafe(n.workpack || ''), n.startDate || '', n.endDate || '', daysStr];
                pdf.setFont('helvetica', entry.isSub ? 'italic' : 'normal');
                pdf.setFontSize(entry.isSub ? 8 : 9);
                var rx = tableX;
                cells.forEach(function(val, ci) {
                    if (ci === 2 && typeColors[val]) {
                        var tc = typeColors[val];
                        pdf.setTextColor(tc[0], tc[1], tc[2]);
                        pdf.setFont('helvetica', 'bold');
                    } else {
                        setColor(entry.isSub ? [150, 150, 160] : T.cellText);
                        pdf.setFont('helvetica', entry.isSub ? 'italic' : 'normal');
                    }
                    pdf.setFontSize(entry.isSub ? 8 : 9);
                    var maxChars = Math.floor(colWidths[ci] / 2.2);
                    var display = val.length > maxChars ? val.substring(0, maxChars - 1) + '\u2026' : val;
                    pdf.text(display, rx + 3, curY + 6.5);
                    rx += colWidths[ci];
                });

                curY += rowH;
                rowCounter++;
            }

            // Summary footer
            pdf.setFontSize(9);
            setColor(T.metaColor);
            pdf.setFont('helvetica', 'italic');
            var summaryText = visibleNodes.length + ' activities';
            if (subCount > 0) summaryText += ' + ' + subCount + ' sub-activities';
            summaryText += ' \u00B7 ' + totalDaysMain + ' total days';
            if (subCount > 0 && totalDays !== totalDaysMain) {
                summaryText += ' (' + totalDays + ' incl. sub-activities)';
            }
            pdf.text(summaryText, tableX, curY + 8);

            // ══════════════════════════════════
            // PAGE 4 — Connections & Transfers
            // ══════════════════════════════════
            //
            // Mirror the visibility logic used by the flow chart + Activity Summary:
            // only include edges whose BOTH endpoints are visible nodes, i.e. activity
            // is not hidden AND the lane (type) is not hidden. This matches which edge
            // lines are actually shown on the diagram — see flow-edges.js render().
            var visibleEdges = FlowData.edges.filter(function(edge) {
                var fromNode = FlowData.getNode(edge.fromNodeId);
                var toNode   = FlowData.getNode(edge.toNodeId);
                if (!fromNode || !toNode) return false;
                if (typeof DataModel !== 'undefined') {
                    if (!DataModel.isActivityVisible(edge.fromNodeId)) return false;
                    if (!DataModel.isActivityVisible(edge.toNodeId))   return false;
                }
                if (FlowData.hiddenLanes) {
                    if (FlowData.hiddenLanes[fromNode.type]) return false;
                    if (FlowData.hiddenLanes[toNode.type])   return false;
                }
                return true;
            });

            if (visibleEdges.length > 0) {
                pdf.addPage('a3', 'landscape');
                fillBg(T.tableBg);

                pdf.setFont('helvetica', 'bold');
                pdf.setFontSize(22);
                setColor(T.headingColor);
                pdf.text('Connections & Equipment Transfers', m, 18);

                setDraw(T.ruleColor);
                pdf.setLineWidth(0.3);
                pdf.line(m, 22, pageW - m, 22);

                // Summary line — mirrors the "X activities" line under Activity Summary
                pdf.setFont('helvetica', 'italic');
                pdf.setFontSize(9);
                setColor(T.cellTextDim || T.cellText);
                var totalEdges = FlowData.edges.length;
                var hiddenCount = totalEdges - visibleEdges.length;
                var subText = visibleEdges.length + ' connection' + (visibleEdges.length === 1 ? '' : 's');
                if (hiddenCount > 0) {
                    subText += ' shown (' + hiddenCount + ' hidden — endpoint not visible)';
                }
                pdf.text(subText, m, 26);

                var eColW = [85, 85, 60, 130];
                var eHeaders = ['From', 'To', 'Details', 'Equipment Transfer'];
                var eHeaderY = 30;
                var eTotalW = eColW.reduce(function(a,b){return a+b;},0);

                drawTableHeader(m, eHeaderY, eColW, eHeaders, rowH);

                var eCurY = eHeaderY + rowH;
                var maxEdges = Math.min(visibleEdges.length, 50);

                for (var ei = 0; ei < maxEdges; ei++) {
                    var e = visibleEdges[ei];
                    var fromNode = FlowData.getNode(e.fromNodeId);
                    var toNode   = FlowData.getNode(e.toNodeId);

                    // Build transfer items string
                    var transferStr = '\u2014';
                    if (e.transferItems && Object.keys(e.transferItems).length > 0) {
                        var parts = [];
                        for (var tk in e.transferItems) {
                            var ti = e.transferItems[tk];
                            if (ti && ti.description) {
                                var s = ti.description;
                                if (ti.partNo) s += ' (' + ti.partNo + ')';
                                if (ti.qty) s += ' x' + ti.qty;
                                parts.push(s);
                            }
                        }
                        if (parts.length > 0) transferStr = parts.join(', ');
                    }

                    // Calculate row height — transfer text might need more space
                    var thisRowH = rowH;
                    var maxTransferChars = Math.floor(eColW[3] / 2.2);
                    if (transferStr.length > maxTransferChars) thisRowH = rowH * 1.5;

                    if (eCurY + thisRowH > pageH - 15) {
                        pdf.addPage('a3', 'landscape');
                        fillBg(T.tableBg);
                        eCurY = 15;
                        drawTableHeader(m, eCurY, eColW, eHeaders, rowH);
                        eCurY += rowH;
                    }

                    if (ei % 2 === 0) {
                        setFill(T.rowAltBg);
                        pdf.rect(m, eCurY, eTotalW, thisRowH, 'F');
                    }
                    setDraw(T.rowBorder);
                    pdf.setLineWidth(0.15);
                    pdf.line(m, eCurY + thisRowH, m + eTotalW, eCurY + thisRowH);

                    var eCells = [
                        pdfSafe(fromNode ? fromNode.name : '?'),
                        pdfSafe(toNode ? toNode.name : '?'),
                        pdfSafe(e.label || '-'),
                        pdfSafe(transferStr)
                    ];
                    pdf.setFont('helvetica', 'normal');
                    pdf.setFontSize(9);
                    setColor(T.cellText);
                    var erx = m;
                    eCells.forEach(function(val, ci) {
                        var maxC = Math.floor(eColW[ci] / 2.0);
                        if (ci === 3 && val.length > maxC) {
                            // Wrap long transfer text
                            var lines = pdf.splitTextToSize(val, eColW[ci] - 6);
                            pdf.text(lines.slice(0, 2), erx + 3, eCurY + 6.5);
                        } else {
                            var disp = val.length > maxC ? val.substring(0, maxC - 1) + '\u2026' : val;
                            pdf.text(disp, erx + 3, eCurY + 6.5);
                        }
                        erx += eColW[ci];
                    });

                    eCurY += thisRowH;
                }
            }

            pdf.save(this._getFilename('pdf'));
        } catch (err) {
            console.error('PDF export error:', err);
            alert('PDF export failed: ' + err.message);
        }
        this._showLoading(false);
    },

    // ══════════════════════════════════════════
    //  PPTX Export (theme-aware)
    // ══════════════════════════════════════════
    async exportPPTX() {
        this._closeDropdown();
        this._showLoading(true, 'Building PowerPoint\u2026');
        try {
            const canvas  = await this._captureNodesOnly();
            const imgData = canvas.toDataURL('image/png');
            var isLight = document.body.classList.contains('light-theme');

            // Theme palette (hex without #)
            var P = isLight ? {
                titleBg:  'FFFFFF',   diagramBg: 'FFFFFF',
                titleClr: '0f172a',   subtitleClr: '2563eb',
                accentClr:'2563eb',   metaClr: '64748b',  dateClr: '94a3b8',
                hdgClr:   '0f172a',   tblHdrBg: '2563eb',
                rowAlt:   'f1f5f9',   rowNorm: 'FFFFFF',  tblBg: 'FFFFFF'
            } : {
                titleBg:  '0a0a12',   diagramBg: '0a0a12',
                titleClr: 'FFFFFF',   subtitleClr: '00d4ff',
                accentClr:'00d4ff',   metaClr: '888888',  dateClr: '666666',
                hdgClr:   'e0e4eb',   tblHdrBg: '00d4ff',  tblHdrTxt: '0a0a12',
                rowAlt:   '16162a',   rowNorm: '10101c',  tblBg: '10101c'
            };

            const pres = new PptxGenJS();
            pres.layout = 'LAYOUT_WIDE';
            pres.author = 'Test Equipment Matrix';
            var pptxFlowTitle = (document.getElementById('flowPageTitle') || {}).value || 'Activity Flow';
            var pptxProjectName = FlowData.projectName || '';
            pres.title  = pptxFlowTitle + (pptxProjectName ? ' \u2014 ' + pptxProjectName : '');

            // -- Slide 1: Title --------------------------------
            var s1 = pres.addSlide();
            s1.background = { color: P.titleBg };
            s1.addText(pptxFlowTitle, {
                x: 0.8, y: 1.5, w: 11.7, h: 1.2,
                fontSize: 40, fontFace: 'Calibri', color: P.titleClr, bold: true
            });
            s1.addText(pptxProjectName || 'Flow Diagram', {
                x: 0.8, y: 2.7, w: 11.7, h: 0.8,
                fontSize: 22, fontFace: 'Calibri', color: P.subtitleClr
            });
            if (FlowData.docNo) {
                s1.addText('Doc: ' + FlowData.docNo, {
                    x: 0.8, y: 3.6, w: 6, h: 0.5,
                    fontSize: 14, fontFace: 'Calibri', color: P.metaClr
                });
            }
            s1.addText('Exported: ' + new Date().toLocaleDateString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric'
            }), {
                x: 0.8, y: 6.5, w: 6, h: 0.4,
                fontSize: 11, fontFace: 'Calibri', color: P.dateClr
            });

            // -- Slide 2: Flow diagram image -------------------
            var s2 = pres.addSlide();
            s2.background = { color: P.diagramBg };
            s2.addText(pptxFlowTitle + ' Diagram', {
                x: 0.4, y: 0.15, w: 12.5, h: 0.45,
                fontSize: 16, fontFace: 'Calibri', color: P.accentClr, bold: true
            });

            var imgW = canvas.width;
            var imgH = canvas.height;
            var maxW = 12.5, maxH = 6.6;
            var ratio = Math.min(maxW / imgW, maxH / imgH);
            var drawW = imgW * ratio;
            var drawH = imgH * ratio;
            var cx = 0.4 + (maxW - drawW) / 2;
            var cy = 0.7 + (maxH - drawH) / 2;
            s2.addImage({ data: imgData, x: cx, y: cy, w: drawW, h: drawH });

            // -- Slide 3: Activity summary table ---------------
            var visibleNodes = FlowData.nodes.filter(function(n) {
                if (typeof DataModel !== 'undefined' && !DataModel.isActivityVisible(n.id)) return false;
                if (FlowData.hiddenLanes && FlowData.hiddenLanes[n.type]) return false;
                return true;
            });

            var s3 = pres.addSlide();
            s3.background = { color: P.tblBg };
            s3.addText('Activity Summary', {
                x: 0.5, y: 0.3, w: 12, h: 0.6,
                fontSize: 22, fontFace: 'Calibri', color: P.hdgClr, bold: true
            });

            function hdr(txt) {
                return {
                    text: txt,
                    options: { bold: true, color: P.tblHdrTxt || 'FFFFFF', fill: { color: P.tblHdrBg }, fontSize: 11, fontFace: 'Calibri' }
                };
            }
            var headerRow = [hdr('Activity'), hdr('Doc Nr.'), hdr('Type'), hdr('Location'), hdr('Work Pack'), hdr('Start'), hdr('End'), hdr('Days')];

            // Default cell text color for theme
            var cellTxt = isLight ? '1e293b' : 'c8cdd7';
            var subTxt  = isLight ? '6d28d9' : 'a78bfa';

            // Helper: days between two date strings
            function pptxDaysBetween(s, e) {
                if (!s || !e) return null;
                var a = new Date(s), b = new Date(e);
                if (isNaN(a) || isNaN(b)) return null;
                return Math.max(0, Math.round((b - a) / 86400000));
            }

            // Build flat list with sub-activities
            var pptxFlat = [];
            visibleNodes.forEach(function(n) {
                pptxFlat.push({ data: n, isSub: false });
                if (typeof DataModel !== 'undefined') {
                    var mainTest = DataModel.testColumns.find(function(t) { return t.id === n.id; });
                    if (mainTest && mainTest.subActivities && mainTest.subActivities.length > 0) {
                        mainTest.subActivities.forEach(function(sub) {
                            pptxFlat.push({ data: sub, isSub: true });
                        });
                    }
                }
            });

            var pptxTotalDays = 0;
            var pptxTotalDaysMain = 0;

            var dataRows = pptxFlat.map(function(entry, i) {
                var n = entry.data;
                var bg = i % 2 === 0 ? P.rowAlt : P.rowNorm;
                var typeColor = FlowData.colors[n.type]
                    ? FlowData.colors[n.type].primary.replace('#', '') : '888888';
                function cell(txt, extra) {
                    var opts = { fontSize: entry.isSub ? 9 : 10, fontFace: 'Calibri', fill: { color: bg }, color: entry.isSub ? subTxt : cellTxt };
                    if (entry.isSub) opts.italic = true;
                    if (extra) { for (var k in extra) opts[k] = extra[k]; }
                    return { text: txt || '', options: opts };
                }
                var actName = entry.isSub ? '  \u2514 ' + (n.name || '') : (n.name || '');
                var dc = pptxDaysBetween(n.startDate, n.endDate);
                var daysStr = (dc == null) ? '\u2014' : (dc + 'd');
                if (dc != null) { pptxTotalDays += dc; if (!entry.isSub) pptxTotalDaysMain += dc; }
                return [
                    cell(actName),
                    cell(n.subtitle || ''),
                    cell(n.type, { color: typeColor, bold: true }),
                    cell(n.location),
                    cell(n.workpack),
                    cell(n.startDate),
                    cell(n.endDate),
                    cell(daysStr, { align: 'center' })
                ];
            });

            var tblBorderClr = isLight ? 'CCCCCC' : '28283c';

            s3.addTable([headerRow].concat(dataRows), {
                x: 0.4, y: 1.1, w: 12.5,
                colW: [2.8, 1.3, 1.0, 2.3, 1.2, 1.5, 1.5, 0.9],
                border: { pt: 0.5, color: tblBorderClr },
                rowH: 0.35, autoPage: true, autoPageRepeatHeader: true
            });

            var pptxSubCount = pptxFlat.filter(function(e){return e.isSub;}).length;
            var pptxFooter = visibleNodes.length + ' activities';
            if (pptxSubCount > 0) pptxFooter += ' + ' + pptxSubCount + ' sub-activities';
            pptxFooter += ' \u00B7 ' + pptxTotalDaysMain + ' total days';
            if (pptxSubCount > 0 && pptxTotalDays !== pptxTotalDaysMain) {
                pptxFooter += ' (' + pptxTotalDays + ' incl. sub-activities)';
            }
            s3.addText(pptxFooter, {
                x: 0.5, y: 6.8, w: 12, h: 0.4,
                fontSize: 10, fontFace: 'Calibri', color: '999999', italic: true
            });

            // -- Slide 4: Connections & Transfers (if any) -----
            // Only include edges whose both endpoints are visible on the flow diagram
            var pptxVisibleEdges = FlowData.edges.filter(function(edge) {
                var fromNode = FlowData.getNode(edge.fromNodeId);
                var toNode   = FlowData.getNode(edge.toNodeId);
                if (!fromNode || !toNode) return false;
                if (typeof DataModel !== 'undefined') {
                    if (!DataModel.isActivityVisible(edge.fromNodeId)) return false;
                    if (!DataModel.isActivityVisible(edge.toNodeId))   return false;
                }
                if (FlowData.hiddenLanes) {
                    if (FlowData.hiddenLanes[fromNode.type]) return false;
                    if (FlowData.hiddenLanes[toNode.type])   return false;
                }
                return true;
            });

            if (pptxVisibleEdges.length > 0) {
                var s4 = pres.addSlide();
                s4.background = { color: P.tblBg };
                s4.addText('Connections & Equipment Transfers', {
                    x: 0.5, y: 0.3, w: 12, h: 0.6,
                    fontSize: 22, fontFace: 'Calibri', color: P.hdgClr, bold: true
                });

                // Summary line
                var pptxHidden = FlowData.edges.length - pptxVisibleEdges.length;
                var pptxSummary = pptxVisibleEdges.length + ' connection' +
                                  (pptxVisibleEdges.length === 1 ? '' : 's');
                if (pptxHidden > 0) {
                    pptxSummary += ' shown (' + pptxHidden + ' hidden — endpoint not visible)';
                }
                s4.addText(pptxSummary, {
                    x: 0.5, y: 0.85, w: 12, h: 0.3,
                    fontSize: 10, fontFace: 'Calibri', color: P.metaClr, italic: true
                });

                var eHeader = [hdr('From'), hdr('To'), hdr('Details'), hdr('Equipment Transfer')];
                var eBorderClr = isLight ? 'CCCCCC' : '28283c';
                var eRows = pptxVisibleEdges.slice(0, 30).map(function(e, i) {
                    var from = FlowData.getNode(e.fromNodeId);
                    var to   = FlowData.getNode(e.toNodeId);
                    var bg   = i % 2 === 0 ? P.rowAlt : P.rowNorm;
                    function c(txt) {
                        return { text: txt || '', options: { fontSize: 9, fontFace: 'Calibri', fill: { color: bg }, color: cellTxt } };
                    }

                    // Build transfer items string
                    var transferStr = '\u2014';
                    if (e.transferItems && Object.keys(e.transferItems).length > 0) {
                        var parts = [];
                        for (var tk in e.transferItems) {
                            var ti = e.transferItems[tk];
                            if (ti && ti.description) {
                                var s = ti.description;
                                if (ti.partNo) s += ' (' + ti.partNo + ')';
                                if (ti.qty) s += ' x' + ti.qty;
                                parts.push(s);
                            }
                        }
                        if (parts.length > 0) transferStr = parts.join(', ');
                    }

                    return [
                        c(from ? from.name : '?'),
                        c(to ? to.name : '?'),
                        c(e.label || '\u2014'),
                        c(transferStr)
                    ];
                });

                s4.addTable([eHeader].concat(eRows), {
                    x: 0.4, y: 1.25, w: 12.5,
                    colW: [3.0, 3.0, 2.0, 4.5],
                    border: { pt: 0.5, color: eBorderClr },
                    rowH: 0.35, autoPage: true, autoPageRepeatHeader: true
                });
            }

            await pres.writeFile({ fileName: this._getFilename('pptx') });
        } catch (err) {
            console.error('PPTX export error:', err);
            alert('PowerPoint export failed: ' + err.message);
        }
        this._showLoading(false);
    },

    // ══════════════════════════════════════════
    //  SVG Export (vector edges + node outlines)
    // ══════════════════════════════════════════
    exportSVG() {
        this._closeDropdown();
        this._showLoading(true, 'Generating SVG\u2026');
        try {
            var edgeLayer = document.getElementById('edgeLayer');
            if (!edgeLayer) throw new Error('Edge layer not found');

            var svgClone   = edgeLayer.cloneNode(true);
            var canvasEl   = document.getElementById('flowCanvas');
            var canvasRect = canvasEl.getBoundingClientRect();
            var w = canvasRect.width;
            var h = canvasRect.height;

            svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            svgClone.setAttribute('width', w);
            svgClone.setAttribute('height', h);
            svgClone.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
            svgClone.style.position   = '';
            svgClone.style.background = document.body.classList.contains('light-theme') ? '#f0f2f5' : '#0a0a12';

            document.querySelectorAll('.flow-node').forEach(function(nel) {
                var nr = nel.getBoundingClientRect();
                var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('x', nr.left - canvasRect.left);
                rect.setAttribute('y', nr.top  - canvasRect.top);
                rect.setAttribute('width', nr.width);
                rect.setAttribute('height', nr.height);
                rect.setAttribute('rx', '8');
                rect.setAttribute('fill', 'rgba(20,25,40,0.85)');
                rect.setAttribute('stroke', 'rgba(0,212,255,0.25)');
                rect.setAttribute('stroke-width', '1');
                svgClone.insertBefore(rect, svgClone.firstChild);

                var nameEl = nel.querySelector('.node-name');
                if (nameEl) {
                    var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    txt.setAttribute('x', nr.left - canvasRect.left + 12);
                    txt.setAttribute('y', nr.top  - canvasRect.top  + 22);
                    txt.setAttribute('fill', '#e0e0e0');
                    txt.setAttribute('font-size', '12');
                    txt.setAttribute('font-family', 'Segoe UI, sans-serif');
                    txt.textContent = nameEl.textContent.trim();
                    svgClone.appendChild(txt);
                }
            });

            var blob = new Blob([new XMLSerializer().serializeToString(svgClone)], { type: 'image/svg+xml' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = this._getFilename('svg');
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('SVG export error:', err);
            alert('SVG export failed: ' + err.message);
        }
        this._showLoading(false);
    },

    // ══════════════════════════════════════════
    //  JSON Export (data-only, re-importable)
    // ══════════════════════════════════════════
    exportJSON() {
        this._closeDropdown();
        try {
            var data = FlowData.exportData();
            data.edges        = FlowData.edges;
            data.descriptions = FlowData.descriptions;

            var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = this._getFilename('json');
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('JSON export error:', err);
            alert('JSON export failed: ' + err.message);
        }
    },

    // ══════════════════════════════════════════
    //  Dropdown helpers
    // ══════════════════════════════════════════
    _closeDropdown() {
        var dd = document.getElementById('exportDropdown');
        if (dd) dd.classList.remove('active');
    },

    toggleDropdown() {
        var dd = document.getElementById('exportDropdown');
        if (!dd) return;
        dd.classList.toggle('active');

        if (dd.classList.contains('active')) {
            var handler = function(e) {
                if (!e.target.closest('.export-dropdown-wrap')) {
                    dd.classList.remove('active');
                    document.removeEventListener('click', handler);
                }
            };
            setTimeout(function() { document.addEventListener('click', handler); }, 0);
        }
    }
};
