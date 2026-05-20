/**
 * GANTT-CHART-APP.JS v4 — Equipment Logistics Tracker
 *
 * v4 changes:
 *  - Pagination (15/20/30/50/75/100 per page)
 *  - Draggable SVG map nodes (positions saved to StorageManager)
 *  - Dots always visible (initial time set to first bar midpoint)
 *  - Flow edge transfer shortcuts in context menu
 *  - Transfer dots follow curved path
 *  - Sequential enforcement with auto-rebuild transfers
 */

var GCApp = {

    _rangeStart:null,_rangeEnd:null,_currentTime:0,_isPlaying:false,_playInterval:null,
    _mapMode:'simple',_leafletMap:null,_leafletMarkers:{},_leafletItemMarkers:{},_leafletPaths:[],_leafletInited:false,_animRunning:false,
    _equipSchedules:[],_nextBarId:1,_drag:null,_svgPositions:null,_ctxClickPct:null,
    _pageSize:'auto',_pageStart:0,
    _mapDrag:null,
    _activeTypes:{},  // {FAT:true, FIT:true, ...}
    _activeWps:{},    // {WP03:true, WP05:true, ...}
    _hiddenWpRows:{}, // {WP04:true, ...} — hidden from milestone timeline
    _locked:false,    // if true, bars cannot be dragged/resized
    _viewMode:'gantt',// 'gantt' or 'summary'

    _locationCoordsFallback:{
        'Norway, Egersund':{lat:58.45,lng:5.99},'Norway, \u00C5gotnes':{lat:60.37,lng:5.01},
        'Norway, Bergen':{lat:60.39,lng:5.32},'Norway, Oslo':{lat:59.91,lng:10.75},
        'India, Pune':{lat:18.52,lng:73.86},'Malaysia':{lat:3.14,lng:101.69},'Brazil':{lat:-14.24,lng:-51.93}
    },

    _getCoords:function(loc){
        // DataModel is source of truth, fallback to hardcoded
        var c=DataModel.getLocationCoords?DataModel.getLocationCoords(loc):null;
        if(c)return c;
        return this._locationCoordsFallback[loc]||null;
    },

    init:function(){
        StorageManager.init();
        // Load custom locations
        try{var p=StorageManager.loadPrefs();if(p&&p.customLocations){for(var name in p.customLocations){DataModel.locations[name]=p.customLocations[name];}}if(p&&p.gcHiddenWpRows){this._hiddenWpRows=p.gcHiddenWpRows;}if(p&&p.gcLocked)this._locked=true;if(p&&p.gcViewMode==='summary')this._viewMode='summary';if(p&&Array.isArray(p.expandedSubActivities))DataModel.expandedSubActivities=p.expandedSubActivities.slice();if(p&&p.gcPageSize!==undefined)this._pageSize=p.gcPageSize;}catch(e){}
        this._loadMatrix();this._loadBars();this._buildEquipList();
        // Initialize FlowData for milestone access
        if(typeof FlowData!=='undefined'){
            var m2=StorageManager.loadMatrix();if(m2)FlowData.loadFromMatrix(m2);
            FlowData.load();
        }
        this._calcRange();
        Nav.render('gantt-chart');
        this._setInitialTime();
        this.render();this._setupControls();this._setupDrag();this._setupContextMenu();this._setupMapDrag();this._setupMapClick();
        // Reflect persisted lock + view-mode prefs in the UI
        this._updateLockUI();
        this.setViewMode(this._viewMode);
        // Sync page-size button highlight to the persisted value
        var self0=this;
        document.querySelectorAll('.gc-ps-btn').forEach(function(b){
            var lbl=(b.textContent||'').trim().toLowerCase();
            var match = (self0._pageSize==='auto') ? (lbl==='auto') : (parseInt(lbl)===parseInt(self0._pageSize));
            b.classList.toggle('active', match);
        });
        if(typeof UndoManager!=='undefined') UndoManager.init();
        var self=this;setTimeout(function(){self._renderMap();self._updateItemList();},50);
        // Cross-tab sync: reload if matrix page updates test activities
        StorageManager.onChange(function(doc){self._onCrossTabChange(doc);});
    },

    _onCrossTabChange:function(doc){
        if(!doc)return;
        // Reload matrix data (test columns with updated locations/dates)
        if(doc.matrix&&doc.matrix.testColumns){
            DataModel.testColumns=doc.matrix.testColumns;
            if(doc.matrix.sections)DataModel.sections=doc.matrix.sections;
        }
        // Reload custom location colors from prefs
        if(doc.prefs&&doc.prefs.customLocations){
            for(var name in doc.prefs.customLocations){
                DataModel.locations[name]=doc.prefs.customLocations[name];
            }
        }
        // Reload gantt bars (may have been updated by matrix page _syncToGanttBars)
        if(doc.gantt&&doc.gantt.bars){
            this._barStore=doc.gantt.bars;
            this._nextBarId=doc.gantt.nextBarId||this._nextBarId;
            this._buildEquipList();
        }
        this._calcRange();this.render();
    },

    _loadMatrix:function(){var m=StorageManager.loadMatrix();if(m&&m.testColumns&&m.testColumns.length){DataModel.testColumns=m.testColumns;DataModel.sections=m.sections||DataModel.sections;}},

    /** Load bars from StorageManager (unified storage), migrate from old keys if needed */
    _loadBars:function(){
        var g=StorageManager.loadGantt();
        if(g&&g.bars&&Object.keys(g.bars).length>0){
            this._barStore=g.bars;this._nextBarId=g.nextBarId||1;this._savedMapPositions=g.mapPositions||{};
            return;
        }
        // Migrate from old localStorage keys
        this._barStore={};this._nextBarId=1;this._savedMapPositions={};
        try{
            var raw=localStorage.getItem('gc_equip_schedules_v2');
            if(raw){var d=JSON.parse(raw);this._nextBarId=d.nextBarId||1;(d.schedules||[]).forEach(function(sec){(sec.rows||[]).forEach(function(row){if(row.bars&&row.bars.length>0)GCApp._barStore[row.rowKey]=row.bars;});});}
            var mp=localStorage.getItem('gc_map_positions');if(mp)this._savedMapPositions=JSON.parse(mp);
            // Save migrated data to unified storage
            if(Object.keys(this._barStore).length>0||Object.keys(this._savedMapPositions).length>0){
                StorageManager.save({gantt:{bars:this._barStore,nextBarId:this._nextBarId,mapPositions:this._savedMapPositions}});
            }
        }catch(e){}
    },

    /** Build equipment list PURELY from DataModel.sections — no duplicates.
     *  Uses stable identity key (itemNo+description hash) so bars stay attached
     *  to the correct equipment even when rows are reordered/added/removed. */
    /** Build equipment list PURELY from DataModel.sections — unique stable keys */
    _buildEquipList:function(){
        var self=this;this._equipSchedules=[];
        DataModel.sections.forEach(function(sec){
            var rows=[];
            sec.rows.forEach(function(row,idx){
                if(!row.itemNo&&!row.description) return;
                // Stable key: section + itemNo + description + partNo
                var key=sec.id+'::'+self._stableId(row);
                // Try content-based key first, then old positional key
                var bars=self._barStore[key]||null;
                if(!bars){
                    var oldKey=sec.id+'_'+idx;
                    bars=self._barStore[oldKey]||null;
                    if(bars){self._barStore[key]=bars;delete self._barStore[oldKey];}
                }
                rows.push({
                    rowKey:key,
                    name:row.description||row.itemNo||'Equipment',
                    itemNo:row.itemNo||'',
                    partNo:row.partNo||'',
                    sectionId:sec.id,
                    rowIdx:idx,
                    bars:bars?JSON.parse(JSON.stringify(bars)):[]
                });
            });
            self._equipSchedules.push({sectionId:sec.id,sectionName:sec.name,collapsed:false,rows:rows});
        });
    },

    /** Create a stable ID string from a row's content (not its index) */
    _stableId:function(row){
        var parts=[(row.itemNo||'').trim(),(row.description||'').trim(),(row.partNo||'').trim()];
        return parts.join('|');
    },

    /** Return all test activities including sub-activities as a flat array */
    _getAllTests:function(){
        var all=[];
        DataModel.testColumns.forEach(function(t){
            all.push(t);
            if(t.subActivities&&t.subActivities.length>0){
                t.subActivities.forEach(function(s){all.push(s);});
            }
        });
        return all;
    },

    /** Save bars + map positions to unified StorageManager */
    _save:function(){
        var bars={},self=this;
        this._equipSchedules.forEach(function(sec){sec.rows.forEach(function(row){if(row.bars.length>0)bars[row.rowKey]=row.bars;});});
        StorageManager.save({gantt:{bars:bars,nextBarId:this._nextBarId,mapPositions:this._savedMapPositions||{}}});
    },

    /** When a bar is added/changed from a test activity, sync dates+location back to DataModel */
    _syncTestData:function(testId,startDate,endDate,location){
        var test=DataModel.getTest(testId);if(!test)return;
        var changed=false;
        if(startDate&&test.startDate!==startDate){test.startDate=startDate;changed=true;}
        if(endDate&&test.endDate!==endDate){test.endDate=endDate;changed=true;}
        if(location&&test.location!==location){test.location=location;changed=true;}
        if(changed){
            // Persist matrix changes
            if(typeof App!=='undefined') App.persistMatrix();
            else StorageManager.save({matrix:{testColumns:DataModel.testColumns,sections:DataModel.sections}});
        }
    },

    /** Set initial timeline to midpoint of first bar so dots appear */
    _setInitialTime:function(){
        var first=null;
        this._equipSchedules.forEach(function(s){s.rows.forEach(function(r){r.bars.forEach(function(b){if(b.startDate&&(!first||new Date(b.startDate)<new Date(first.startDate)))first=b;});});});
        if(first&&first.startDate&&first.endDate){
            var mid=new Date((new Date(first.startDate).getTime()+new Date(first.endDate).getTime())/2);
            var total=this._rangeEnd-this._rangeStart;
            this._currentTime=Math.max(0,Math.min(1,(mid-this._rangeStart)/total));
            var sl=document.getElementById('gcSlider');if(sl)sl.value=Math.round(this._currentTime*1000);
        }
    },

    _calcRange:function(){
        var start=null,end=null,today=new Date();
        this._getAllTests().forEach(function(t){if(t.startDate){var d=new Date(t.startDate);if(!start||d<start)start=d;}if(t.endDate){var d=new Date(t.endDate);if(!end||d>end)end=d;}});
        this._equipSchedules.forEach(function(sec){sec.rows.forEach(function(row){row.bars.forEach(function(b){if(b.startDate){var d=new Date(b.startDate);if(!start||d<start)start=d;}if(b.endDate){var d=new Date(b.endDate);if(!end||d>end)end=d;}});});});
        this._getMilestones().forEach(function(ms){if(ms.pd){if(!start||ms.pd<start)start=ms.pd;if(!end||ms.pd>end)end=ms.pd;}});
        if(!start)start=new Date(today.getFullYear(),today.getMonth()-2,1);if(!end)end=new Date(today.getFullYear(),today.getMonth()+8,0);
        this._rangeStart=new Date(start.getFullYear(),start.getMonth()-1,1);this._rangeEnd=new Date(end.getFullYear(),end.getMonth()+2,0);
    },

    _getMilestones:function(){
        try{
            // Prefer in-memory FlowData (avoids debounce lag), fall back to StorageManager
            var milestones=null;
            if(typeof FlowData!=='undefined'&&FlowData.milestones&&FlowData.milestones.length>0){
                milestones=FlowData.milestones;
            } else {
                var f=StorageManager.loadFlow();
                if(!f||!f.milestones)return[];
                milestones=f.milestones;
            }
            return milestones.map(function(ms){
                var pd=null;
                if(ms.date){
                    var p=ms.date.split('.');
                    if(p.length===3){
                        var yr=parseInt(p[2]);if(yr<100)yr+=2000;
                        pd=new Date(yr,parseInt(p[1])-1,parseInt(p[0]));
                        if(isNaN(pd.getTime()))pd=null;
                    }
                }
                return{id:ms.id,text:ms.text||'',date:ms.date||'',color:ms.color||'#fff',shape:ms.shape||'circle',size:ms.size||'medium',pd:pd,wpRow:ms.wpRow||'WP03'};
            }).filter(function(m){return m.pd;});
        }catch(e){return[];}
    },

    _gcTimelineVisible:true,
    _wpRows:['WP03','WP04','WP05','WP06','WP07','WP09','WP10','WP11'],
    _wpColors:{'WP03':'#06b6d4','WP04':'#8b5cf6','WP05':'#10b981','WP06':'#f59e0b','WP07':'#ef4444','WP09':'#ec4899','WP10':'#6366f1','WP11':'#14b8a6'},
    _msSizeMap:{small:8,medium:12,large:16},

    _msShapeSvg:function(shape,color,size){
        var s=size||12,h=s/2,inner='';
        if(shape==='square'){var i=s*0.1;inner='<rect x="'+i+'" y="'+i+'" width="'+(s-i*2)+'" height="'+(s-i*2)+'" rx="1" fill="'+color+'"/>';}
        else if(shape==='triangle'){inner='<polygon points="'+h+','+(s*0.08)+' '+(s*0.92)+','+(s*0.88)+' '+(s*0.08)+','+(s*0.88)+'" fill="'+color+'"/>';}
        else if(shape==='diamond'){inner='<polygon points="'+h+','+(s*0.05)+' '+(s*0.95)+','+h+' '+h+','+(s*0.95)+' '+(s*0.05)+','+h+'" fill="'+color+'"/>';}
        else{inner='<circle cx="'+h+'" cy="'+h+'" r="'+(h*0.78)+'" fill="'+color+'"/>';}
        return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 '+s+' '+s+'" style="filter:drop-shadow(0 0 3px '+color+'80);vertical-align:middle;">'+inner+'</svg>';
    },

    toggleGcTimeline:function(){
        this._gcTimelineVisible=!this._gcTimelineVisible;
        StorageManager.save({prefs:{gcTimelineVisible:this._gcTimelineVisible}});
        this._renderGantt();
        var btn=document.getElementById('gcTlToggleBtn');
        if(btn)btn.innerHTML=this._gcTimelineVisible?'<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Hide Milestones':'<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/></svg> Show Milestones';
    },

    /** Load flow edges with transferItems */
    _getFlowEdges:function(){try{var f=StorageManager.loadFlow();return(f&&f.edges)?f.edges:[];}catch(e){return[];}},

    /** Find flow edges that reference this equipment key and have transferItems checked */
    _getEdgeShortcuts:function(rowKey){
        var edges=this._getFlowEdges(),out=[];
        edges.forEach(function(edge){
            if(!edge.transferItems)return;
            if(edge.transferItems[rowKey]){
                var fromTest=DataModel.getTest(edge.fromNodeId),toTest=DataModel.getTest(edge.toNodeId);
                if(fromTest&&toTest) out.push({edge:edge,fromTest:fromTest,toTest:toTest,item:edge.transferItems[rowKey]});
            }
        });
        return out;
    },

    _totalDays:function(){return Math.max(1,Math.ceil((this._rangeEnd-this._rangeStart)/86400000));},
    _dayToPct:function(d){return((d-this._rangeStart)/86400000)/this._totalDays()*100;},
    _pctToDate:function(pct){return new Date(this._rangeStart.getTime()+(pct/100)*this._totalDays()*86400000);},

    // ── Sequential rebuild ──────────────────────────────

    _rebuildTransfers:function(row){
        // Remove existing transfer bars, keep only location bars
        var locs=row.bars.filter(function(b){return b.type!=='transfer';}).sort(function(a,b){return new Date(a.startDate)-new Date(b.startDate);});
        var nb=[],self=this;
        for(var i=0;i<locs.length;i++){
            var bar=locs[i];
            if(i>0){
                var prev=locs[i-1],pe=new Date(prev.endDate),cs=new Date(bar.startDate);
                // Only add transfer bar if: different location, bars don't overlap, and there's a gap
                if(prev.location!==bar.location&&cs>=pe){
                    nb.push({id:self._nextBarId++,location:bar.location,fromLocation:prev.location,startDate:self._fmtDate(pe),endDate:self._fmtDate(cs),type:'transfer',label:prev.location+' \u2192 '+bar.location});
                }
            }
            nb.push(bar);
        }
        row.bars=nb;
    },

    // ── Pagination ──────────────────────────────────────

    _flatRowsAll:function(){var o=[];this._equipSchedules.forEach(function(s){if(!s.collapsed)s.rows.forEach(function(r){o.push({sec:s,row:r});});else o.push({sec:s,row:null,isSecHeader:true});});return o;},

    /** Get flattened list including section headers, respecting pagination */
    _collapsedWps:{},

    _getVisibleItems:function(){
        var all=[],self=this;
        var wpColors={'WP03':'#06b6d4','WP04':'#8b5cf6','WP05':'#10b981','WP06':'#f59e0b','WP07':'#ef4444','WP09':'#ec4899','WP10':'#6366f1','WP11':'#14b8a6'};

        this._equipSchedules.forEach(function(sec,sIdx){
            all.push({type:'section',sec:sec,sIdx:sIdx});
            if(sec.collapsed) return;

            // Group rows by WP from matrix data
            var wpGroups={},ungrouped=[];
            sec.rows.forEach(function(row,rIdx){
                if(self._hasActiveFilter()&&!self._rowMatchesFilter(row,sec.sectionId,rIdx)) return;
                var section=DataModel.getSection(sec.sectionId);
                var mRow=section?section.rows[row.rowIdx]:null;
                var wp=mRow?(mRow.workpack||'').trim():'';
                if(wp){if(!wpGroups[wp])wpGroups[wp]=[];wpGroups[wp].push({row:row,rIdx:rIdx});}
                else ungrouped.push({row:row,rIdx:rIdx});
            });

            // WP groups sorted
            Object.keys(wpGroups).sort().forEach(function(wp){
                var wpId=sec.sectionId+'::'+wp;
                var collapsed=!!self._collapsedWps[wpId];
                all.push({type:'wpHeader',sec:sec,sIdx:sIdx,wp:wp,wpId:wpId,count:wpGroups[wp].length,collapsed:collapsed,color:wpColors[wp]||'#667'});
                if(!collapsed) wpGroups[wp].forEach(function(item){all.push({type:'row',sec:sec,sIdx:sIdx,row:item.row,rIdx:item.rIdx});});
            });

            // Unassigned at bottom
            if(ungrouped.length>0){
                var unId=sec.sectionId+'::_unassigned';
                var unCollapsed=!!self._collapsedWps[unId];
                all.push({type:'wpHeader',sec:sec,sIdx:sIdx,wp:'\u2014',wpId:unId,count:ungrouped.length,collapsed:unCollapsed,color:'#444'});
                if(!unCollapsed) ungrouped.forEach(function(item){all.push({type:'row',sec:sec,sIdx:sIdx,row:item.row,rIdx:item.rIdx});});
            }
        });

        var equipRows=all.filter(function(x){return x.type==='row';});
        var totalEquip=equipRows.length;

        // 'auto' mode: show every item on a single page (no paging).
        var effectiveSize = (this._pageSize === 'auto') ? Math.max(1, totalEquip) : this._pageSize;

        var totalPages=Math.max(1,Math.ceil(totalEquip/effectiveSize));
        var page=Math.floor(this._pageStart/effectiveSize);
        if(page>=totalPages){page=totalPages-1;this._pageStart=page*effectiveSize;}

        var startIdx=this._pageStart,endIdx=this._pageStart+effectiveSize,equipCount=0;
        var visible=[];
        all.forEach(function(item){
            if(item.type==='section'||item.type==='wpHeader'){visible.push(item);return;}
            if(equipCount>=startIdx&&equipCount<endIdx)visible.push(item);
            equipCount++;
        });
        return{items:visible,totalEquip:totalEquip,totalPages:totalPages,page:page};
    },

    toggleWpGroup:function(wpId){this._collapsedWps[wpId]=!this._collapsedWps[wpId];this._renderGantt();this._updatePagination();},

    setPageSize:function(n){
        // Accepts a positive integer or the string 'auto' (all items on one page).
        this._pageSize = (n === 'auto') ? 'auto' : parseInt(n);
        this._pageStart = 0;
        try { StorageManager.save({ prefs: { gcPageSize: this._pageSize } }); } catch(e){}
        this._renderGantt();
        this._updatePagination();
        // Update button highlight (match by label to support 'Auto')
        document.querySelectorAll('.gc-ps-btn').forEach(function(b){
            var lbl = (b.textContent || '').trim().toLowerCase();
            var match = (n === 'auto') ? (lbl === 'auto') : (parseInt(lbl) === parseInt(n));
            b.classList.toggle('active', match);
        });
    },

    prevPage:function(){
        if(this._pageSize === 'auto') return;  // no paging in auto mode
        this._pageStart=Math.max(0,this._pageStart-this._pageSize);this._renderGantt();this._updatePagination();
    },
    nextPage:function(){
        if(this._pageSize === 'auto') return;  // no paging in auto mode
        var info=this._getVisibleItems();if(this._pageStart+this._pageSize<info.totalEquip){this._pageStart+=this._pageSize;this._renderGantt();this._updatePagination();}
    },

    _updatePagination:function(){
        var info=this._getVisibleItems();
        var lbl=document.getElementById('gcPgLabel');
        var pi=document.getElementById('gcPageInfo');
        if(this._pageSize === 'auto'){
            if(lbl) lbl.textContent = 'All ' + info.totalEquip;
            if(pi)  pi.textContent  = info.totalEquip + ' items (all shown)';
        } else {
            if(lbl) lbl.textContent = 'Page ' + (info.page+1) + ' / ' + info.totalPages;
            if(pi)  pi.textContent  = info.totalEquip + ' items';
        }
        // Disable prev/next buttons when in auto mode
        var prevBtn=document.querySelector('.gc-pg-btn[onclick*="prevPage"]');
        var nextBtn=document.querySelector('.gc-pg-btn[onclick*="nextPage"]');
        var autoMode = (this._pageSize === 'auto');
        if(prevBtn){ prevBtn.disabled = autoMode || info.page === 0; prevBtn.style.opacity = (prevBtn.disabled ? '0.4' : ''); }
        if(nextBtn){ nextBtn.disabled = autoMode || info.page >= info.totalPages - 1; nextBtn.style.opacity = (nextBtn.disabled ? '0.4' : ''); }
    },

    // ── Render ──────────────────────────────────────────

    render:function(){this._renderFilterBar();this._renderGantt();this._renderMap();this._updateItemList();this._renderLegend();this._updateTimeIndicator();this._updatePagination();},

    _renderGantt:function(){
        var labelsEl=document.getElementById('gcGanttLabels'),timelineEl=document.getElementById('gcGanttTimeline'),msStripEl=document.getElementById('gcMsStrip'),rowsEl=document.getElementById('gcGanttRows');
        if(!labelsEl||!timelineEl||!rowsEl)return;

        var th='',d=new Date(this._rangeStart),td=this._totalDays();
        while(d<=this._rangeEnd){var dim=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();th+='<div class="gc-gantt-month" style="flex:0 0 '+(dim/td*100).toFixed(4)+'%;">'+d.toLocaleString('en',{month:'short'})+' '+d.getFullYear()+'</div>';d=new Date(d.getFullYear(),d.getMonth()+1,1);}
        timelineEl.innerHTML=th;

        var ms=this._getMilestones(),msh='';

        // Load visibility pref
        try{var pr=StorageManager.loadPrefs();if(pr&&pr.gcTimelineVisible===false)this._gcTimelineVisible=false;}catch(e2){}

        if(this._gcTimelineVisible){
            // Render WP-based milestone rows (skip hidden) — NO labels in strip (they go in labels column)
            var self2=this;
            this._wpRows.forEach(function(wp){
                if(self2._hiddenWpRows[wp]) return;
                var wpColor=self2._wpColors[wp]||'#888';
                msh+='<div class="gc-ms-wp-row" data-wp="'+wp+'"><div class="gc-ms-wp-track" data-wp="'+wp+'">';
                ms.filter(function(m){return m.wpRow===wp;}).forEach(function(m){
                    var pct=GCApp._dayToPct(m.pd);if(pct<-2||pct>102)return;
                    var sz=self2._msSizeMap[m.size]||12;
                    msh+='<div class="gc-ms-marker gc-ms-interactive" data-ms-id="'+m.id+'" style="left:'+pct.toFixed(4)+'%;color:'+m.color+';">'+self2._msShapeSvg(m.shape,m.color,sz)+'<div class="gc-ms-label">'+GCApp._esc(m.text)+'</div>'+(m.date?'<div class="gc-ms-date">'+GCApp._esc(m.date)+'</div>':'')+'</div>';
                });
                msh+='</div></div>';
            });
        }
        if(msStripEl)msStripEl.innerHTML=msh;
        if(msStripEl)msStripEl.style.display=this._gcTimelineVisible?'':'none';

        // Add milestone lines inside the strip for visual continuity
        if(this._gcTimelineVisible && msStripEl){
            ms.forEach(function(m){var pct=GCApp._dayToPct(m.pd);if(pct<-2||pct>102)return;
                var line=document.createElement('div');
                line.className='gc-ms-line';
                line.style.cssText='left:'+pct.toFixed(4)+'%;top:0;bottom:0;border-left-color:'+m.color+';position:absolute;';
                msStripEl.appendChild(line);
            });
        }

        var info=this._getVisibleItems();
        // WP milestone labels → head-left element
        var msLabelEl=document.getElementById('gcGanttLabelMs');
        var wpLabelHtml='';
        if(this._gcTimelineVisible){
            var self3=this;
            this._wpRows.forEach(function(wp){
                if(self3._hiddenWpRows[wp]) return;
                var wpColor=self3._wpColors[wp]||'#888';
                wpLabelHtml+='<div class="gc-label-ms-wp" style="color:'+wpColor+'">'+wp+'</div>';
            });
        }
        if(msLabelEl){msLabelEl.innerHTML=wpLabelHtml;msLabelEl.style.display=this._gcTimelineVisible?'':'none';}

        // Equipment labels + rows
        var lh='';
        var rh='';
        if(this._gcTimelineVisible){
            ms.forEach(function(m){var pct=GCApp._dayToPct(m.pd);if(pct<-2||pct>102)return;rh+='<div class="gc-ms-line" style="left:'+pct.toFixed(4)+'%;top:0;bottom:0;border-left-color:'+m.color+';"></div>';});
        }
        // Note: vertical time-indicator line is now a single full-height overlay
        // (#gcTimeIndicatorFull) placed in .gc-gantt-wrapper — no per-render insert.

        var self=this;
        info.items.forEach(function(item){
            if(item.type==='section'){
                lh+='<div class="gc-label-sec" onclick="GCApp.toggleSection('+item.sIdx+')"><span class="toggle">'+(item.sec.collapsed?'\u25B6':'\u25BC')+'</span>'+self._esc(item.sec.sectionName)+'</div>';
                rh+='<div class="gc-row-sec" data-sec="'+item.sIdx+'"></div>';
            } else if(item.type==='wpHeader'){
                lh+='<div class="gc-label-wp" onclick="GCApp.toggleWpGroup(\''+item.wpId+'\')"><span class="toggle">'+(item.collapsed?'\u25B6':'\u25BC')+'</span><span class="gc-wp-dot" style="background:'+item.color+'"></span>'+self._esc(item.wp)+' <span class="gc-wp-count">('+item.count+')</span></div>';
                rh+='<div class="gc-row-wp"></div>';
            } else {
                var row=item.row,rIdx=item.rIdx,sIdx=item.sIdx,color=self._getEquipColor(row);
                lh+='<div class="gc-label-row" data-sec="'+sIdx+'" data-row="'+rIdx+'"><div class="dot" style="background:'+color+'"></div><span class="name">'+(row.itemNo?'<b>'+self._esc(row.itemNo)+'</b>':'')+self._esc(row.name)+'</span></div>';
                rh+='<div class="gc-row" data-sec="'+sIdx+'" data-row="'+rIdx+'">';
                var sorted=row.bars.slice().sort(function(a,b){return new Date(a.startDate)-new Date(b.startDate);});
                sorted.forEach(function(bar){
                    if(!bar.startDate||!bar.endDate)return;
                    var l=self._dayToPct(new Date(bar.startDate)),r2=self._dayToPct(new Date(bar.endDate)),w=Math.max(0.3,r2-l);
                    var bcolor=self._getLocationColor(bar.location),isX=bar.type==='transfer';
                    var cls=isX?'gc-bar transfer':'gc-bar location-bar';
                    var txt=isX?self._shortLoc(bar.fromLocation||'')+'\u2192'+self._shortLoc(bar.location):self._shortLoc(bar.location);
                    rh+='<div class="'+cls+'" data-bar-id="'+bar.id+'" data-sec="'+sIdx+'" data-row="'+rIdx+'" style="left:'+l.toFixed(4)+'%;width:'+w.toFixed(4)+'%;';
                    if(!isX)rh+='background:'+bcolor+';';
                    rh+='"><div class="handle handle-l" data-edge="l"></div><span style="pointer-events:none;flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;">'+txt+'</span><div class="handle handle-r" data-edge="r"></div></div>';
                });
                rh+='</div>';
            }
        });

        var minRows=Math.max(10,info.items.filter(function(x){return x.type==='row';}).length);
        var minH=minRows*36;
        labelsEl.innerHTML=lh;labelsEl.style.minHeight=minH+'px';
        rowsEl.innerHTML=rh;rowsEl.style.minHeight=minH+'px';

        setTimeout(function(){
            self._bindMsStripEvents();
            self._updateTimeIndicator();
            var sl=document.getElementById('gcSlider');
            if(sl)sl.value=Math.round(self._currentTime*1000);
        },0);
    },

    toggleSection:function(sIdx){var s=this._equipSchedules[sIdx];if(s)s.collapsed=!s.collapsed;this._save();this._renderGantt();this._updatePagination();},

    // ── Drag / Resize ──────────────────────────────────

    _setupDrag:function(){
        var self=this;
        document.addEventListener('mousedown',function(e){
            if(e.button!==0)return;var barEl=e.target.closest('.gc-bar');if(!barEl)return;
            if(self._locked){ return; }  // lock mode — do not initiate drag
            e.preventDefault();
            var sIdx=parseInt(barEl.dataset.sec),rIdx=parseInt(barEl.dataset.row),barId=parseInt(barEl.dataset.barId);
            var sec=self._equipSchedules[sIdx];if(!sec)return;var row=sec.rows[rIdx];if(!row)return;
            var bar=row.bars.find(function(b){return b.id===barId;});if(!bar)return;
            var chartRect=document.getElementById('gcGanttRows').getBoundingClientRect();
            var type='move';if(e.target.dataset.edge==='l')type='resize-l';else if(e.target.dataset.edge==='r')type='resize-r';
            self._drag={type:type,sIdx:sIdx,rIdx:rIdx,barId:barId,barEl:barEl,startX:e.clientX,origStart:bar.startDate,origEnd:bar.endDate,chartWidth:chartRect.width,totalDays:self._totalDays()};
            barEl.classList.add('dragging');self._hideCtx();
        });
        document.addEventListener('mousemove',function(e){
            if(!self._drag)return;e.preventDefault();
            var dx=e.clientX-self._drag.startX,daysDelta=Math.round(dx/self._drag.chartWidth*self._drag.totalDays);
            var bar=self._getBarById(self._drag.sIdx,self._drag.rIdx,self._drag.barId);if(!bar)return;
            var os=new Date(self._drag.origStart),oe=new Date(self._drag.origEnd);
            if(self._drag.type==='move'){bar.startDate=self._fmtDate(new Date(os.getTime()+daysDelta*86400000));bar.endDate=self._fmtDate(new Date(oe.getTime()+daysDelta*86400000));}
            else if(self._drag.type==='resize-l'){var ns=new Date(os.getTime()+daysDelta*86400000);if(ns<oe)bar.startDate=self._fmtDate(ns);}
            else if(self._drag.type==='resize-r'){var ne=new Date(oe.getTime()+daysDelta*86400000);if(ne>os)bar.endDate=self._fmtDate(ne);}
            var l=self._dayToPct(new Date(bar.startDate)),r2=self._dayToPct(new Date(bar.endDate));
            self._drag.barEl.style.left=l.toFixed(4)+'%';self._drag.barEl.style.width=Math.max(0.3,r2-l).toFixed(4)+'%';
        });
        document.addEventListener('mouseup',function(e){
            if(!self._drag)return;self._drag.barEl.classList.remove('dragging');
            var sIdx=self._drag.sIdx,rIdx=self._drag.rIdx,barId=self._drag.barId;
            self._drag=null;
            var sec=self._equipSchedules[sIdx];
            if(sec){
                var row=sec.rows[rIdx];
                if(row){
                    self._rebuildTransfers(row);
                    // Sync dates back to test activity if bar is linked
                    var bar=row.bars.find(function(b){return b.id===barId;});
                    if(bar&&bar.testId) self._syncTestData(bar.testId,bar.startDate,bar.endDate,bar.location);
                }
            }
            self._save();self._renderGantt();self._renderMap();
        });
    },

    _getBarById:function(sIdx,rIdx,barId){var sec=this._equipSchedules[sIdx];if(!sec)return null;var row=sec.rows[rIdx];if(!row)return null;return row.bars.find(function(b){return b.id===barId;})||null;},

    // ── SVG Map Drag (locations) ────────────────────────

    _loadMapPositions:function(){return this._savedMapPositions||{};},
    _saveMapPositions:function(){this._save();},

    _setupMapDrag:function(){
        var self=this;
        var svg=document.getElementById('gcMapSvg');if(!svg)return;

        svg.addEventListener('mousedown',function(e){
            var node=e.target.closest('.location-node');if(!node||e.button!==0)return;
            e.preventDefault();e.stopPropagation();
            var loc=node.getAttribute('data-loc');if(!loc)return;
            var svgRect=svg.getBoundingClientRect();
            var vb=svg.viewBox.baseVal;
            self._mapDrag={loc:loc,node:node,svgRect:svgRect,vbW:vb.width,vbH:vb.height,startX:e.clientX,startY:e.clientY,origX:self._svgPositions[loc].x,origY:self._svgPositions[loc].y};
            node.style.cursor='grabbing';
        });
        document.addEventListener('mousemove',function(e){
            if(!self._mapDrag)return;e.preventDefault();
            var d=self._mapDrag,dx=e.clientX-d.startX,dy=e.clientY-d.startY;
            var scaleX=d.vbW/d.svgRect.width,scaleY=d.vbH/d.svgRect.height;
            var nx=d.origX+dx*scaleX,ny=d.origY+dy*scaleY;
            nx=Math.max(30,Math.min(770,nx));ny=Math.max(30,Math.min(430,ny));
            self._svgPositions[d.loc]={x:nx,y:ny};
            d.node.setAttribute('transform','translate('+nx+','+ny+')');
            // Live-update paths and dots
            self._renderSvgPaths();self._renderDots(document.getElementById('gcItemDots'),self._svgPositions);
        });
        document.addEventListener('mouseup',function(e){
            if(!self._mapDrag)return;
            self._mapDrag.node.style.cursor='';self._mapDrag=null;
            // Save positions into unified storage
            self._savedMapPositions={};
            for(var k in self._svgPositions) self._savedMapPositions[k]={x:self._svgPositions[k].x,y:self._svgPositions[k].y};
            self._save();
        });
    },

    resetMapPositions:function(){this._savedMapPositions={};this._save();this._renderSvgMap();},

    // ── Context Menu ────────────────────────────────────

    _setupContextMenu:function(){
        var self=this;
        document.addEventListener('click',function(){self._hideCtx();});
        document.addEventListener('keydown',function(e){if(e.code==='Escape')self._hideCtx();if(e.code==='Space'&&!e.target.matches('input,select,textarea')){e.preventDefault();self.togglePlay();}});
        ['gcGanttRows','gcGanttLabels'].forEach(function(id){
            var el=document.getElementById(id);if(!el)return;
            el.addEventListener('contextmenu',function(e){
                e.preventDefault();
                var rowsEl=document.getElementById('gcGanttRows');
                if(rowsEl&&id==='gcGanttRows'){var rect=rowsEl.getBoundingClientRect();self._ctxClickPct=Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100));}
                else self._ctxClickPct=null;
                var barEl=e.target.closest('.gc-bar');
                if(barEl){self._showBarCtx(e.clientX,e.clientY,parseInt(barEl.dataset.sec),parseInt(barEl.dataset.row),parseInt(barEl.dataset.barId));return;}
                var rowEl=e.target.closest('[data-row]');
                if(rowEl){var sI=parseInt(rowEl.dataset.sec),rI=parseInt(rowEl.dataset.row);if(!isNaN(sI)&&!isNaN(rI))self._showRowCtx(e.clientX,e.clientY,sI,rI);}
            });
        });
    },


    _showBarCtx:function(x,y,sIdx,rIdx,barId){
        var sec=this._equipSchedules[sIdx];if(!sec)return;var row=sec.rows[rIdx];if(!row)return;
        var bar=row.bars.find(function(b){return b.id===barId;});if(!bar)return;var self=this;
        var menu=document.getElementById('gcCtxMenu');

        // Build test activity list: only show tests overlapping this bar's time frame
        var scheduleHtml='';
        var section=DataModel.getSection(sec.sectionId);
        var linkedTests=[];
        if(section){var mRow=section.rows[row.rowIdx];if(mRow&&mRow.testQty){self._getAllTests().forEach(function(t){var v=mRow.testQty[t.id];if(v&&v!==''&&v!=='0')linkedTests.push(t);});}}

        var barStart=bar.startDate?new Date(bar.startDate):null;
        var barEnd=bar.endDate?new Date(bar.endDate):null;
        var overlappingTests=linkedTests.filter(function(t){
            if(!t.startDate||!t.endDate||!barStart||!barEnd)return false;
            var tStart=new Date(t.startDate),tEnd=new Date(t.endDate);
            return tStart<barEnd&&tEnd>barStart;
        });

        if(overlappingTests.length>0){
            scheduleHtml='<div class="gc-ctx-divider"></div><div class="gc-ctx-label">Test Activities ('+self._esc(bar.startDate)+' \u2192 '+self._esc(bar.endDate)+')</div>';
            overlappingTests.forEach(function(t){
                var tc=DataModel.getLocationColor(t.location);var dot=tc?tc.color:'#64748b';
                var info=t.startDate&&t.endDate?' ('+t.startDate.substring(5)+'\u2192'+t.endDate.substring(5)+')':'';
                var locMatch=t.location===bar.location?' style="color:var(--gc-accent-cyan);"':'';
                var isSub=!!t.parentId;var prefix=isSub?'\u2514 ':'';var subAttr=isSub?' style="font-style:italic;opacity:0.85;'+(t.location===bar.location?'color:var(--gc-accent-cyan);':'')+'"':locMatch;
                scheduleHtml+='<div class="gc-ctx-item sub"'+subAttr+'><span class="gc-ctx-dot" style="background:'+dot+'"></span>'+prefix+self._esc(t.name)+' <span style="color:#8b929a;">\u00B7 '+self._esc(t.type)+' \u00B7 '+self._shortLoc(t.location||'')+info+'</span></div>';
            });
        } else if(linkedTests.length>0){
            scheduleHtml='<div class="gc-ctx-divider"></div><div class="gc-ctx-label">Test Activities</div><div class="gc-ctx-item disabled">No tests overlap this period</div>';
        }

        var locColor=self._getLocationColor(bar.location);
        menu.innerHTML='<div class="gc-ctx-header">'+self._esc(bar.location)+' \u2014 '+(bar.type==='transfer'?'Transfer':'Location')+'</div>'
            +'<div class="gc-ctx-item" data-action="edit-dates"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit Dates</div>'
            +'<div class="gc-ctx-item" data-action="change-loc"><span class="gc-ctx-dot" style="background:'+locColor+'"></span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Change Location</div>'
            +scheduleHtml
            +'<div class="gc-ctx-divider"></div><div class="gc-ctx-item danger" data-action="delete">\uD83D\uDDD1 Delete Bar</div>';
        self._positionCtx(menu,x,y);
        setTimeout(function(){
            var cl=menu.querySelector('[data-action="change-loc"]');if(cl)cl.onclick=function(ev){ev.stopPropagation();self._hideCtx();self._openLocationPicker(sIdx,rIdx,barId,bar,row);};
            var eb=menu.querySelector('[data-action="edit-dates"]');if(eb)eb.onclick=function(ev){ev.stopPropagation();self._hideCtx();self._openEditModal(sIdx,rIdx,barId);};
            var db=menu.querySelector('[data-action="delete"]');if(db)db.onclick=function(ev){ev.stopPropagation();row.bars=row.bars.filter(function(b){return b.id!==barId;});self._rebuildTransfers(row);self._save();self._hideCtx();self.render();};
        },0);
    },

    /** Location picker popup */
    _openLocationPicker:function(sIdx,rIdx,barId,bar,row){
        var self=this;
        var overlay=document.getElementById('gcLocPickerOverlay');
        if(!overlay){
            overlay=document.createElement('div');
            overlay.id='gcLocPickerOverlay';overlay.className='gc-loc-picker-overlay';
            overlay.innerHTML='<div class="gc-loc-picker"><div class="gc-loc-picker-header"><h3>Change Location</h3><button class="gc-loc-picker-close" id="gcLocPickerClose">&times;</button></div><div class="gc-loc-picker-current" id="gcLocPickerCurrent"></div><div class="gc-loc-picker-list" id="gcLocPickerList"></div></div>';
            document.body.appendChild(overlay);
        }
        var curEl=document.getElementById('gcLocPickerCurrent');
        var curColor=self._getLocationColor(bar.location);
        if(curEl) curEl.innerHTML='<span class="gc-ctx-dot" style="background:'+curColor+'"></span> Current: <strong>'+self._esc(bar.location)+'</strong>';

        var listEl=document.getElementById('gcLocPickerList');
        var locs=DataModel.getLocationNames();
        var h='';
        locs.forEach(function(n){
            var c=self._getLocationColor(n);
            var isCurrent=n===bar.location;
            h+='<div class="gc-loc-picker-item'+(isCurrent?' active':'')+'" data-loc="'+self._esc(n)+'">';
            h+='<span class="gc-loc-picker-dot" style="background:'+c+'"></span>';
            h+='<span class="gc-loc-picker-name">'+self._esc(n)+'</span>';
            if(isCurrent) h+='<span class="gc-loc-picker-check">\u2713</span>';
            h+='</div>';
        });
        listEl.innerHTML=h;

        overlay.classList.add('active');

        document.getElementById('gcLocPickerClose').onclick=function(){overlay.classList.remove('active');};
        overlay.onclick=function(e){if(e.target===overlay)overlay.classList.remove('active');};

        listEl.querySelectorAll('.gc-loc-picker-item').forEach(function(el){
            el.onclick=function(){
                var newLoc=el.dataset.loc;if(!newLoc||newLoc===bar.location){overlay.classList.remove('active');return;}
                bar.location=newLoc;bar.label=newLoc;
                if(bar.testId) self._syncTestData(bar.testId,bar.startDate,bar.endDate,bar.location);
                self._rebuildTransfers(row);self._save();
                overlay.classList.remove('active');
                self.render();
            };
        });
    },

    _showRowCtx:function(x,y,sIdx,rIdx){
        var sec=this._equipSchedules[sIdx];if(!sec)return;var row=sec.rows[rIdx];if(!row)return;var self=this;
        var menu=document.getElementById('gcCtxMenu');

        // Test scope items
        var tests=this._getTestsForRow(sec.sectionId,rIdx),testHtml='';
        if(tests.length>0){tests.forEach(function(t){var c=DataModel.getLocationColor(t.location);var dot=c?c.color:'#64748b';var hasDates=t.startDate&&t.endDate;var info=hasDates?' ('+t.startDate.substring(5)+'\u2192'+t.endDate.substring(5)+')':' (assign dates)';var style=hasDates?'':'color:#f59e0b;';var isSub=!!t.parentId;var prefix=isSub?'\u2514 ':'';var subStyle=isSub?'font-style:italic;opacity:0.85;':'';testHtml+='<div class="gc-ctx-item sub" data-action="from-test" data-tid="'+t.id+'" style="'+subStyle+'"><span class="gc-ctx-dot" style="background:'+dot+'"></span>'+prefix+self._esc(t.name)+' <span style="color:#64748b;">'+self._esc(t.type)+'</span> <span style="'+style+'font-size:10px;">'+info+'</span></div>';});}
        else testHtml='<div class="gc-ctx-item disabled">No linked test scopes</div>';

        // Flow edge shortcuts
        var shortcuts=this._getEdgeShortcuts(row.rowKey),shortcutHtml='';
        if(shortcuts.length>0){
            shortcutHtml='<div class="gc-ctx-divider"></div><div class="gc-ctx-label">Flow Transfer Shortcuts</div>';
            shortcuts.forEach(function(sc,i){
                var fc=DataModel.getLocationColor(sc.fromTest.location),tc=DataModel.getLocationColor(sc.toTest.location);
                var fCol=fc?fc.color:'#64748b',tCol=tc?tc.color:'#64748b';
                shortcutHtml+='<div class="gc-ctx-item sub" data-action="flow-sc" data-sc-idx="'+i+'">';
                shortcutHtml+='<span class="gc-ctx-dot" style="background:'+fCol+'"></span>';
                shortcutHtml+=self._esc(sc.fromTest.name)+' \u2192 ';
                shortcutHtml+='<span class="gc-ctx-dot" style="background:'+tCol+';margin-left:2px;"></span>';
                shortcutHtml+=self._esc(sc.toTest.name);
                shortcutHtml+='</div>';
            });
        }

        menu.innerHTML='<div class="gc-ctx-header">'+(row.itemNo?self._esc(row.itemNo)+' \u2014 ':'')+self._esc(row.name)+'</div><div class="gc-ctx-item" data-action="add-loc"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> Add Location Bar</div><div class="gc-ctx-divider"></div><div class="gc-ctx-label">Add from Test Scope</div>'+testHtml+shortcutHtml;
        self._positionCtx(menu,x,y);
        setTimeout(function(){
            var ab=menu.querySelector('[data-action="add-loc"]');if(ab)ab.onclick=function(ev){ev.stopPropagation();self._hideCtx();self._openAddModal(sIdx,rIdx);};
            menu.querySelectorAll('[data-action="from-test"]').forEach(function(el){el.onclick=function(ev){ev.stopPropagation();self._hideCtx();self._addFromTest(sIdx,rIdx,parseInt(el.dataset.tid));};});
            menu.querySelectorAll('[data-action="flow-sc"]').forEach(function(el){
                el.onclick=function(ev){
                    ev.stopPropagation();self._hideCtx();
                    var sc=shortcuts[parseInt(el.dataset.scIdx)];if(!sc)return;
                    // Add bars for both from and to test activities
                    if(sc.fromTest.startDate&&sc.fromTest.endDate&&sc.fromTest.location)
                        row.bars.push({id:self._nextBarId++,location:sc.fromTest.location,startDate:sc.fromTest.startDate,endDate:sc.fromTest.endDate,type:'location',label:sc.fromTest.location,testId:sc.fromTest.id});
                    if(sc.toTest.startDate&&sc.toTest.endDate&&sc.toTest.location)
                        row.bars.push({id:self._nextBarId++,location:sc.toTest.location,startDate:sc.toTest.startDate,endDate:sc.toTest.endDate,type:'location',label:sc.toTest.location,testId:sc.toTest.id});
                    self._rebuildTransfers(row);self._save();self._calcRange();self.render();
                };
            });
        },0);
    },

    _positionCtx:function(menu,x,y){menu.style.left=x+'px';menu.style.top=y+'px';menu.classList.add('visible');setTimeout(function(){var r=menu.getBoundingClientRect();if(r.right>window.innerWidth)menu.style.left=(x-r.width)+'px';if(r.bottom>window.innerHeight)menu.style.top=(y-r.height)+'px';},0);},
    _hideCtx:function(){var m=document.getElementById('gcCtxMenu');if(m)m.classList.remove('visible');},

    _getTestsForRow:function(sectionId,rowIdx){var section=DataModel.getSection(sectionId);if(!section)return[];var row=section.rows[rowIdx];if(!row||!row.testQty)return[];var out=[];this._getAllTests().forEach(function(t){var v=row.testQty[t.id];if(v&&v!==''&&v!=='0')out.push(t);});return out;},

    _addFromTest:function(sIdx,rIdx,testId){
        var t=DataModel.getTest(testId);if(!t)return;
        var sec=this._equipSchedules[sIdx];if(!sec)return;var row=sec.rows[rIdx];if(!row)return;
        // If test has dates and location, add directly
        if(t.startDate&&t.endDate&&t.location){
            row.bars.push({id:this._nextBarId++,location:t.location,startDate:t.startDate,endDate:t.endDate,type:'location',label:t.location,testId:testId});
            this._syncTestData(testId,t.startDate,t.endDate,t.location);
            this._rebuildTransfers(row);this._save();this._calcRange();this.render();
        } else {
            // Open modal so user can assign dates/location — link to this test
            this._openAddModal(sIdx,rIdx,testId,t);
        }
    },

    // ── Modal ────────────────────────────────────────────

    _openAddModal:function(sIdx,rIdx,testId,testObj){
        var sec=this._equipSchedules[sIdx];if(!sec)return;var row=sec.rows[rIdx];if(!row)return;
        document.getElementById('gcModalSecIdx').value=sIdx;document.getElementById('gcModalRowIdx').value=rIdx;
        document.getElementById('gcModalBarId').value='';
        document.getElementById('gcModalTestId').value=testId||'';
        var testBadge=document.getElementById('gcModalTestBadge');
        if(testObj&&testId){
            document.getElementById('gcModalTitle').textContent='Add Test Activity Bar';
            if(testBadge){testBadge.style.display='inline-block';testBadge.textContent='\u25C6 '+testObj.name+(testObj.type?' \u00B7 '+testObj.type:'');}
        } else {
            document.getElementById('gcModalTitle').textContent='Add Location Bar';
            if(testBadge)testBadge.style.display='none';
        }
        document.getElementById('gcModalEquipName').textContent=(row.itemNo?row.itemNo+' \u2014 ':'')+row.name;
        document.getElementById('gcModalDeleteBtn').style.display='none';
        var locOptions=DataModel.getLocationNames();
        var preselectedLoc=(testObj&&testObj.location)?testObj.location:'';
        document.getElementById('gcModalLocation').innerHTML=locOptions.map(function(n){return'<option value="'+n+'"'+(n===preselectedLoc?' selected':'')+'>'+n+'</option>';}).join('');
        var startDate,endDate;
        if(testObj&&testObj.startDate&&testObj.endDate){startDate=testObj.startDate;endDate=testObj.endDate;}
        else if(this._ctxClickPct!==null){var d=this._pctToDate(this._ctxClickPct);startDate=this._fmtDate(d);var e=new Date(d);e.setDate(e.getDate()+30);endDate=this._fmtDate(e);}
        else{var sorted=row.bars.filter(function(b){return b.type!=='transfer';}).sort(function(a,b){return new Date(a.startDate)-new Date(b.startDate);});var last=sorted.length>0?sorted[sorted.length-1]:null;if(last){var sd=new Date(last.endDate);startDate=this._fmtDate(sd);var ed=new Date(sd);ed.setDate(ed.getDate()+30);endDate=this._fmtDate(ed);}else{startDate=this._fmtDate(new Date());var ed2=new Date();ed2.setDate(ed2.getDate()+30);endDate=this._fmtDate(ed2);}}
        document.getElementById('gcModalStart').value=startDate;document.getElementById('gcModalEnd').value=endDate;
        document.getElementById('gcEditModal').classList.add('active');
    },

    _openEditModal:function(sIdx,rIdx,barId){
        var bar=this._getBarById(sIdx,rIdx,barId);if(!bar)return;var sec=this._equipSchedules[sIdx];var row=sec.rows[rIdx];
        document.getElementById('gcModalSecIdx').value=sIdx;document.getElementById('gcModalRowIdx').value=rIdx;document.getElementById('gcModalBarId').value=barId;
        document.getElementById('gcModalTestId').value=bar.testId||'';
        document.getElementById('gcModalTitle').textContent='Edit Bar';document.getElementById('gcModalEquipName').textContent=(row.itemNo?row.itemNo+' \u2014 ':'')+row.name;
        var testBadge=document.getElementById('gcModalTestBadge');
        if(bar.testId){var t=DataModel.getTest(bar.testId);if(t&&testBadge){testBadge.style.display='inline-block';testBadge.textContent='\u25C6 '+t.name+(t.type?' \u00B7 '+t.type:'');} else if(testBadge)testBadge.style.display='none';}
        else if(testBadge)testBadge.style.display='none';
        document.getElementById('gcModalDeleteBtn').style.display='';
        document.getElementById('gcModalLocation').innerHTML=DataModel.getLocationNames().map(function(n){return'<option value="'+n+'"'+(n===bar.location?' selected':'')+'>'+n+'</option>';}).join('');
        document.getElementById('gcModalStart').value=bar.startDate||'';document.getElementById('gcModalEnd').value=bar.endDate||'';
        document.getElementById('gcEditModal').classList.add('active');
    },

    saveModal:function(){
        var sIdx=parseInt(document.getElementById('gcModalSecIdx').value),rIdx=parseInt(document.getElementById('gcModalRowIdx').value),barId=document.getElementById('gcModalBarId').value;
        var location=document.getElementById('gcModalLocation').value,startDate=document.getElementById('gcModalStart').value,endDate=document.getElementById('gcModalEnd').value;
        var modalTestId=document.getElementById('gcModalTestId').value;
        if(!location||!startDate||!endDate)return;var sec=this._equipSchedules[sIdx];if(!sec)return;var row=sec.rows[rIdx];if(!row)return;
        if(barId){var bar=row.bars.find(function(b){return b.id===parseInt(barId);});if(!bar)return;bar.location=location;bar.startDate=startDate;bar.endDate=endDate;bar.label=location;
            if(bar.testId)this._syncTestData(bar.testId,startDate,endDate,location);}
        else{
            var newBar={id:this._nextBarId++,location:location,startDate:startDate,endDate:endDate,type:'location',label:location};
            if(modalTestId){newBar.testId=parseInt(modalTestId);this._syncTestData(newBar.testId,startDate,endDate,location);}
            row.bars.push(newBar);
        }
        this._rebuildTransfers(row);this._save();this.closeModal('gcEditModal');this._calcRange();this.render();
    },

    deleteFromModal:function(){
        var sIdx=parseInt(document.getElementById('gcModalSecIdx').value),rIdx=parseInt(document.getElementById('gcModalRowIdx').value),barId=parseInt(document.getElementById('gcModalBarId').value);
        var sec=this._equipSchedules[sIdx];if(!sec)return;var row=sec.rows[rIdx];if(!row)return;
        row.bars=row.bars.filter(function(b){return b.id!==barId;});this._rebuildTransfers(row);this._save();this.closeModal('gcEditModal');this.render();
    },

    closeModal:function(id){var el=document.getElementById(id);if(el)el.classList.remove('active');},

    // ── Timeline ────────────────────────────────────────

    _setupControls:function(){
        var self=this;
        var slider=document.getElementById('gcSlider');if(slider)slider.addEventListener('input',function(e){self._currentTime=parseInt(e.target.value)/1000;self._tick();});
        var pb=document.getElementById('gcPlayBtn');if(pb)pb.addEventListener('click',function(){self.togglePlay();});
        var si=document.getElementById('gcRangeStart'),ei=document.getElementById('gcRangeEnd');
        if(si){si.value=this._fmtDate(this._rangeStart);si.addEventListener('change',function(e){self._rangeStart=new Date(e.target.value);self.render();});}
        if(ei){ei.value=this._fmtDate(this._rangeEnd);ei.addEventListener('change',function(e){self._rangeEnd=new Date(e.target.value);self.render();});}
        window.addEventListener('resize',function(){self._updateTimeIndicator();});
        this._setupTimeIndicatorDrag();
    },

    /** Make the vertical timeline indicator draggable along its entire length.
     *  Users can grab anywhere on the full-height line to scrub the current
     *  time. The slider below remains fully functional as a fallback. */
    _setupTimeIndicatorDrag:function(){
        var self=this;
        var line=document.getElementById('gcTimeIndicatorFull');
        if(!line)return;

        var dragging=false;

        function scrubToClientX(clientX){
            var rowsEl=document.getElementById('gcGanttRows');
            if(!rowsEl)return;
            var rect=rowsEl.getBoundingClientRect();
            var rel=(clientX - rect.left) / rect.width;
            if(rel<0)rel=0; if(rel>1)rel=1;
            self._currentTime=rel;
            // Pause playback while scrubbing so the line doesn't fight the user
            if(self._isPlaying){
                self._isPlaying=false;
                if(self._playInterval){clearInterval(self._playInterval);self._playInterval=null;}
                var icon=document.getElementById('gcPlayIcon');if(icon)icon.setAttribute('d','M8 5v14l11-7z');
            }
            self._tick();
        }

        line.addEventListener('mousedown',function(e){
            if(e.button!==0)return;
            e.preventDefault();
            dragging=true;
            line.classList.add('dragging');
            scrubToClientX(e.clientX);
        });

        document.addEventListener('mousemove',function(e){
            if(!dragging)return;
            e.preventDefault();
            scrubToClientX(e.clientX);
        });

        document.addEventListener('mouseup',function(){
            if(!dragging)return;
            dragging=false;
            line.classList.remove('dragging');
        });

        // Also allow click-anywhere on the timeline strip to jump the line there
        var tl=document.getElementById('gcGanttTimeline');
        if(tl){
            tl.addEventListener('mousedown',function(e){
                // Only direct clicks on the timeline itself, not on milestones
                if(e.target!==tl)return;
                if(e.button!==0)return;
                e.preventDefault();
                dragging=true;
                line.classList.add('dragging');
                scrubToClientX(e.clientX);
            });
        }

        // Re-align the line when the user scrolls the body vertically or resizes
        var body=document.getElementById('gcGanttBody');
        if(body) body.addEventListener('scroll',function(){ self._updateTimeIndicator(); });
    },

    togglePlay:function(){
        var self=this;this._isPlaying=!this._isPlaying;
        var icon=document.getElementById('gcPlayIcon');if(icon)icon.setAttribute('d',this._isPlaying?'M6 19h4V5H6v14zm8-14v14h4V5h-4z':'M8 5v14l11-7z');
        if(this._isPlaying){this._playInterval=setInterval(function(){self._currentTime+=0.003;if(self._currentTime>1)self._currentTime=0;var s=document.getElementById('gcSlider');if(s)s.value=Math.round(self._currentTime*1000);self._tick();},50);}
        else clearInterval(this._playInterval);
    },

    _tick:function(){this._updateTimeIndicator();this._updateItemList();if(this._mapMode==='world')this._updateLeafletMarkers();else this._updateMapDots();},

    _updateTimeIndicator:function(){
        // Keep the header's chart area exactly as wide as the body's rows area.
        // When the body has a vertical scrollbar, the rows column is narrower
        // than the header strip — without this sync, milestones in the header
        // and the timeline indicator drift to the right relative to the bars.
        var body=document.getElementById('gcGanttBody');
        var head=document.querySelector('.gc-gantt-head');
        if(body && head){
            var sbw = body.offsetWidth - body.clientWidth;
            if(sbw < 0) sbw = 0;
            head.style.paddingRight = sbw + 'px';
        }

        // The single full-height indicator sits in .gc-gantt-wrapper, aligned to
        // .gc-gantt-rows (the bar chart column). We place it using pixel math
        // against the wrapper, so the line overlays both the header strip and
        // the scrollable body as one continuous vertical line.
        var full=document.getElementById('gcTimeIndicatorFull');
        var wrap=document.querySelector('.gc-gantt-wrapper');
        var rowsEl=document.getElementById('gcGanttRows');
        if(full && wrap && rowsEl){
            var wRect=wrap.getBoundingClientRect();
            var rRect=rowsEl.getBoundingClientRect();
            var offsetInWrapper = rRect.left - wRect.left;
            var px = offsetInWrapper + (this._currentTime * rRect.width);
            full.style.left = px + 'px';
        }
        var disp=document.getElementById('gcCurrentDate');
        if(disp){var d=new Date(this._rangeStart.getTime()+(this._rangeEnd-this._rangeStart)*this._currentTime);disp.textContent=d.toLocaleDateString('en',{day:'numeric',month:'short',year:'numeric'});}
        var sl=document.getElementById('gcSlider');if(sl&&document.activeElement!==sl)sl.value=Math.round(this._currentTime*1000);
    },

    // ── Map ──────────────────────────────────────────────

    _renderMap:function(){if(this._mapMode==='simple')this._renderSvgMap();if(this._mapMode==='world'&&this._leafletInited)this._refreshLeaflet();},

    setMapMode:function(mode){
        this._mapMode=mode;
        document.getElementById('gcBtnSimple')?.classList.toggle('active',mode==='simple');
        document.getElementById('gcBtnWorld')?.classList.toggle('active',mode==='world');
        var svg=document.getElementById('gcMapSvg');if(svg)svg.style.display=mode==='simple'?'':'none';
        var lf=document.getElementById('gcLeafletMap');
        if(mode==='world'){if(lf)lf.classList.add('visible');if(!this._leafletInited)this._initLeaflet();else{this._leafletMap.invalidateSize();this._refreshLeaflet();}this._startAnim();}
        else{if(lf)lf.classList.remove('visible');this._stopAnim();this._renderSvgMap();}
    },

    _getUsedLocs:function(){var u=new Set();this._equipSchedules.forEach(function(s){s.rows.forEach(function(r){r.bars.forEach(function(b){if(b.location)u.add(b.location);if(b.fromLocation)u.add(b.fromLocation);});});});GCApp._getAllTests().forEach(function(t){if(t.location)u.add(t.location);});return u;},

    _rowPosAt:function(row,t){
        var ms=this._rangeEnd-this._rangeStart,cd=new Date(this._rangeStart.getTime()+ms*t);
        for(var i=0;i<row.bars.length;i++){var b=row.bars[i];if(!b.startDate||!b.endDate)continue;var bs=new Date(b.startDate),be=new Date(b.endDate);
            if(cd>=bs&&cd<=be){if(b.type==='transfer'){var prog=(cd-bs)/(be-bs);return{location:b.location,fromLocation:b.fromLocation||b.location,progress:Math.max(0,Math.min(1,prog)),isTransfer:true};}return{location:b.location,progress:0,isTransfer:false};}}
        // Check if before first bar or after last — show at nearest location
        var sorted=row.bars.slice().sort(function(a,b){return new Date(a.startDate)-new Date(b.startDate);});
        if(sorted.length>0){
            if(cd<new Date(sorted[0].startDate))return{location:sorted[0].location,progress:0,isTransfer:false};
            var last=sorted[sorted.length-1];if(cd>new Date(last.endDate))return{location:last.location,progress:0,isTransfer:false};
        }
        return null;
    },

    _renderSvgMap:function(){
        var pg=document.getElementById('gcTransportPaths'),ng=document.getElementById('gcLocationNodes'),dg=document.getElementById('gcItemDots');
        if(!pg||!ng||!dg)return;
        var locs=Array.from(this._getUsedLocs()),self=this;

        // Use saved positions or generate layout
        var saved=this._loadMapPositions(),pos={};
        var auto=this._layoutLocs(locs);
        locs.forEach(function(loc){pos[loc]=saved[loc]||auto[loc];});
        this._svgPositions=pos;

        this._renderSvgPaths();

        var nh='';
        locs.forEach(function(loc){var p=pos[loc];if(!p)return;var c=self._getLocationColor(loc),l=self._shortLoc(loc);nh+='<g class="location-node" data-loc="'+self._esc(loc)+'" transform="translate('+p.x.toFixed(1)+','+p.y.toFixed(1)+')"><circle r="32" fill="'+c+'" opacity="0.15"/><circle r="22" fill="rgba(26,35,48,0.9)" stroke="'+c+'" stroke-width="2"/><text class="location-label" y="4" font-size="9" fill="'+c+'">'+l+'</text><text class="location-name" y="40" font-size="7">'+self._esc(loc)+'</text></g>';});
        ng.innerHTML=nh;
        this._renderDots(dg,pos);
    },

    _renderSvgPaths:function(){
        var pg=document.getElementById('gcTransportPaths');if(!pg||!this._svgPositions)return;
        var routes=new Set(),self=this,pos=this._svgPositions;
        this._equipSchedules.forEach(function(s){s.rows.forEach(function(r){r.bars.forEach(function(b){if(b.type==='transfer'&&b.fromLocation&&b.location)routes.add(b.fromLocation+'|'+b.location);});});});
        var ph='';
        routes.forEach(function(route){var p=route.split('|'),fp=pos[p[0]],tp=pos[p[1]];if(!fp||!tp)return;var cx=(fp.x+tp.x)/2,cy=(fp.y+tp.y)/2-50,d='M '+fp.x.toFixed(1)+' '+fp.y.toFixed(1)+' Q '+cx.toFixed(1)+' '+cy.toFixed(1)+' '+tp.x.toFixed(1)+' '+tp.y.toFixed(1),c=self._getLocationColor(p[0]);ph+='<g class="transport-path"><path d="'+d+'" stroke="'+c+'" stroke-width="8" fill="none" opacity="0.15" stroke-linecap="round"/><path d="'+d+'" stroke="'+c+'" stroke-width="2" fill="none" stroke-dasharray="8 4" stroke-linecap="round" opacity="0.6"/></g>';});
        pg.innerHTML=ph;
    },

    _layoutLocs:function(arr){var p={},cols=Math.ceil(Math.sqrt(arr.length*1.5))||2,rows=Math.ceil(arr.length/cols)||1,cw=600/cols,ch=340/rows,self=this;arr.forEach(function(loc,i){var c=i%cols,r=Math.floor(i/cols),s=self._hash(loc);p[loc]={x:100+c*cw+cw/2+(self._srand(s)-0.5)*cw*0.4,y:60+r*ch+ch/2+(self._srand(s+1)-0.5)*ch*0.4};});return p;},

    _svgBezierAt:function(from,to,t){var cx=(from.x+to.x)/2,cy=(from.y+to.y)/2-50;return{x:(1-t)*(1-t)*from.x+2*(1-t)*t*cx+t*t*to.x,y:(1-t)*(1-t)*from.y+2*(1-t)*t*cy+t*t*to.y};},

    _renderDots:function(g,pos){
        var h='',self=this,all=this._flatRows();
        all.forEach(function(item,idx){
            var info=self._rowPosAt(item.row,self._currentTime);if(!info)return;
            var c=self._getEquipColor(item.row),cx,cy;
            if(info.isTransfer&&info.fromLocation){var fp=pos[info.fromLocation],tp=pos[info.location];if(fp&&tp){var pt=self._svgBezierAt(fp,tp,info.progress);cx=pt.x;cy=pt.y;}else return;}
            else{var p=pos[info.location];if(!p)return;var angle=(idx/Math.max(all.length,1))*Math.PI*2,r=28+Math.min(idx*3,30);cx=p.x+Math.cos(angle)*r;cy=p.y+Math.sin(angle)*r;}
            h+='<circle class="item-dot" data-row-key="'+self._esc(item.row.rowKey)+'" r="6" cx="'+cx.toFixed(1)+'" cy="'+cy.toFixed(1)+'" fill="'+c+'" stroke="#0a0e14" stroke-width="2" filter="url(#gcGlow)" style="cursor:pointer;"/>';
        });
        g.innerHTML=h;
    },

    _updateMapDots:function(){var g=document.getElementById('gcItemDots');if(g&&this._svgPositions)this._renderDots(g,this._svgPositions);},

    // ── Leaflet ─────────────────────────────────────────

    _initLeaflet:function(){
        this._leafletMap=L.map('gcLeafletMap',{center:[55,10],zoom:4});
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{attribution:'&copy; OSM',subdomains:'abcd',maxZoom:19}).addTo(this._leafletMap);
        this._leafletInited=true;this._refreshLeaflet();
        var self=this;
        // Left-click map background → clear dot highlight + hide tooltip
        this._leafletMap.on('click',function(e){
            self._clearLeafletFocus();
            document.getElementById('gcTooltip')?.classList.remove('visible');
        });
        // Right-click map background → assign location coordinates (skip during move mode)
        this._leafletMap.on('contextmenu',function(e){
            if(self._movingLocation) return;
            self._showAssignLocationMenu(e.latlng,e.originalEvent.clientX,e.originalEvent.clientY);
        });
        setTimeout(function(){self._leafletMap.invalidateSize();var b=[];self._getUsedLocs().forEach(function(loc){var c=self._getCoords(loc);if(c)b.push([c.lat,c.lng]);});if(b.length>1)self._leafletMap.fitBounds(b,{padding:[50,50]});},100);
    },

    /** Show context menu to pick a location and assign clicked coordinates to it */
    _showAssignLocationMenu:function(latlng,clientX,clientY){
        var self=this;
        var menu=document.getElementById('gcCtxMenu');if(!menu)return;
        var names=DataModel.getLocationNames();

        var h='<div class="gc-ctx-header">Assign Location Here</div>';
        h+='<div class="gc-ctx-label" style="font-size:9px;padding:2px 14px;color:#5c6370;">'+latlng.lat.toFixed(4)+', '+latlng.lng.toFixed(4)+'</div>';
        h+='<div class="gc-ctx-divider"></div>';

        names.forEach(function(name){
            var c=self._getLocationColor(name);
            var hasCoords=DataModel.locations[name]&&DataModel.locations[name].lat!==undefined;
            h+='<div class="gc-ctx-item sub" data-action="assign-loc" data-loc-name="'+self._esc(name)+'">';
            h+='<span class="gc-ctx-dot" style="background:'+c+'"></span>';
            h+=self._esc(name);
            if(hasCoords) h+=' <span style="color:#3b4252;font-size:9px;">(has coords)</span>';
            h+='</div>';
        });

        h+='<div class="gc-ctx-divider"></div>';
        h+='<div class="gc-ctx-item" data-action="assign-new">+ New Location Here</div>';

        menu.innerHTML=h;
        this._positionCtx(menu,clientX,clientY);

        setTimeout(function(){
            menu.querySelectorAll('[data-action="assign-loc"]').forEach(function(el){
                el.onclick=function(ev){
                    ev.stopPropagation();
                    var locName=el.dataset.locName;
                    self._assignCoordsToLocation(locName,latlng.lat,latlng.lng);
                    self._hideCtx();
                };
            });
            var newBtn=menu.querySelector('[data-action="assign-new"]');
            if(newBtn) newBtn.onclick=function(ev){
                ev.stopPropagation();
                self._hideCtx();
                var name=prompt('New location name:');
                if(!name||!name.trim())return;
                name=name.trim();
                if(DataModel.locations[name]){
                    self._assignCoordsToLocation(name,latlng.lat,latlng.lng);
                } else {
                    // Create new location
                    var color='#06b6d4';
                    DataModel.locations[name]={
                        color:color,
                        bg:'rgba(6,182,212,0.08)',
                        border:'rgba(6,182,212,0.25)',
                        lat:latlng.lat,
                        lng:latlng.lng
                    };
                    self._persistLocationPrefs();
                    self._refreshLeaflet();
                    self._renderLegend();
                }
            };
        },0);
    },

    _assignCoordsToLocation:function(name,lat,lng){
        var loc=DataModel.locations[name];
        if(!loc)return;
        loc.lat=lat;
        loc.lng=lng;
        this._persistLocationPrefs();
        this._refreshLeaflet();
        this._renderLegend();
    },

    _persistLocationPrefs:function(){
        var d={};
        Object.keys(DataModel.locations).forEach(function(n){
            var l=DataModel.locations[n],e={color:l.color,bg:l.bg,border:l.border};
            if(l.lat!==undefined&&l.lng!==undefined){e.lat=l.lat;e.lng=l.lng;}
            d[n]=e;
        });
        StorageManager.save({prefs:{customLocations:d}});
    },

    _refreshLeaflet:function(){
        if(!this._leafletInited)return;var self=this;
        Object.values(this._leafletMarkers).forEach(function(m){self._leafletMap.removeLayer(m);});Object.values(this._leafletItemMarkers).forEach(function(m){self._leafletMap.removeLayer(m);});this._leafletPaths.forEach(function(p){self._leafletMap.removeLayer(p);});
        this._leafletMarkers={};this._leafletItemMarkers={};this._leafletPaths=[];
        this._getUsedLocs().forEach(function(loc){
            var co=self._getCoords(loc);if(!co)return;var c=self._getLocationColor(loc);
            var icon=L.divIcon({className:'leaflet-custom-marker',html:'<div class="lf-marker" style="--marker-color:'+c+'"><div class="lf-marker-glow"></div><div class="lf-marker-circle"><span>'+self._shortLoc(loc)+'</span></div><div class="lf-marker-name">'+self._esc(loc)+'</div></div>',iconSize:[80,60],iconAnchor:[40,25]});
            // Rich popup: test activities + equipment with their linked tests
            var popup='<div style="font-family:monospace;font-size:11px;min-width:220px;max-height:350px;overflow-y:auto;">';
            popup+='<strong style="color:'+c+';font-size:12px;">'+self._esc(loc)+'</strong>';
            var testsHere=GCApp._getAllTests().filter(function(t){return t.location===loc;});
            if(testsHere.length>0){
                popup+='<div style="margin-top:6px;border-top:1px solid #333;padding-top:4px;"><div style="color:#8b929a;font-size:9px;text-transform:uppercase;margin-bottom:2px;">Test Activities</div>';
                testsHere.forEach(function(t){
                    var dates=t.startDate&&t.endDate?t.startDate.substring(5)+' \u2192 '+t.endDate.substring(5):'No dates';
                    var isSub=!!t.parentId;var prefix=isSub?'<span style="color:#a78bfa;">\u2514 </span>':'';var subStyle=isSub?'font-style:italic;color:#a78bfa;':'';
                    popup+='<div style="margin-bottom:2px;'+subStyle+'">'+prefix+self._esc(t.name)+' <span style="color:#8b929a;">\u00B7 '+self._esc(t.type)+' \u00B7 '+dates+'</span></div>';
                });
                popup+='</div>';
            }
            // Equipment at this location with their linked test activities
            var equipHere=[];
            self._flatRows().forEach(function(item){
                var info=self._rowPosAt(item.row,self._currentTime);
                if(info&&info.location===loc&&!info.isTransfer) equipHere.push({row:item.row,sec:item.sec});
            });
            if(equipHere.length>0){
                popup+='<div style="margin-top:6px;border-top:1px solid #333;padding-top:4px;"><div style="color:#8b929a;font-size:9px;text-transform:uppercase;margin-bottom:3px;">Equipment ('+equipHere.length+')</div>';
                var shown=Math.min(equipHere.length,10);
                for(var ei=0;ei<shown;ei++){
                    var er=equipHere[ei].row,esec=equipHere[ei].sec;
                    var ec=self._getEquipColor(er);
                    popup+='<div style="margin-bottom:4px;"><div style="color:'+ec+';font-weight:600;">'+(er.itemNo?self._esc(er.itemNo)+' \u2014 ':'')+self._esc(er.name)+'</div>';
                    var section=DataModel.getSection(esec.sectionId);
                    if(section){
                        var mRow=section.rows[er.rowIdx];
                        if(mRow&&mRow.testQty){
                            GCApp._getAllTests().forEach(function(t){
                                var v=mRow.testQty[t.id];
                                if(v&&v!==''&&v!=='0'&&t.location===loc){
                                    var dates=t.startDate&&t.endDate?t.startDate.substring(5)+'\u2192'+t.endDate.substring(5):'';
                                    popup+='<div style="padding-left:10px;color:#8b929a;font-size:10px;">\u2514 '+self._esc(t.name)+' \u00B7 '+self._esc(t.type)+(dates?' \u00B7 '+dates:'')+'</div>';
                                }
                            });
                        }
                    }
                    popup+='</div>';
                }
                if(equipHere.length>10) popup+='<div style="color:#5c6370;font-size:10px;">...and '+(equipHere.length-10)+' more</div>';
                popup+='</div>';
            }
            popup+='</div>';
            self._leafletMarkers[loc]=L.marker([co.lat,co.lng],{icon:icon}).addTo(self._leafletMap);
            // Left-click → show popup with test + equipment info
            self._leafletMarkers[loc].bindPopup(popup,{maxWidth:300,className:'gc-leaflet-popup'});
            // Right-click location → context menu with View Info + Update Location
            (function(popupHtml,locName,coords){
                self._leafletMarkers[locName].on('contextmenu',function(e){
                    self._showLocContextMenu(popupHtml,locName,coords,e.originalEvent.clientX,e.originalEvent.clientY);
                });
            })(popup,loc,co);
        });
        var routes=new Set();
        this._equipSchedules.forEach(function(s){s.rows.forEach(function(r){r.bars.forEach(function(b){if(b.type==='transfer'&&b.fromLocation&&b.location)routes.add(b.fromLocation+'|'+b.location);});});});
        routes.forEach(function(route){var p=route.split('|'),fc=self._getCoords(p[0]),tc=self._getCoords(p[1]);if(!fc||!tc)return;var pts=self._curvedLL(fc,tc),c=self._getLocationColor(p[0]);self._leafletPaths.push(L.polyline(pts,{color:c,weight:8,opacity:0.12}).addTo(self._leafletMap),L.polyline(pts,{color:c,weight:2,opacity:0.6,dashArray:'10,8'}).addTo(self._leafletMap));});
        this._flatRows().forEach(function(item){
            var info=self._rowPosAt(item.row,self._currentTime);var co=null;
            if(info){if(info.isTransfer&&info.fromLocation){var fc=self._getCoords(info.fromLocation),tc=self._getCoords(info.location);if(fc&&tc)co=self._llBezierAt(fc,tc,info.progress);}else co=self._getCoords(info.location);}
            if(!co)return;
            var c=self._getEquipColor(item.row);
            var icon=L.divIcon({className:'leaflet-item-marker',html:'<div class="lf-item-dot" style="background:'+c+';box-shadow:0 0 10px '+c+'50;"></div>',iconSize:[12,12],iconAnchor:[6,6]});
            var m=L.marker([co.lat,co.lng],{icon:icon,zIndexOffset:1000}).addTo(self._leafletMap);
            m._cp={lat:co.lat,lng:co.lng};m._tp={lat:co.lat,lng:co.lng};

            // Rich popup
            var popup='<div style="font-family:monospace;font-size:11px;min-width:180px;">';
            popup+='<strong style="color:#00d9ff;">'+(item.row.itemNo?self._esc(item.row.itemNo)+' — ':'')+self._esc(item.row.name)+'</strong>';
            popup+='<div style="color:#8b929a;font-size:10px;margin:2px 0 6px;">'+self._esc(item.sec.sectionName)+'</div>';
            if(info){popup+='<div style="margin-bottom:4px;">📍 '+(info.isTransfer?'In transit → ':'')+self._esc(info.location)+'</div>';}
            var bars=item.row.bars.filter(function(b){return b.type!=='transfer';});
            if(bars.length>0){
                popup+='<div style="border-top:1px solid #333;padding-top:4px;margin-top:4px;">';
                bars.forEach(function(b){popup+='<div>'+self._shortLoc(b.location)+': '+self._esc(b.startDate||'')+' → '+self._esc(b.endDate||'')+'</div>';});
                popup+='</div>';
            }
            popup+='</div>';
            // Right-click equipment dot → show tooltip (same box as simplified view)
            (function(popupHtml,dotCoords,rowKeyRef){
                m.on('contextmenu',function(e){
                    self._showLeafletTooltip(popupHtml,(rowKeyRef.itemNo?rowKeyRef.itemNo+' — ':'')+rowKeyRef.name,dotCoords);
                });
            })(popup,co,item.row);
            // Left-click equipment dot → highlight only this dot
            (function(markerRef){
                markerRef.on('click',function(){
                    self._clearLeafletFocus();
                    var el=markerRef.getElement();
                    if(el)el.classList.add('lf-dot-focused');
                });
            })(m);

            self._leafletItemMarkers[item.row.rowKey]=m;
        });
    },

    _llBezierAt:function(from,to,t){var d=Math.sqrt(Math.pow(from.lat-to.lat,2)+Math.pow(from.lng-to.lng,2));var cl=(from.lat+to.lat)/2+Math.min(d*0.3,5),cg=(from.lng+to.lng)/2;return{lat:(1-t)*(1-t)*from.lat+2*(1-t)*t*cl+t*t*to.lat,lng:(1-t)*(1-t)*from.lng+2*(1-t)*t*cg+t*t*to.lng};},

    _updateLeafletMarkers:function(){
        if(!this._leafletInited)return;var self=this;
        this._flatRows().forEach(function(item){var m=self._leafletItemMarkers[item.row.rowKey];if(!m)return;var info=self._rowPosAt(item.row,self._currentTime);var co=null;if(info){if(info.isTransfer&&info.fromLocation){var fc=self._getCoords(info.fromLocation),tc=self._getCoords(info.location);if(fc&&tc)co=self._llBezierAt(fc,tc,info.progress);}else co=self._getCoords(info.location);}if(!co)return;m._tp={lat:co.lat,lng:co.lng};if(!m._cp)m._cp={lat:co.lat,lng:co.lng};m._cp.lat+=(m._tp.lat-m._cp.lat)*0.15;m._cp.lng+=(m._tp.lng-m._cp.lng)*0.15;m.setLatLng([m._cp.lat,m._cp.lng]);});
    },

    _startAnim:function(){if(this._animRunning)return;this._animRunning=true;var self=this;(function loop(){if(!self._animRunning)return;if(self._mapMode==='world'&&self._leafletInited)self._updateLeafletMarkers();requestAnimationFrame(loop);})();},
    _stopAnim:function(){this._animRunning=false;},
    _curvedLL:function(f,t){var pts=[],n=25,d=Math.sqrt(Math.pow(f.lat-t.lat,2)+Math.pow(f.lng-t.lng,2)),cl=(f.lat+t.lat)/2+Math.min(d*0.3,5),cg=(f.lng+t.lng)/2;for(var i=0;i<=n;i++){var s=i/n;pts.push([(1-s)*(1-s)*f.lat+2*(1-s)*s*cl+s*s*t.lat,(1-s)*(1-s)*f.lng+2*(1-s)*s*cg+s*s*t.lng]);}return pts;},

    // ── Sidebar ─────────────────────────────────────────

    _updateItemList:function(){
        var el=document.getElementById('gcItemList');if(!el)return;var self=this,h='';
        this._flatRows().forEach(function(item){var info=self._rowPosAt(item.row,self._currentTime),c=self._getEquipColor(item.row);var locText='\u2014',status='';if(info){if(info.isTransfer){locText='\u2192 '+self._shortLoc(info.location);status='TRANSIT';}else{locText=self._shortLoc(info.location);status='AT LOC';}}h+='<div class="gc-item-entry"><div class="gc-item-color" style="background:'+c+';"></div><div class="gc-item-info"><span class="gc-item-name" style="color:'+c+'">'+self._esc(item.row.name)+'</span><span class="gc-item-loc">'+locText+'</span></div>'+(status?'<span class="gc-item-status'+(info&&info.isTransfer?' transit':'')+'">'+status+'</span>':'')+'</div>';});
        el.innerHTML=h;
    },

    _renderLegend:function(){var el=document.getElementById('gcLegend');if(!el)return;var self=this,h='';this._getUsedLocs().forEach(function(loc){h+='<div class="gc-legend-item" data-loc="'+self._esc(loc)+'" title="'+self._esc(loc)+'"><div class="gc-legend-dot" style="background:'+self._getLocationColor(loc)+'"></div>'+self._esc(loc)+'</div>';});el.innerHTML=h;},

    _focusedLoc:null,

    _clearLeafletFocus:function(){
        Object.values(this._leafletItemMarkers).forEach(function(m){
            if(!m)return;var el=m.getElement();
            if(el)el.classList.remove('lf-dot-focused');
        });
    },

    /** Show the gcTooltip div positioned relative to the leaflet map container */
    _showLeafletTooltip:function(html,title,coords){
        var tip=document.getElementById('gcTooltip');if(!tip)return;
        var mapContainer=document.getElementById('gcLeafletMap');if(!mapContainer)return;

        document.getElementById('gcTooltipTitle').textContent=title||'';
        document.getElementById('gcTooltipContent').innerHTML=html;

        // Convert lat/lng to pixel position on the map container
        var point=this._leafletMap.latLngToContainerPoint([coords.lat,coords.lng]);
        var mapRect=mapContainer.getBoundingClientRect();

        tip.style.left=(mapRect.left+point.x+15)+'px';
        tip.style.top=(mapRect.top+point.y+15)+'px';
        tip.classList.add('visible');
        clearTimeout(tip._hideTimer);
        tip._hideTimer=setTimeout(function(){tip.classList.remove('visible');},6000);
    },

    /** Location node right-click context menu */
    _showLocContextMenu:function(popupHtml,locName,coords,clientX,clientY){
        var self=this;
        var menu=document.getElementById('gcCtxMenu');if(!menu)return;
        var c=this._getLocationColor(locName);

        var h='<div class="gc-ctx-header"><span class="gc-ctx-dot" style="background:'+c+'"></span>'+this._esc(locName)+'</div>';
        h+='<div class="gc-ctx-label" style="font-size:9px;padding:2px 14px;color:#5c6370;">'+coords.lat.toFixed(4)+', '+coords.lng.toFixed(4)+'</div>';
        h+='<div class="gc-ctx-divider"></div>';
        h+='<div class="gc-ctx-item" data-action="view-info">📋 View Info</div>';
        h+='<div class="gc-ctx-item" data-action="update-loc">📍 Update Position</div>';

        menu.innerHTML=h;
        this._positionCtx(menu,clientX,clientY);

        setTimeout(function(){
            var viewBtn=menu.querySelector('[data-action="view-info"]');
            if(viewBtn) viewBtn.onclick=function(ev){
                ev.stopPropagation();
                self._hideCtx();
                self._showLeafletTooltip(popupHtml,locName,coords);
            };
            var updateBtn=menu.querySelector('[data-action="update-loc"]');
            if(updateBtn) updateBtn.onclick=function(ev){
                ev.stopPropagation();
                self._hideCtx();
                self._startLocationMove(locName);
            };
        },0);
    },

    /** Enter "pick new position" mode for a location */
    _movingLocation:null,
    _moveOverlay:null,

    _startLocationMove:function(locName){
        var self=this;
        this._movingLocation=locName;

        // Show a banner overlay on the map
        var mapContainer=document.getElementById('gcLeafletMap');if(!mapContainer)return;
        var overlay=document.createElement('div');
        overlay.id='gcMoveOverlay';
        overlay.style.cssText='position:absolute;top:0;left:0;right:0;z-index:1000;padding:8px 16px;background:rgba(0,212,255,0.15);border-bottom:2px solid rgba(0,212,255,0.4);text-align:center;font-size:12px;font-weight:600;color:#00d4ff;pointer-events:none;backdrop-filter:blur(2px);';
        overlay.textContent='Click on the map to set new position for "'+locName+'" · Press Esc to cancel';
        mapContainer.style.position='relative';
        mapContainer.appendChild(overlay);
        this._moveOverlay=overlay;

        // Change cursor
        mapContainer.style.cursor='crosshair';

        // One-time click handler
        var onClick=function(e){
            self._leafletMap.off('click',onClick);
            self._leafletMap.off('contextmenu',onCancel);
            document.removeEventListener('keydown',onEsc);
            self._endLocationMove();

            // Apply new coordinates
            var loc=DataModel.locations[locName];
            if(loc){
                loc.lat=e.latlng.lat;
                loc.lng=e.latlng.lng;
                self._persistLocationPrefs();
                self._refreshLeaflet();
                self._renderLegend();
            }
        };
        var onCancel=function(e){
            self._leafletMap.off('click',onClick);
            self._leafletMap.off('contextmenu',onCancel);
            document.removeEventListener('keydown',onEsc);
            self._endLocationMove();
        };
        var onEsc=function(e){
            if(e.key==='Escape'){
                self._leafletMap.off('click',onClick);
                self._leafletMap.off('contextmenu',onCancel);
                document.removeEventListener('keydown',onEsc);
                self._endLocationMove();
            }
        };

        this._leafletMap.once('click',onClick);
        this._leafletMap.once('contextmenu',onCancel);
        document.addEventListener('keydown',onEsc);
    },

    _endLocationMove:function(){
        this._movingLocation=null;
        var mapContainer=document.getElementById('gcLeafletMap');
        if(mapContainer) mapContainer.style.cursor='';
        if(this._moveOverlay&&this._moveOverlay.parentElement){
            this._moveOverlay.parentElement.removeChild(this._moveOverlay);
        }
        this._moveOverlay=null;
    },

    // ── Helpers ─────────────────────────────────────────

    _flatRows:function(){var o=[];this._equipSchedules.forEach(function(s){s.rows.forEach(function(r){o.push({sec:s,row:r});});});return o;},
    _getEquipColor:function(row){var locBars=row.bars.filter(function(b){return b.type!=='transfer';});return locBars.length>0&&locBars[0].location?this._getLocationColor(locBars[0].location):'#00d9ff';},
    _getLocationColor:function(loc){var c=DataModel.getLocationColor(loc);return c?c.color:'#64748b';},
    _shortLoc:function(loc){if(!loc)return'?';var p=loc.split(',');return p.length>1?p[1].trim().substring(0,12):loc.substring(0,12);},
    _fmtDate:function(d){if(!d)return'';if(typeof d==='string')d=new Date(d);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');},
    _esc:function(s){if(!s)return'';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML;},
    _hash:function(s){var h=0;for(var i=0;i<s.length;i++)h=((h<<5)-h)+s.charCodeAt(i)&0x7fffffff;return h;},
    _srand:function(s){var x=Math.sin(s)*10000;return x-Math.floor(x);},

    // ══════════════════════════════════════════════════════
    // FILTER BAR — WP and test scope chips
    // ══════════════════════════════════════════════════════


    _lockedFiltersLoaded:false,

    /** Load locked filters from prefs — called ONCE during init */
    _initLockedFilters:function(){
        if(this._lockedFiltersLoaded) return;
        this._lockedFiltersLoaded=true;
        this._lockedTypes={};
        this._lockedWps={};
        try{
            var p=StorageManager.loadPrefs();
            if(p){
                var self=this;
                (p.gcLockedTypeFilters||[]).forEach(function(t){self._lockedTypes[t]=true;self._activeTypes[t]=true;});
                (p.gcLockedWpFilters||[]).forEach(function(w){self._lockedWps[w]=true;self._activeWps[w]=true;});
            }
        }catch(e){}
    },

    _renderFilterBar:function(){
        var els=document.querySelectorAll('#gcFilterBar, #gcFilterBarSummary');
        if(!els.length)return;
        var self=this;

        // Load locked state only once
        this._initLockedFilters();

        var typeColors={'FAT':'#00d4ff','EFAT':'#10b981','FIT':'#8b5cf6','M-SIT':'#ef4444','SIT':'#f59e0b','SRT':'#ec4899'};
        var wpColors={'WP03':'#06b6d4','WP04':'#8b5cf6','WP05':'#10b981','WP06':'#f59e0b','WP07':'#ef4444','WP09':'#ec4899','WP10':'#6366f1','WP11':'#14b8a6'};
        var usedTypes={},usedWPs={};
        GCApp._getAllTests().forEach(function(t){if(t.type)usedTypes[t.type]=true;if(t.workpack)usedWPs[t.workpack]=true;});
        DataModel.sections.forEach(function(sec){sec.rows.forEach(function(row){if(row.workpack)usedWPs[row.workpack]=true;});});

        var h='<span class="gc-filter-label">Activity:</span>';
        // Canonical order matches lane order elsewhere in the app: FAT → EFAT → FIT → M-SIT → SIT → SRT
        var typeOrder=['FAT','EFAT','FIT','M-SIT','SIT','SRT'];
        var orderedTypes=typeOrder.filter(function(t){return usedTypes[t];})
            .concat(Object.keys(usedTypes).filter(function(t){return typeOrder.indexOf(t)===-1;}).sort());
        orderedTypes.forEach(function(type){
            var c=typeColors[type]||'#888',active=!!self._activeTypes[type],locked=!!self._lockedTypes[type];
            h+='<button class="gc-chip'+(active?' active':'')+'" onclick="GCApp.toggleFilter(\'actType\',\''+self._esc(type)+'\')" oncontextmenu="event.preventDefault();GCApp._showFilterCtx(event,\'actType\',\''+self._esc(type)+'\')"><span class="gc-chip-dot" style="background:'+c+'"></span>'+self._esc(type)+(locked?' \uD83D\uDD12':'')+'</button>';
        });
        h+='<span class="gc-filter-label" style="margin-left:12px;">WP:</span>';
        Object.keys(usedWPs).sort().forEach(function(wp){
            var c=wpColors[wp]||'#888',active=!!self._activeWps[wp],locked=!!self._lockedWps[wp];
            h+='<button class="gc-chip'+(active?' active':'')+'" onclick="GCApp.toggleFilter(\'wp\',\''+self._esc(wp)+'\')" oncontextmenu="event.preventDefault();GCApp._showFilterCtx(event,\'wp\',\''+self._esc(wp)+'\')"><span class="gc-chip-dot" style="background:'+c+'"></span>'+self._esc(wp)+(locked?' \uD83D\uDD12':'')+'</button>';
        });
        if(self._hasActiveFilter()) h+='<button class="gc-chip gc-chip-clear" onclick="GCApp.clearFilter()">\u2715 Clear</button>';
        els.forEach(function(el){ el.innerHTML=h; });
    },

    _hasActiveFilter:function(){for(var k in this._activeTypes)if(this._activeTypes[k])return true;for(var k in this._activeWps)if(this._activeWps[k])return true;return false;},

    toggleFilter:function(kind,value){
        if(kind==='actType'){this._activeTypes[value]=!this._activeTypes[value];if(!this._activeTypes[value])delete this._activeTypes[value];}
        else{this._activeWps[value]=!this._activeWps[value];if(!this._activeWps[value])delete this._activeWps[value];}
        this.render();
        if(this._viewMode==='summary') this._renderSummary();
    },

    clearFilter:function(){
        this._activeTypes={};this._activeWps={};
        for(var k in this._lockedTypes)if(this._lockedTypes[k])this._activeTypes[k]=true;
        for(var k in this._lockedWps)if(this._lockedWps[k])this._activeWps[k]=true;
        this.render();
        if(this._viewMode==='summary') this._renderSummary();
    },

    _showFilterCtx:function(event,kind,value){
        var menu=document.getElementById('gcCtxMenu');if(!menu)return;var self=this;
        var isLocked=kind==='actType'?!!this._lockedTypes[value]:!!this._lockedWps[value];
        menu.innerHTML='<div class="gc-ctx-header">'+self._esc(value)+'</div>'+(!isLocked?'<div class="gc-ctx-item" data-action="lock">\uD83D\uDD12 Lock Filter</div>':'<div class="gc-ctx-item" data-action="unlock">\uD83D\uDD13 Unlock Filter</div>');
        menu.style.left=event.clientX+'px';menu.style.top=event.clientY+'px';menu.classList.add('visible');
        setTimeout(function(){menu.querySelectorAll('.gc-ctx-item').forEach(function(el){el.onclick=function(ev){ev.stopPropagation();
            if(el.dataset.action==='lock'){if(kind==='actType'){self._lockedTypes[value]=true;self._activeTypes[value]=true;}else{self._lockedWps[value]=true;self._activeWps[value]=true;}}
            else{if(kind==='actType')delete self._lockedTypes[value];else delete self._lockedWps[value];}
            self._saveLockedFilters();self._hideCtx();self.render();};});},0);
    },

    _saveLockedFilters:function(){var lt=[],lw=[];for(var k in this._lockedTypes)if(this._lockedTypes[k])lt.push(k);for(var k in this._lockedWps)if(this._lockedWps[k])lw.push(k);StorageManager.save({prefs:{gcLockedTypeFilters:lt,gcLockedWpFilters:lw}});},

    _rowMatchesFilter:function(row,sectionId,rowIdx){
        var hasTypes=false,hasWps=false;
        for(var k in this._activeTypes)if(this._activeTypes[k]){hasTypes=true;break;}
        for(var k in this._activeWps)if(this._activeWps[k]){hasWps=true;break;}
        if(!hasTypes&&!hasWps)return true;
        var section=DataModel.getSection(sectionId);if(!section)return false;
        var mRow=section.rows[rowIdx];if(!mRow)return false;
        var matchesType=!hasTypes,matchesWp=!hasWps,self=this;
        if(hasTypes&&mRow.testQty){GCApp._getAllTests().forEach(function(t){if(self._activeTypes[t.type]){var v=mRow.testQty[t.id];if(v&&v!==''&&v!=='0')matchesType=true;}});}
        if(hasWps){if(this._activeWps[mRow.workpack])matchesWp=true;if(!matchesWp&&mRow.testQty){GCApp._getAllTests().forEach(function(t){if(self._activeWps[t.workpack]){var v=mRow.testQty[t.id];if(v&&v!==''&&v!=='0')matchesWp=true;}});}}
        return matchesType&&matchesWp;
    },

    _locMatchesFilter:function(loc){
        var hasTypes=false,hasWps=false;
        for(var k in this._activeTypes)if(this._activeTypes[k]){hasTypes=true;break;}
        for(var k in this._activeWps)if(this._activeWps[k]){hasWps=true;break;}
        if(!hasTypes&&!hasWps)return true;
        var found=false,self=this;
        GCApp._getAllTests().forEach(function(t){if(t.location===loc){if(hasTypes&&self._activeTypes[t.type])found=true;if(hasWps&&self._activeWps[t.workpack])found=true;}});
        return found;
    },

    // MAP NODE CLICK — show equipment + test info popup
    // ══════════════════════════════════════════════════════

    _setupMapClick:function(){
        var svg=document.getElementById('gcMapSvg');if(!svg)return;
        var self=this;
        // Right-click on equipment dot or location node → show info
        svg.addEventListener('contextmenu',function(e){
            var dot=e.target.closest('.item-dot');
            if(dot){
                e.preventDefault();
                var rowKey=dot.dataset.rowKey;
                if(rowKey) self._showEquipInfo(rowKey,e.clientX,e.clientY);
                return;
            }
            var node=e.target.closest('.location-node');
            if(node){
                e.preventDefault();
                var loc=node.dataset.loc;if(loc) self._showLocInfo(loc,e.clientX,e.clientY);
                return;
            }
        });
        // Left-click item dot → highlight just that dot
        svg.addEventListener('click',function(e){
            var dot=e.target.closest('.item-dot');
            if(dot){
                self._clearSvgDotHighlight();
                dot.classList.add('svg-dot-focused');
                // Dim all others
                document.querySelectorAll('.item-dot').forEach(function(d){
                    if(d!==dot) d.classList.add('svg-dot-dimmed');
                });
                return;
            }
            var node=e.target.closest('.location-node');
            if(node){
                var loc=node.dataset.loc;
                if(loc) self._showLocInfo(loc,e.clientX,e.clientY);
                return;
            }
            // Click elsewhere — clear highlights and hide tooltip
            self._clearSvgDotHighlight();
            document.getElementById('gcTooltip')?.classList.remove('visible');
        });
        // Global click — dismiss tooltip when clicking outside it
        document.addEventListener('click',function(e){
            var tip=document.getElementById('gcTooltip');
            if(tip&&tip.classList.contains('visible')&&!tip.contains(e.target)&&!e.target.closest('.location-node')&&!e.target.closest('.item-dot')){
                tip.classList.remove('visible');
            }
        });
    },

    _clearSvgDotHighlight:function(){
        document.querySelectorAll('.item-dot').forEach(function(dot){
            dot.classList.remove('svg-dot-focused','svg-dot-dimmed');
        });
    },

    /** Show detailed equipment info popup */
    _showEquipInfo:function(rowKey,x,y){
        var tip=document.getElementById('gcTooltip');if(!tip)return;
        var self=this;
        // Find the row
        var found=null;
        this._equipSchedules.forEach(function(sec){sec.rows.forEach(function(row){if(row.rowKey===rowKey)found={sec:sec,row:row};});});
        if(!found)return;
        var row=found.row,sec=found.sec;

        document.getElementById('gcTooltipTitle').textContent=(row.itemNo?row.itemNo+' — ':'')+row.name;

        var h='<div class="gc-tooltip-row"><span class="gc-tooltip-label">Section:</span><span class="gc-tooltip-value">'+self._esc(sec.sectionName)+'</span></div>';

        // Current location
        var info=self._rowPosAt(row,self._currentTime);
        if(info){
            var locStr=info.isTransfer?'In transit → '+info.location:info.location;
            h+='<div class="gc-tooltip-row"><span class="gc-tooltip-label">Location:</span><span class="gc-tooltip-value">'+self._esc(locStr)+'</span></div>';
        }

        // Schedule bars
        var bars=row.bars.filter(function(b){return b.type!=='transfer';});
        if(bars.length>0){
            h+='<div style="font-size:10px;color:#5c6370;text-transform:uppercase;margin:8px 0 4px;border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;">Schedule</div>';
            bars.forEach(function(b){
                var c=self._getLocationColor(b.location);
                h+='<div class="gc-tooltip-row"><span class="gc-tooltip-label" style="color:'+c+'">'+self._shortLoc(b.location)+'</span><span class="gc-tooltip-value">'+self._esc(b.startDate||'')+' → '+self._esc(b.endDate||'')+'</span></div>';
            });
        }

        // Linked test activities
        var section=DataModel.getSection(sec.sectionId);
        if(section){
            var mRow=section.rows[row.rowIdx];
            if(mRow&&mRow.testQty){
                var tests=[];
                GCApp._getAllTests().forEach(function(t){var v=mRow.testQty[t.id];if(v&&v!==''&&v!=='0')tests.push(t);});
                if(tests.length>0){
                    h+='<div style="font-size:10px;color:#5c6370;text-transform:uppercase;margin:8px 0 4px;border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;">Test Activities</div>';
                    tests.forEach(function(t){
                        var c=DataModel.getLocationColor(t.location);var dot=c?c.color:'#64748b';
                        h+='<div class="gc-tooltip-row"><span class="gc-tooltip-label" style="color:'+dot+'">'+self._esc(t.name)+'</span><span class="gc-tooltip-value">'+self._esc(t.type)+(t.location?' · '+self._shortLoc(t.location):'')+'</span></div>';
                    });
                }
            }
        }

        document.getElementById('gcTooltipContent').innerHTML=h;
        tip.style.left=(x+15)+'px';tip.style.top=(y+15)+'px';tip.classList.add('visible');
        // Keep visible until click elsewhere
        clearTimeout(tip._hideTimer);
        tip._hideTimer=setTimeout(function(){tip.classList.remove('visible');},8000);
    },

    _showLocInfo:function(loc,x,y){
        var tip=document.getElementById('gcTooltip');if(!tip)return;
        var self=this;
        var locColor=self._getLocationColor(loc);
        document.getElementById('gcTooltipTitle').innerHTML='<span class="gc-ctx-dot" style="background:'+locColor+';display:inline-block;margin-right:6px;"></span>'+self._esc(loc);

        // Equipment at this location (current time)
        var equipHere=[];
        this._flatRows().forEach(function(item){
            var info=self._rowPosAt(item.row,self._currentTime);
            if(info&&info.location===loc&&!info.isTransfer) equipHere.push({row:item.row,sec:item.sec});
        });
        // Test activities at this location
        var testsHere=GCApp._getAllTests().filter(function(t){return t.location===loc;});
        var h='';

        // Show test activities header
        if(testsHere.length>0){
            h+='<div style="font-size:10px;color:#5c6370;text-transform:uppercase;margin-bottom:4px;">Test Activities at Location</div>';
            testsHere.forEach(function(t){
                var c=DataModel.getLocationColor(t.location);var dot=c?c.color:'#64748b';
                var dates=t.startDate&&t.endDate?t.startDate.substring(5)+' \u2192 '+t.endDate.substring(5):'No dates';
                var isSub=!!t.parentId;var prefix=isSub?'\u2514 ':'';var subStyle=isSub?' style="font-style:italic;opacity:0.8;"':'';
                h+='<div class="gc-tooltip-row"'+subStyle+'><span class="gc-tooltip-label" style="color:'+dot+'">'+prefix+self._esc(t.name)+'</span><span class="gc-tooltip-value">'+self._esc(t.type)+' \u00B7 '+dates+'</span></div>';
            });
        }

        // Equipment here grouped with their linked test activities
        if(equipHere.length>0){
            h+='<div style="font-size:10px;color:#5c6370;text-transform:uppercase;margin:8px 0 4px;border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;">Equipment Here ('+equipHere.length+')</div>';
            var shown=Math.min(equipHere.length,12);
            for(var i=0;i<shown;i++){
                var r=equipHere[i].row,sec=equipHere[i].sec;
                var ec=self._getEquipColor(r);
                h+='<div style="margin-bottom:6px;">';
                h+='<div class="gc-tooltip-row"><span class="gc-tooltip-label" style="color:'+ec+';font-weight:600;">'+(r.itemNo?self._esc(r.itemNo)+' \u2014 ':'')+self._esc(r.name)+'</span></div>';
                // Find test activities linked to this equipment row at this location
                var section=DataModel.getSection(sec.sectionId);
                if(section){
                    var mRow=section.rows[r.rowIdx];
                    if(mRow&&mRow.testQty){
                        var rowTests=[];
                        GCApp._getAllTests().forEach(function(t){
                            var v=mRow.testQty[t.id];
                            if(v&&v!==''&&v!=='0'&&t.location===loc) rowTests.push(t);
                        });
                        if(rowTests.length>0){
                            rowTests.forEach(function(t){
                                var dates=t.startDate&&t.endDate?t.startDate.substring(5)+'\u2192'+t.endDate.substring(5):'';
                                h+='<div class="gc-tooltip-row" style="padding-left:12px;"><span class="gc-tooltip-label" style="color:#8b929a;font-size:10px;">\u2514 '+self._esc(t.name)+' \u00B7 '+self._esc(t.type)+'</span><span class="gc-tooltip-value" style="font-size:10px;">'+dates+'</span></div>';
                            });
                        }
                    }
                }
                h+='</div>';
            }
            if(equipHere.length>12) h+='<div style="font-size:10px;color:#5c6370;">...and '+(equipHere.length-12)+' more</div>';
        }
        if(!h) h='<div style="color:#5c6370;">No equipment or tests at this location</div>';
        document.getElementById('gcTooltipContent').innerHTML=h;
        tip.classList.add('visible');
        // Smart position: keep on-screen
        var tx=x+15,ty=y+15;
        var tr=tip.getBoundingClientRect();
        if(tx+tr.width>window.innerWidth-10) tx=x-tr.width-10;
        if(ty+tr.height>window.innerHeight-10) ty=y-tr.height-10;
        if(tx<10) tx=10;if(ty<10) ty=10;
        tip.style.left=tx+'px';tip.style.top=ty+'px';
        clearTimeout(tip._hideTimer);
        tip._hideTimer=setTimeout(function(){tip.classList.remove('visible');},12000);
    },

    // ══════════════════════════════════════════════════════
    // MILESTONE STRIP EVENTS + EDITING
    // ══════════════════════════════════════════════════════

    _bindMsStripEvents:function(){
        var self=this;
        var strip=document.getElementById('gcMsStrip');if(!strip)return;

        // Right-click on WP track → add milestone
        strip.querySelectorAll('.gc-ms-wp-track').forEach(function(track){
            track.addEventListener('contextmenu',function(e){
                if(e.target.closest('.gc-ms-interactive'))return;
                e.preventDefault();
                var rect=track.getBoundingClientRect();
                var pct=Math.max(0,Math.min(100,(e.clientX-rect.left)/rect.width*100));
                var wp=track.dataset.wp;
                self._addGcMilestone(wp,pct);
            });
        });

        // Milestone: mousedown = drag, dblclick = edit, contextmenu = edit
        strip.querySelectorAll('.gc-ms-interactive').forEach(function(el){
            el.addEventListener('mousedown',function(e){
                if(e.button!==0)return;
                e.preventDefault();e.stopPropagation();
                self._startMsDrag(e,el);
            });
            el.addEventListener('dblclick',function(e){
                e.preventDefault();e.stopPropagation();
                self.openMsModal(parseInt(el.dataset.msId));
            });
            el.addEventListener('contextmenu',function(e){
                e.preventDefault();e.stopPropagation();
                self.openMsModal(parseInt(el.dataset.msId));
            });
        });
    },

    _msDrag:null,

    _startMsDrag:function(event,el){
        var msId=parseInt(el.dataset.msId);
        this._ensureFlowData();
        var ms=FlowData.milestones.find(function(m){return m.id===msId;});
        if(!ms)return;

        var strip=document.getElementById('gcMsStrip');if(!strip)return;
        var stripRect=strip.getBoundingClientRect();

        // Snapshot all visible WP track rects
        var tracks=[];
        strip.querySelectorAll('.gc-ms-wp-track').forEach(function(track){
            tracks.push({wp:track.dataset.wp,el:track,rect:track.getBoundingClientRect()});
        });
        if(tracks.length===0)return;

        var startX=event.clientX,startY=event.clientY;
        var moved=false;
        el.classList.add('gc-ms-dragging');
        el.style.zIndex='100';

        // Vertical date line
        var vLine=document.getElementById('gc-ms-drag-vline');
        if(!vLine){
            vLine=document.createElement('div');
            vLine.id='gc-ms-drag-vline';
            vLine.style.cssText='position:fixed;width:1px;pointer-events:none;z-index:9999;background:rgba(0,212,255,0.4);display:none;';
            document.body.appendChild(vLine);
        }

        // Date tooltip
        var dateTip=document.getElementById('gc-ms-drag-date');
        if(!dateTip){
            dateTip=document.createElement('div');
            dateTip.id='gc-ms-drag-date';
            dateTip.style.cssText='position:fixed;pointer-events:none;z-index:10000;background:rgba(10,14,20,0.95);color:#00d4ff;font-size:10px;font-weight:600;padding:3px 8px;border-radius:4px;border:1px solid rgba(0,212,255,0.3);display:none;font-family:monospace;';
            document.body.appendChild(dateTip);
        }

        var self=this;

        var onMove=function(e){
            var dx=e.clientX-startX,dy=e.clientY-startY;
            if(!moved&&Math.abs(dx)<3&&Math.abs(dy)<3)return;
            moved=true;

            // Find which track cursor is in
            var targetTrack=tracks[0];
            for(var i=0;i<tracks.length;i++){
                if(e.clientY>=tracks[i].rect.top&&e.clientY<=tracks[i].rect.bottom){
                    targetTrack=tracks[i];break;
                }
            }

            // Clamp X to track bounds
            var clampedX=Math.max(targetTrack.rect.left,Math.min(targetTrack.rect.right,e.clientX));
            var pct=((clampedX-targetTrack.rect.left)/targetTrack.rect.width)*100;
            pct=Math.max(0,Math.min(100,pct));

            // Move the element visually
            el.style.left=pct.toFixed(2)+'%';
            // If cursor moved to another track, reparent
            if(el.parentElement!==targetTrack.el){
                targetTrack.el.appendChild(el);
            }

            // Highlight drop target
            tracks.forEach(function(tr){tr.el.classList.toggle('tl-drop-target',tr===targetTrack);});

            // Show vertical line
            vLine.style.display='block';
            vLine.style.left=clampedX+'px';
            vLine.style.top=stripRect.top+'px';
            vLine.style.height=stripRect.height+'px';

            // Show date tooltip
            var d=self._pctToDate(pct);
            var dd=String(d.getDate()).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+String(d.getFullYear()).toString().substring(2);
            dateTip.textContent=dd;
            dateTip.style.display='block';
            dateTip.style.left=(clampedX+10)+'px';
            dateTip.style.top=(e.clientY-28)+'px';

            // Store pending values
            self._msDrag={msId:msId,wp:targetTrack.wp,pct:pct,dateStr:dd};
        };

        var onUp=function(e){
            document.removeEventListener('mousemove',onMove);
            document.removeEventListener('mouseup',onUp);
            el.classList.remove('gc-ms-dragging');
            el.style.zIndex='';
            vLine.style.display='none';
            dateTip.style.display='none';
            tracks.forEach(function(tr){tr.el.classList.remove('tl-drop-target');});

            if(!moved){
                // It was a click, not a drag → open edit modal
                self.openMsModal(msId);
                return;
            }

            // Apply drag result
            if(self._msDrag){
                ms.wpRow=self._msDrag.wp;
                ms.date=self._msDrag.dateStr;
                // Immediate save to avoid debounce stale data
                StorageManager.saveNow({flow:{
                    positions:self._getFlowPositions(),
                    edges:FlowData.edges,nextEdgeId:FlowData.nextEdgeId,
                    descriptions:FlowData.descriptions,
                    milestones:FlowData.milestones,
                    nextMilestoneId:FlowData.nextMilestoneId,
                    hiddenLanes:FlowData.hiddenLanes||{},
                    lockedHiddenLanes:FlowData.lockedHiddenLanes||{},
                    inactiveNodes:FlowData.inactiveNodes||{}
                }});
                self._msDrag=null;
                self._calcRange();
                self._renderGantt();
                self._renderMap();
            }
        };

        document.addEventListener('mousemove',onMove);
        document.addEventListener('mouseup',onUp);
    },

    _addGcMilestone:function(wpRow,pct){
        this._ensureFlowData();
        var d=this._pctToDate(pct);
        var dd=String(d.getDate()).padStart(2,'0')+'.'+String(d.getMonth()+1).padStart(2,'0')+'.'+String(d.getFullYear()).toString().substring(2);
        var ms={
            id:FlowData.nextMilestoneId++,
            wpRow:wpRow,
            laneType:FlowData.laneTypes[0]||'FAT',
            x:50,
            text:'',date:dd,
            shape:'circle',color:'#ffffff',size:'medium'
        };
        FlowData.milestones.push(ms);
        // Force immediate save to avoid debounce stale reads
        StorageManager.saveNow({flow:{
            positions:this._getFlowPositions(),
            edges:FlowData.edges,
            nextEdgeId:FlowData.nextEdgeId,
            descriptions:FlowData.descriptions,
            milestones:FlowData.milestones,
            nextMilestoneId:FlowData.nextMilestoneId,
            hiddenLanes:FlowData.hiddenLanes||{},
            lockedHiddenLanes:FlowData.lockedHiddenLanes||{},
            inactiveNodes:FlowData.inactiveNodes||{}
        }});
        this._calcRange();
        this._renderGantt();
        this.openMsModal(ms.id);
    },

    _getFlowPositions:function(){
        var p={};
        if(typeof FlowData!=='undefined'&&FlowData.nodes){
            FlowData.nodes.forEach(function(n){p[n.id]=n.y;});
        }
        return p;
    },

    _ensureFlowData:function(){
        if(FlowData.milestones.length===0 || !FlowData._loaded){
            var f=StorageManager.loadFlow();
            if(f){
                if(f.milestones)FlowData.milestones=f.milestones;
                if(f.nextMilestoneId)FlowData.nextMilestoneId=f.nextMilestoneId;
                if(f.edges)FlowData.edges=f.edges;
                if(f.nextEdgeId)FlowData.nextEdgeId=f.nextEdgeId;
                if(f.positions){
                    FlowData.nodes.forEach(function(n){if(f.positions[n.id]!==undefined)n.y=f.positions[n.id];});
                }
                if(f.descriptions)FlowData.descriptions=f.descriptions;
                FlowData.hiddenLanes=f.hiddenLanes||{};
                FlowData.lockedHiddenLanes=f.lockedHiddenLanes||{};
            }
            FlowData._loaded=true;
        }
    },

    _gcMsActiveMsId:null,
    _gcMsShape:'circle',
    _gcMsColor:'#ffffff',
    _gcMsSize:'medium',

    openMsModal:function(msId){
        this._ensureFlowData();
        var ms=FlowData.milestones.find(function(m){return m.id===msId;});
        if(!ms)return;

        this._gcMsActiveMsId=msId;
        this._gcMsShape=ms.shape||'circle';
        this._gcMsColor=ms.color||'#ffffff';
        this._gcMsSize=ms.size||'medium';

        document.getElementById('gcMsTextInput').value=ms.text||'';
        document.getElementById('gcMsDateInput').value=ms.date||'';

        // WP selector
        var wpSel=document.getElementById('gcMsWpSelect');
        if(wpSel){
            wpSel.innerHTML=this._wpRows.map(function(wp){return'<option value="'+wp+'"'+(wp===ms.wpRow?' selected':'')+'>'+wp+'</option>';}).join('');
        }

        var self=this;
        // Shape buttons
        document.querySelectorAll('#gcMsShapePicker .ms-shape-btn').forEach(function(btn){
            btn.classList.toggle('active',btn.dataset.shape===self._gcMsShape);
            btn.onclick=function(){
                self._gcMsShape=btn.dataset.shape;
                document.querySelectorAll('#gcMsShapePicker .ms-shape-btn').forEach(function(b){b.classList.remove('active');});
                btn.classList.add('active');
                self._updateGcMsPreview();
            };
        });
        // Color buttons
        document.querySelectorAll('#gcMsColorPicker .ms-color-btn').forEach(function(btn){
            btn.classList.toggle('active',btn.dataset.color===self._gcMsColor);
            btn.onclick=function(){
                self._gcMsColor=btn.dataset.color;
                document.querySelectorAll('#gcMsColorPicker .ms-color-btn').forEach(function(b){b.classList.remove('active');});
                btn.classList.add('active');
                self._updateGcMsPreview();
            };
        });
        // Size buttons
        document.querySelectorAll('#gcMsSizePicker .ms-size-btn').forEach(function(btn){
            btn.classList.toggle('active',btn.dataset.size===self._gcMsSize);
            btn.onclick=function(){
                self._gcMsSize=btn.dataset.size;
                document.querySelectorAll('#gcMsSizePicker .ms-size-btn').forEach(function(b){b.classList.remove('active');});
                btn.classList.add('active');
                self._updateGcMsPreview();
            };
        });

        document.getElementById('gcMsTextInput').oninput=function(){self._updateGcMsPreview();};
        document.getElementById('gcMsDateInput').oninput=function(){self._updateGcMsPreview();};

        this._updateGcMsPreview();
        document.getElementById('gcMsModal').classList.add('active');
        setTimeout(function(){document.getElementById('gcMsTextInput').focus();},100);
    },

    _updateGcMsPreview:function(){
        var el=document.getElementById('gcMsPreview');if(!el)return;
        var text=(document.getElementById('gcMsTextInput')||{}).value||'';
        var date=(document.getElementById('gcMsDateInput')||{}).value||'';
        var sz={'small':10,'medium':22,'large':32}[this._gcMsSize]||22;
        el.innerHTML='<div style="display:flex;flex-direction:column;align-items:center;gap:2px;"><span style="font-size:10px;color:#ccd;font-weight:600;">'+this._esc(text||'Title')+'</span>'+this._msShapeSvg(this._gcMsShape,this._gcMsColor,sz)+'<span style="font-size:9px;color:#889;">'+this._esc(date||'dd.mm.yy')+'</span></div>';
    },

    saveMsModal:function(){
        this._ensureFlowData();
        var ms=FlowData.milestones.find(function(m){return m.id===GCApp._gcMsActiveMsId;});
        if(!ms)return;
        ms.text=((document.getElementById('gcMsTextInput')||{}).value||'').trim();
        ms.date=((document.getElementById('gcMsDateInput')||{}).value||'').trim();
        ms.shape=this._gcMsShape;
        ms.color=this._gcMsColor;
        ms.size=this._gcMsSize;
        var wpSel=document.getElementById('gcMsWpSelect');
        if(wpSel)ms.wpRow=wpSel.value;
        StorageManager.saveNow({flow:{
            positions:this._getFlowPositions(),edges:FlowData.edges,nextEdgeId:FlowData.nextEdgeId,
            descriptions:FlowData.descriptions,milestones:FlowData.milestones,
            nextMilestoneId:FlowData.nextMilestoneId,
            hiddenLanes:FlowData.hiddenLanes||{},lockedHiddenLanes:FlowData.lockedHiddenLanes||{},
            inactiveNodes:FlowData.inactiveNodes||{}
        }});
        this.closeMsModal();
        this._calcRange();
        this.render();
    },

    deleteMsFromModal:function(){
        if(!this._gcMsActiveMsId)return;
        this._ensureFlowData();
        FlowData.milestones=FlowData.milestones.filter(function(m){return m.id!==GCApp._gcMsActiveMsId;});
        StorageManager.saveNow({flow:{
            positions:this._getFlowPositions(),edges:FlowData.edges,nextEdgeId:FlowData.nextEdgeId,
            descriptions:FlowData.descriptions,milestones:FlowData.milestones,
            nextMilestoneId:FlowData.nextMilestoneId,
            hiddenLanes:FlowData.hiddenLanes||{},lockedHiddenLanes:FlowData.lockedHiddenLanes||{},
            inactiveNodes:FlowData.inactiveNodes||{}
        }});
        this.closeMsModal();
        this.render();
    },

    closeMsModal:function(){
        var el=document.getElementById('gcMsModal');if(el)el.classList.remove('active');
        this._gcMsActiveMsId=null;
    },

    // ══════════════════════════════════════════════════════
    // WP VISIBILITY PANEL
    // ══════════════════════════════════════════════════════

    openWpPanel:function(){
        this._renderWpPanel();
        document.getElementById('gcWpPanelOverlay').classList.add('active');
    },

    closeWpPanel:function(){
        document.getElementById('gcWpPanelOverlay').classList.remove('active');
        StorageManager.save({prefs:{gcHiddenWpRows:this._hiddenWpRows}});
        this._renderGantt();
    },

    _renderWpPanel:function(){
        var list=document.getElementById('gcWpPanelList');if(!list)return;
        var self=this;
        var html='';
        this._wpRows.forEach(function(wp){
            var color=self._wpColors[wp]||'#888';
            var hidden=!!self._hiddenWpRows[wp];
            html+='<div class="gc-wp-panel-item">';
            html+='<span class="gc-wp-panel-dot" style="background:'+color+'"></span>';
            html+='<span class="gc-wp-panel-name">'+wp+'</span>';
            html+='<label class="gc-wp-toggle"><input type="checkbox" '+(hidden?'':'checked')+' onchange="GCApp.toggleWpRow(\''+wp+'\',this.checked)"><span class="gc-wp-slider"></span></label>';
            html+='</div>';
        });
        list.innerHTML=html;
    },

    toggleWpRow:function(wp,visible){
        if(visible) delete this._hiddenWpRows[wp];
        else this._hiddenWpRows[wp]=true;
        StorageManager.save({prefs:{gcHiddenWpRows:this._hiddenWpRows}});
        this._renderGantt();
    },

    wpPanelShowAll:function(){
        this._hiddenWpRows={};
        this._renderWpPanel();
        StorageManager.save({prefs:{gcHiddenWpRows:this._hiddenWpRows}});
        this._renderGantt();
    },

    wpPanelHideAll:function(){
        var self=this;
        this._wpRows.forEach(function(wp){self._hiddenWpRows[wp]=true;});
        this._renderWpPanel();
        StorageManager.save({prefs:{gcHiddenWpRows:this._hiddenWpRows}});
        this._renderGantt();
    },

    // ── Lock toggle (bars free-move vs. locked) ──────────────
    toggleLock:function(){
        this._locked=!this._locked;
        this._updateLockUI();
        StorageManager.save({prefs:{gcLocked:this._locked}});
    },

    _updateLockUI:function(){
        var btn=document.getElementById('gcLockBtn');
        var lbl=document.getElementById('gcLockLabel');
        var ico=document.getElementById('gcLockIcon');
        var body=document.getElementById('gcGanttRows');
        if(!btn||!lbl||!ico)return;
        if(this._locked){
            btn.classList.add('active');
            lbl.textContent='Locked';
            // Closed padlock
            ico.innerHTML='<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
            if(body) body.classList.add('gc-locked');
            var w=document.querySelector('.gc-gantt-wrapper');
            if(w) w.classList.add('gc-locked');
        } else {
            btn.classList.remove('active');
            lbl.textContent='Unlocked';
            // Open padlock
            ico.innerHTML='<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>';
            if(body) body.classList.remove('gc-locked');
            var w2=document.querySelector('.gc-gantt-wrapper');
            if(w2) w2.classList.remove('gc-locked');
        }
    },

    // ── View mode toggle (Gantt vs. Activity Summary) ────────
    setViewMode:function(mode){
        if(mode!=='gantt'&&mode!=='summary')return;
        this._viewMode=mode;
        var g=document.getElementById('gcViewGantt');
        var s=document.getElementById('gcViewSummary');
        var tg=document.getElementById('gcViewTabGantt');
        var ts=document.getElementById('gcViewTabSummary');
        if(g) g.style.display = (mode==='gantt') ? '' : 'none';
        if(s) s.style.display = (mode==='summary') ? '' : 'none';
        if(tg) tg.classList.toggle('active', mode==='gantt');
        if(ts) ts.classList.toggle('active', mode==='summary');
        if(mode==='summary') this._renderSummary();
        StorageManager.save({prefs:{gcViewMode:mode}});
    },

    // ── Activity Summary Renderer ────────────────────────────
    // Produces a list view similar to the PDF "Activity Summary" page,
    // with a mini-gantt on the right showing each activity's start→end span
    // against the chart's current date range. Sub-activities can be
    // expanded / collapsed — state is shared with DataModel.expandedSubActivities.
    _renderSummary:function(){
        var container=document.getElementById('gcSummaryContainer');
        var hint=document.getElementById('gcSummaryHint');
        if(!container)return;

        var self = this;
        var hasTypeFilter = false, hasWpFilter = false;
        for(var kk in this._activeTypes) if(this._activeTypes[kk]){ hasTypeFilter = true; break; }
        for(var kk in this._activeWps)   if(this._activeWps[kk]){ hasWpFilter = true; break; }

        function passesFilter(t){
            // When chips are active, activity must match at least one in each
            // active category (type / WP) — matches the Gantt view semantics.
            if(hasTypeFilter && !self._activeTypes[t.type]) return false;
            if(hasWpFilter   && !self._activeWps[t.workpack]) return false;
            return true;
        }

        var tests=(DataModel.testColumns||[]).filter(function(t){
            if(!t) return false;
            if(typeof DataModel.isActivityVisible==='function' && !DataModel.isActivityVisible(t.id)) return false;
            // Parent passes if it matches, OR if any of its sub-activities match
            if(passesFilter(t)) return true;
            if(t.subActivities && t.subActivities.length > 0){
                for(var i=0; i<t.subActivities.length; i++){
                    if(passesFilter(t.subActivities[i])) return true;
                }
            }
            return false;
        });

        if(tests.length===0){
            container.innerHTML='<div class="gc-summary-empty">'+
                ((hasTypeFilter||hasWpFilter)
                    ? 'No test activities match the current filter.'
                    : 'No test activities to summarize.')+
                '</div>';
            if(hint) hint.textContent='';
            return;
        }

        // Date axis from _rangeStart / _rangeEnd
        var rangeStart=this._rangeStart ? new Date(this._rangeStart) : null;
        var rangeEnd  =this._rangeEnd   ? new Date(this._rangeEnd)   : null;
        var hasRange = rangeStart && rangeEnd && rangeEnd > rangeStart;
        var totalMs  = hasRange ? (rangeEnd - rangeStart) : 0;

        function pct(dateStr){
            if(!hasRange || !dateStr) return null;
            var d=new Date(dateStr);
            if(isNaN(d)) return null;
            var clamped=Math.max(rangeStart.getTime(), Math.min(rangeEnd.getTime(), d.getTime()));
            return ((clamped - rangeStart.getTime()) / totalMs) * 100;
        }

        function esc(s){ var d=document.createElement('div'); d.textContent=s==null?'':String(s); return d.innerHTML; }
        function fmt(d){ if(!d) return '—'; var x=new Date(d); if(isNaN(x))return '—';
            var dd=String(x.getDate()).padStart(2,'0'),mm=String(x.getMonth()+1).padStart(2,'0'),yy=String(x.getFullYear()).slice(-2);
            return dd+'.'+mm+'.'+yy;
        }
        function duration(s,e){ if(!s||!e) return '—'; var a=new Date(s),b=new Date(e); if(isNaN(a)||isNaN(b)) return '—';
            var days=Math.round((b-a)/86400000); return days>=0 ? (days+'d') : '—';
        }

        var typeColors={'FAT':'#00d4ff','EFAT':'#10b981','FIT':'#8b5cf6','SIT':'#f59e0b','M-SIT':'#ef4444','SRT':'#ec4899'};

        // Month ticks for the header axis
        var tickHtml='';
        if(hasRange){
            var months=[]; var d=new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
            while(d<=rangeEnd){ months.push(new Date(d)); d.setMonth(d.getMonth()+1); }
            if(months.length>10){
                var step=Math.ceil(months.length/10);
                months=months.filter(function(_,i){return i%step===0;});
            }
            months.forEach(function(m){
                var p=pct(m);
                if(p!=null){
                    var lbl=m.toLocaleString('en',{month:'short',year:'2-digit'});
                    tickHtml+='<div class="gc-sum-tick" style="left:'+p.toFixed(3)+'%"><span>'+lbl+'</span></div>';
                }
            });
        }

        // ── Build a single row (main or sub-activity) ─────────
        function buildRow(t, opts) {
            opts = opts || {};
            var color = typeColors[t.type] || '#888';
            var sPct = pct(t.startDate);
            var ePct = pct(t.endDate);
            var barHtml='';
            if(sPct!=null && ePct!=null && ePct>sPct){
                barHtml='<div class="gc-sum-bar" style="left:'+sPct.toFixed(3)+'%;width:'+(ePct-sPct).toFixed(3)+'%;background:'+color+';"></div>';
            } else if(sPct!=null){
                barHtml='<div class="gc-sum-bar gc-sum-bar-point" style="left:'+sPct.toFixed(3)+'%;background:'+color+';"></div>';
            }
            var today=new Date();
            var todayPct=pct(today);
            var todayLine = (todayPct!=null) ? '<div class="gc-sum-today" style="left:'+todayPct.toFixed(3)+'%"></div>' : '';

            var isSub = !!opts.isSub;
            var hasSubs = !!(t.subActivities && t.subActivities.length > 0);
            var expanded = hasSubs && DataModel.isSubExpanded(t.id);

            // Toggle (chevron) or spacer — always same width so columns align
            var toggleHtml;
            if (hasSubs) {
                toggleHtml = '<span class="gc-sum-toggle'+(expanded?' open':'')+
                    '" onclick="event.stopPropagation();GCApp.toggleSummarySubs('+t.id+')" title="'+
                    (expanded?'Collapse':'Expand')+' sub-activities">'+
                    '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg>'+
                    '</span>';
            } else if (isSub) {
                toggleHtml = '<span class="gc-sum-subchild-dot"></span>';
            } else {
                toggleHtml = '<span class="gc-sum-toggle-spacer"></span>';
            }

            var rowClass = 'gc-sum-row'
                + (opts.alt ? ' gc-sum-row-alt' : '')
                + (isSub ? ' gc-sum-row-sub' : '')
                + (hasSubs ? ' gc-sum-has-subs' : '');

            var subtitle = t.subtitle ? '<div class="gc-sum-subtitle">'+esc(t.subtitle)+'</div>' : '';
            var subCount = (hasSubs && !expanded)
                ? '<span class="gc-sum-subcount">+'+t.subActivities.length+'</span>'
                : '';

            // ISO date values for the <input type="date"> controls
            var startIso = (t.startDate && !isNaN(new Date(t.startDate))) ? t.startDate : '';
            var endIso   = (t.endDate   && !isNaN(new Date(t.endDate)))   ? t.endDate   : '';

            return '<div class="'+rowClass+'">'
                + '<div class="gc-sum-col-activity">'
                    + toggleHtml
                    + '<div class="gc-sum-activity-text">'
                        + '<div class="gc-sum-activity-name">'+esc(t.name||'—')+subCount+'</div>'
                        + subtitle
                    + '</div>'
                + '</div>'
                + '<div class="gc-sum-col-type"><span class="gc-sum-type" style="background:'+color+'22;color:'+color+';border:1px solid '+color+'55;">'+esc(t.type||'')+'</span></div>'
                + '<div class="gc-sum-col-loc" title="'+esc(t.location||'')+'">'+esc(t.location||'—')+'</div>'
                + '<div class="gc-sum-col-wp">'+esc(t.workpack||'—')+'</div>'
                + '<div class="gc-sum-col-date">'
                    + '<input type="date" class="gc-sum-date-input" value="'+startIso+'" '
                    +    'onchange="GCApp.updateActivityDate('+t.id+',\'start\',this.value)" '
                    +    'title="Start date — changes also apply to the matrix (index.html)">'
                + '</div>'
                + '<div class="gc-sum-col-date">'
                    + '<input type="date" class="gc-sum-date-input" value="'+endIso+'" '
                    +    'onchange="GCApp.updateActivityDate('+t.id+',\'end\',this.value)" '
                    +    'title="End date — changes also apply to the matrix (index.html)">'
                + '</div>'
                + '<div class="gc-sum-col-dur">'+duration(t.startDate,t.endDate)+'</div>'
                + '<div class="gc-sum-col-bar"><div class="gc-sum-track">'+todayLine+barHtml+'</div></div>'
                + '</div>';
        }

        var html='';
        html+='<div class="gc-sum-header">'
            + '<div class="gc-sum-col-activity"><span class="gc-sum-toggle-spacer"></span>Activity</div>'
            + '<div class="gc-sum-col-type">Type</div>'
            + '<div class="gc-sum-col-loc">Location</div>'
            + '<div class="gc-sum-col-wp">WP</div>'
            + '<div class="gc-sum-col-date">Start</div>'
            + '<div class="gc-sum-col-date">End</div>'
            + '<div class="gc-sum-col-dur">Days</div>'
            + '<div class="gc-sum-col-bar"><div class="gc-sum-axis">'+tickHtml+'</div></div>'
            + '</div>';

        var rowIdx = 0;
        var subCount = 0;
        tests.forEach(function(t){
            html += buildRow(t, { alt: (rowIdx % 2 === 1) });
            rowIdx++;
            // Render expanded sub-activities directly below the parent, honoring filters
            if (t.subActivities && t.subActivities.length > 0 && DataModel.isSubExpanded(t.id)) {
                t.subActivities.forEach(function(sub){
                    if(!passesFilter(sub)) return;
                    html += buildRow(sub, { alt: (rowIdx % 2 === 1), isSub: true });
                    rowIdx++;
                    subCount++;
                });
            }
        });

        container.innerHTML=html;

        var summary = tests.length + ' activit' + (tests.length===1?'y':'ies');
        if (subCount > 0) summary += ' + ' + subCount + ' sub-activit' + (subCount===1?'y':'ies');
        if (hasRange) summary += ' · ' + fmt(rangeStart) + ' → ' + fmt(rangeEnd);
        if (hint) hint.textContent = summary;

        this._updateSumExpandBtn();
    },

    /** Toggle a parent test's sub-activities in the summary view. Shares state
     *  with DataModel.expandedSubActivities so it stays in sync with the matrix. */
    toggleSummarySubs:function(parentId){
        DataModel.toggleSubExpanded(parentId);
        try { StorageManager.save({ prefs: { expandedSubActivities: DataModel.expandedSubActivities } }); } catch(e){}
        this._renderSummary();
    },

    /** Edit a test activity's start or end date from the Activity Summary view.
     *  Reuses the same _syncTestData path the Gantt bar drag uses, so the
     *  change is persisted to DataModel.testColumns and reflected in index.html
     *  (via StorageManager / App.persistMatrix). Works for both main tests
     *  and sub-activities (DataModel.getTest walks both). */
    updateActivityDate:function(testId, field, value){
        var test = DataModel.getTest(testId);
        if(!test) return;

        // Validate: don't allow an order flip (start > end).
        // If the new value would invert the range, we just ignore the change
        // and re-render so the input snaps back.
        if(value){
            if(field === 'start' && test.endDate && new Date(value) > new Date(test.endDate)){
                this._renderSummary();
                return;
            }
            if(field === 'end' && test.startDate && new Date(value) < new Date(test.startDate)){
                this._renderSummary();
                return;
            }
        }

        // Reuse the existing sync path — same one used when dragging a Gantt bar.
        // Pass undefined for args we don't want to touch so _syncTestData skips them.
        if(field === 'start'){
            this._syncTestData(testId, value || '', undefined, undefined);
        } else if(field === 'end'){
            this._syncTestData(testId, undefined, value || '', undefined);
        }

        // Recompute date-axis range & refresh both views (range may have grown)
        this._calcRange();
        if(this._viewMode === 'summary') this._renderSummary();
        this.render();
    },

    /** Expand or collapse every parent with sub-activities, in one click.
     *  If ANY parent is currently expanded → collapse all.
     *  If ALL parents are collapsed → expand all. */
    toggleAllSummarySubs:function(){
        var parents=(DataModel.testColumns||[]).filter(function(t){
            return t && t.subActivities && t.subActivities.length > 0
                && (typeof DataModel.isActivityVisible !== 'function' || DataModel.isActivityVisible(t.id));
        });
        if(parents.length===0) return;

        var anyExpanded = parents.some(function(p){ return DataModel.isSubExpanded(p.id); });
        if(anyExpanded){
            // Collapse all by clearing only the parent IDs in our list
            parents.forEach(function(p){
                if(DataModel.isSubExpanded(p.id)) DataModel.toggleSubExpanded(p.id);
            });
        } else {
            // Expand all
            parents.forEach(function(p){
                if(!DataModel.isSubExpanded(p.id)) DataModel.toggleSubExpanded(p.id);
            });
        }
        try { StorageManager.save({ prefs: { expandedSubActivities: DataModel.expandedSubActivities } }); } catch(e){}
        this._renderSummary();
    },

    /** Update the "Expand All / Collapse All" button label + icon to reflect
     *  what clicking it right now would do. Called at the end of _renderSummary. */
    _updateSumExpandBtn:function(){
        var btn=document.getElementById('gcSumExpandBtn');
        var lbl=document.getElementById('gcSumExpandLabel');
        var ico=document.getElementById('gcSumExpandIcon');
        if(!btn||!lbl||!ico) return;

        var parents=(DataModel.testColumns||[]).filter(function(t){
            return t && t.subActivities && t.subActivities.length > 0
                && (typeof DataModel.isActivityVisible !== 'function' || DataModel.isActivityVisible(t.id));
        });

        // Hide button entirely if there's nothing to expand/collapse
        if(parents.length===0){
            btn.style.display='none';
            return;
        }
        btn.style.display='';

        var anyExpanded = parents.some(function(p){ return DataModel.isSubExpanded(p.id); });
        if(anyExpanded){
            lbl.textContent='Collapse All';
            btn.classList.add('active');
            // Up-chevron
            ico.innerHTML='<polyline points="18 15 12 9 6 15"/>';
        } else {
            lbl.textContent='Expand All';
            btn.classList.remove('active');
            // Down-chevron
            ico.innerHTML='<polyline points="6 9 12 15 18 9"/>';
        }
    }
};

document.addEventListener('DOMContentLoaded',function(){GCApp.init();});
