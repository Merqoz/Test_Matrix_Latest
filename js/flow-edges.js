/**
 * FLOW-EDGES.JS - Edge / Connection Drawing
 * Handles creating, rendering, and managing edges (connections) between nodes
 */

const FlowEdges = {
    // Drawing state
    isDrawing: false,
    drawingFromNodeId: null,
    tempLine: null,

    // Context menu state
    activeEdgeId: null,
    _justShowedMenu: false,

    /**
     * Render all edges as SVG paths
     */
    render() {
        var svg = document.getElementById('edgeLayer');
        if (!svg) return;

        // Clear selection state (SVG is about to be rebuilt)
        this._selectedEdgeId = null;

        var canvas = document.getElementById('flowCanvas');
        if (canvas) {
            svg.setAttribute('width', canvas.scrollWidth);
            svg.setAttribute('height', canvas.scrollHeight);
        }

        var tempLine = svg.querySelector('.edge-temp');
        svg.innerHTML = '';
        if (tempLine) svg.appendChild(tempLine);

        // Click on SVG background deselects
        var self = this;
        svg.addEventListener('click', function(e) {
            if (!e.target.closest('.edge-group') && !e.target.closest('.edge-handle')) {
                self.deselectEdge();
            }
        });

        // Pre-compute port usage: count how many edges connect to each node+side
        var portCounts = {};   // key: "nodeId-side" → total count
        var portIndex  = {};   // key: "edgeId-nodeId-side" → index

        var visibleEdges = FlowData.edges.filter(function(edge) {
            if (typeof DataModel !== 'undefined') {
                if (!DataModel.isActivityVisible(edge.fromNodeId) ||
                    !DataModel.isActivityVisible(edge.toNodeId)) return false;
            }
            return true;
        });

        // First pass: determine port side for each edge
        var edgePorts = {};
        visibleEdges.forEach(function(edge) {
            var ports = FlowNodes.getBestPorts(edge.fromNodeId, edge.toNodeId, edge);
            if (!ports) return;
            edgePorts[edge.id] = ports;

            var fromKey = edge.fromNodeId + '-' + ports.fromSide;
            var toKey   = edge.toNodeId + '-' + ports.toSide;
            portCounts[fromKey] = (portCounts[fromKey] || 0) + 1;
            portCounts[toKey]   = (portCounts[toKey]   || 0) + 1;
        });

        // Second pass: assign index per port, respecting stored portOrder
        var portAssigned = {};
        // Group edges by port key so we can sort within each group
        var portEdgeGroups = {};  // key: "nodeId-side-end" → [{edge, portKey, end}]
        visibleEdges.forEach(function(edge) {
            var ports = edgePorts[edge.id];
            if (!ports) return;
            var fromKey = edge.fromNodeId + '-' + ports.fromSide;
            var toKey   = edge.toNodeId + '-' + ports.toSide;
            if (!portEdgeGroups[fromKey]) portEdgeGroups[fromKey] = [];
            if (!portEdgeGroups[toKey]) portEdgeGroups[toKey] = [];
            portEdgeGroups[fromKey].push({ edge: edge, end: 'from' });
            portEdgeGroups[toKey].push({ edge: edge, end: 'to' });
        });
        // Sort each group by stored portOrder, then assign indices
        Object.keys(portEdgeGroups).forEach(function(key) {
            portEdgeGroups[key].sort(function(a, b) {
                var oa = (a.edge.portOrder && a.edge.portOrder[key + '-' + a.end]) || 0;
                var ob = (b.edge.portOrder && b.edge.portOrder[key + '-' + b.end]) || 0;
                return oa - ob;
            });
            portEdgeGroups[key].forEach(function(item, idx) {
                portIndex[item.edge.id + '-' + item.end] = idx;
            });
        });

        // Draw edges with computed offsets
        var self = this;
        this._lastPortCounts = portCounts;
        this._lastPortIndex = portIndex;
        this._lastEdgePorts = edgePorts;
        this._lastPortEdgeGroups = portEdgeGroups;
        visibleEdges.forEach(function(edge) {
            var ports = edgePorts[edge.id];
            if (!ports) return;

            var fromKey = edge.fromNodeId + '-' + ports.fromSide;
            var toKey   = edge.toNodeId + '-' + ports.toSide;

            var fromIdx   = portIndex[edge.id + '-from'];
            var fromTotal = portCounts[fromKey];
            var toIdx     = portIndex[edge.id + '-to'];
            var toTotal   = portCounts[toKey];

            self.drawEdge(svg, edge, ports, fromIdx, fromTotal, toIdx, toTotal);
        });
    },

    /**
     * Draw a single edge as an SVG bezier curve
     */
    drawEdge(svg, edge, ports, fromIdx, fromTotal, toIdx, toTotal) {
        var from = FlowNodes.getPortPosition(edge.fromNodeId, ports.fromSide, fromIdx, fromTotal);
        var to   = FlowNodes.getPortPosition(edge.toNodeId,   ports.toSide,   toIdx,   toTotal);
        if (!from || !to) return;

        // Create group
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.classList.add('edge-group');
        group.dataset.edgeId = edge.id;

        // Calculate bezier control points
        const path = this.buildBezierPath(from, to, ports);

        // Invisible fat hit area for easier clicking
        const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitLine.setAttribute('d', path);
        hitLine.classList.add('edge-line-hit');
        group.appendChild(hitLine);

        // Visible line
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', path);
        line.classList.add('edge-line');
        group.appendChild(line);

        // Arrow at the end
        this.addArrowhead(group, from, to, ports);

        // Directional arrow along the line (mid-path) so the travel
        // direction stays visible even if the endpoint is hidden by a node.
        this.addDirectionArrow(group, line);

        // Label and/or transfer indicator
        var transferCount = edge.transferItems ? Object.keys(edge.transferItems).length : 0;
        var displayLabel = edge.label || '';
        if (transferCount > 0) {
            displayLabel = (displayLabel ? displayLabel + '  ' : '') + '\uD83D\uDCE6' + transferCount;
        }
        if (displayLabel) {
            this.addLabel(group, from, to, displayLabel);
        }

        // Events
        group.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            this.showContextMenu(e, edge.id);
        });
        group.addEventListener('dblclick', e => {
            e.preventDefault();
            this.editLabel(edge.id);
        });
        group.addEventListener('click', e => {
            e.stopPropagation();
            this.selectEdge(edge.id, ports);
        });

        // Tooltip showing transferred equipment
        if (transferCount > 0) {
            var tipLines = [];
            for (var tKey in edge.transferItems) {
                var tItem = edge.transferItems[tKey];
                if (typeof tItem === 'object' && tItem.description) {
                    tipLines.push(tItem.description + ' (' + tItem.partNo + ') x' + tItem.qty);
                }
            }
            if (tipLines.length > 0) {
                var titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                titleEl.textContent = 'Equipment transfer:\n' + tipLines.join('\n');
                group.appendChild(titleEl);
            }
        }

        svg.appendChild(group);
    },

    /**
     * Build a bezier curve path between two points
     */
    buildBezierPath(from, to, ports) {
        const dx = Math.abs(to.x - from.x);
        const dy = Math.abs(to.y - from.y);
        const cpOffset = Math.max(60, dx * 0.4);
        const cpOffsetV = Math.max(60, dy * 0.4);

        let cp1x, cp1y, cp2x, cp2y;
        const fs = ports.fromSide, ts = ports.toSide;

        if (fs === 'right' && ts === 'left') {
            cp1x = from.x + cpOffset; cp1y = from.y;
            cp2x = to.x - cpOffset;   cp2y = to.y;
        } else if (fs === 'left' && ts === 'right') {
            cp1x = from.x - cpOffset; cp1y = from.y;
            cp2x = to.x + cpOffset;   cp2y = to.y;
        } else if (fs === 'bottom' && ts === 'top') {
            cp1x = from.x; cp1y = from.y + cpOffsetV;
            cp2x = to.x;   cp2y = to.y - cpOffsetV;
        } else if (fs === 'top' && ts === 'bottom') {
            cp1x = from.x; cp1y = from.y - cpOffsetV;
            cp2x = to.x;   cp2y = to.y + cpOffsetV;
        } else if (fs === 'right' && ts === 'top') {
            cp1x = from.x + cpOffset; cp1y = from.y;
            cp2x = to.x;              cp2y = to.y - cpOffsetV;
        } else if (fs === 'right' && ts === 'bottom') {
            cp1x = from.x + cpOffset; cp1y = from.y;
            cp2x = to.x;              cp2y = to.y + cpOffsetV;
        } else if (fs === 'left' && ts === 'top') {
            cp1x = from.x - cpOffset; cp1y = from.y;
            cp2x = to.x;              cp2y = to.y - cpOffsetV;
        } else if (fs === 'left' && ts === 'bottom') {
            cp1x = from.x - cpOffset; cp1y = from.y;
            cp2x = to.x;              cp2y = to.y + cpOffsetV;
        } else if (fs === 'top' && ts === 'left') {
            cp1x = from.x; cp1y = from.y - cpOffsetV;
            cp2x = to.x - cpOffset;   cp2y = to.y;
        } else if (fs === 'top' && ts === 'right') {
            cp1x = from.x; cp1y = from.y - cpOffsetV;
            cp2x = to.x + cpOffset;   cp2y = to.y;
        } else if (fs === 'bottom' && ts === 'left') {
            cp1x = from.x; cp1y = from.y + cpOffsetV;
            cp2x = to.x - cpOffset;   cp2y = to.y;
        } else if (fs === 'bottom' && ts === 'right') {
            cp1x = from.x; cp1y = from.y + cpOffsetV;
            cp2x = to.x + cpOffset;   cp2y = to.y;
        } else if (fs === 'top' && ts === 'top') {
            var upOff = Math.max(60, dy * 0.5);
            cp1x = from.x; cp1y = from.y - upOff;
            cp2x = to.x;   cp2y = to.y - upOff;
        } else if (fs === 'bottom' && ts === 'bottom') {
            var downOff = Math.max(60, dy * 0.5);
            cp1x = from.x; cp1y = from.y + downOff;
            cp2x = to.x;   cp2y = to.y + downOff;
        } else {
            // Same side fallback (e.g., right→right)
            const offset = Math.max(80, Math.abs(to.y - from.y) * 0.5);
            if (fs === 'left' && ts === 'left') {
                cp1x = from.x - offset; cp1y = from.y;
                cp2x = to.x - offset;   cp2y = to.y;
            } else {
                cp1x = from.x + offset; cp1y = from.y;
                cp2x = to.x + offset;   cp2y = to.y;
            }
        }

        return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
    },

    /**
     * Add an arrowhead near the target node
     */
    addArrowhead(group, from, to, ports) {
        const arrowSize = 8;
        let adjustedAngle;
        if (ports.toSide === 'left') adjustedAngle = Math.PI;
        else if (ports.toSide === 'right') adjustedAngle = 0;
        else if (ports.toSide === 'top') adjustedAngle = -Math.PI / 2;
        else if (ports.toSide === 'bottom') adjustedAngle = Math.PI / 2;
        else adjustedAngle = Math.atan2(to.y - from.y, to.x - from.x);

        // Same-side override
        if (ports.fromSide === ports.toSide) {
            if (ports.toSide === 'right') adjustedAngle = 0;
            else if (ports.toSide === 'left') adjustedAngle = Math.PI;
            else if (ports.toSide === 'top') adjustedAngle = -Math.PI / 2;
            else if (ports.toSide === 'bottom') adjustedAngle = Math.PI / 2;
        }

        const tipX = to.x;
        const tipY = to.y;

        const p1x = tipX - arrowSize * Math.cos(adjustedAngle - 0.4);
        const p1y = tipY - arrowSize * Math.sin(adjustedAngle - 0.4);
        const p2x = tipX - arrowSize * Math.cos(adjustedAngle + 0.4);
        const p2y = tipY - arrowSize * Math.sin(adjustedAngle + 0.4);

        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrow.setAttribute('points', `${tipX},${tipY} ${p1x},${p1y} ${p2x},${p2y}`);
        arrow.classList.add('edge-arrow');
        group.appendChild(arrow);
    },

    /**
     * Draw a small arrow midway along the edge path pointing in the
     * direction of travel (from → to). Uses the rendered path's
     * getPointAtLength so it follows the bezier curve exactly.
     */
    addDirectionArrow(group, pathEl) {
        var total;
        try { total = pathEl.getTotalLength(); } catch (e) { return; }
        if (!total || !isFinite(total) || total < 20) return; // too short to bother

        // Place the arrow ~80% along the path so it sits close to the
        // target node, clearly indicating where the edge goes.
        var pos = total * 0.8;
        var pMid  = pathEl.getPointAtLength(pos);
        // Sample slightly ahead/behind to get the tangent direction
        var delta = Math.min(6, total * 0.05);
        var pBack = pathEl.getPointAtLength(Math.max(0, pos - delta));
        var pFwd  = pathEl.getPointAtLength(Math.min(total, pos + delta));
        var angle = Math.atan2(pFwd.y - pBack.y, pFwd.x - pBack.x);

        var size = 11;
        // Tip points forward (direction of travel), base trails behind
        var tipX = pMid.x + size * 0.6 * Math.cos(angle);
        var tipY = pMid.y + size * 0.6 * Math.sin(angle);
        var b1x = pMid.x - size * 0.5 * Math.cos(angle) + size * 0.5 * Math.cos(angle - Math.PI / 2);
        var b1y = pMid.y - size * 0.5 * Math.sin(angle) + size * 0.5 * Math.sin(angle - Math.PI / 2);
        var b2x = pMid.x - size * 0.5 * Math.cos(angle) + size * 0.5 * Math.cos(angle + Math.PI / 2);
        var b2y = pMid.y - size * 0.5 * Math.sin(angle) + size * 0.5 * Math.sin(angle + Math.PI / 2);

        var arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrow.setAttribute('points', tipX + ',' + tipY + ' ' + b1x + ',' + b1y + ' ' + b2x + ',' + b2y);
        arrow.classList.add('edge-direction-arrow');
        group.appendChild(arrow);
    },

    /**
     * Add a label to an edge at the midpoint
     */
    addLabel(group, from, to, text) {
        const mx = (from.x + to.x) / 2;
        const my = (from.y + to.y) / 2;

        const labelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        labelGroup.classList.add('edge-label-group');

        // Measure text width approximately
        const textWidth = text.length * 6.5 + 16;
        const textHeight = 22;

        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bg.setAttribute('x', mx - textWidth / 2);
        bg.setAttribute('y', my - textHeight / 2);
        bg.setAttribute('width', textWidth);
        bg.setAttribute('height', textHeight);
        bg.classList.add('edge-label-bg');
        labelGroup.appendChild(bg);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', mx);
        label.setAttribute('y', my);
        label.classList.add('edge-label-text');
        label.textContent = text;
        labelGroup.appendChild(label);

        group.appendChild(labelGroup);
    },

    /**
     * Start drawing an edge from a node port
     */
    startEdge(event, nodeId) {
        event.preventDefault();
        event.stopPropagation();

        this.isDrawing = true;
        this.drawingFromNodeId = nodeId;
        document.body.classList.add('edge-mode');

        // Highlight source node
        const nodeEl = document.getElementById(`node-${nodeId}`);
        if (nodeEl) nodeEl.classList.add('edge-source');

        // Show indicator
        const indicator = document.getElementById('edgeModeIndicator');
        if (indicator) indicator.classList.add('active');

        // Create temp line in SVG
        const svg = document.getElementById('edgeLayer');
        if (svg) {
            const tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            tempLine.classList.add('edge-temp');
            tempLine.id = 'tempEdgeLine';
            svg.appendChild(tempLine);
            this.tempLine = tempLine;
        }

        // Track mouse movement
        this._onMouseMove = e => this.onDrawMove(e);
        this._onMouseUp = e => this.cancelDraw(e);
        this._onKeyDown = e => { if (e.key === 'Escape') this.cancelDraw(e); };
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
        document.addEventListener('keydown', this._onKeyDown);
    },

    /**
     * Track mouse during edge drawing
     */
    onDrawMove(event) {
        if (!this.isDrawing || !this.tempLine) return;

        var canvas = document.getElementById('flowCanvas');
        if (!canvas) return;

        var canvasRect = canvas.getBoundingClientRect();
        var fromCenter = FlowNodes.getNodeCenter(this.drawingFromNodeId);
        if (!fromCenter) return;

        // Mouse position relative to canvas (no scroll offset needed —
        // getBoundingClientRect already accounts for scroll)
        var mouseX = event.clientX - canvasRect.left;
        var mouseY = event.clientY - canvasRect.top;

        var dx = mouseX - fromCenter.x;
        var cpOffset = Math.max(40, Math.abs(dx) * 0.4);

        var path = 'M ' + fromCenter.x + ' ' + fromCenter.y + ' C ' + (fromCenter.x + cpOffset) + ' ' + fromCenter.y + ', ' + (mouseX - cpOffset) + ' ' + mouseY + ', ' + mouseX + ' ' + mouseY;
        this.tempLine.setAttribute('d', path);
    },

    /**
     * Complete the edge to a target node
     */
    finishEdge(event, targetNodeId) {
        if (!this.isDrawing || !this.drawingFromNodeId) return;
        event.stopPropagation();

        if (this.drawingFromNodeId !== targetNodeId) {
            const edge = FlowData.addEdge(this.drawingFromNodeId, targetNodeId);
            if (edge) {
                // Prompt for label
                this.cleanupDraw();
                this.editLabel(edge.id);
                this.render();
                return;
            }
        }

        this.cleanupDraw();
    },

    /**
     * Cancel edge drawing
     */
    cancelDraw(event) {
        if (!this.isDrawing) return;
        // Don't cancel if mouseup is on a node (that's handled by finishEdge)
        if (event && event.type === 'mouseup') {
            const target = event.target;
            if (target.closest && target.closest('.flow-node')) return;
        }
        this.cleanupDraw();
    },

    /**
     * Clean up drawing state
     */
    cleanupDraw() {
        this.isDrawing = false;
        document.body.classList.remove('edge-mode');

        // Remove source highlight
        if (this.drawingFromNodeId) {
            const nodeEl = document.getElementById(`node-${this.drawingFromNodeId}`);
            if (nodeEl) nodeEl.classList.remove('edge-source');
        }
        this.drawingFromNodeId = null;

        // Remove temp line
        const tempLine = document.getElementById('tempEdgeLine');
        if (tempLine) tempLine.remove();
        this.tempLine = null;

        // Hide indicator
        const indicator = document.getElementById('edgeModeIndicator');
        if (indicator) indicator.classList.remove('active');

        // Remove listeners
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        document.removeEventListener('keydown', this._onKeyDown);
    },

    /**
     * Show context menu for an edge
     */
    showContextMenu(event, edgeId) {
        this.activeEdgeId = edgeId;
        this._justShowedMenu = true;  // prevent canvas menu from also firing
        const menu = document.getElementById('contextMenu');
        if (!menu) return;

        // Close canvas menu if it's open
        const cmenu = document.getElementById('canvasContextMenu');
        if (cmenu) cmenu.classList.remove('active');

        menu.style.left = event.clientX + 'px';
        menu.style.top = event.clientY + 'px';
        menu.classList.add('active');

        // Close on outside click
        setTimeout(() => {
            const closeHandler = () => {
                menu.classList.remove('active');
                document.removeEventListener('click', closeHandler);
            };
            document.addEventListener('click', closeHandler);
        }, 10);
    },

    /**
     * Edit edge details (label + equipment transfer)
     */
    editLabel(edgeId) {
        const edge = FlowData.getEdge(edgeId);
        if (!edge) return;

        this.activeEdgeId = edgeId;
        const overlay = document.getElementById('labelModalOverlay');
        const input = document.getElementById('labelInput');
        if (!overlay || !input) return;

        input.value = edge.label || '';

        // Populate equipment transfer list
        this._renderEdgeEquipment(edge);

        overlay.classList.add('active');
        setTimeout(() => input.focus(), 100);
    },

    /**
     * Render the equipment transfer checklist.
     * Shows items that exist in the source node's activity.
     * Items also in the target node get a "shared" indicator.
     */
    _renderEdgeEquipment(edge) {
        var listEl = document.getElementById('edgeEquipmentList');
        if (!listEl) return;

        var m = typeof StorageManager !== 'undefined' ? StorageManager.loadMatrix() : null;
        if (!m || !m.sections) {
            listEl.innerHTML = '<div class="edge-eq-empty">No matrix data</div>';
            return;
        }

        var fromId = edge.fromNodeId;
        var toId = edge.toNodeId;
        var fromNode = FlowData.getNode(fromId);
        var toNode = FlowData.getNode(toId);

        // Collect items in source and target
        var items = [];
        var targetItems = {};

        m.sections.forEach(function(section) {
            section.rows.forEach(function(row, ri) {
                var fromQty = row.testQty ? row.testQty[fromId] : '';
                var toQty = row.testQty ? row.testQty[toId] : '';
                var hasFrom = fromQty && fromQty !== '0' && String(fromQty).trim() !== '';
                var hasTo = toQty && toQty !== '0' && String(toQty).trim() !== '';

                if (hasFrom) {
                    var key = section.id + '-' + ri;
                    items.push({
                        key: key,
                        partNo: row.partNo || '-',
                        description: row.description || '-',
                        fromQty: fromQty,
                        toQty: hasTo ? toQty : '',
                        shared: hasTo
                    });
                }
                if (hasTo) {
                    targetItems[section.id + '-' + ri] = true;
                }
            });
        });

        if (items.length === 0) {
            listEl.innerHTML = '<div class="edge-eq-empty">No equipment in source activity' +
                (fromNode ? ' (' + fromNode.name + ')' : '') + '</div>';
            return;
        }

        // Current transfer selections
        var transfers = edge.transferItems || {};

        var html = '<div class="edge-eq-header">' +
            '<span>From: <strong>' + (fromNode ? fromNode.name : '?') + '</strong></span>' +
            '<span>To: <strong>' + (toNode ? toNode.name : '?') + '</strong></span>' +
            '</div>';

        // Table header
        html += '<div class="edge-eq-scroll">' +
            '<table class="edge-eq-table"><thead><tr>' +
            '<th class="edge-eq-th-cb"></th>' +
            '<th>Description</th>' +
            '<th>Part No.</th>' +
            '<th>QTY</th>' +
            '<th></th>' +
            '</tr></thead><tbody>';

        items.forEach(function(item) {
            var checked = transfers[item.key] ? ' checked' : '';
            var sharedTag = item.shared ? '<span class="edge-eq-shared" title="Also in target activity">↔</span>' : '';
            var rowClass = item.shared ? ' class="shared"' : '';
            html += '<tr' + rowClass + '>' +
                '<td class="edge-eq-td-cb"><input type="checkbox" data-key="' + item.key + '"' + checked + '></td>' +
                '<td class="edge-eq-td-desc">' + item.description + '</td>' +
                '<td class="edge-eq-td-pn">' + item.partNo + '</td>' +
                '<td class="edge-eq-td-qty">' + item.fromQty + '</td>' +
                '<td class="edge-eq-td-shared">' + sharedTag + '</td>' +
            '</tr>';
        });

        html += '</tbody></table></div>';
        listEl.innerHTML = html;

        // Make entire row clickable to toggle checkbox
        listEl.querySelectorAll('.edge-eq-table tbody tr').forEach(function(row) {
            row.addEventListener('click', function(e) {
                if (e.target.tagName === 'INPUT') return; // already handled
                var cb = row.querySelector('input[type="checkbox"]');
                if (cb) cb.checked = !cb.checked;
            });
        });
    },

    /**
     * Save label and equipment transfers
     */
    saveLabel() {
        const input = document.getElementById('labelInput');
        if (!input || !this.activeEdgeId) return;

        var edge = FlowData.getEdge(this.activeEdgeId);
        if (edge) {
            edge.label = input.value.trim();

            // Collect checked equipment transfers with item details
            var transfers = {};
            var listEl = document.getElementById('edgeEquipmentList');
            if (listEl) {
                listEl.querySelectorAll('.edge-eq-table tbody tr').forEach(function(row) {
                    var cb = row.querySelector('input[type="checkbox"]');
                    if (!cb || !cb.checked) return;
                    var key = cb.dataset.key;
                    var descTd = row.querySelector('.edge-eq-td-desc');
                    var pnTd = row.querySelector('.edge-eq-td-pn');
                    var qtyTd = row.querySelector('.edge-eq-td-qty');
                    transfers[key] = {
                        description: descTd ? descTd.textContent.trim() : '',
                        partNo: pnTd ? pnTd.textContent.trim() : '',
                        qty: qtyTd ? qtyTd.textContent.trim() : ''
                    };
                });
            }
            edge.transferItems = transfers;
            FlowData.save();
        }

        this.closeLabelModal();
        this.render();
    },

    /**
     * Close label modal
     */
    closeLabelModal() {
        const overlay = document.getElementById('labelModalOverlay');
        if (overlay) overlay.classList.remove('active');
        this.activeEdgeId = null;
    },

    /**
     * Delete the active edge (from context menu)
     */
    deleteActiveEdge() {
        if (!this.activeEdgeId) return;
        FlowData.removeEdge(this.activeEdgeId);
        this.activeEdgeId = null;
        this._selectedEdgeId = null;

        const menu = document.getElementById('contextMenu');
        if (menu) menu.classList.remove('active');

        this.render();
    },

    /**
     * Reset custom port routing on an edge (from context menu)
     */
    resetEdgePorts(edgeId) {
        var eid = edgeId || this.activeEdgeId;
        var edge = FlowData.getEdge(eid);
        if (edge) {
            delete edge.fromSide;
            delete edge.toSide;
            FlowData.save();
        }
        this._selectedEdgeId = null;
        var menu = document.getElementById('contextMenu');
        if (menu) menu.classList.remove('active');
        this.render();
    },

    /**
     * Reverse the direction of an edge: swap from/to node IDs and any
     * stored port sides so the arrow points the other way.
     */
    reverseEdge(edgeId) {
        var eid = edgeId || this.activeEdgeId;
        var edge = FlowData.getEdge(eid);
        if (edge) {
            var tmpNode = edge.fromNodeId;
            edge.fromNodeId = edge.toNodeId;
            edge.toNodeId = tmpNode;

            // Swap explicit port sides if the user had set them
            var tmpSide = edge.fromSide;
            edge.fromSide = edge.toSide;
            edge.toSide = tmpSide;
            if (edge.fromSide === undefined) delete edge.fromSide;
            if (edge.toSide === undefined) delete edge.toSide;

            // Clear cached port ordering — it was keyed to the old direction
            if (edge.portOrder) delete edge.portOrder;

            FlowData.save();
        }
        this._selectedEdgeId = null;
        var menu = document.getElementById('contextMenu');
        if (menu) menu.classList.remove('active');
        this.render();
    },

    // ══════════════════════════════════════════════════════
    // EDGE ENDPOINT REPOSITIONING
    // ══════════════════════════════════════════════════════

    _selectedEdgeId: null,
    _handleDrag: null,

    selectEdge(edgeId, ports) {
        // If already selected, deselect
        if (this._selectedEdgeId === edgeId) { this.deselectEdge(); return; }
        this.deselectEdge();
        this._selectedEdgeId = edgeId;
        // Raise SVG layer above nodes so handles are clickable
        var svg = document.getElementById('edgeLayer');
        if (svg) svg.classList.add('edge-active');
        // Highlight the edge group
        var g = document.querySelector('.edge-group[data-edge-id="'+edgeId+'"]');
        if (g) g.classList.add('edge-selected');
        this._showHandles(edgeId, ports);
    },

    deselectEdge() {
        this._selectedEdgeId = null;
        // Lower SVG layer back to normal
        var svg = document.getElementById('edgeLayer');
        if (svg) svg.classList.remove('edge-active');
        // Remove highlights
        document.querySelectorAll('.edge-selected').forEach(function(el){ el.classList.remove('edge-selected'); });
        // Remove handle elements
        document.querySelectorAll('.edge-handle').forEach(function(el){ el.remove(); });
    },

    _showHandles(edgeId, ports) {
        var edge = FlowData.getEdge(edgeId);
        if (!edge) return;
        var svg = document.getElementById('edgeLayer');
        if (!svg) return;
        var self = this;

        // Get actual computed positions for this edge's endpoints
        var pc = this._lastPortCounts || {};
        var pi = this._lastPortIndex || {};
        var ep = this._lastEdgePorts || {};
        var peg = this._lastPortEdgeGroups || {};

        var fromKey = edge.fromNodeId + '-' + ports.fromSide;
        var toKey = edge.toNodeId + '-' + ports.toSide;
        var fromIdx = pi[edge.id + '-from'] || 0;
        var toIdx = pi[edge.id + '-to'] || 0;
        var fromTotal = pc[fromKey] || 1;
        var toTotal = pc[toKey] || 1;

        var fromPos = FlowNodes.getPortPosition(edge.fromNodeId, ports.fromSide, fromIdx, fromTotal);
        var toPos = FlowNodes.getPortPosition(edge.toNodeId, ports.toSide, toIdx, toTotal);
        if (!fromPos || !toPos) return;

        // Helper — build a handle group with an invisible hit ring, a halo, and a visible dot
        function buildHandle(pos, end, sideLabel) {
            var g = document.createElementNS('http://www.w3.org/2000/svg','g');
            g.classList.add('edge-handle', 'edge-endpoint-handle');
            g.dataset.end = end;

            // Soft halo behind the dot (purely decorative)
            var halo = document.createElementNS('http://www.w3.org/2000/svg','circle');
            halo.setAttribute('cx', pos.x); halo.setAttribute('cy', pos.y); halo.setAttribute('r', '14');
            halo.classList.add('edge-handle-halo');
            g.appendChild(halo);

            // Big invisible hit target for easier grabbing
            var hit = document.createElementNS('http://www.w3.org/2000/svg','circle');
            hit.setAttribute('cx', pos.x); hit.setAttribute('cy', pos.y); hit.setAttribute('r', '16');
            hit.classList.add('edge-handle-hit');
            g.appendChild(hit);

            // Visible dot
            var c = document.createElementNS('http://www.w3.org/2000/svg','circle');
            c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y); c.setAttribute('r', '9');
            c.classList.add('edge-handle-dot');
            g.appendChild(c);

            // Side label
            var t = document.createElementNS('http://www.w3.org/2000/svg','text');
            t.setAttribute('x', pos.x); t.setAttribute('y', pos.y - 16);
            t.classList.add('edge-handle-label');
            t.textContent = sideLabel;
            g.appendChild(t);

            return { g: g, halo: halo, hit: hit, circle: c, text: t };
        }

        var hFrom = buildHandle(fromPos, 'from', ports.fromSide);
        svg.appendChild(hFrom.g);
        var hTo = buildHandle(toPos, 'to', ports.toSide);
        svg.appendChild(hTo.g);

        // Show port side indicators
        this._showPortIndicators(edge.fromNodeId);
        this._showPortIndicators(edge.toNodeId);

        // Show slot indicators for multi-connection ports
        this._showSlotIndicators(svg, edge, 'from', fromKey, ports.fromSide, fromIdx, fromTotal);
        this._showSlotIndicators(svg, edge, 'to', toKey, ports.toSide, toIdx, toTotal);

        // Drag handlers — bind on ALL parts of the handle for maximum reliability
        var handlePairs = [
            { h: hFrom, end: 'from', nodeId: edge.fromNodeId },
            { h: hTo,   end: 'to',   nodeId: edge.toNodeId   }
        ];
        handlePairs.forEach(function(hp) {
            function startDrag(e) {
                if (e.button !== 0) return;
                e.preventDefault(); e.stopPropagation();
                self._handleDrag = {
                    edgeId: edgeId,
                    end: hp.end,
                    nodeId: hp.nodeId,
                    handle: hp.h.g,
                    circle: hp.h.circle,
                    halo: hp.h.halo,
                    text: hp.h.text,
                    startX: e.clientX,
                    startY: e.clientY
                };
                hp.h.g.classList.add('edge-handle-dragging');
                // Mark the OTHER endpoint as anchored (visually fixed)
                var otherG = hp.end === 'from' ? hTo.g : hFrom.g;
                if (otherG) otherG.classList.add('edge-handle-anchored');
                document.addEventListener('mousemove', self._onHandleMove);
                document.addEventListener('mouseup',   self._onHandleUp);
                document.addEventListener('keydown',   self._onHandleKey);
            }
            hp.h.g.addEventListener('mousedown', startDrag);
            hp.h.circle.addEventListener('mousedown', startDrag);
            hp.h.hit.addEventListener('mousedown', startDrag);
        });
    },

    /** Show clickable slot dots for each connection sharing a port */
    _showSlotIndicators(svg, selectedEdge, end, portKey, side, currentIdx, totalSlots) {
        if (totalSlots <= 1) return;
        var self = this;
        var nodeId = end === 'from' ? selectedEdge.fromNodeId : selectedEdge.toNodeId;
        var peg = this._lastPortEdgeGroups || {};
        var group = peg[portKey] || [];

        for (var i = 0; i < totalSlots; i++) {
            var pos = FlowNodes.getPortPosition(nodeId, side, i, totalSlots);
            if (!pos) continue;
            var isCurrent = (i === currentIdx);

            var g = document.createElementNS('http://www.w3.org/2000/svg','g');
            g.classList.add('edge-handle', 'edge-slot-group');

            // Slot dot
            var dot = document.createElementNS('http://www.w3.org/2000/svg','circle');
            dot.setAttribute('cx', pos.x);
            dot.setAttribute('cy', pos.y);
            dot.setAttribute('r', isCurrent ? '6' : '5');
            dot.classList.add('edge-slot-dot');
            if (isCurrent) dot.classList.add('slot-current');
            g.appendChild(dot);

            // Number label offset from the dot
            var label = document.createElementNS('http://www.w3.org/2000/svg','text');
            var lx = (side === 'left') ? pos.x - 16 : (side === 'right') ? pos.x + 16 : pos.x;
            var ly = (side === 'top') ? pos.y - 12 : (side === 'bottom') ? pos.y + 16 : pos.y + 3;
            label.setAttribute('x', lx);
            label.setAttribute('y', ly);
            label.classList.add('edge-slot-label');
            label.textContent = (i + 1);
            g.appendChild(label);

            // Find the edge that occupies this slot and show its target node name
            if (!isCurrent && group[i]) {
                var siblingEdge = group[i].edge;
                var siblingEnd = group[i].end;
                var otherNodeId = siblingEnd === 'from' ? siblingEdge.toNodeId : siblingEdge.fromNodeId;
                var otherNode = FlowData.getNode(otherNodeId);
                if (otherNode) {
                    var tip = document.createElementNS('http://www.w3.org/2000/svg','title');
                    tip.textContent = 'Swap with → ' + otherNode.name;
                    g.appendChild(tip);
                }
            } else if (isCurrent) {
                var tip2 = document.createElementNS('http://www.w3.org/2000/svg','title');
                tip2.textContent = 'Current position (' + (i+1) + '/' + totalSlots + ')';
                g.appendChild(tip2);
            }

            // Click to swap
            if (!isCurrent) {
                g.style.cursor = 'pointer';
                (function(slotIdx) {
                    g.addEventListener('click', function(e) {
                        e.stopPropagation();
                        self._swapSlot(selectedEdge, end, portKey, currentIdx, slotIdx, group);
                    });
                })(i);
            }

            svg.appendChild(g);
        }
    },

    /** Swap this edge's port order with the edge at targetIdx */
    _swapSlot(selectedEdge, end, portKey, currentIdx, targetIdx, group) {
        // Find the edge currently at targetIdx
        var targetItem = group[targetIdx];
        var currentItem = group[currentIdx];
        if (!targetItem || !currentItem) return;

        var targetEdge = targetItem.edge;
        var currentEdge = currentItem.edge;

        // Initialize portOrder objects
        if (!currentEdge.portOrder) currentEdge.portOrder = {};
        if (!targetEdge.portOrder) targetEdge.portOrder = {};

        var currentOrderKey = portKey + '-' + currentItem.end;
        var targetOrderKey = portKey + '-' + targetItem.end;

        // Swap: give current edge the target's order value, and vice versa
        var currentVal = currentEdge.portOrder[currentOrderKey] || currentIdx;
        var targetVal = targetEdge.portOrder[targetOrderKey] || targetIdx;

        currentEdge.portOrder[currentOrderKey] = targetVal;
        targetEdge.portOrder[targetOrderKey] = currentVal;

        FlowData.save();
        var edgeId = selectedEdge.id;
        this.deselectEdge();
        this.render();

        // Re-select after render
        var self = this;
        setTimeout(function() {
            var edge = FlowData.getEdge(edgeId);
            if (edge) {
                var ports = FlowNodes.getBestPorts(edge.fromNodeId, edge.toNodeId, edge);
                if (ports) self.selectEdge(edgeId, ports);
            }
        }, 50);
    },

    _showPortIndicators(nodeId) {
        var svg = document.getElementById('edgeLayer');
        if (!svg) return;
        var self = this;
        var edgeId = this._selectedEdgeId;
        var edge = FlowData.getEdge(edgeId);
        if (!edge) return;

        var sides = ['left','right','top','bottom'];
        sides.forEach(function(side) {
            var pos = FlowNodes.getPortPosition(nodeId, side, 0, 1);
            if (!pos) return;
            var dot = document.createElementNS('http://www.w3.org/2000/svg','circle');
            dot.setAttribute('cx', pos.x);
            dot.setAttribute('cy', pos.y);
            dot.setAttribute('r', '5');
            dot.classList.add('edge-handle', 'edge-port-indicator');
            dot.dataset.nodeId = nodeId;
            dot.dataset.side = side;

            // Click to snap edge endpoint to this port
            dot.addEventListener('click', function(e) {
                e.stopPropagation();
                // Determine which end of the edge this node belongs to
                var end = null;
                if (String(nodeId) === String(edge.fromNodeId)) end = 'from';
                else if (String(nodeId) === String(edge.toNodeId)) end = 'to';
                if (!end) return;

                // Ensure both sides are stored
                if (!edge.fromSide || !edge.toSide) {
                    var autoPorts = FlowNodes.getBestPorts(edge.fromNodeId, edge.toNodeId);
                    if (autoPorts) {
                        if (!edge.fromSide) edge.fromSide = autoPorts.fromSide;
                        if (!edge.toSide) edge.toSide = autoPorts.toSide;
                    }
                }
                if (end === 'from') edge.fromSide = side;
                else edge.toSide = side;
                FlowData.save();

                self.deselectEdge();
                self.render();
                // Re-select to show updated handles
                setTimeout(function() {
                    self.selectEdge(edgeId, { fromSide: edge.fromSide, toSide: edge.toSide });
                }, 50);
            });

            svg.appendChild(dot);
        });
    },

    _onHandleMove: function(e) {
        var d = FlowEdges._handleDrag;
        if (!d) return;
        e.preventDefault();
        var canvas = document.getElementById('flowCanvas');
        if (!canvas) return;
        var cr = canvas.getBoundingClientRect();
        var mx = e.clientX - cr.left, my = e.clientY - cr.top;

        // Detect node under cursor (bounding-box hit with generous padding)
        var nearest = FlowEdges._getNodeUnderCursor(e.clientX, e.clientY, d.edgeId, d.end);

        // If hovering a node, snap the handle to its nearest port. Otherwise follow cursor.
        var handleX = mx, handleY = my;
        var snappedSide = null;
        if (nearest) {
            var snap = FlowEdges._getNearestSide(nearest.nodeId, mx, my);
            var sPos = FlowNodes.getPortPosition(nearest.nodeId, snap.side, 0, 1);
            if (sPos) {
                handleX = sPos.x; handleY = sPos.y;
                snappedSide = snap.side;
            }
        }

        // Move the handle dot, halo, and label visually
        var circle = d.circle || d.handle.querySelector('.edge-handle-dot');
        var halo   = d.halo   || d.handle.querySelector('.edge-handle-halo');
        var label  = d.text   || d.handle.querySelector('.edge-handle-label');
        if (circle) { circle.setAttribute('cx', handleX); circle.setAttribute('cy', handleY); }
        if (halo)   { halo.setAttribute('cx', handleX);   halo.setAttribute('cy', handleY);   }
        if (label)  { label.setAttribute('x', handleX);   label.setAttribute('y', handleY - 16); }

        // Also move the invisible hit ring so it tracks the handle
        var hit = d.handle && d.handle.querySelector('.edge-handle-hit');
        if (hit) { hit.setAttribute('cx', handleX); hit.setAttribute('cy', handleY); }

        // Draw live preview line from the anchored end to the handle position (snapped or cursor)
        var edge = FlowData.getEdge(d.edgeId);
        var svg = document.getElementById('edgeLayer');
        if (edge && svg) {
            var anchorNodeId = d.end === 'from' ? edge.toNodeId    : edge.fromNodeId;
            var anchorSide   = d.end === 'from' ? (edge.toSide || 'left') : (edge.fromSide || 'right');
            var anchorPos    = FlowNodes.getPortPosition(anchorNodeId, anchorSide, 0, 1);

            // Remove old preview line
            var oldPreview = svg.querySelector('.edge-drag-preview');
            if (oldPreview) oldPreview.remove();

            if (anchorPos) {
                var preview = document.createElementNS('http://www.w3.org/2000/svg','path');
                var dx = Math.abs(handleX - anchorPos.x);
                var dy = Math.abs(handleY - anchorPos.y);
                var cpOff = Math.max(40, dx * 0.35);
                // Bezier from anchor (tangent along anchor side) to snapped/cursor point
                var cpAx = anchorSide === 'right' ? anchorPos.x + cpOff
                         : anchorSide === 'left'  ? anchorPos.x - cpOff
                         : anchorPos.x;
                var cpAy = anchorSide === 'top'    ? anchorPos.y - cpOff
                         : anchorSide === 'bottom' ? anchorPos.y + cpOff
                         : anchorPos.y;

                // If snapped to a target port, also give the preview a tangent at the target end
                var cpBx = handleX, cpBy = handleY;
                if (snappedSide) {
                    var tOff = Math.max(40, dx * 0.35);
                    cpBx = snappedSide === 'right' ? handleX + tOff
                         : snappedSide === 'left'  ? handleX - tOff
                         : handleX;
                    cpBy = snappedSide === 'top'    ? handleY - tOff
                         : snappedSide === 'bottom' ? handleY + tOff
                         : handleY;
                    var pathD = 'M ' + anchorPos.x + ' ' + anchorPos.y +
                                ' C ' + cpAx + ' ' + cpAy + ', ' + cpBx + ' ' + cpBy +
                                ', ' + handleX + ' ' + handleY;
                    preview.setAttribute('d', pathD);
                } else {
                    // No snap — simple quadratic from anchor to cursor
                    var pathQ = 'M ' + anchorPos.x + ' ' + anchorPos.y +
                                ' Q ' + cpAx + ' ' + cpAy + ', ' + handleX + ' ' + handleY;
                    preview.setAttribute('d', pathQ);
                }
                preview.classList.add('edge-drag-preview');
                if (snappedSide) preview.classList.add('edge-drag-preview-snapped');
                svg.appendChild(preview);
            }
        }

        // Clear all node / port highlights from previous frame
        document.querySelectorAll('.flow-node').forEach(function(el) {
            el.classList.remove('edge-drop-target');
        });
        document.querySelectorAll('.edge-port-indicator').forEach(function(ind) {
            ind.classList.remove('port-hover');
        });

        if (nearest && snappedSide) {
            var nodeEl = document.getElementById('node-' + nearest.nodeId);
            if (nodeEl) nodeEl.classList.add('edge-drop-target');

            // Highlight the specific port indicator that will be chosen on drop
            var targetInd = document.querySelector(
                '.edge-port-indicator[data-node-id="' + nearest.nodeId + '"][data-side="' + snappedSide + '"]'
            );
            if (targetInd) targetInd.classList.add('port-hover');

            // Slot number this edge would occupy
            var portKey = nearest.nodeId + '-' + snappedSide;
            var count = (FlowEdges._lastPortCounts && FlowEdges._lastPortCounts[portKey]) || 0;
            var isSameNode = String(nearest.nodeId) === String(d.nodeId);
            // If staying on the same node, this edge already counts toward the total
            var slotNum = isSameNode ? Math.max(1, count) : count + 1;

            var targetNode = FlowData.getNode(nearest.nodeId);
            if (label) {
                var nameStr = targetNode ? targetNode.name.substring(0, 12) : '';
                label.textContent = isSameNode
                    ? snappedSide + ' #' + slotNum
                    : nameStr + ' · ' + snappedSide + ' #' + slotNum;
            }
            d._hoverNodeId = nearest.nodeId;
            d._hoverSide   = snappedSide;
        } else {
            d._hoverNodeId = null;
            d._hoverSide = null;
            if (label) label.textContent = 'release on a node';
        }
    },

    /** Cancel handle drag on Escape */
    _onHandleKey: function(e) {
        if (e.key !== 'Escape') return;
        var d = FlowEdges._handleDrag;
        if (!d) return;
        e.preventDefault();
        // Cleanup without applying the drag
        document.removeEventListener('mousemove', FlowEdges._onHandleMove);
        document.removeEventListener('mouseup',   FlowEdges._onHandleUp);
        document.removeEventListener('keydown',   FlowEdges._onHandleKey);

        var svg = document.getElementById('edgeLayer');
        if (svg) {
            var p = svg.querySelector('.edge-drag-preview');
            if (p) p.remove();
        }
        document.querySelectorAll('.flow-node').forEach(function(el) {
            el.classList.remove('edge-drop-target');
        });

        var edgeId = d.edgeId;
        FlowEdges._handleDrag = null;
        FlowEdges.deselectEdge();
        FlowEdges.render();
        // Re-select so the user can retry
        setTimeout(function() {
            var e2 = FlowData.getEdge(edgeId);
            if (e2) {
                var ports = FlowNodes.getBestPorts(e2.fromNodeId, e2.toNodeId, e2);
                if (ports) FlowEdges.selectEdge(edgeId, ports);
            }
        }, 50);
    },

    _onHandleUp: function(e) {
        var d = FlowEdges._handleDrag;
        if (!d) return;
        document.removeEventListener('mousemove', FlowEdges._onHandleMove);
        document.removeEventListener('mouseup',   FlowEdges._onHandleUp);
        document.removeEventListener('keydown',   FlowEdges._onHandleKey);

        // Remove preview line
        var svg = document.getElementById('edgeLayer');
        if (svg) { var p = svg.querySelector('.edge-drag-preview'); if (p) p.remove(); }

        // Clear node highlights
        document.querySelectorAll('.flow-node').forEach(function(el) {
            el.classList.remove('edge-drop-target');
        });

        var canvas = document.getElementById('flowCanvas');
        if (!canvas) { FlowEdges._handleDrag = null; return; }
        var cr = canvas.getBoundingClientRect();
        var mx = e.clientX - cr.left, my = e.clientY - cr.top;

        var edge = FlowData.getEdge(d.edgeId);
        if (!edge) { FlowEdges._handleDrag = null; return; }

        var otherEnd = d.end === 'from' ? edge.toNodeId : edge.fromNodeId;

        // Only apply the drag if the cursor was actually over a node when released.
        // Otherwise, bail out and restore original handle position.
        if (!d._hoverNodeId) {
            FlowEdges._handleDrag = null;
            FlowEdges.deselectEdge();
            FlowEdges.render();
            // Re-select so the user can try again
            setTimeout(function() {
                var e2 = FlowData.getEdge(d.edgeId);
                if (e2) {
                    var ports = FlowNodes.getBestPorts(e2.fromNodeId, e2.toNodeId, e2);
                    if (ports) FlowEdges.selectEdge(d.edgeId, ports);
                }
            }, 50);
            return;
        }

        var targetNodeId = d._hoverNodeId;

        // Don't allow connecting a node to its edge partner (would make a self-loop edge invalid)
        if (String(targetNodeId) === String(otherEnd)) {
            FlowEdges._handleDrag = null;
            FlowEdges.deselectEdge();
            FlowEdges.render();
            setTimeout(function() {
                var e2 = FlowData.getEdge(d.edgeId);
                if (e2) {
                    var ports = FlowNodes.getBestPorts(e2.fromNodeId, e2.toNodeId, e2);
                    if (ports) FlowEdges.selectEdge(d.edgeId, ports);
                }
            }, 50);
            return;
        }

        // Prefer the side captured during move (snapped). Fall back to nearest-side from cursor.
        var chosenSide = d._hoverSide || FlowEdges._getNearestSide(targetNodeId, mx, my).side;
        var isReconnect = String(targetNodeId) !== String(d.nodeId);

        // Initialize port sides
        if (!edge.fromSide || !edge.toSide) {
            var autoPorts = FlowNodes.getBestPorts(edge.fromNodeId, edge.toNodeId);
            if (autoPorts) {
                if (!edge.fromSide) edge.fromSide = autoPorts.fromSide;
                if (!edge.toSide) edge.toSide = autoPorts.toSide;
            }
        }

        if (isReconnect) {
            if (d.end === 'from') {
                edge.fromNodeId = targetNodeId;
                edge.fromSide = chosenSide;
            } else {
                edge.toNodeId = targetNodeId;
                edge.toSide = chosenSide;
            }
            // First in line at new node
            if (!edge.portOrder) edge.portOrder = {};
            var newPortKey = targetNodeId + '-' + chosenSide + '-' + d.end;
            edge.portOrder[newPortKey] = -1;
        } else {
            if (d.end === 'from') edge.fromSide = chosenSide;
            else edge.toSide = chosenSide;
        }

        FlowData.save();
        FlowEdges._handleDrag = null;
        FlowEdges.deselectEdge();
        FlowEdges.render();

        // Re-select
        setTimeout(function() {
            var e2 = FlowData.getEdge(d.edgeId);
            if (e2) {
                var ports = { fromSide: e2.fromSide, toSide: e2.toSide };
                FlowEdges.selectEdge(d.edgeId, ports);
            }
        }, 50);
    },

    /** Detect if cursor is directly over a node element (bounding box hit test) */
    _getNodeUnderCursor(clientX, clientY, edgeId, end) {
        var edge = FlowData.getEdge(edgeId);
        if (!edge) return null;
        var otherEnd = end === 'from' ? edge.toNodeId : edge.fromNodeId;

        var hit = null;
        var hitArea = Infinity;  // prefer tighter hits when overlapping
        FlowData.nodes.forEach(function(node) {
            if (node.id === otherEnd) return; // can't connect to self
            // Skip hidden / invisible nodes
            if (typeof DataModel !== 'undefined' && !DataModel.isActivityVisible(node.id)) return;
            var el = document.getElementById('node-' + node.id);
            if (!el) return;
            var r = el.getBoundingClientRect();
            // Expand hit area by 18px for easier targeting (slightly more forgiving than before)
            if (clientX >= r.left - 18 && clientX <= r.right + 18 &&
                clientY >= r.top - 18  && clientY <= r.bottom + 18) {
                var area = r.width * r.height;
                if (area < hitArea) {
                    hitArea = area;
                    hit = { nodeId: node.id };
                }
            }
        });
        return hit;
    },

    /** Find the nearest node using center distance (fallback) */
    _getNearestNode(mx, my, edgeId, end) {
        var edge = FlowData.getEdge(edgeId);
        if (!edge) return null;
        var otherEnd = end === 'from' ? edge.toNodeId : edge.fromNodeId;
        var best = null;
        var bestDist = 80;

        FlowData.nodes.forEach(function(node) {
            if (node.id === otherEnd) return;
            var center = FlowNodes.getNodeCenter(node.id);
            if (!center) return;
            var dist = Math.sqrt(Math.pow(center.x - mx, 2) + Math.pow(center.y - my, 2));
            if (dist < bestDist) {
                bestDist = dist;
                best = { nodeId: node.id, dist: dist };
            }
        });
        return best;
    },

    _getNearestSide(nodeId, mx, my) {
        var sides = ['left','right','top','bottom'];
        var best = { side: 'right', dist: Infinity };
        sides.forEach(function(side) {
            var pos = FlowNodes.getPortPosition(nodeId, side, 0, 1);
            if (!pos) return;
            var dist = Math.sqrt(Math.pow(pos.x - mx, 2) + Math.pow(pos.y - my, 2));
            if (dist < best.dist) { best = { side: side, dist: dist }; }
        });
        return best;
    }
};
