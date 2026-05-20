/**
 * NAV.JS - Shared Navigation + Theme Toggle
 * Handles tab rendering and light/dark theme switching across all pages.
 */

const Nav = {
    render(activePage) {
        const container = document.getElementById('navTabs');
        if (!container) return;
        const inSub = activePage === 'changelog';
        const p = inSub ? '../' : '';
        const isLight = document.body.classList.contains('light-theme');

        container.innerHTML = `
            <a href="${p}index.html" class="nav-tab ${activePage === 'matrix' ? 'active' : ''}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                    <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
                </svg>
                Matrix
            </a>
            <a href="${p}flow.html" class="nav-tab ${activePage === 'flow' ? 'active' : ''}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="5" cy="6" r="3"/><circle cx="19" cy="6" r="3"/><circle cx="12" cy="18" r="3"/>
                    <line x1="7.5" y1="7.5" x2="10.5" y2="16.5"/><line x1="16.5" y1="7.5" x2="13.5" y2="16.5"/>
                </svg>
                Activity Flow
            </a>
            <a href="${p}gantt-chart.html" class="nav-tab ${activePage === 'gantt-chart' ? 'active' : ''}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="4" width="14" height="3" rx="1"/><rect x="5" y="10" width="16" height="3" rx="1"/>
                    <rect x="7" y="16" width="10" height="3" rx="1"/><line x1="3" y1="2" x2="3" y2="22"/>
                </svg>
                Gantt Chart
            </a>
            <a href="${p}log/changelog.html" class="nav-tab ${activePage === 'changelog' ? 'active' : ''}" style="margin-left:auto;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
                </svg>
                Log
            </a>
            <button class="nav-theme-btn${isLight ? ' active' : ''}" onclick="Nav.toggleTheme()" title="Switch light / dark theme">
                <svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="5"/>
                    <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                    <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
                <svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
                </svg>
            </button>
        `;
    },

    toggleTheme() {
        const isLight = document.body.classList.toggle('light-theme');
        try { localStorage.setItem('tem_theme', isLight ? 'light' : 'dark'); } catch(e) {}
        var btn = document.querySelector('.nav-theme-btn');
        if (btn) btn.classList.toggle('active', isLight);
        // Sync flow page Light button if present
        var flowLabel = document.getElementById('lightModeLabel');
        if (flowLabel) flowLabel.textContent = isLight ? 'Dark' : 'Light';
        var flowBtn = document.getElementById('lightModeBtn');
        if (flowBtn) flowBtn.classList.toggle('active', isLight);
        if (typeof FlowApp !== 'undefined') FlowApp._lightMode = isLight;

        // Re-apply the matrix type-colour highlight so its inline background
        // tints (set per-theme by FilterManager._tintFor) recompute for the
        // theme we just switched to. Without this, tints chosen for the old
        // theme persist until the next filter change.
        if (typeof FilterManager !== 'undefined' && FilterManager.apply) {
            try { FilterManager.apply(); } catch (e) {}
        }
    },

    applyStoredTheme() {
        try {
            if (localStorage.getItem('tem_theme') === 'light') {
                document.body.classList.add('light-theme');
            }
        } catch(e) {}
    }
};

Nav.applyStoredTheme();
